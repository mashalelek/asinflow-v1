// Supplier claims — the Claims page's rows and the one timer (SPEC §22 "Supplier claims" §3.2–3.4, claims commit 2).
//   loadClaimsPage — every claim (or a filtered set) with its derived bucket, since / due, days in bucket, steps and next action.
//   sweepClaimTimers — the 5-business-day timer (D7): an open claim with no open task whose timer ran out gets
//     follow_up_supplier (Waiting on supplier) or check_on_it with the reason (every other bucket); one open per kind per
//     claim, never while a snooze holds. Runs when the Claims page loads (GET /api/claims) — the buckets are read then.
//   claimDetail — one claim with its PO (payments for the method prefill, refunds, alt order #s), the other open claims
//     of the PO (a refund split), the timeline.
import type { QueryLike } from "./scheduler/types";
import { CLAIM_KINDS, REFUND_OUTCOMES } from "@shared/supplier-claim";
import { claimSteps, daysSince, deriveBucket, nextAction, type BucketResult, type ClaimBucket, type ClaimStep } from "@shared/claim-bucket";
import { stateSentence, primaryAction, needsAttentionGroup, stepActions, whatHappensNext, type PrimaryAction, type UiStep } from "@shared/claim-ui";
import { addTask, loadClaimEvents, loadClaims, type ClaimEvent, type ClaimRow } from "./supplier-claims";

export interface ClaimPageRow extends ClaimRow {
  bucket: ClaimBucket; bucket_since: string | null; due_at: string | null; timed_out: boolean; days_in_bucket: number | null;
  steps: ClaimStep[]; step: string; next_action: string;
  /** §5 amended 2026-11-12 (the mockups): the one-sentence state, the Do column's primary button, the Needs attention group, the steps with handlers, what happens next. */
  sentence: string; action: PrimaryAction; group: string | null; ui_steps: UiStep[]; next: Array<{ when: "Now" | "Then"; text: string }>; days_open: number | null;
}
export interface ClaimsPageFilters { supplier?: string | null; kind?: string | null; po?: string | null }

const rowOf = (c: ClaimRow, now: Date): ClaimPageRow => {
  const b: BucketResult = deriveBucket(c, now);
  const steps = claimSteps(c);
  const current = steps.find((s) => s.current);
  const step = c.status === "closed" ? "Closed" : c.status === "dismissed" ? "Dismissed" : current?.todo ?? current?.label ?? "";
  return { ...c, bucket: b.bucket, bucket_since: b.since, due_at: b.due, timed_out: b.timedOut, days_in_bucket: daysSince(b.since, now), steps, step, next_action: nextAction(c, b),
    sentence: stateSentence(c, b), action: primaryAction(c, b), group: b.bucket === "needs_attention" ? needsAttentionGroup(c) : null, ui_steps: stepActions(c), next: whatHappensNext(c, b), days_open: daysSince(c.found_at, now) };
};

/** Every claim with its bucket, filtered by supplier / kind / PO (order # or id); default order: longest waiting first. */
export async function loadClaimsPage(query: QueryLike, filters: ClaimsPageFilters = {}, now = new Date()): Promise<ClaimPageRow[]> {
  const rows = (await loadClaims(query, { all: true })).map((c) => rowOf(c, now));
  const sup = filters.supplier?.trim().toLowerCase() || null, kind = filters.kind?.trim() || null, po = filters.po?.trim() || null;
  return rows
    .filter((r) => (!sup || r.supplier.toLowerCase() === sup) && (!kind || r.kind === kind) && (!po || r.order_id === po || r.po_id === po || (r.alt_order_ids ?? "").split(/[\s,;/]+/).includes(po)))
    .sort((a, b) => (a.bucket_since ?? a.found_at).localeCompare(b.bucket_since ?? b.found_at) || a.id - b.id);
}

