// Supplier claims (SPEC §22 "Supplier claims", docs/claude_spec-patch-supplier-claims.md, migration 101;
// commit 1). One record per supplier problem on a PO line — missing, damaged, wrong item, expired, never
// received, can't sell, canceled, returned — carrying the $ owed (D1). Replaces server/po-defects.ts (094).
//
//   qty is INDIVIDUAL units (D16 / D17), stored, never derived from Ordered − Received.
//   $ owed = qty × the line's sourcing cost per Individual unit while amount_owed_source = 'auto'; a typed
//   amount is 'manual' and never recalculated (§3.7). remaining = owed − Σ refunds applied.
//   status suggested | open | closed | dismissed; an OPEN claim keeps its PO open (D15, po-close.ts).
//   outcome refund_card | gift_card | store_credit — closes by itself when the applied refunds cover the $
//   owed; replacement — closes when marked arrived; write_off — closes at once, a reason required.
//   Every manual step is a task (supplier_claim_tasks, §3.3): contact_supplier on a new claim, refund_received when the
//   supplier confirms a refund / credit (D6's second tick — not at Set outcome, Maria 2026-11-11), follow_up_supplier / check_on_it from the 5-business-day timer (server/claim-buckets.ts),
//   enter_quantity on a converted badge. Ticking a task (doneTask) records what the tick means — the report date and
//   channel, the reship order #, the refund row — and the bucket (derived, shared/claim-bucket.ts) moves on.
//   Every change is a History row (po_edit_log, entity 'claim') and an event (supplier_claim_events).
import type { QueryLike } from "./scheduler/types";
import { EditError, logEdits } from "./po-edit";
import { isReported } from "@shared/claim-bucket";
import { addMoneyRow } from "./po-money-edit";
import { addBusinessDays, BUSINESS_DAYS } from "@shared/claim-bucket";
import { CLAIM_KINDS, CLAIM_KIND_LABELS, CLAIM_OUTCOMES, CLAIM_TASK_KINDS, REFUND_OUTCOMES, claimAmount, claimMoney, type ClaimKind, type ClaimOutcome, type ClaimTaskKind, CLAIM_TASK_GROUP } from "@shared/supplier-claim";

export { OPEN_CLAIM_ASIN_SQL, OPEN_CLAIM_PO_SQL, OPEN_CLAIM_LINE_SQL, OPEN_CLAIM_COUNT_PO_SQL, REFUNDS_DUE_PO_SQL, REFUNDS_DUE_EXISTS_SQL, CLAIM_REMAINING_SQL } from "./supplier-claim-sql";

export interface ClaimRow {
  id: number; po_id: string; po_line_item_id: string | null; kind: ClaimKind; /** Individual units; NULL = not known yet (a converted badge, a sheet-zeroed line) — counts toward nothing. */ qty: number | null; amount_owed: number | null; amount_owed_source: "auto" | "manual";
  status: "suggested" | "open" | "closed" | "dismissed"; outcome: ClaimOutcome | null; outcome_amount: number | null; outcome_detail: string | null; write_off_reason: string | null;
  found_at: string; found_by: string; reported_at: string | null; reported_channel: string | null; supplier_confirmed_at: string | null; last_supplier_reply_at: string | null; closed_at: string | null; note: string | null;
  replacement_qty: number | null; replacement_shipped_at: string | null; replacement_arrived_at: string | null; return_required: boolean; qty_disposed: number | null;
  /** The PO (for the Claims page rows): supplier, order #, date, destination, whether closed, the alternate order #s. */
  supplier: string; order_id: string; order_date: string; ships_to: string | null; po_closed_at: string | null; alt_order_ids: string | null;
  asin: string | null; product_name: string | null; line_no: number;
  /** The line's Ordered in the claim's unit (Individual; a legacy line's Product units) — the row's "2 of 24"; null for a whole-PO claim. */
  ordered: number | null;
  /** The line's packs, for the Product / ASIN equivalents of the Individual qty (NULL when not known). */
  product_pack: number | null; asin_pack: number | null; qty_basis: string | null;
  refunds: Array<{ id: number; amount: number | null; amount_applied: number | null; refunded_at: string | null; method: string | null }>;
  tasks: Array<{ id: number; kind: ClaimTaskKind; group: string; reason: string | null; created_at: string; due_at: string | null; done_at: string | null; snoozed_until: string | null }>;
  /** Migration 101's conversion flags (supplier_claim_conversions), e.g. canceled_no_ordered_qty, qty_unknown, kind_unclear; empty for a claim made by hand. */
  conversion_flags: string[];
  owed: number | null; remaining: number | null; received: number;
}

const num = (v: unknown) => (v == null ? null : Number(v));
const money = (v: number | null) => (v == null ? "—" : `$${v.toFixed(2)}`);
const describe = (d: { qty: number | string | null; kind: string; amount_owed: number | string | null }) => `${d.qty == null ? "? " : `${Number(d.qty)} `}${CLAIM_KIND_LABELS[d.kind as ClaimKind] ?? d.kind} × ${money(num(d.amount_owed))}`;

/** The line's 1-based number within its ASIN row (position order) — how the UI and the scripts name a line. */
const LINE_NO_SQL = (l: string) => `(SELECT COUNT(*)::int FROM po_line_items s WHERE s.po_asin_id IS NOT DISTINCT FROM ${l}.po_asin_id AND s.po_id = ${l}.po_id
  AND (COALESCE(s.position, 0), s.id) <= (COALESCE(${l}.position, 0), ${l}.id))`;

export async function loadClaims(query: QueryLike, where: { poId?: string; ids?: number[]; /** every claim (the Claims page) */ all?: boolean }): Promise<ClaimRow[]> {
  const cond = where.all ? `TRUE` : where.ids ? `c.id = ANY($1::bigint[])` : `c.po_id = $1`;
  const params = where.all ? [] : [where.ids ?? where.poId];
  const rows = (await query(
    `SELECT c.*, c.found_at::text AS found_at, c.reported_at::text AS reported_at, c.closed_at::text AS closed_at,
            c.supplier_confirmed_at::text AS supplier_confirmed_at, c.last_supplier_reply_at::text AS last_supplier_reply_at,
            c.replacement_shipped_at::text AS replacement_shipped_at, c.replacement_arrived_at::text AS replacement_arrived_at,
            p.supplier, p.order_id, p.order_date::text AS order_date, p.ships_to, p.closed_at::text AS po_closed_at, p.alt_order_ids,
            pa.asin, l.product_name, CASE WHEN l.id IS NULL THEN 0 ELSE ${LINE_NO_SQL("l")} END AS line_no,
            l.retailer_units_per_product AS product_pack, COALESCE(pa.units_per_pack, l.asin_units_per_pack) AS asin_pack, l.qty_basis,
            CASE WHEN l.qty_basis = 'product_legacy' THEN le.ordered_product ELSE le.ordered_individual END AS ordered,
            COALESCE((SELECT json_agg(json_build_object('id', r.id, 'amount', r.amount, 'amount_applied', x.amount_applied, 'refunded_at', r.refunded_at, 'method', r.method) ORDER BY r.id)
                        FROM supplier_claim_refunds x JOIN po_line_refunds r ON r.id = x.po_line_refund_id WHERE x.claim_id = c.id), '[]') AS refunds,
            COALESCE((SELECT json_agg(json_build_object('id', t.id, 'kind', t.kind, 'group', t."group", 'reason', t.reason, 'created_at', t.created_at, 'due_at', t.due_at, 'done_at', t.done_at, 'snoozed_until', t.snoozed_until) ORDER BY t.id)
                        FROM supplier_claim_tasks t WHERE t.claim_id = c.id), '[]') AS tasks,
            COALESCE((SELECT array_agg(DISTINCT f) FROM supplier_claim_conversions k, unnest(k.flags) f WHERE k.claim_id = c.id), '{}') AS conversion_flags
       FROM supplier_claims c JOIN purchase_orders p ON p.id = c.po_id LEFT JOIN po_line_items l ON l.id = c.po_line_item_id LEFT JOIN po_asins pa ON pa.id = l.po_asin_id
            LEFT JOIN po_line_expected le ON le.line_id = l.id
      WHERE ${cond} ORDER BY c.found_at, c.id`, params,
  )).rows as any[];
  return rows.map((r) => {
    const refunds = (r.refunds ?? []).map((x: any) => ({ id: Number(x.id), amount: num(x.amount), amount_applied: num(x.amount_applied), refunded_at: x.refunded_at ?? null, method: x.method ?? null }));
    const m = claimMoney(r.amount_owed, refunds);
    return { ...r, id: Number(r.id), qty: num(r.qty), amount_owed: num(r.amount_owed), conversion_flags: r.conversion_flags ?? [], outcome_amount: num(r.outcome_amount), replacement_qty: num(r.replacement_qty), qty_disposed: num(r.qty_disposed),
      product_pack: num(r.product_pack), asin_pack: num(r.asin_pack), ordered: num(r.ordered), line_no: Number(r.line_no), refunds, tasks: (r.tasks ?? []).map((t: any) => ({ ...t, id: Number(t.id) })),
      owed: m.owed, remaining: m.remaining, received: m.received };
  });
}

/** The chip / hover form of open claims: what the list rows carry. */
export interface OpenClaimBrief { id: number; po_line_item_id: string | null; asin: string | null; line_no: number; kind: string; qty: number | null; amount_owed: number | null; remaining: number | null; note: string | null; status: string; outcome: string | null; open_tasks: number }
export const briefOf = (d: ClaimRow): OpenClaimBrief => ({ id: d.id, po_line_item_id: d.po_line_item_id, asin: d.asin, line_no: d.line_no, kind: d.kind, qty: d.qty, amount_owed: d.amount_owed, remaining: d.remaining, note: d.note, status: d.status, outcome: d.outcome, open_tasks: d.tasks.filter((t) => t.done_at == null).length });

