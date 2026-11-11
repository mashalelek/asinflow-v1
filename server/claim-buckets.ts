// Supplier claims — the Claims page's rows and the one timer (SPEC §22 "Supplier claims" §3.2–3.4, claims commit 2).
//   loadClaimsPage — every claim (or a filtered set) with its derived bucket, since / due, days in bucket, steps and next action.
//   sweepClaimTimers — the 5-business-day timer (D7): an open claim with no open task whose timer ran out gets
//     follow_up_supplier (Waiting on supplier) or check_on_it with the reason (every other bucket); one open per kind per
//     claim, never while a snooze holds. Runs when the Claims page loads (GET /api/claims) — the buckets are read then.
//   claimDetail — one claim with its PO (payments for the method prefill, refunds, alt order #s), the other open claims
//     of the PO (a refund split), the timeline.
import type { QueryLike } from "./scheduler/types";
import { CLAIM_KINDS } from "@shared/supplier-claim";
import { claimSteps, daysSince, deriveBucket, nextAction, type BucketResult, type ClaimBucket, type ClaimStep } from "@shared/claim-bucket";
import { addTask, loadClaimEvents, loadClaims, type ClaimEvent, type ClaimRow } from "./supplier-claims";

export interface ClaimPageRow extends ClaimRow {
  bucket: ClaimBucket; bucket_since: string | null; due_at: string | null; timed_out: boolean; days_in_bucket: number | null;
  steps: ClaimStep[]; step: string; next_action: string;
}
export interface ClaimsPageFilters { supplier?: string | null; kind?: string | null; po?: string | null }

const rowOf = (c: ClaimRow, now: Date): ClaimPageRow => {
  const b: BucketResult = deriveBucket(c, now);
  const steps = claimSteps(c);
  const current = steps.find((s) => s.current);
  const step = c.status === "closed" ? "Closed" : c.status === "dismissed" ? "Dismissed" : current?.label ?? "";
  return { ...c, bucket: b.bucket, bucket_since: b.since, due_at: b.due, timed_out: b.timedOut, days_in_bucket: daysSince(b.since, now), steps, step, next_action: nextAction(c, b) };
};

/** Every claim with its bucket, filtered by supplier / kind / PO (order # or id); default order: longest waiting first. */
export async function loadClaimsPage(query: QueryLike, filters: ClaimsPageFilters = {}, now = new Date()): Promise<ClaimPageRow[]> {
  const rows = (await loadClaims(query, { all: true })).map((c) => rowOf(c, now));
  const sup = filters.supplier?.trim().toLowerCase() || null, kind = filters.kind?.trim() || null, po = filters.po?.trim() || null;
  return rows
    .filter((r) => (!sup || r.supplier.toLowerCase() === sup) && (!kind || r.kind === kind) && (!po || r.order_id === po || r.po_id === po || (r.alt_order_ids ?? "").split(/[\s,;/]+/).includes(po)))
    .sort((a, b) => (a.bucket_since ?? a.found_at).localeCompare(b.bucket_since ?? b.found_at) || a.id - b.id);
}

/** Counts per bucket over a set of rows (the tabs). */
export function bucketCounts(rows: ReadonlyArray<{ bucket: ClaimBucket }>): Record<ClaimBucket, number> {
  const out = { needs_attention: 0, waiting_supplier: 0, waiting_shipment: 0, waiting_refund: 0, waiting_velocity: 0, closed: 0, dismissed: 0 } as Record<ClaimBucket, number>;
  for (const r of rows) out[r.bucket]++;
  return out;
}

/**
 * The timer sweep: for every open claim with NO open task (Maria 2026-11-11: any open task — a Needs attention task or a
 * passive tick — holds the timer, so a claim never gets a Follow up / Check on it on top of one) whose timer ran out,
 * create the timeout task with the reason (once; a snooze holds it). Runs in every scheduled pass (component 30,
 * `30_claim_timers`, so the POs list's Claims column and the Dashboard never lag) and when the Claims page loads
 * (`GET /api/claims`). Returns the tasks created.
 */