/** The header's "Refunds due $X · N open": the Dashboard's definition (open claims with no outcome or a refund outcome, Σ remaining). */
export function refundsDueTotal(rows: ReadonlyArray<{ status: string; outcome: string | null; remaining: number | null }>): { due: number; open: number } {
  const open = rows.filter((r) => r.status === "open");
  const due = open.filter((r) => !r.outcome || ["refund_card", "gift_card", "store_credit"].includes(String(r.outcome))).reduce((t, r) => t + Math.max(0, r.remaining ?? 0), 0);
  return { due: Math.round(due * 100) / 100, open: open.length };
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
    if (c.status !== "open" && c.status !== "closed") continue; // a written-off claim waiting on Velocity's dispose times out too (Maria 2026-11-12)
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
  /** The PO's other open claims a refund can be split across (isSplitTarget). */
  other_open_claims: Array<{ id: number; kind: string; asin: string | null; line_no: number; qty: number | null; amount_owed: number | null; outcome: string | null; remaining: number | null }>;
  events: ClaimEvent[];
  /** Placeholders until commits 6–7 (emails, labels, return tracking): what this claim has linked today. */
  linked: {
    documents: Array<{ id: number; type: string; file_name: string; drive_file_id: string | null }>;
    tracking: Array<{ id: number; carrier: string | null; tracking_number: string | null; direction: string | null; status: string | null; carrier_status?: string | null; delivered_at?: string | null }>;
    /** The PO's inbound tracking (not only the claim's own rows) and the Velocity order(s) of the claim's ASIN row (§5 Linked). */
    po_tracking: Array<{ id: number; carrier: string | null; tracking_number: string | null; carrier_status: string | null; delivered_at: string | null }>;
    velocity: Array<{ velocity_order_id: string; asin: string }>;
    po_received_individual: number | null;
  };
}

export async function claimDetail(query: QueryLike, id: number, now = new Date()): Promise<ClaimDetail | null> {
  const [c] = await loadClaims(query, { ids: [id] });
  if (!c) return null;
  const claim = rowOf(c, now);
  const po = (await query(`SELECT id, order_id, supplier, order_date::text AS order_date, ships_to, closed_at::text AS closed_at, alt_order_ids FROM purchase_orders WHERE id = $1`, [c.po_id])).rows[0];
  const payments = (await query(`SELECT id, method, nickname, last4, amount FROM po_payments WHERE po_id = $1 ORDER BY position, id`, [c.po_id])).rows.map((p: any) => ({ ...p, id: Number(p.id) }));
  const refunds = (await query(`SELECT id, amount, method, refunded_at::text AS refunded_at, note, po_line_item_id FROM po_line_refunds WHERE po_id = $1 ORDER BY refunded_at NULLS LAST, id`, [c.po_id])).rows.map((r: any) => ({ ...r, id: Number(r.id) }));
  const others = (await loadClaims(query, { poId: String(c.po_id) })).filter((o) => o.id !== id && isSplitTarget(o)).map((o) => ({ id: o.id, kind: o.kind, asin: o.asin, line_no: o.line_no, qty: o.qty, amount_owed: o.amount_owed, outcome: o.outcome, remaining: o.remaining }));
  const documents = (await query(`SELECT id, type, file_name, drive_file_id FROM po_documents WHERE claim_id = $1 ORDER BY id`, [id])).rows.map((d: any) => ({ ...d, id: Number(d.id) }));
  const tracking = (await query(`SELECT id, carrier, tracking_number, direction, status, carrier_status, delivered_at::text AS delivered_at FROM po_tracking WHERE claim_id = $1 ORDER BY id`, [id])).rows.map((t: any) => ({ ...t, id: Number(t.id) }));
  const poTracking = (await query(`SELECT id, carrier, tracking_number, carrier_status, delivered_at::text AS delivered_at FROM po_tracking WHERE po_id = $1 AND direction = 'inbound' AND tracking_number NOT LIKE 'email:%' ORDER BY id`, [c.po_id])).rows.map((t: any) => ({ ...t, id: Number(t.id) }));
  const velocity = c.po_line_item_id
    ? (await query(`SELECT v.velocity_order_id, pa.asin FROM velocity_order_links v JOIN po_asins pa ON pa.id = v.po_asin_id JOIN po_line_items l ON l.po_asin_id = pa.id WHERE l.id = $1`, [c.po_line_item_id])).rows
    : (await query(`SELECT v.velocity_order_id, pa.asin FROM velocity_order_links v JOIN po_asins pa ON pa.id = v.po_asin_id WHERE pa.po_id = $1`, [c.po_id])).rows;
  const received = (await query(`SELECT COALESCE(SUM(received_velocity_individual), 0) AS n FROM po_asin_expected WHERE po_id = $1`, [c.po_id])).rows[0];
  return { claim, po: { ...po, id: String(po.id), payments, refunds }, other_open_claims: others, events: await loadClaimEvents(query, id), linked: { documents, tracking, po_tracking: poTracking, velocity, po_received_individual: received ? Number(received.n) : null } };
}

export const CLAIM_KIND_FILTERS: readonly string[] = CLAIM_KINDS;

/** A refund-split target (Maria 2026-11-12): an open claim with a quantity whose outcome is a refund / credit or not set yet — never a converted empty claim, never a replacement / write-off. */
export const isSplitTarget = (o: { status: string; qty: number | null; outcome: string | null }): boolean =>
  o.status === "open" && o.qty != null && (o.outcome == null || (REFUND_OUTCOMES as readonly string[]).includes(o.outcome));