/** Per ASIN row / per PO: the open claims (the chip text / hover; the POs list's Claims column in commit 2). */
export async function loadOpenClaimSummaries(query: QueryLike, poIds: readonly string[]): Promise<{ byPo: Map<string, ClaimRow[]>; byAsinRow: Map<string, ClaimRow[]> }> {
  const byPo = new Map<string, ClaimRow[]>(), byAsinRow = new Map<string, ClaimRow[]>();
  if (poIds.length === 0) return { byPo, byAsinRow };
  const ids = (await query(`SELECT id FROM supplier_claims WHERE po_id = ANY($1::uuid[]) AND status = 'open'`, [poIds])).rows.map((r: any) => Number(r.id));
  if (ids.length === 0) return { byPo, byAsinRow };
  const rows = await loadClaims(query, { ids });
  const lineIds = rows.map((r) => r.po_line_item_id).filter((x): x is string => x != null);
  const asinRow = new Map<string, string>(lineIds.length ? ((await query(`SELECT id, po_asin_id FROM po_line_items WHERE id = ANY($1::uuid[])`, [lineIds])).rows as any[]).map((r) => [String(r.id), String(r.po_asin_id)]) : []);
  for (const r of rows) {
    const k = String(r.po_id); if (!byPo.has(k)) byPo.set(k, []); byPo.get(k)!.push(r);
    const a = r.po_line_item_id ? asinRow.get(String(r.po_line_item_id)) : null; if (a) { if (!byAsinRow.has(a)) byAsinRow.set(a, []); byAsinRow.get(a)!.push(r); }
  }
  return { byPo, byAsinRow };
}

async function lineOf(query: QueryLike, poId: string, lineId: string) {
  const l = (await query(
    `SELECT l.id, l.qty_basis, l.price, l.adjusted_product_cost, l.retailer_units_per_product, le.ordered_individual, le.ordered_product, p.subtotal, p.discount, p.tax, p.sh_donations
       FROM po_line_items l JOIN po_line_expected le ON le.line_id = l.id JOIN purchase_orders p ON p.id = l.po_id WHERE l.id = $1 AND l.po_id = $2`, [lineId, poId])).rows[0];
  if (!l) throw new EditError(400, "po_line_item_id must be a product line of this PO");
  return l;
}
/** The line's auto $ owed for a qty (Individual units; a legacy line's qty is Product units, so its pack is 1 there). */
function autoAmount(line: any, qty: number): number | null {
  return claimAmount({ qty, productPack: line.qty_basis === "product_legacy" ? 1 : line.retailer_units_per_product, adjustedProductCost: line.adjusted_product_cost, price: line.price, subtotal: line.subtotal, discount: line.discount, tax: line.tax, shipping: line.sh_donations });
}

const qtyOf = (v: unknown): number => {
  const q = Number(v);
  if (!Number.isFinite(q) || q <= 0 || Math.round(q * 100) !== q * 100) throw new EditError(400, "qty must be a positive number (Individual units, up to 2 decimals)");
  return q;
};
const amountOf = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const a = Number(v);
  if (!Number.isFinite(a) || a < 0) throw new EditError(400, "amount must be a non-negative number");
  return Math.round(a * 100) / 100;
};
const kindOf = (v: unknown): ClaimKind => {
  const k = String(v ?? "").trim().replace(/[ -]/g, "_") as ClaimKind;
  if (!(CLAIM_KINDS as readonly string[]).includes(k)) throw new EditError(400, `kind must be one of ${CLAIM_KINDS.join(", ")}`);
  return k;
};
const dateOf = (v: unknown, field: string): string => { if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) throw new EditError(400, `${field} must be YYYY-MM-DD`); return String(v); };

async function event(query: QueryLike, claimId: number, type: string, summary: string | null, by: number | null, refs: { po_line_refund_id?: number } = {}): Promise<void> {
  await query(`INSERT INTO supplier_claim_events (claim_id, type, summary, by, po_line_refund_id) VALUES ($1, $2, $3, $4, $5)`, [claimId, type, summary, by, refs.po_line_refund_id ?? null]);
}
export interface ClaimEvent { id: number; at: string; type: string; summary: string | null; by: number | null; by_name: string | null; po_line_refund_id: number | null; po_document_id: number | null; po_tracking_id: number | null }
/** The timeline (§4.3), oldest first. */
export async function loadClaimEvents(query: QueryLike, claimId: number): Promise<ClaimEvent[]> {
  return ((await query(`SELECT e.id, e.at, e.type, e.summary, e.by, u.display_name AS by_name, e.po_line_refund_id, e.po_document_id, e.po_tracking_id
                           FROM supplier_claim_events e LEFT JOIN users u ON u.id = e.by WHERE e.claim_id = $1 ORDER BY e.at, e.id`, [claimId])).rows as any[])
    .map((e) => ({ ...e, id: Number(e.id), at: e.at instanceof Date ? e.at.toISOString() : String(e.at), by: e.by == null ? null : Number(e.by), po_line_refund_id: e.po_line_refund_id == null ? null : Number(e.po_line_refund_id), po_document_id: e.po_document_id == null ? null : Number(e.po_document_id), po_tracking_id: e.po_tracking_id == null ? null : Number(e.po_tracking_id) }));
}
/** One open task per kind per claim (the unique index); re-adding an open one is a no-op. */
export async function addTask(query: QueryLike, claimId: number, kind: ClaimTaskKind, reason: string | null = null, qty: number | null = null): Promise<void> {
  await query(`INSERT INTO supplier_claim_tasks (claim_id, kind, "group", reason, qty) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (claim_id, kind) WHERE done_at IS NULL DO NOTHING`, [claimId, kind, CLAIM_TASK_GROUP[kind], reason, qty]);
}
/** What a tick carries (§3.3 "Ticking it"): the report's date / channel / note, the reship order #, a suggestion's decision. */
export interface DoneTaskBody { date?: string | null; channel?: string | null; note?: string | null; alt_order_id?: string | null; decision?: "open" | "dismiss" | null; reason?: string | null }

/**
 * Tick a task. contact_supplier / follow_up_supplier record the report (date, channel, note → reported_at / reported_channel,
 * event `reported`); confirm_reship_order adds the order # to the PO's alt_order_ids; review_suggestion opens or dismisses
 * the claim; refund_received must go through addRefundReceived (the refund row IS the tick); replacement_arrived through
 * setOutcome; enter_quantity through editClaim. Every other kind is a plain tick with its event.
 */
export async function doneTask(query: QueryLike, taskId: number, userId: number | null, body: DoneTaskBody = {}): Promise<{ id: number; claim_id: number; po_id: string }> {
  const t = (await query(`SELECT t.id, t.claim_id, t.kind, t.done_at, c.po_id, c.qty, c.status, c.reported_at FROM supplier_claim_tasks t JOIN supplier_claims c ON c.id = t.claim_id WHERE t.id = $1`, [taskId])).rows[0];
  if (!t) throw new EditError(404, "task not found");
  const claimId = Number(t.claim_id), poId = String(t.po_id), kind = String(t.kind) as ClaimTaskKind;
  if (t.done_at) return { id: Number(t.id), claim_id: claimId, po_id: poId };
  // "Enter quantity" is done by typing the quantity on the claim (editClaim closes it), never by a tick.
  if (kind === "enter_quantity" && t.qty == null) throw new EditError(400, "type the claim's quantity (Individual units) — that completes Enter quantity");
  if (kind === "refund_received") throw new EditError(400, "add the refund row (Refund received) — that is the tick");
  if (kind === "replacement_arrived") { await setOutcome(query, claimId, { outcome: "replacement", arrived: true }, userId); return { id: Number(t.id), claim_id: claimId, po_id: poId }; }
  if (kind === "review_suggestion") {
    if (body.decision === "dismiss") { await dismissClaim(query, claimId, userId, body.reason ?? null); return { id: Number(t.id), claim_id: claimId, po_id: poId }; }
    if (body.decision !== "open") throw new EditError(400, "decision must be open or dismiss");
    await query(`UPDATE supplier_claims SET status = 'open', updated_at = now() WHERE id = $1 AND status = 'suggested'`, [claimId]);
    await event(query, claimId, "opened", "suggestion accepted", userId);
    // a canceled claim is confirmed already (its cancel date): the passive Refund received tick, never a report prompt (paths, Maria 2026-11-12)
    const opened = (await query(`SELECT kind FROM supplier_claims WHERE id = $1`, [claimId])).rows[0];
    if (opened?.kind === "canceled") await addTask(query, claimId, "refund_received", "canceled — tick when the refund posts (add the refund row)");
    else await addContactTaskIfUnreported(query, claimId, "a claim was opened — report it to the supplier");
  }
  await query(`UPDATE supplier_claim_tasks SET done_at = now(), done_by = $2 WHERE id = $1 AND done_at IS NULL`, [taskId, userId]);
  const changes: Array<{ field: string; old: string | null; new: string | null }> = [{ field: `task ${kind}`, old: "open", new: "done" }];
  if (kind === "contact_supplier" || kind === "follow_up_supplier") {
    const date = body.date && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : new Date().toISOString().slice(0, 10);
    const channel = String(body.channel ?? "").trim() || null;
    if (kind === "contact_supplier" || !t.reported_at) {
      await query(`UPDATE supplier_claims SET reported_at = COALESCE(reported_at, $2::date), reported_channel = COALESCE($3, reported_channel), updated_at = now() WHERE id = $1`, [claimId, date, channel]);
      changes.push({ field: "claim reported_at", old: t.reported_at ? String(t.reported_at).slice(0, 10) : null, new: date });
    }
    const note = String(body.note ?? "").trim() || null;
    await event(query, claimId, kind === "contact_supplier" ? "reported" : "followed_up", [channel, date, note].filter(Boolean).join(" · ") || null, userId);
  } else if (kind === "confirm_reship_order") {
    const alt = String(body.alt_order_id ?? "").trim();
    if (!alt) throw new EditError(400, "the reship order # is required");
    const po = (await query(`SELECT alt_order_ids FROM purchase_orders WHERE id = $1`, [poId])).rows[0];
    const have = String(po?.alt_order_ids ?? "").split(/[\s,;/]+/).filter(Boolean);
    if (!have.includes(alt)) {
      const next = [...have, alt].join(", ");
      await query(`UPDATE purchase_orders SET alt_order_ids = $2, updated_at = now() WHERE id = $1`, [poId, next]);
      await logEdits(query, poId, userId, "po", poId, [{ field: "alt_order_ids", old: po?.alt_order_ids ?? null, new: next }]);
    }
    await event(query, claimId, "reship_confirmed", alt, userId);
  } else if (kind === "check_on_it") {
    await event(query, claimId, "checked", body.note?.trim() || "checked — timer restarted", userId);
  } else {
    await event(query, claimId, "task_done", `${kind}${body.note?.trim() ? `: ${body.note.trim()}` : ""}`, userId);
  }
  await logEdits(query, poId, userId, "claim", String(claimId), changes);
  return { id: Number(t.id), claim_id: claimId, po_id: poId };
}