export async function sweepClaimTimers(query: QueryLike, now = new Date(), userId: number | null = null): Promise<Array<{ claim_id: number; kind: string; reason: string }>> {
  const created: Array<{ claim_id: number; kind: string; reason: string }> = [];
  for (const c of await loadClaims(query, { all: true })) {
    if (c.status !== "open") continue;
    const b = deriveBucket(c, now);
    if (!b.timedOut || !b.timeout) continue;
    if (c.tasks.some((t) => t.kind === b.timeout!.kind && !t.done_at)) continue;
    await addTask(query, c.id, b.timeout.kind, b.timeout.reason);
    await query(`INSERT INTO supplier_claim_events (claim_id, type, summary, by) VALUES ($1, 'timed_out', $2, $3)`, [c.id, b.timeout.reason, userId]);
    created.push({ claim_id: c.id, kind: b.timeout.kind, reason: b.timeout.reason });
  }
  return created;
}

export interface ClaimDetail {
  claim: ClaimPageRow;
  po: { id: string; order_id: string; supplier: string; order_date: string; ships_to: string | null; closed_at: string | null; alt_order_ids: string | null; payments: Array<{ id: number; method: string; nickname: string | null; last4: string | null; amount: string | null }>; refunds: Array<{ id: number; amount: string | null; method: string | null; refunded_at: string | null; note: string | null; po_line_item_id: string | null }> };
  /** The PO's other OPEN claims — the targets of a refund split. */
  other_open_claims: Array<{ id: number; kind: string; asin: string | null; line_no: number; qty: number | null; remaining: number | null }>;
  events: ClaimEvent[];
  /** Placeholders until commits 6–7 (emails, labels, return tracking): what this claim has linked today. */
  linked: { documents: Array<{ id: number; type: string; file_name: string; drive_file_id: string | null }>; tracking: Array<{ id: number; carrier: string | null; tracking_number: string | null; direction: string | null; status: string | null }> };
}

export async function claimDetail(query: QueryLike, id: number, now = new Date()): Promise<ClaimDetail | null> {
  const [c] = await loadClaims(query, { ids: [id] });
  if (!c) return null;
  const claim = rowOf(c, now);
  const po = (await query(`SELECT id, order_id, supplier, order_date::text AS order_date, ships_to, closed_at::text AS closed_at, alt_order_ids FROM purchase_orders WHERE id = $1`, [c.po_id])).rows[0];
  const payments = (await query(`SELECT id, method, nickname, last4, amount FROM po_payments WHERE po_id = $1 ORDER BY position, id`, [c.po_id])).rows.map((p: any) => ({ ...p, id: Number(p.id) }));
  const refunds = (await query(`SELECT id, amount, method, refunded_at::text AS refunded_at, note, po_line_item_id FROM po_line_refunds WHERE po_id = $1 ORDER BY refunded_at NULLS LAST, id`, [c.po_id])).rows.map((r: any) => ({ ...r, id: Number(r.id) }));
  const others = (await loadClaims(query, { poId: String(c.po_id) })).filter((o) => o.id !== id && o.status === "open").map((o) => ({ id: o.id, kind: o.kind, asin: o.asin, line_no: o.line_no, qty: o.qty, remaining: o.remaining }));
  const documents = (await query(`SELECT id, type, file_name, drive_file_id FROM po_documents WHERE claim_id = $1 ORDER BY id`, [id])).rows.map((d: any) => ({ ...d, id: Number(d.id) }));
  const tracking = (await query(`SELECT id, carrier, tracking_number, direction, status FROM po_tracking WHERE claim_id = $1 ORDER BY id`, [id])).rows.map((t: any) => ({ ...t, id: Number(t.id) }));
  return { claim, po: { ...po, id: String(po.id), payments, refunds }, other_open_claims: others, events: await loadClaimEvents(query, id), linked: { documents, tracking } };
}

export const CLAIM_KIND_FILTERS: readonly string[] = CLAIM_KINDS;
