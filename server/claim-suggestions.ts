// Auto-found claims (SPEC §22 "Supplier claims"; claims patch §3.1, D8, §3.2 "suggested", commit 5, Maria 2026-11-12).
// Everything here creates SUGGESTED claims only — status 'suggested' with a review_suggestion task under Needs
// attention → Decide; nothing changes a PO until Maria opens one. Three finders:
//   missing (D8)     per ASIN row of an open Velocity PO: every inbound tracking row delivered (EasyPost's delivered_at,
//                    else Velocity's tracking_status "Delivered" for rows EasyPost does not track), ≥ 3 business days
//                    since the latest delivery, and Received by Velocity < shipped. Shipped (Individual units) =
//                    Σ po_tracking.qty (Product units × the product pack) when the PO has one ASIN row and every
//                    delivered row states a qty, else ordered − canceled. The suggestion shows both figures and the two
//                    possible causes. One suggestion per line; the same figures are never suggested twice.
//   never_received   (a) with tracking: an inbound row with a carrier exception / returned to sender, or whose ETA
//                    passed 5 business days ago, or with no scan for 5 business days, or in transit > 14 days with no
//                    scan in the last 3; whole-PO claim when every inbound row is flagged (or the PO has one line),
//                    else a whole-PO claim naming the numbers. (b) with nothing: no tracking row of any kind (a
//                    placeholder counts as a shipping email) and nothing received 14 days after the order date.
//   canceled         cancellation emails → server/cancellation-emails.ts (suggestClaim below is the common writer).
// suggestion_key (migration 106) is the dedupe: the same key is never suggested twice, a dismissed suggestion comes
// back only when its figures change. Every quantity is read from the views (po_asin_expected / po_line_expected).
import { claimAmount } from "@shared/supplier-claim";
import { businessDaysBetween } from "@shared/claim-bucket";
import { addTask, dismissClaim } from "./supplier-claims";
import type { QueryLike } from "./scheduler/types";

/** D8: business days since the latest delivery before "missing" is suggested. */
export const MISSING_AFTER_BUSINESS_DAYS = 3;
/** never_received (a): the ETA passed / no scan for this many business days. */
export const LOST_AFTER_BUSINESS_DAYS = 5;
/** never_received (a): in transit longer than this with no scan in the last STALE_SCAN_DAYS. */
export const IN_TRANSIT_MAX_DAYS = 14;
export const STALE_SCAN_DAYS = 3;
/** never_received (b): no tracking row and no shipping email this long after the order date. */
export const NOTHING_AFTER_DAYS = 14;
/** never_received (b) applies to orders placed since tracking emails are read (the tracking backfill window): before that "no shipping email" means nothing. */
export const NOTHING_RULE_FROM = "2026-07-29";

export interface Suggestion {
  po_id: string; order_id: string; supplier: string;
  po_line_item_id: string | null;
  kind: "missing" | "never_received" | "canceled";
  /** Individual units; null = not known (an enter_quantity task asks). */
  qty: number | null;
  /** $ owed; null = auto from the line (or unknown for a whole-PO claim). */
  amount: number | null;
  /** What the review_suggestion task shows. */
  reason: string;
  key: string;
  found_by: "auto" | "email";
  /** A canceled suggestion: the cancel date (the email's date) — the supplier's confirmation at creation (paths, Maria 2026-11-12). */
  confirmed_at?: string | null;
  source_email_id?: string | null;
  source_items_json?: unknown;
  note?: string | null;
  /** The rule that fired (the dry-run report groups by it). */
  rule: string;
}

export interface SuggestOutcome { created: boolean; id: number | null; why: "created" | "same_key" | "already_suggested" | "dry_run"; /** Converted badge claims on the same line dismissed "superseded by found claim" (Maria 2026-11-12). */ superseded?: number[] }

const num = (v: unknown): number => (v == null ? 0 : Number(v));
const DAY_MS = 86_400_000;
const daysBetween = (from: string | Date, to: Date): number => (to.getTime() - new Date(from).getTime()) / DAY_MS;

export type ExistingClaim = { po_id: string; po_line_item_id: string | null; kind: string; status: string; suggestion_key: string | null; /** A migration-101 badge conversion still waiting on its quantity (open, qty NULL, enter_quantity open): never blocks a suggestion, is superseded by one. */ converted_badge?: boolean };
/** SQL (alias `c` = supplier_claims): a converted badge claim — open, no quantity, its enter_quantity task still open, a supplier_claim_conversions row behind it. */
export const CONVERTED_BADGE_SQL = `(c.status = 'open' AND c.qty IS NULL
    AND EXISTS (SELECT 1 FROM supplier_claim_conversions k WHERE k.claim_id = c.id)
    AND EXISTS (SELECT 1 FROM supplier_claim_tasks t WHERE t.claim_id = c.id AND t.kind = 'enter_quantity' AND t.done_at IS NULL))`;