/**
 * "Contacted supplier" on a claim (Maria 2026-11-12): records the report (date, channel, note → reported_at /
 * reported_channel, event `reported`) through the claim's contact_supplier task — created on the spot when the claim
 * has none (a converted claim) — so the Reported step ticks and the timer starts from that date (shared/claim-bucket.ts).
 */
export async function recordContact(query: QueryLike, id: number, body: DoneTaskBody, userId: number | null): Promise<{ id: number; po_id: string }> {
  const d = await claimRow(query, id);
  if (d.status !== "open") throw new EditError(400, "only an open claim can be reported");
  let t = (await query(`SELECT id FROM supplier_claim_tasks WHERE claim_id = $1 AND kind = 'contact_supplier' AND done_at IS NULL LIMIT 1`, [id])).rows[0];
  if (!t) {
    await addTask(query, id, "contact_supplier", "report the claim to the supplier — the timer starts from the report date");
    t = (await query(`SELECT id FROM supplier_claim_tasks WHERE claim_id = $1 AND kind = 'contact_supplier' AND done_at IS NULL LIMIT 1`, [id])).rows[0];
  }
  await doneTask(query, Number(t.id), userId, body);
  return { id, po_id: String(d.po_id) };
}

/**
 * "Supplier replied" (§5 amended 2026-11-12): one entry per reply — date, how, the summary; sets `last_supplier_reply_at`
 * (the timer restarts from it), writes the `supplier_reply` event and a History row, closes an open Follow up / Check on
 * it (the reply is the answer). With an outcome the reply told → setOutcome; without → a confirm_outcome task carrying
 * the summary (Needs attention › Decide, "Supplier replied 11/2: … → outcome?").
 */
export interface ReplyBody { date?: string | null; channel?: string | null; summary?: string | null; outcome?: string | null; amount?: number | string | null; detail?: string | null }
export async function recordReply(query: QueryLike, id: number, body: ReplyBody, userId: number | null): Promise<{ id: number; po_id: string }> {
  const d = await claimRow(query, id);
  if (d.status !== "open" && d.status !== "suggested") throw new EditError(400, "only an open claim can take a supplier reply");
  const date = body.date && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : new Date().toISOString().slice(0, 10);
  const channel = String(body.channel ?? "").trim() || null;
  const summary = String(body.summary ?? "").trim() || null;
  const at = `${date}T12:00:00Z`;
  await query(`UPDATE supplier_claims SET last_supplier_reply_at = $2, status = CASE WHEN status = 'suggested' THEN 'open' ELSE status END, updated_at = now() WHERE id = $1`, [id, at]);
  await query(`UPDATE supplier_claim_tasks SET done_at = now(), done_by = $2 WHERE claim_id = $1 AND done_at IS NULL AND kind IN ('follow_up_supplier', 'check_on_it', 'confirm_outcome')`, [id, userId]);
  await event(query, id, "supplier_reply", [channel, date, summary].filter(Boolean).join(" · ") || null, userId);
  await logEdits(query, String(d.po_id), userId, "claim", String(id), [{ field: "supplier replied", old: d.last_supplier_reply_at ? String(d.last_supplier_reply_at).slice(0, 10) : null, new: `${date}${channel ? ` · ${channel}` : ""}${summary ? ` · ${summary}` : ""}` }]);
  const outcome = String(body.outcome ?? "").trim();
  if (outcome) {
    if (outcome === "write_off") await setOutcome(query, id, { outcome: "write_off", reason: summary ?? "the supplier declined" }, userId);
    else if (outcome === "replacement") await setOutcome(query, id, { outcome: "replacement" }, userId);
    else await setOutcome(query, id, { outcome: outcome as "refund_card", amount: body.amount ?? null, detail: body.detail ?? null }, userId);
  } else if (!d.outcome) {
    const md = `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
    await addTask(query, id, "confirm_outcome", `Supplier replied ${md}${summary ? `: "${summary}"` : ""} → outcome?`);
  }
  return { id, po_id: String(d.po_id) };
}

/** Clear the outcome (§5: "not known yet" until set, clearable): back to open with no outcome and no confirmation (a confirmation is of an outcome), the passive ticks it opened removed, event + History row. */
export async function clearOutcome(query: QueryLike, id: number, reason: string | null, userId: number | null): Promise<{ id: number; po_id: string }> {
  const d = await claimRow(query, id);
  if (!d.outcome) return { id, po_id: String(d.po_id) };
  if (d.status === "closed" && d.outcome === "write_off") throw new EditError(400, "a written-off claim is closed — Reopen it first");
  await query(`UPDATE supplier_claims SET outcome = NULL, outcome_amount = NULL, outcome_detail = NULL, replacement_qty = NULL, replacement_shipped_at = NULL, replacement_arrived_at = NULL, supplier_confirmed_at = NULL,
                 status = CASE WHEN status = 'closed' THEN 'open' ELSE status END, closed_at = CASE WHEN status = 'closed' THEN NULL ELSE closed_at END, updated_at = now() WHERE id = $1`, [id]);
  await query(`DELETE FROM supplier_claim_tasks WHERE claim_id = $1 AND done_at IS NULL AND kind IN ('refund_received', 'replacement_arrived')`, [id]);
  await event(query, id, "outcome_set", `outcome cleared — was ${d.outcome}${reason ? ` · ${reason}` : ""}`, userId);
  await logEdits(query, String(d.po_id), userId, "claim", String(id), [{ field: "claim outcome", old: String(d.outcome), new: reason ? `cleared: ${reason}` : null }]);
  return { id, po_id: String(d.po_id) };
}

/**
 * Edit a timeline entry in place (§5: every entry editable): its summary and / or its time. A dated fact's event moves the
 * fact with it — `reported` → reported_at, `supplier_reply` → last_supplier_reply_at, `supplier_confirmed` →
 * supplier_confirmed_at (the timer restarts from the latest). History row on the claim.
 */
export async function editEvent(query: QueryLike, eventId: number, body: { at?: string | null; summary?: string | null }, userId: number | null): Promise<{ id: number; claim_id: number; po_id: string }> {
  const e = (await query(`SELECT e.id, e.claim_id, e.type, e.summary, e.at, c.po_id FROM supplier_claim_events e JOIN supplier_claims c ON c.id = e.claim_id WHERE e.id = $1`, [eventId])).rows[0];
  if (!e) throw new EditError(404, "timeline entry not found");
  const changes: Array<{ field: string; old: string | null; new: string | null }> = [];
  if (body.summary !== undefined) {
    const summary = String(body.summary ?? "").trim() || null;
    await query(`UPDATE supplier_claim_events SET summary = $2 WHERE id = $1`, [eventId, summary]);
    changes.push({ field: `timeline ${e.type}`, old: e.summary ?? null, new: summary });
  }
  if (body.at) {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(body.at) ? body.at : null;
    if (!date) throw new EditError(400, "the date must be YYYY-MM-DD");
    await query(`UPDATE supplier_claim_events SET at = $2::timestamptz WHERE id = $1`, [eventId, `${date}T12:00:00Z`]);
    changes.push({ field: `timeline ${e.type} date`, old: e.at ? new Date(e.at).toISOString().slice(0, 10) : null, new: date });
    if (e.type === "reported") await query(`UPDATE supplier_claims SET reported_at = $2::date, updated_at = now() WHERE id = $1`, [e.claim_id, date]);
    if (e.type === "supplier_reply") await query(`UPDATE supplier_claims SET last_supplier_reply_at = $2::timestamptz, updated_at = now() WHERE id = $1`, [e.claim_id, `${date}T12:00:00Z`]);
    if (e.type === "supplier_confirmed") await query(`UPDATE supplier_claims SET supplier_confirmed_at = $2::timestamptz, updated_at = now() WHERE id = $1`, [e.claim_id, `${date}T12:00:00Z`]);
    if (e.type === "found" || e.type === "opened") await query(`UPDATE supplier_claims SET found_at = $2::date, updated_at = now() WHERE id = $1`, [e.claim_id, date]);
  }
  if (changes.length) await logEdits(query, String(e.po_id), userId, "claim", String(e.claim_id), changes);
  return { id: eventId, claim_id: Number(e.claim_id), po_id: String(e.po_id) };
}

/** The timeline entries "Remove this entry" undoes (Maria 2026-11-12): the fact each one records goes with it. */
export const REMOVABLE_EVENT_TYPES = ["reported", "followed_up", "checked", "supplier_reply", "supplier_confirmed", "refund_received", "outcome_set", "task_done", "timed_out"] as const;

/**
 * Remove a timeline entry and undo the fact it set (Maria 2026-11-12). `reported` → reported_at / reported_channel cleared
 * (or back to the earliest remaining report) and the Contacted tick re-opened; `supplier_reply` → last_supplier_reply_at back
 * to the latest remaining reply (or cleared), the Confirm outcome task the reply opened removed and the tasks the reply
 * closed re-opened; `supplier_confirmed` → supplier_confirmed_at cleared, the Refund received tick it opened removed;
 * `refund_received` → the refund row unlinked, and deleted when nothing else links to it; the claim it closed opens again
 * and its Refund received tick re-opens (the Closed / Refund short entries of that refund go with it); `outcome_set` → the
 * outcome back to the latest remaining one or "not known yet" (a written-off claim reopens) — refused while a confirmation
 * stands, since a confirmation is of an outcome; `followed_up` / `checked` / `task_done` → the tick re-opened; `timed_out`
 * → the task it created removed while still open. The timer is derived from the facts, so it re-derives by itself. One
 * History row on the claim, no event (the timeline is back to what it was).
 */
export async function removeEvent(query: QueryLike, eventId: number, userId: number | null): Promise<{ id: number; claim_id: number; po_id: string }> {
  const e = (await query(`SELECT e.id, e.claim_id, e.type, e.summary, e.at, e.at::text AS at_text, e.po_line_refund_id, c.po_id FROM supplier_claim_events e JOIN supplier_claims c ON c.id = e.claim_id WHERE e.id = $1`, [eventId])).rows[0];
  if (!e) throw new EditError(404, "timeline entry not found");
  // at_text keeps the microseconds (a JS Date drops them): the tasks this entry's action ticked share its timestamp exactly
  const claimId = Number(e.claim_id), poId = String(e.po_id), type = String(e.type), at: string = e.at instanceof Date ? e.at.toISOString() : String(e.at), atText = String(e.at_text);
  if (!(REMOVABLE_EVENT_TYPES as readonly string[]).includes(type)) throw new EditError(400, "this entry records the claim's own state — change it on the claim (More, the outcome, the fields), not by removing the entry");
  const d = await claimRow(query, claimId);
  if (d.status === "dismissed") throw new EditError(400, "reopen the claim first");
  // the tasks this entry's action ticked share its timestamp (now() is one value per transaction): re-open them
  const untick = (kinds: readonly string[]) => query(`UPDATE supplier_claim_tasks SET done_at = NULL, done_by = NULL WHERE claim_id = $1 AND done_at = $2::timestamptz AND kind = ANY($3::text[])
        AND NOT EXISTS (SELECT 1 FROM supplier_claim_tasks o WHERE o.claim_id = $1 AND o.kind = supplier_claim_tasks.kind AND o.done_at IS NULL)`, [claimId, atText, kinds]);
  const remaining = async (t: string) => (await query(`SELECT id, at, summary FROM supplier_claim_events WHERE claim_id = $1 AND type = $2 AND id <> $3 ORDER BY at, id`, [claimId, t, eventId])).rows as Array<{ id: number; at: Date | string; summary: string | null }>;
  const stamp = (v: Date | string) => (v instanceof Date ? v.toISOString() : String(v));
  // a report's / reply's own date is in its summary ("email · 2026-11-03 · note"); the entry's time is when it was typed
  const dateOfEntry = (x: { at: Date | string; summary: string | null }) => /\b(\d{4}-\d{2}-\d{2})\b/.exec(String(x.summary ?? ""))?.[1] ?? stamp(x.at).slice(0, 10);
  const changes: Array<{ field: string; old: string | null; new: string | null }> = [{ field: `timeline ${type} removed`, old: `${at.slice(0, 10)}${e.summary ? ` · ${e.summary}` : ""}`, new: null }];
  if (type === "outcome_set" && d.supplier_confirmed_at) throw new EditError(400, "remove the Confirmed by supplier entry first — a confirmation is of an outcome");
  if (type === "outcome_set" && /^outcome cleared/.test(String(e.summary ?? ""))) throw new EditError(400, "a cleared outcome is not undone by removing the note — set the outcome again");
  await query(`DELETE FROM supplier_claim_events WHERE id = $1`, [eventId]);
  if (type === "reported") {
    const rest = await remaining("reported");
    const first = rest[0] ? dateOfEntry(rest[0]) : null;
    // the remaining first report's channel is its summary's first part ("email · 2026-11-03 · note"); none → the channel stays
    const head = rest[0] ? String(rest[0].summary ?? "").split(" · ")[0].trim() : "";
    const channel = !first ? null : head && !/^\d{4}-\d{2}-\d{2}$/.test(head) ? head : d.reported_channel;
    await query(`UPDATE supplier_claims SET reported_at = $2::date, reported_channel = $3, updated_at = now() WHERE id = $1`, [claimId, first, channel]);
    changes.push({ field: "claim reported_at", old: d.reported_at ? String(d.reported_at).slice(0, 10) : null, new: first });
    // a second report's Contacted tick (recordContact adds one per report) goes with its entry; the last report's tick re-opens
    if (first) await query(`DELETE FROM supplier_claim_tasks WHERE id = (SELECT id FROM supplier_claim_tasks WHERE claim_id = $1 AND kind = 'contact_supplier' AND done_at = $2::timestamptz ORDER BY id DESC LIMIT 1)
                              AND EXISTS (SELECT 1 FROM supplier_claim_tasks o WHERE o.claim_id = $1 AND o.kind = 'contact_supplier' AND o.done_at IS NOT NULL AND o.id <> supplier_claim_tasks.id)`, [claimId, atText]);
    if (!first) {
      const r = await untick(["contact_supplier"]);
      if (!(r.rowCount ?? 0)) {
        const u = await query(`UPDATE supplier_claim_tasks SET done_at = NULL, done_by = NULL WHERE id = (SELECT id FROM supplier_claim_tasks WHERE claim_id = $1 AND kind = 'contact_supplier' AND done_at IS NOT NULL ORDER BY done_at DESC, id DESC LIMIT 1)
                               AND NOT EXISTS (SELECT 1 FROM supplier_claim_tasks o WHERE o.claim_id = $1 AND o.kind = 'contact_supplier' AND o.done_at IS NULL)`, [claimId]);
        if (!(u.rowCount ?? 0) && d.status === "open") await addContactTaskIfUnreported(query, claimId, "report the claim to the supplier — the timer starts from the report date");
      }
    }
  } else if (type === "supplier_reply") {
    const rest = await remaining("supplier_reply");
    const last = rest.length ? `${dateOfEntry(rest[rest.length - 1])}T12:00:00Z` : null;
    await query(`UPDATE supplier_claims SET last_supplier_reply_at = $2::timestamptz, updated_at = now() WHERE id = $1`, [claimId, last]);
    changes.push({ field: "supplier replied", old: d.last_supplier_reply_at ? String(d.last_supplier_reply_at).slice(0, 10) : null, new: last ? last.slice(0, 10) : null });
    const own = dateOfEntry({ at: e.at, summary: e.summary });
    const replyMd = `${Number(own.slice(5, 7))}/${Number(own.slice(8, 10))}`;
    await query(`DELETE FROM supplier_claim_tasks WHERE claim_id = $1 AND kind = 'confirm_outcome' AND done_at IS NULL AND reason LIKE $2`, [claimId, `Supplier replied ${replyMd}%`]);
    await untick(["follow_up_supplier", "check_on_it", "confirm_outcome"]);
  } else if (type === "supplier_confirmed") {
    const rest = await remaining("supplier_confirmed");
    const last = rest.length ? stamp(rest[rest.length - 1].at) : null;
    await query(`UPDATE supplier_claims SET supplier_confirmed_at = $2::timestamptz, updated_at = now() WHERE id = $1`, [claimId, last]);
    changes.push({ field: "claim supplier_confirmed_at", old: d.supplier_confirmed_at ? String(d.supplier_confirmed_at).slice(0, 10) : null, new: last ? last.slice(0, 10) : null });
    if (!last) await query(`DELETE FROM supplier_claim_tasks WHERE claim_id = $1 AND kind = 'refund_received' AND done_at IS NULL`, [claimId]);
    await untick(["follow_up_supplier", "check_on_it", "confirm_outcome"]);
  } else if (type === "refund_received") {
    const refundId = e.po_line_refund_id == null ? null : Number(e.po_line_refund_id);
    if (refundId != null) {
      const r = (await query(`SELECT amount, method FROM po_line_refunds WHERE id = $1`, [refundId])).rows[0];
      await query(`DELETE FROM supplier_claim_refunds WHERE claim_id = $1 AND po_line_refund_id = $2`, [claimId, refundId]);
      const others = await claimsLinkedTo(query, [refundId]);
      changes.push({ field: "refund unlinked", old: r ? money(num(r.amount)) : String(refundId), new: null });
      if (others.length === 0 && r) {
        await query(`DELETE FROM po_line_refunds WHERE id = $1`, [refundId]);
        await logEdits(query, poId, userId, "po", poId, [{ field: "refund removed", old: `${money(num(r.amount))} (${r.method ?? "refund"}) — the claim's Refund received entry was removed`, new: null }]);
      }
    }
    // the entries that refund wrote after itself (Closed, Refund short) go with it; the claim it closed is open again
    await query(`DELETE FROM supplier_claim_events WHERE claim_id = $1 AND type IN ('closed', 'refund_short') AND at >= $2::timestamptz`, [claimId, at]);
    if (d.status === "closed" && !d.write_off_reason && d.outcome !== "replacement") {
      await query(`UPDATE supplier_claims SET status = 'open', closed_at = NULL, updated_at = now() WHERE id = $1`, [claimId]);
      changes.push({ field: "claim reopened", old: "closed", new: "open: the refund was removed" });
    }
    // a refund arriving stood for the confirmation when there was none: without the refund, no confirmation
    if (d.supplier_confirmed_at && (await remaining("supplier_confirmed")).length === 0) {
      await query(`UPDATE supplier_claims SET supplier_confirmed_at = NULL, updated_at = now() WHERE id = $1`, [claimId]);
      changes.push({ field: "claim supplier_confirmed_at", old: String(d.supplier_confirmed_at).slice(0, 10), new: null });
    } else {
      const u = await untick(["refund_received"]);
      if (!(u.rowCount ?? 0) && d.outcome && (REFUND_OUTCOMES as readonly string[]).includes(String(d.outcome))) await addTask(query, claimId, "refund_received", "tick when the money arrives (add the refund row)");
    }
    await syncRefundCoverage(query, [claimId], userId);
  } else if (type === "outcome_set") {
    const rest = (await remaining("outcome_set")).map((x) => String(x.summary ?? "").split(/[:\s]/)[0]);
    const prev = rest.length ? rest[rest.length - 1] : null;
    const outcome = prev && (CLAIM_OUTCOMES as readonly string[]).includes(prev) && prev !== "write_off" ? prev : null;
    await query(`UPDATE supplier_claims SET outcome = $2, outcome_amount = NULL, outcome_detail = NULL, replacement_qty = NULL, replacement_shipped_at = NULL, replacement_arrived_at = NULL, write_off_reason = NULL,
                   status = CASE WHEN status = 'closed' THEN 'open' ELSE status END, closed_at = CASE WHEN status = 'closed' THEN NULL ELSE closed_at END, updated_at = now() WHERE id = $1`, [claimId, outcome]);
    await query(`DELETE FROM supplier_claim_tasks WHERE claim_id = $1 AND done_at IS NULL AND kind IN ('refund_received', 'replacement_arrived')`, [claimId]);
    await query(`DELETE FROM supplier_claim_events WHERE claim_id = $1 AND type = 'closed' AND at >= $2::timestamptz`, [claimId, at]);
    if (outcome === "replacement") await addTask(query, claimId, "replacement_arrived", "tick when the replacement units arrive");
    changes.push({ field: "claim outcome", old: d.outcome, new: outcome });
  } else if (type === "followed_up") await untick(["follow_up_supplier"]);
  else if (type === "checked") await untick(["check_on_it"]);
  else if (type === "task_done") await untick([String(e.summary ?? "").split(":")[0].trim()]);
  else if (type === "timed_out") await query(`DELETE FROM supplier_claim_tasks WHERE claim_id = $1 AND done_at IS NULL AND kind IN ('follow_up_supplier', 'check_on_it') AND reason = $2`, [claimId, e.summary ?? ""]);
  await logEdits(query, poId, userId, "claim", String(claimId), changes);
  return { id: eventId, claim_id: claimId, po_id: poId };
}