export const SUPERSEDED_REASON = "superseded by found claim";
let hasKeyColumn: boolean | null = null;
/** Before migration 106 is applied (a dry run against production from a newer checkout) the key column is read as NULL. */
async function keyColumn(query: QueryLike): Promise<string> {
  if (hasKeyColumn == null) hasKeyColumn = (await query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'supplier_claims' AND column_name = 'suggestion_key'`)).rows.length > 0;
  return hasKeyColumn ? "suggestion_key" : "NULL::text AS suggestion_key";
}
/** The claims already on the PO (any status) that decide whether a suggestion is new. */
export async function existingClaims(query: QueryLike, poIds: readonly string[]): Promise<ExistingClaim[]> {
  if (!poIds.length) return [];
  return (await query(`SELECT po_id, po_line_item_id, kind, status, ${await keyColumn(query)}, ${CONVERTED_BADGE_SQL} AS converted_badge FROM supplier_claims c WHERE po_id = ANY($1::uuid[])`, [poIds])).rows;
}

/** Pure: is this suggestion new — no claim with the same key, and no open / suggested claim of the kind on the same line (or the whole PO)? A converted badge claim never blocks (it is superseded instead). */
export function isNewSuggestion(s: Pick<Suggestion, "po_id" | "po_line_item_id" | "kind" | "key">, existing: ReadonlyArray<ExistingClaim>): SuggestOutcome["why"] {
  if (existing.some((c) => c.suggestion_key === s.key)) return "same_key";
  if (existing.some((c) => !c.converted_badge && c.po_id === s.po_id && c.kind === s.kind && (c.status === "open" || c.status === "suggested") && (c.po_line_item_id ?? null) === (s.po_line_item_id ?? null))) return "already_suggested";
  return "created";
}

/**
 * Converted badge claims (migration 101: open, qty NULL, enter_quantity open) are superseded when a finder suggests on their
 * line — or anywhere on their PO when the suggestion is a whole-PO one (Maria 2026-11-12): dismissed with the reason
 * "superseded by found claim" — a History row and a `dismissed` event each, through dismissClaim. Returns the ids dismissed
 * (dry run: the ids it would).
 */
export async function supersedeConvertedOnLine(query: QueryLike, poId: string, lineId: string | null, opts: { dryRun?: boolean; except?: number | null } = {}): Promise<number[]> {
  const ids = (await query(`SELECT c.id FROM supplier_claims c WHERE c.po_id = $1 AND ($2::uuid IS NULL OR c.po_line_item_id = $2) AND ${CONVERTED_BADGE_SQL} ORDER BY c.id`, [poId, lineId])).rows
    .map((r: any) => Number(r.id)).filter((id: number) => id !== (opts.except ?? null));
  if (!opts.dryRun) for (const id of ids) await dismissClaim(query, id, null, SUPERSEDED_REASON);
  return ids;
}

/**
 * Stray report prompts (Maria 2026-11-12): open contact_supplier tasks on claims already reported — a canceled claim (any
 * source), a typed report date, the supplier's confirmation, an earlier Contacted tick — that the timer sweep did not create
 * (its reason starts "N business days:"). The derivation already ignores them; this removes the rows. Dry run lists them.
 */
export async function deleteStrayContactTasks(query: QueryLike, opts: { dryRun?: boolean } = {}): Promise<Array<{ task_id: number; claim_id: number; kind: string; found_by: string }>> {
  const rows = (await query(
    `SELECT t.id AS task_id, c.id AS claim_id, c.kind, c.found_by FROM supplier_claim_tasks t JOIN supplier_claims c ON c.id = t.claim_id
      WHERE t.kind = 'contact_supplier' AND t.done_at IS NULL AND COALESCE(t.reason, '') !~ '^[0-9]+ business days: '
        AND (c.kind = 'canceled' OR c.reported_at IS NOT NULL OR c.supplier_confirmed_at IS NOT NULL
             OR EXISTS (SELECT 1 FROM supplier_claim_tasks d WHERE d.claim_id = c.id AND d.kind = 'contact_supplier' AND d.done_at IS NOT NULL))
      ORDER BY c.id, t.id`)).rows.map((r: any) => ({ task_id: Number(r.task_id), claim_id: Number(r.claim_id), kind: String(r.kind), found_by: String(r.found_by) }));
  if (!opts.dryRun && rows.length) await query(`DELETE FROM supplier_claim_tasks WHERE id = ANY($1::bigint[])`, [rows.map((r) => r.task_id)]);
  return rows;
}

export interface SupersededRow { claim_id: number; po_id: string; order_id: string; supplier: string; po_line_item_id: string; product_name: string | null; kind: string; suggestion_id: number; suggestion_kind: string; suggestion_status: string }
/**
 * The one-time sweep (Maria 2026-11-12): every converted badge claim whose line — or whose PO, through a whole-PO
 * suggestion — already carries a finder's suggestion (any status — the finder had figures there) is dismissed
 * "superseded by found claim". Dry run lists them.
 */
export async function sweepSupersededConverted(query: QueryLike, opts: { dryRun?: boolean } = {}): Promise<{ rows: SupersededRow[]; dismissed: number }> {
  const rows = (await query(
    `SELECT c.id AS claim_id, c.po_id, p.order_id, p.supplier, c.po_line_item_id, l.product_name, c.kind,
            s.id AS suggestion_id, s.kind AS suggestion_kind, s.status AS suggestion_status
       FROM supplier_claims c JOIN purchase_orders p ON p.id = c.po_id LEFT JOIN po_line_items l ON l.id = c.po_line_item_id
       JOIN LATERAL (SELECT s.id, s.kind, s.status FROM supplier_claims s WHERE s.po_id = c.po_id AND (s.po_line_item_id = c.po_line_item_id OR s.po_line_item_id IS NULL)
                       AND s.id <> c.id AND s.suggestion_key IS NOT NULL ORDER BY (s.po_line_item_id IS NULL), s.id LIMIT 1) s ON true
      WHERE c.po_line_item_id IS NOT NULL AND ${CONVERTED_BADGE_SQL} ORDER BY p.order_date, c.id`)).rows
    .map((r: any) => ({ ...r, claim_id: Number(r.claim_id), suggestion_id: Number(r.suggestion_id) })) as SupersededRow[];
  let dismissed = 0;
  if (!opts.dryRun) for (const r of rows) { await dismissClaim(query, r.claim_id, null, SUPERSEDED_REASON); dismissed++; }
  return { rows, dismissed };
}

/**
 * Write one suggested claim: status 'suggested', found_by, the key, event `found`, a review_suggestion task carrying the
 * reason (and enter_quantity when the qty is not known). The $ owed is auto from the line when a line and qty are known.
 */
export async function suggestClaim(query: QueryLike, s: Suggestion, opts: { dryRun?: boolean; existing?: Awaited<ReturnType<typeof existingClaims>> } = {}): Promise<SuggestOutcome> {
  const existing = opts.existing ?? (await existingClaims(query, [s.po_id]));
  const why = isNewSuggestion(s, existing);
  if (why !== "created") return { created: false, id: null, why };
  if (opts.dryRun) return { created: false, id: null, why: "dry_run" };
  let amount = s.amount;
  if (amount == null && s.po_line_item_id && s.qty != null) {
    const l = (await query(
      `SELECT l.qty_basis, l.price, l.adjusted_product_cost, l.retailer_units_per_product, p.subtotal, p.discount, p.tax, p.sh_donations
         FROM po_line_items l JOIN purchase_orders p ON p.id = l.po_id WHERE l.id = $1 AND l.po_id = $2`, [s.po_line_item_id, s.po_id])).rows[0];
    if (l) amount = claimAmount({ qty: s.qty, productPack: l.qty_basis === "product_legacy" ? 1 : l.retailer_units_per_product, adjustedProductCost: l.adjusted_product_cost, price: l.price, subtotal: l.subtotal, discount: l.discount, tax: l.tax, shipping: l.sh_donations });
  }
  const row = (await query(
    `INSERT INTO supplier_claims (po_id, po_line_item_id, kind, qty, amount_owed, amount_owed_source, found_at, note, status, found_by, source_email_id, source_items_json, suggestion_key, supplier_confirmed_at)
     VALUES ($1, $2, $3, $4, $5, 'auto', CURRENT_DATE, $6, 'suggested', $7, $8, $9, $10, $11) RETURNING id`,
    [s.po_id, s.po_line_item_id, s.kind, s.qty, amount, s.note ?? null, s.found_by, s.source_email_id ?? null, s.source_items_json == null ? null : JSON.stringify(s.source_items_json), s.key, s.kind === "canceled" ? s.confirmed_at ?? null : null])).rows[0];
  const id = Number(row.id);
  await query(`INSERT INTO supplier_claim_events (claim_id, type, summary, by) VALUES ($1, $2, $3, NULL)`, [id, "found", s.reason.slice(0, 500)]);
  await addTask(query, id, "review_suggestion", s.reason);
  if (s.qty == null) await addTask(query, id, "enter_quantity", "the quantity is not known yet — type it in Individual units");
  // The finder's figures replace a migration-101 badge conversion on the same line (Maria 2026-11-12).
  const superseded = await supersedeConvertedOnLine(query, s.po_id, s.po_line_item_id, { except: id });
  return { created: true, id, why: "created", ...(superseded.length ? { superseded } : {}) };
}

// ── The tracking rows a PO's delivery state rests on ─────────────────────────
export interface TrackingState {
  id: number; po_id: string; carrier: string; tracking_number: string;
  carrier_status: string | null; est_delivery_at: string | null; last_scan_at: string | null; delivered_at: string | null;
  velocity_tracking_status: string | null; shipped_at: string | null; updated_at: string; qty: number | null;
}
/** Delivered: EasyPost's delivered_at, else Velocity's status says delivered (its time = when AF recorded it). */
export function deliveredAt(t: Pick<TrackingState, "delivered_at" | "velocity_tracking_status" | "updated_at">): string | null {
  if (t.delivered_at) return t.delivered_at;
  if (t.velocity_tracking_status && /deliver/i.test(t.velocity_tracking_status)) return t.updated_at;
  return null;
}

export const TRACKING_STATE_SQL = `SELECT t.id, t.po_id, t.carrier, t.tracking_number, t.carrier_status, t.est_delivery_at::text AS est_delivery_at, t.last_scan_at::text AS last_scan_at,
    t.delivered_at::text AS delivered_at, t.velocity_tracking_status, t.shipped_at::text AS shipped_at, t.updated_at::text AS updated_at, t.qty
  FROM po_tracking t WHERE t.po_id = ANY($1::uuid[]) AND t.direction = 'inbound' AND t.tracking_number NOT LIKE 'email:%'
    AND NOT (t.status = 'unmatched' AND COALESCE(t.match_reason, '') = 'dismissed') ORDER BY t.po_id, t.id`;

// ── missing (D8) ─────────────────────────────────────────────────────────────
export interface AsinRowState {
  asin_row_id: string; po_id: string; order_id: string; supplier: string; asin: string | null;
  ordered_individual: number; canceled_individual: number; received_velocity_individual: number;
  /** Individual units per Product unit of the row's first line (the tracking qty is Product units). */
  product_pack: number | null;
  asin_rows_on_po: number; line_id: string | null; line_count: number;
}
export const MISSING_ROWS_SQL = `SELECT a.id AS asin_row_id, a.po_id, p.order_id, p.supplier, a.asin,
    ae.ordered_individual, ae.canceled_individual, ae.received_velocity_individual, ae.product_pack,
    (SELECT count(*)::int FROM po_asins x WHERE x.po_id = a.po_id) AS asin_rows_on_po,
    (SELECT l.id FROM po_line_items l WHERE l.po_asin_id = a.id ORDER BY l.position NULLS LAST, l.id LIMIT 1) AS line_id,
    (SELECT count(*)::int FROM po_line_items l WHERE l.po_asin_id = a.id) AS line_count
  FROM po_asins a JOIN purchase_orders p ON p.id = a.po_id JOIN po_asin_expected ae ON ae.id = a.id
  WHERE p.closed_at IS NULL AND p.ships_to = 'velocity' ORDER BY p.order_date, a.id`;

/** Pure: D8 for one ASIN row given its PO's tracking rows; null = nothing to suggest. */
export function missingSuggestion(row: AsinRowState, tracking: readonly TrackingState[], now: Date): Suggestion | null {
  if (!tracking.length) return null;
  const delivered = tracking.map(deliveredAt);
  if (delivered.some((d) => !d)) return null;
  const latest = delivered.reduce((m, d) => (d! > m! ? d : m))!;
  if (businessDaysBetween(latest, now) < MISSING_AFTER_BUSINESS_DAYS) return null;
  const ordered = num(row.ordered_individual), canceled = num(row.canceled_individual), received = num(row.received_velocity_individual);
  const statedQty = row.asin_rows_on_po === 1 && row.product_pack && tracking.every((t) => t.qty != null) ? tracking.reduce((s, t) => s + num(t.qty), 0) * num(row.product_pack) : null;
  const shipped = statedQty ?? Math.max(0, ordered - canceled);
  const basis = statedQty != null ? `the ${tracking.length} shipping email${tracking.length === 1 ? "" : "s"} state ${tracking.reduce((s, t) => s + num(t.qty), 0)} Product units` : `ordered ${ordered} − canceled ${canceled}`;
  if (!(received < shipped)) return null;
  const missing = shipped - received;
  const reason = `Velocity received ${received} Individual units, ${shipped} shipped (${basis}); every tracking delivered, the latest ${latest.slice(0, 10)}. ${missing} missing — possible causes: the supplier shipped a single instead of the case, or Velocity's pack size is wrong.`;
  return {
    po_id: row.po_id, order_id: row.order_id, supplier: row.supplier, po_line_item_id: row.line_id, kind: "missing", qty: missing, amount: null,
    reason, key: `missing:${row.asin_row_id}:${shipped}:${received}`, found_by: "auto", rule: "missing_after_delivery",
    note: row.line_count > 1 ? `the ASIN row has ${row.line_count} lines; the claim sits on the first` : null,
  };
}

// ── never_received ───────────────────────────────────────────────────────────
export interface PoState {
  po_id: string; order_id: string; supplier: string; ships_to: string | null; order_date: string; order_total: number | null;
  line_count: number; single_line_id: string | null;
  tracking_rows_any: number; expected_individual: number; received_individual: number; shipped_fba_individual: number;
}
export const PO_STATE_SQL = `SELECT p.id AS po_id, p.order_id, p.supplier, p.ships_to, p.order_date::text AS order_date, p.order_total,
    (SELECT count(*)::int FROM po_line_items l WHERE l.po_id = p.id) AS line_count,
    (SELECT l.id FROM po_line_items l WHERE l.po_id = p.id ORDER BY l.position NULLS LAST, l.id LIMIT 1) AS single_line_id,
    (SELECT count(*)::int FROM po_tracking t WHERE t.po_id = p.id) AS tracking_rows_any,
    COALESCE((SELECT sum(ae.expected_individual) FROM po_asin_expected ae WHERE ae.po_id = p.id), 0) AS expected_individual,
    COALESCE((SELECT sum(ae.received_velocity_individual) FROM po_asin_expected ae WHERE ae.po_id = p.id), 0) AS received_individual,
    COALESCE((SELECT sum(ae.shipped_fba_individual) + sum(ae.received_amazon_individual) FROM po_asin_expected ae WHERE ae.po_id = p.id), 0) AS shipped_fba_individual
  FROM purchase_orders p WHERE p.closed_at IS NULL ORDER BY p.order_date, p.id`;

export type LostRule = "carrier_exception" | "eta_passed" | "no_scan" | "stale_in_transit";
/** Pure: why one undelivered inbound row looks lost, or null. */
export function lostRule(t: TrackingState, now: Date): LostRule | null {
  if (deliveredAt(t)) return null;
  if (t.carrier_status && ["failure", "error", "return_to_sender", "cancelled"].includes(t.carrier_status)) return "carrier_exception";
  if (t.est_delivery_at && businessDaysBetween(t.est_delivery_at, now) >= LOST_AFTER_BUSINESS_DAYS) return "eta_passed";
  if (t.last_scan_at && businessDaysBetween(t.last_scan_at, now) >= LOST_AFTER_BUSINESS_DAYS) return "no_scan";
  const since = t.shipped_at ?? t.updated_at;
  if (daysBetween(since, now) > IN_TRANSIT_MAX_DAYS && (!t.last_scan_at || daysBetween(t.last_scan_at, now) > STALE_SCAN_DAYS)) return "stale_in_transit";
  return null;
}
const RULE_TEXT: Record<LostRule, string> = {
  carrier_exception: "the carrier reports an exception / returned to sender",
  eta_passed: `the estimated delivery date passed ${LOST_AFTER_BUSINESS_DAYS} business days ago with no delivery`,
  no_scan: `no carrier scan for ${LOST_AFTER_BUSINESS_DAYS} business days`,
  stale_in_transit: `in transit for more than ${IN_TRANSIT_MAX_DAYS} days with no scan in the last ${STALE_SCAN_DAYS}`,
};

/** Pure: never_received for one open PO; null = nothing to suggest. */
export function neverReceivedSuggestion(po: PoState, tracking: readonly TrackingState[], now: Date): Suggestion | null {
  const received = num(po.received_individual) + num(po.shipped_fba_individual);
  if (received > 0 || num(po.expected_individual) <= 0) return null;
  if (tracking.length === 0) {
    // (b) with nothing: no tracking row of any kind (a placeholder is a shipping email) 14 days after the order date.
    if (num(po.tracking_rows_any) > 0) return null;
    if (po.order_date < NOTHING_RULE_FROM) return null;
    if (daysBetween(po.order_date, now) < NOTHING_AFTER_DAYS) return null;
    return {
      po_id: po.po_id, order_id: po.order_id, supplier: po.supplier, po_line_item_id: null, kind: "never_received", qty: num(po.expected_individual), amount: po.order_total == null ? null : num(po.order_total),
      reason: `Looks not received. Open a claim? No tracking number and no shipping email ${Math.floor(daysBetween(po.order_date, now))} days after the order date (${po.order_date}).`,
      key: `never_received:${po.po_id}:nothing:${po.order_date}`, found_by: "auto", rule: "nothing_after_order",
    };
  }
  const flagged = tracking.map((t) => ({ t, rule: lostRule(t, now) })).filter((x) => x.rule) as Array<{ t: TrackingState; rule: LostRule }>;
  if (!flagged.length) return null;
  const whole = flagged.length === tracking.length;
  const detail = flagged.map((x) => `${x.t.carrier} ${x.t.tracking_number}: ${RULE_TEXT[x.rule]}`).join("; ");
  const numbers = flagged.map((x) => x.t.tracking_number).sort().join(",");
  const line = !whole && po.line_count === 1 ? po.single_line_id : null;
  return {
    po_id: po.po_id, order_id: po.order_id, supplier: po.supplier, po_line_item_id: line, kind: "never_received",
    qty: whole ? num(po.expected_individual) : null, amount: whole && po.order_total != null ? num(po.order_total) : null,
    reason: `Looks not received. Open a claim? ${whole ? "Every shipment" : `${flagged.length} of ${tracking.length} shipments`} on the PO looks lost — ${detail}.`,
    key: `never_received:${po.po_id}:${flagged.map((x) => x.rule).sort().join("+")}:${numbers}`, found_by: "auto", rule: whole ? `lost:${flagged[0].rule}` : `lost_partial:${flagged[0].rule}`,
  };
}

// ── The sweep (component 30) ─────────────────────────────────────────────────
export interface SuggestionSweep { suggestions: Array<Suggestion & { outcome: SuggestOutcome["why"]; id: number | null }>; created: number; by_rule: Record<string, number> }

/** missing + never_received over every open PO; dry run lists what it would suggest. */
export async function sweepSuggestions(query: QueryLike, now = new Date(), opts: { dryRun?: boolean } = {}): Promise<SuggestionSweep> {
  const out: SuggestionSweep = { suggestions: [], created: 0, by_rule: {} };
  const asinRows = (await query(MISSING_ROWS_SQL)).rows as AsinRowState[];
  const pos = (await query(PO_STATE_SQL)).rows as PoState[];
  const poIds = Array.from(new Set([...asinRows.map((r) => r.po_id), ...pos.map((p) => p.po_id)]));
  const tracking = poIds.length ? ((await query(TRACKING_STATE_SQL, [poIds])).rows as TrackingState[]) : [];
  const byPo = new Map<string, TrackingState[]>();
  for (const t of tracking) byPo.set(t.po_id, [...(byPo.get(t.po_id) ?? []), t]);
  const existing = await existingClaims(query, poIds);
  const found: Suggestion[] = [];
  for (const r of asinRows) { const s = missingSuggestion(r, byPo.get(r.po_id) ?? [], now); if (s) found.push(s); }
  for (const p of pos) { const s = neverReceivedSuggestion(p, byPo.get(p.po_id) ?? [], now); if (s) found.push(s); }
  for (const s of found) {
    const o = await suggestClaim(query, s, { dryRun: opts.dryRun, existing: existing.filter((c) => c.po_id === s.po_id) });
    if (o.created) { out.created++; existing.push({ po_id: s.po_id, po_line_item_id: s.po_line_item_id, kind: s.kind, status: "suggested", suggestion_key: s.key }); }
    if (o.why === "created" || o.why === "dry_run") out.by_rule[s.rule] = (out.by_rule[s.rule] ?? 0) + 1;
    out.suggestions.push({ ...s, outcome: o.why, id: o.id });
  }
  return out;
}