/**
 * Merge a claim into another claim of the same PO (§5 More): the source's refunds and timeline move to the target, the
 * quantities add up when both are known (a manual $ owed adds up too; an auto one re-derives), the source is dismissed
 * with "merged into #N". History rows on both.
 */
export async function mergeClaims(query: QueryLike, fromId: number, intoId: number, userId: number | null): Promise<{ id: number; po_id: string; merged_from: number }> {
  if (fromId === intoId) throw new EditError(400, "pick another claim of this PO");
  const from = await claimRow(query, fromId), into = await claimRow(query, intoId);
  if (String(from.po_id) !== String(into.po_id)) throw new EditError(400, "both claims must be on the same PO");
  if (into.status === "dismissed" || from.status === "dismissed") throw new EditError(400, "a dismissed claim cannot be merged");
  const qty = from.qty != null && into.qty != null ? Number(from.qty) + Number(into.qty) : into.qty == null ? from.qty : into.qty;
  const edits: Record<string, unknown> = {};
  if (qty !== into.qty) edits.qty = qty;
  if (into.amount_owed_source === "manual" || !into.po_line_item_id) { if (from.amount_owed != null) edits.amount_owed = Number(into.amount_owed ?? 0) + Number(from.amount_owed); }
  else if (qty != null && into.po_line_item_id) { const line = await lineOf(query, String(into.po_id), String(into.po_line_item_id)); edits.amount_owed = autoAmount(line, Number(qty)); }
  if (Object.keys(edits).length) await query(`UPDATE supplier_claims SET ${Object.keys(edits).map((k, i) => `${k} = $${i + 2}`).join(", ")}, updated_at = now() WHERE id = $1`, [intoId, ...Object.values(edits)]);
  // refunds: the source's links move (a row already on the target keeps the larger share)
  for (const r of (await query(`SELECT po_line_refund_id, amount_applied FROM supplier_claim_refunds WHERE claim_id = $1`, [fromId])).rows) {
    await query(`INSERT INTO supplier_claim_refunds (claim_id, po_line_refund_id, amount_applied) VALUES ($1, $2, $3) ON CONFLICT (claim_id, po_line_refund_id) DO UPDATE SET amount_applied = CASE WHEN supplier_claim_refunds.amount_applied IS NULL OR EXCLUDED.amount_applied IS NULL THEN NULL ELSE supplier_claim_refunds.amount_applied + EXCLUDED.amount_applied END`, [intoId, r.po_line_refund_id, r.amount_applied]);
  }
  await query(`DELETE FROM supplier_claim_refunds WHERE claim_id = $1`, [fromId]);
  await query(`UPDATE supplier_claim_events SET claim_id = $2 WHERE claim_id = $1`, [fromId, intoId]);
  await query(`UPDATE supplier_claim_tasks SET done_at = now(), done_by = $2 WHERE claim_id = $1 AND done_at IS NULL`, [fromId, userId]);
  await query(`UPDATE supplier_claims SET status = 'dismissed', closed_at = now(), note = COALESCE(note || ' · ', '') || $2, updated_at = now() WHERE id = $1`, [fromId, `merged into claim #${intoId}`]);
  await event(query, intoId, "converted", `merged claim #${fromId} (${describe({ qty: from.qty, kind: from.kind, amount_owed: from.amount_owed })}) into this one`, userId);
  await event(query, fromId, "dismissed", `merged into claim #${intoId}`, userId);
  await logEdits(query, String(into.po_id), userId, "claim", String(intoId), [{ field: "claim merged", old: `#${fromId}`, new: `qty ${qty ?? "?"} · ${money(num(edits.amount_owed ?? into.amount_owed))}` }]);
  await logEdits(query, String(from.po_id), userId, "claim", String(fromId), [{ field: "claim merged into", old: from.status, new: `#${intoId}` }]);
  await syncRefundCoverage(query, [intoId], userId);
  return { id: intoId, po_id: String(into.po_id), merged_from: fromId };
}

/** Snooze a Check on it / Follow up task: ticked now, and the timer holds until `snoozed_until` (5 business days by default) before the sweep fires again. */
export async function snoozeTask(query: QueryLike, taskId: number, userId: number | null, businessDays = BUSINESS_DAYS): Promise<{ id: number; claim_id: number; po_id: string; snoozed_until: string }> {
  const t = (await query(`SELECT t.id, t.claim_id, t.kind, c.po_id FROM supplier_claim_tasks t JOIN supplier_claims c ON c.id = t.claim_id WHERE t.id = $1`, [taskId])).rows[0];
  if (!t) throw new EditError(404, "task not found");
  if (t.kind !== "check_on_it" && t.kind !== "follow_up_supplier") throw new EditError(400, "only Check on it / Follow up with supplier can be snoozed");
  const until = addBusinessDays(new Date(), Math.max(1, Math.min(20, Math.round(businessDays) || BUSINESS_DAYS))).toISOString();
  await query(`UPDATE supplier_claim_tasks SET done_at = now(), done_by = $2, snoozed_until = $3 WHERE id = $1 AND done_at IS NULL`, [taskId, userId, until]);
  await event(query, Number(t.claim_id), "snoozed", `until ${until.slice(0, 10)}`, userId);
  await logEdits(query, String(t.po_id), userId, "claim", String(t.claim_id), [{ field: `task ${t.kind}`, old: "open", new: `snoozed until ${until.slice(0, 10)}` }]);
  return { id: Number(t.id), claim_id: Number(t.claim_id), po_id: String(t.po_id), snoozed_until: until };
}

/** Create a task from outside (the timer sweep): the kind must be one of the fourteen. */
export function isTaskKind(v: unknown): v is ClaimTaskKind { return (CLAIM_TASK_KINDS as readonly string[]).includes(String(v)); }

/**
 * "Confirmed by supplier" by hand (D6; the email match is commit 6): stamps supplier_confirmed_at, takes the outcome when the
 * claim has none (a refund / credit by default), and moves the claim to Waiting on refund to post.
 */
export async function confirmSupplier(query: QueryLike, id: number, body: { at?: string | null; outcome?: string | null; amount?: number | string | null; detail?: string | null }, userId: number | null): Promise<{ id: number; po_id: string }> {
  const d = await claimRow(query, id);
  if (d.status !== "open" && d.status !== "suggested") throw new EditError(400, "only an open claim can be confirmed");
  const at = body.at && /^\d{4}-\d{2}-\d{2}$/.test(body.at) ? `${body.at}T12:00:00Z` : new Date().toISOString();
  const outcome = body.outcome ?? d.outcome ?? "refund_card";
  if (!(REFUND_OUTCOMES as readonly string[]).includes(outcome) && outcome !== "replacement") throw new EditError(400, "confirm a refund / credit or a replacement");
  if (d.outcome !== outcome || body.amount != null) await setOutcome(query, id, outcome === "replacement" ? { outcome: "replacement" } : { outcome: outcome as "refund_card", amount: body.amount ?? null, detail: body.detail ?? null }, userId);
  await query(`UPDATE supplier_claims SET supplier_confirmed_at = $2, status = CASE WHEN status = 'suggested' THEN 'open' ELSE status END, updated_at = now() WHERE id = $1`, [id, at]);
  await query(`UPDATE supplier_claim_tasks SET done_at = now(), done_by = $2 WHERE claim_id = $1 AND done_at IS NULL AND kind IN ('confirm_outcome', 'follow_up_supplier', 'check_on_it')`, [id, userId]);
  // D6's second tick (Maria 2026-11-11): the Refund received tick opens here, once the supplier has confirmed — never at Set outcome.
  if ((REFUND_OUTCOMES as readonly string[]).includes(outcome)) await addTask(query, id, "refund_received", "tick when the money arrives (add the refund row)");
  await event(query, id, "supplier_confirmed", `${outcome}${body.detail ? ` — ${String(body.detail).trim()}` : ""}`, userId);
  await logEdits(query, String(d.po_id), userId, "claim", String(id), [{ field: "claim supplier_confirmed_at", old: d.supplier_confirmed_at ? String(d.supplier_confirmed_at).slice(0, 10) : null, new: at.slice(0, 10) }]);
  return { id, po_id: String(d.po_id) };
}

export interface RefundReceivedBody {
  amount: number | string; method?: string | null; refunded_at?: string | null; nickname?: string | null; last4?: string | null; note?: string | null;
  /** One refund across several claims (§3.5, Michaels): how much of it each claim takes; this claim's share may be listed or implied (amount − Σ others). */
  split?: Array<{ claim_id: number; amount: number | string }>;
}
/**
 * "Refund received" (D6, Maria's tick): adds a po_line_refunds row (received money; method prefilled by the UI from the PO's
 * payments) and links it to this claim — and, with `split`, to the PO's other open claims for their shares. A refund arriving
 * also stands for the supplier's confirmation. Full → the coverage sync closes the claim; short → the claim stays owed
 * ("short by $X", Waiting on refund to post) with the refund_received task ticked.
 */
export async function addRefundReceived(query: QueryLike, id: number, body: RefundReceivedBody, userId: number | null): Promise<{ id: number; po_id: string; refund_id: number; applied: Array<{ claim_id: number; amount: number }> }> {
  const d = await claimRow(query, id);
  if (d.status !== "open") throw new EditError(400, "only an open claim takes a refund");
  const amount = amountOf(body.amount);
  if (amount == null || amount <= 0) throw new EditError(400, "the refund amount is required");
  const poId = String(d.po_id);
  const others = (body.split ?? []).filter((x) => Number(x.claim_id) !== id).map((x) => ({ claim_id: Number(x.claim_id), amount: amountOf(x.amount) ?? 0 })).filter((x) => x.amount > 0);
  const mine = (body.split ?? []).find((x) => Number(x.claim_id) === id);
  const othersSum = Math.round(others.reduce((t, x) => t + x.amount, 0) * 100) / 100;
  const myShare = mine ? amountOf(mine.amount) ?? 0 : Math.round((amount - othersSum) * 100) / 100;
  if (myShare < 0 || Math.round((myShare + othersSum) * 100) / 100 > amount + 0.005) throw new EditError(400, `the shares ($${(myShare + othersSum).toFixed(2)}) exceed the refund ($${amount.toFixed(2)})`);
  for (const o of others) {
    const oc = (await query(`SELECT po_id, status FROM supplier_claims WHERE id = $1`, [o.claim_id])).rows[0];
    if (!oc || String(oc.po_id) !== poId) throw new EditError(400, `claim ${o.claim_id} is not a claim of this PO`);
    if (oc.status !== "open") throw new EditError(400, `claim ${o.claim_id} is not open`);
  }
  const single = others.length === 0;
  const r = await addMoneyRow(query, "po_line_refunds", poId, {
    po_line_item_id: single ? d.po_line_item_id : null, qty: single && d.qty != null ? String(d.qty) : null, amount: String(amount), refunded_at: body.refunded_at || null,
    method: body.method || null, nickname: body.nickname || null, last4: body.last4 || null, note: body.note || null, needs_split: !single,
  }, userId);
  const applied: Array<{ claim_id: number; amount: number }> = [];
  const stamp = async (cid: number) => query(`UPDATE supplier_claims SET supplier_confirmed_at = COALESCE(supplier_confirmed_at, now()), updated_at = now() WHERE id = $1`, [cid]);
  if (myShare > 0) { await linkRefund(query, id, r.id, userId, { sync: false, amountApplied: single ? null : myShare }); applied.push({ claim_id: id, amount: myShare }); }
  await stamp(id);
  await query(`UPDATE supplier_claim_tasks SET done_at = now(), done_by = $2 WHERE claim_id = $1 AND done_at IS NULL AND kind = 'refund_received'`, [id, userId]);
  for (const o of others) {
    await linkRefund(query, o.claim_id, r.id, userId, { sync: false, amountApplied: o.amount }); applied.push(o);
    await stamp(o.claim_id);
    await query(`UPDATE supplier_claim_tasks SET done_at = now(), done_by = $2 WHERE claim_id = $1 AND done_at IS NULL AND kind = 'refund_received'`, [o.claim_id, userId]);
  }
  await syncRefundCoverage(query, [id, ...others.map((o) => o.claim_id)], userId);
  // Short: the claim stays owed and waits for the rest (the timer's Check on it asks after 5 business days).
  for (const c of await loadClaims(query, { ids: [id, ...others.map((o) => o.claim_id)] })) {
    if (c.status === "open" && c.remaining != null && c.remaining > 0.005) await event(query, c.id, "refund_short", `short by ${money(c.remaining)}`, userId);
  }
  return { id, po_id: poId, refund_id: r.id, applied };
}

/** Write off what is still owed on a refund / credit claim (§3.5): the claim closes with its outcome, the remainder goes to Supplier write-offs (commit 9 reads it). */
export async function writeOffRemainder(query: QueryLike, id: number, reason: string, userId: number | null): Promise<{ id: number; po_id: string }> {
  const d = await claimRow(query, id);
  const why = String(reason ?? "").trim();
  if (!why) throw new EditError(400, "a write-off needs a reason");
  if (d.status !== "open") throw new EditError(400, "only an open claim can have its remainder written off");
  const [c] = await loadClaims(query, { ids: [id] });
  if (c.remaining == null || c.remaining <= 0.005) throw new EditError(400, "nothing is owed on this claim");
  const outcome = d.outcome && (REFUND_OUTCOMES as readonly string[]).includes(d.outcome) ? d.outcome : "refund_card";
  await query(`UPDATE supplier_claims SET status = 'closed', outcome = $2, write_off_reason = $3, outcome_amount = $4, closed_at = now(), updated_at = now() WHERE id = $1`, [id, outcome, why, c.received]);
  await query(`UPDATE supplier_claim_tasks SET done_at = now(), done_by = $2 WHERE claim_id = $1 AND done_at IS NULL`, [id, userId]);
  await logEdits(query, String(d.po_id), userId, "claim", String(id), [{ field: "claim remainder written off", old: money(c.remaining), new: why }]);
  await event(query, id, "remainder_written_off", `${money(c.remaining)}: ${why}`, userId); await event(query, id, "closed", `${outcome} ${money(c.received)} received, ${money(c.remaining)} written off`, userId);
  return { id, po_id: String(d.po_id) };
}

export interface AddClaimBody { po_line_item_id?: string | null; kind: string; qty: number | string; amount_owed?: number | string | null; found_at?: string | null; note?: string | null; refund_ids?: number[]; return_required?: boolean; status?: "open" | "suggested" }

/**
 * Open a claim. qty in Individual units (on a product_legacy line: the line's stored Product units — the pack is not known).
 * amount_owed omitted → auto (qty × the line's cost per Individual unit); a whole-PO claim (no line) needs the amount typed.
 * A new open claim gets a contact_supplier task (§3.3).
 */
export async function addClaim(query: QueryLike, poId: string, body: AddClaimBody, userId: number | null, opts: { noTask?: boolean } = {}): Promise<{ id: number; po_id: string }> {
  const lineId = body?.po_line_item_id == null || body.po_line_item_id === "" ? null : String(body.po_line_item_id);
  const line = lineId ? await lineOf(query, poId, lineId) : null;
  if (!line && !(await query(`SELECT 1 FROM purchase_orders WHERE id = $1`, [poId])).rows[0]) throw new EditError(404, "PO not found");
  const kind = kindOf(body.kind), qty = qtyOf(body.qty);
  if (line) {
    const ordered = line.qty_basis === "product_legacy" ? Number(line.ordered_product) : Number(line.ordered_individual);
    if (Number.isFinite(ordered) && ordered > 0 && qty > ordered + 1e-9) throw new EditError(400, `qty (${qty}) cannot exceed the line's Ordered (${ordered} ${line.qty_basis === "product_legacy" ? "Product" : "Individual"} units)`);
  }
  const manual = body.amount_owed !== undefined && body.amount_owed !== null && body.amount_owed !== "";
  const amount = manual ? amountOf(body.amount_owed) : line ? autoAmount(line, qty) : null;
  const found = body.found_at && /^\d{4}-\d{2}-\d{2}$/.test(body.found_at) ? body.found_at : null;
  const status = body.status === "suggested" ? "suggested" : "open";
  const row = (await query(
    `INSERT INTO supplier_claims (po_id, po_line_item_id, kind, qty, amount_owed, amount_owed_source, found_at, note, status, found_by, return_required, created_by_user_id, supplier_confirmed_at)
     VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::date, CURRENT_DATE), $8, $9, 'maria', $10, $11,
             CASE WHEN $3 = 'canceled' THEN COALESCE($7::date, CURRENT_DATE)::timestamp + interval '12 hours' END) RETURNING id`,
    [poId, line?.id ?? null, kind, qty, amount, manual ? "manual" : "auto", found, body.note?.trim() || null, status, body.return_required === true, userId])).rows[0];
  const id = Number(row.id);
  // a canceled claim (Cancel PO, a line's cancel, Open claim with kind canceled) is supplier-confirmed on the cancel date and
  // supersedes any open suggestion on the PO or its line (paths, Maria 2026-11-12)
  if (kind === "canceled" && status === "open") await supersedeSuggestionsByCancel(query, poId, line?.id ? String(line.id) : null, userId, id);
  await logEdits(query, poId, userId, "claim", String(id), [{ field: "claim opened", old: null, new: `${describe({ qty, kind, amount_owed: amount })}${line ? "" : " (whole PO)"}${body.note?.trim() ? ` — ${body.note.trim()}` : ""}` }]);
  await event(query, id, status === "open" ? "opened" : "found", describe({ qty, kind, amount_owed: amount }), userId);
  for (const rid of body.refund_ids ?? []) await linkRefund(query, id, Number(rid), userId, { sync: false });
  if (status === "open" && !opts.noTask) {
    if (kind === "canceled") await addTask(query, id, "refund_received", "canceled — tick when the refund posts (add the refund row)");
    else await addContactTaskIfUnreported(query, id, "a claim was opened — report it to the supplier");
  }
  await syncRefundCoverage(query, [id], userId);
  return { id, po_id: poId };
}

/** Cancel PO / a line's cancel / Open claim with kind canceled dismisses the open suggestions on that PO (whole-PO ones) and on the line, "superseded by cancel" (Maria 2026-11-12). */
export async function supersedeSuggestionsByCancel(query: QueryLike, poId: string, lineId: string | null, userId: number | null, except: number | null = null): Promise<number[]> {
  const ids = (await query(`SELECT id FROM supplier_claims WHERE po_id = $1 AND status = 'suggested' AND (po_line_item_id IS NULL OR po_line_item_id = $2) AND id IS DISTINCT FROM $3 ORDER BY id`, [poId, lineId, except])).rows.map((r: any) => Number(r.id));
  for (const id of ids) await dismissClaim(query, id, userId, "superseded by cancel");
  return ids;
}

/**
 * A contact_supplier task only for a claim not yet reported (one derivation, Maria 2026-11-12): an emailed cancellation,
 * a typed report date or the supplier's confirmation already stand for the report — opening the Walmart cancellation
 * suggestion (#3355, confirmed 9/23) added one and the list read "Report to supplier" while the detail read Received.
 * Never a second open one.
 */
export async function addContactTaskIfUnreported(query: QueryLike, claimId: number, reason: string): Promise<boolean> {
  const d = (await query(`SELECT kind, found_by, reported_at, supplier_confirmed_at FROM supplier_claims WHERE id = $1`, [claimId])).rows[0];
  if (d && isReported({ ...d, tasks: [] })) return false;
  const open = (await query(`SELECT 1 FROM supplier_claim_tasks WHERE claim_id = $1 AND kind = 'contact_supplier' AND done_at IS NULL LIMIT 1`, [claimId])).rows;
  if (open.length) return false;
  await addTask(query, claimId, "contact_supplier", reason);
  return true;
}

async function claimRow(query: QueryLike, id: number) {
  const d = (await query(`SELECT * FROM supplier_claims WHERE id = $1`, [id])).rows[0];
  if (!d) throw new EditError(404, "claim not found");
  return d;
}

/** Edit qty / amount_owed (→ manual; "" → back to auto) / kind / note / found_at / return_required / reported_at. A qty change re-derives an auto amount. */
export async function editClaim(query: QueryLike, id: number, body: Record<string, unknown>, userId: number | null): Promise<{ id: number; po_id: string }> {
  const d = await claimRow(query, id);
  const edits: Record<string, unknown> = {};
  const line = d.po_line_item_id ? await lineOf(query, String(d.po_id), String(d.po_line_item_id)) : null;
  if ("qty" in body) {
    const q = qtyOf(body.qty);
    if (line) {
      const ordered = line.qty_basis === "product_legacy" ? Number(line.ordered_product) : Number(line.ordered_individual);
      if (Number.isFinite(ordered) && ordered > 0 && q > ordered + 1e-9) throw new EditError(400, `qty (${q}) cannot exceed the line's Ordered (${ordered} ${line.qty_basis === "product_legacy" ? "Product" : "Individual"} units)`);
    }
    edits.qty = q;
    if (d.amount_owed_source === "auto" && line && !("amount_owed" in body)) edits.amount_owed = autoAmount(line, q);
    // A quantity typed on a claim that had none completes its "Enter quantity" task.
    if (d.qty == null) {
      await query(`UPDATE supplier_claim_tasks SET done_at = now(), done_by = $2 WHERE claim_id = $1 AND kind = 'enter_quantity' AND done_at IS NULL`, [id, userId]);
      await event(query, id, "task_done", "enter_quantity", userId);
    }
  }
  if ("amount_owed" in body) {
    if (body.amount_owed == null || body.amount_owed === "") { edits.amount_owed_source = "auto"; edits.amount_owed = line ? autoAmount(line, Number(edits.qty ?? d.qty)) : null; }
    else { edits.amount_owed = amountOf(body.amount_owed); edits.amount_owed_source = "manual"; }
  }
  if ("kind" in body) edits.kind = kindOf(body.kind);
  if ("note" in body) edits.note = String(body.note ?? "").trim() || null;
  if ("found_at" in body) edits.found_at = dateOf(body.found_at, "found_at");
  if ("reported_at" in body) edits.reported_at = body.reported_at == null || body.reported_at === "" ? null : dateOf(body.reported_at, "reported_at");
  if ("reported_channel" in body) edits.reported_channel = String(body.reported_channel ?? "").trim() || null;
  if ("last_supplier_reply_at" in body) edits.last_supplier_reply_at = body.last_supplier_reply_at == null || body.last_supplier_reply_at === "" ? null : `${dateOf(body.last_supplier_reply_at, "last_supplier_reply_at")}T12:00:00Z`;
  if ("supplier_confirmed_at" in body) edits.supplier_confirmed_at = body.supplier_confirmed_at == null || body.supplier_confirmed_at === "" ? null : `${dateOf(body.supplier_confirmed_at, "supplier_confirmed_at")}T12:00:00Z`;
  if ("return_required" in body) edits.return_required = body.return_required === true || body.return_required === "true";
  const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v);
  const cur = { ...d, found_at: d.found_at instanceof Date ? d.found_at.toISOString().slice(0, 10) : d.found_at, reported_at: d.reported_at instanceof Date ? d.reported_at.toISOString().slice(0, 10) : d.reported_at,
    last_supplier_reply_at: iso(d.last_supplier_reply_at), supplier_confirmed_at: iso(d.supplier_confirmed_at) };
  const canon = (k: string, v: unknown) => (v == null ? "" : k === "qty" || k === "amount_owed" ? String(Number(v)) : String(v));
  const changes = Object.entries(edits).filter(([k, v]) => canon(k, cur[k]) !== canon(k, v));
  if (changes.length === 0) return { id, po_id: String(d.po_id) };
  await query(`UPDATE supplier_claims SET ${changes.map(([k], i) => `${k} = $${i + 2}`).join(", ")}, updated_at = now() WHERE id = $1`, [id, ...changes.map(([, v]) => v)]);
  await logEdits(query, String(d.po_id), userId, "claim", String(id), changes.map(([k, v]) => ({ field: `claim ${k}`, old: cur[k] == null ? null : canon(k, cur[k]), new: v == null ? null : canon(k, v) })));
  if (changes.some(([k]) => k === "amount_owed" && edits.amount_owed_source === "manual")) await event(query, id, "amount_overridden", money(num(edits.amount_owed)), userId);
  if (changes.some(([k]) => k === "reported_at")) await event(query, id, "reported", String(edits.reported_channel ?? d.reported_channel ?? ""), userId);
  await syncRefundCoverage(query, [id], userId);
  return { id, po_id: String(d.po_id) };
}

/** Link a received refund row of the same PO; amount_applied = how much of it this claim takes (NULL = the whole row). */
export async function linkRefund(query: QueryLike, id: number, refundId: number, userId: number | null, opts: { sync?: boolean; amountApplied?: number | null } = {}): Promise<{ id: number; po_id: string }> {
  const d = await claimRow(query, id);
  const r = (await query(`SELECT id, po_id, amount, method FROM po_line_refunds WHERE id = $1`, [refundId])).rows[0];
  if (!r || String(r.po_id) !== String(d.po_id)) throw new EditError(400, "the refund must be a refund row of this PO");
  const applied = opts.amountApplied === undefined ? null : amountOf(opts.amountApplied);
  const ins = await query(`INSERT INTO supplier_claim_refunds (claim_id, po_line_refund_id, amount_applied) VALUES ($1, $2, $3) ON CONFLICT (claim_id, po_line_refund_id) DO UPDATE SET amount_applied = EXCLUDED.amount_applied`, [id, refundId, applied]);
  if ((ins.rowCount ?? 0) > 0) {
    await logEdits(query, String(d.po_id), userId, "claim", String(id), [{ field: "refund linked", old: null, new: `${money(num(applied ?? r.amount))}${applied != null ? ` of ${money(num(r.amount))}` : ""} (${r.method ?? "refund"})` }]);
    await event(query, id, "refund_received", money(num(applied ?? r.amount)), userId, { po_line_refund_id: Number(r.id) });
  }
  if (opts.sync !== false) await syncRefundCoverage(query, [id], userId);
  return { id, po_id: String(d.po_id) };
}

export async function unlinkRefund(query: QueryLike, id: number, refundId: number, userId: number | null): Promise<{ id: number; po_id: string }> {
  const d = await claimRow(query, id);
  const r = (await query(`SELECT amount FROM po_line_refunds WHERE id = $1`, [refundId])).rows[0];
  const del = await query(`DELETE FROM supplier_claim_refunds WHERE claim_id = $1 AND po_line_refund_id = $2`, [id, refundId]);
  if ((del.rowCount ?? 0) > 0) await logEdits(query, String(d.po_id), userId, "claim", String(id), [{ field: "refund unlinked", old: r ? money(num(r.amount)) : String(refundId), new: null }]);
  await syncRefundCoverage(query, [id], userId);
  return { id, po_id: String(d.po_id) };
}

export type OutcomeBody = { outcome: "refund_card" | "gift_card" | "store_credit"; amount?: number | string | null; detail?: string | null }
  | { outcome: "replacement"; qty?: number | string | null; arrived?: boolean; shipped_at?: string | null; arrived_at?: string | null }
  | { outcome: "write_off"; reason: string };

/**
 * Set the outcome (D3, one per claim). Refund / credit: stays open (Waiting on supplier until Confirmed by supplier, which opens
 * the refund_received tick — D6's two ticks) until the applied refunds cover the $ owed; replacement: open until `arrived` (then
 * closed); write_off: closed at once, reason required.
 */
export async function setOutcome(query: QueryLike, id: number, body: OutcomeBody, userId: number | null): Promise<{ id: number; po_id: string }> {
  const d = await claimRow(query, id);
  if (d.status === "dismissed") throw new EditError(400, "a dismissed claim has no outcome — reopen it first");
  const outcome = String((body as any)?.outcome ?? "");
  if (!(CLAIM_OUTCOMES as readonly string[]).includes(outcome)) throw new EditError(400, `outcome must be one of ${CLAIM_OUTCOMES.join(", ")}`);
  const poId = String(d.po_id);
  if (outcome === "write_off") {
    const reason = String((body as any).reason ?? "").trim();
    if (!reason) throw new EditError(400, "a write-off needs a reason");
    await query(`UPDATE supplier_claims SET status = 'closed', outcome = 'write_off', write_off_reason = $2, outcome_amount = amount_owed, closed_at = now(), updated_at = now() WHERE id = $1`, [id, reason]);
    await query(`UPDATE supplier_claim_tasks SET done_at = now(), done_by = $2 WHERE claim_id = $1 AND done_at IS NULL`, [id, userId]);
    await logEdits(query, poId, userId, "claim", String(id), [{ field: "claim outcome", old: d.outcome, new: `write-off: ${reason}` }]);
    await event(query, id, "outcome_set", `write_off: ${reason}`, userId); await event(query, id, "closed", "written off", userId);
    return { id, po_id: poId };
  }
  if (outcome === "replacement") {
    const b = body as Extract<OutcomeBody, { outcome: "replacement" }>;
    const rq = b.qty == null || b.qty === "" ? null : qtyOf(b.qty);
    const shipped = b.shipped_at ? dateOf(b.shipped_at, "shipped_at") : null, arrived = b.arrived_at ? dateOf(b.arrived_at, "arrived_at") : b.arrived ? new Date().toISOString().slice(0, 10) : null;
    await query(`UPDATE supplier_claims SET outcome = 'replacement', replacement_qty = COALESCE($2, replacement_qty, qty), replacement_shipped_at = COALESCE($3::date, replacement_shipped_at), replacement_arrived_at = COALESCE($4::date, replacement_arrived_at),
                   status = CASE WHEN $4::date IS NOT NULL THEN 'closed' ELSE 'open' END, closed_at = CASE WHEN $4::date IS NOT NULL THEN now() ELSE NULL END, updated_at = now() WHERE id = $1`, [id, rq, shipped, arrived]);
    await logEdits(query, poId, userId, "claim", String(id), [{ field: "claim outcome", old: d.outcome, new: `replacement${arrived ? " (arrived)" : ""}` }]);
    await event(query, id, "outcome_set", "replacement", userId);
    if (arrived) { await query(`UPDATE supplier_claim_tasks SET done_at = now(), done_by = $2 WHERE claim_id = $1 AND done_at IS NULL`, [id, userId]); await event(query, id, "replacement_arrived", null, userId); await event(query, id, "closed", "replacement arrived", userId); }
    else await addTask(query, id, "replacement_arrived", "tick when the replacement units arrive");
    return { id, po_id: poId };
  }
  const b = body as Extract<OutcomeBody, { outcome: "refund_card" | "gift_card" | "store_credit" }>;
  const amt = b.amount == null || b.amount === "" ? null : amountOf(b.amount);
  await query(`UPDATE supplier_claims SET outcome = $2, outcome_amount = COALESCE($3, outcome_amount), outcome_detail = COALESCE($4, outcome_detail), status = CASE WHEN status = 'suggested' THEN 'open' ELSE status END, updated_at = now() WHERE id = $1`,
    [id, outcome, amt, b.detail == null ? null : String(b.detail).trim() || null]);
  await logEdits(query, poId, userId, "claim", String(id), [{ field: "claim outcome", old: d.outcome, new: `${outcome}${amt != null ? ` ${money(amt)}` : ""}` }]);
  await event(query, id, "outcome_set", outcome, userId);
  await syncRefundCoverage(query, [id], userId);
  return { id, po_id: poId };
}

/** Reopen a closed claim (any outcome) or un-dismiss one. */
export async function reopenClaim(query: QueryLike, id: number, userId: number | null): Promise<{ id: number; po_id: string }> {
  const d = await claimRow(query, id);
  if (d.status === "open") return { id, po_id: String(d.po_id) };
  await query(`UPDATE supplier_claims SET status = 'open', closed_at = NULL, replacement_arrived_at = CASE WHEN outcome = 'replacement' THEN NULL ELSE replacement_arrived_at END,
                 write_off_reason = CASE WHEN outcome = 'write_off' THEN write_off_reason ELSE NULL END, updated_at = now() WHERE id = $1`, [id]);
  await logEdits(query, String(d.po_id), userId, "claim", String(id), [{ field: "claim reopened", old: d.status, new: "open" }]);
  await event(query, id, "reopened", d.outcome, userId);
  await syncRefundCoverage(query, [id], userId);
  return { id, po_id: String(d.po_id) };
}
/** Dismiss a suggestion (or an open claim Maria rejects): never counts, never blocks. */
export async function dismissClaim(query: QueryLike, id: number, userId: number | null, reason: string | null = null): Promise<{ id: number; po_id: string }> {
  const d = await claimRow(query, id);
  await query(`UPDATE supplier_claims SET status = 'dismissed', closed_at = now(), updated_at = now() WHERE id = $1`, [id]);
  await query(`UPDATE supplier_claim_tasks SET done_at = now(), done_by = $2 WHERE claim_id = $1 AND done_at IS NULL`, [id, userId]);
  await logEdits(query, String(d.po_id), userId, "claim", String(id), [{ field: "claim dismissed", old: d.status, new: reason ?? "dismissed" }]);
  await event(query, id, "dismissed", reason, userId);
  return { id, po_id: String(d.po_id) };
}
export async function removeClaim(query: QueryLike, id: number, userId: number | null): Promise<{ id: number; po_id: string }> {
  const d = await claimRow(query, id);
  await query(`DELETE FROM supplier_claims WHERE id = $1`, [id]);
  await logEdits(query, String(d.po_id), userId, "claim", String(id), [{ field: "claim removed", old: describe(d), new: null }]);
  return { id, po_id: String(d.po_id) };
}

/**
 * Refund coverage, derived on every change (link, unlink, a refund row edited or removed, the amount owed changed): an OPEN claim
 * whose outcome is unset or a refund / credit and whose applied refunds cover the $ owed closes (outcome from the refund's method
 * when unset); a CLOSED refund / credit claim no longer covered reopens. Replacement / write-off are left alone.
 */
export async function syncRefundCoverage(query: QueryLike, claimIds: readonly number[], userId: number | null): Promise<{ closed: number; reopened: number }> {
  let closed = 0, reopened = 0;
  if (claimIds.length === 0) return { closed, reopened };
  for (const d of await loadClaims(query, { ids: Array.from(new Set(claimIds)) })) {
    if (d.outcome === "replacement" || d.outcome === "write_off" || d.status === "dismissed" || d.status === "suggested") continue;
    // A refund / credit claim whose remainder was written off (write_off_reason set) stays closed although not fully covered.
    if (d.status === "closed" && d.write_off_reason) continue;
    const m = claimMoney(d.amount_owed, d.refunds);
    if (d.status === "open" && m.fullyCovered) {
      const outcome = d.outcome ?? (d.refunds[0]?.method === "gift_card" ? "gift_card" : d.refunds[0]?.method === "store_credit" ? "store_credit" : "refund_card");
      await query(`UPDATE supplier_claims SET status = 'closed', outcome = $2, outcome_amount = $3, closed_at = now(), updated_at = now() WHERE id = $1`, [d.id, outcome, m.received]);
      await query(`UPDATE supplier_claim_tasks SET done_at = now(), done_by = $2 WHERE claim_id = $1 AND done_at IS NULL AND kind IN ('refund_received', 'contact_supplier', 'follow_up_supplier', 'check_on_it')`, [d.id, userId]);
      await logEdits(query, d.po_id, userId, "claim", String(d.id), [{ field: "claim closed", old: "open", new: `${outcome}: ${money(m.received)} received` }]);
      await event(query, d.id, "closed", `${outcome} ${money(m.received)} received`, userId);
      closed++;
    } else if (d.status === "closed" && d.outcome != null && (REFUND_OUTCOMES as readonly string[]).includes(d.outcome) && !m.fullyCovered) {
      await query(`UPDATE supplier_claims SET status = 'open', closed_at = NULL, updated_at = now() WHERE id = $1`, [d.id]);
      await addTask(query, d.id, "refund_received", `short by ${money(m.remaining)}`);
      await logEdits(query, d.po_id, userId, "claim", String(d.id), [{ field: "claim reopened", old: d.outcome, new: `open: ${money(m.remaining)} still owed` }]);
      await event(query, d.id, "reopened", `short by ${money(m.remaining)}`, userId);
      reopened++;
    }
  }
  return { closed, reopened };
}

/** The claims linked to these refund rows (call before a refund row is deleted — the link cascades away). */
export async function claimsLinkedTo(query: QueryLike, refundIds: readonly number[]): Promise<number[]> {
  if (refundIds.length === 0) return [];
  return (await query(`SELECT DISTINCT claim_id FROM supplier_claim_refunds WHERE po_line_refund_id = ANY($1::bigint[])`, [refundIds])).rows.map((r: any) => Number(r.claim_id));
}

/**
 * Cancel lines (Cancel PO / an ASIN row's "cancel", D14): one OPEN canceled claim per line for its remaining expected units
 * (Individual; a legacy line's Product units), with a refund_received task — nothing edits Ordered. Lines with nothing left
 * expected are skipped. Returns the claims created.
 */
export async function cancelLines(query: QueryLike, poId: string, lineIds: readonly string[], userId: number | null, note: string): Promise<Array<{ id: number; line_id: string; qty: number }>> {
  if (lineIds.length === 0) return [];
  const lines = (await query(
    `SELECT le.line_id, le.qty_basis, le.expected_individual, le.expected_product FROM po_line_expected le WHERE le.po_id = $1 AND le.line_id = ANY($2::uuid[])`, [poId, lineIds])).rows;
  const out: Array<{ id: number; line_id: string; qty: number }> = [];
  for (const l of lines) {
    const qty = Number(l.qty_basis === "product_legacy" ? l.expected_product : l.expected_individual) || 0;
    if (!(qty > 0)) continue;
    const { id } = await addClaim(query, poId, { po_line_item_id: String(l.line_id), kind: "canceled", qty, note }, userId, { noTask: true });
    await addTask(query, id, "refund_received", "canceled — tick when the refund posts (add the refund row)");
    out.push({ id, line_id: String(l.line_id), qty });
  }
  return out;
}
