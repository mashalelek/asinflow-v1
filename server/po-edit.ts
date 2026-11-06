// AF-owned PO editing (patch docs/claude_spec-patch-po-af-owned.md §3,
// 2026-10-18). AF is the system of record for every PO once it exists; these
// are the writers for the PO header, its product lines and its ASIN rows.
//
// Every write:
//   - validates each field through its parser (unknown fields are refused),
//   - writes only the fields whose value actually changes,
//   - records one po_edit_log row per changed field (entity po | line | asin
//     | shipment, old → new as text),
//   - re-runs the auto-close rule for the PO (§3 "every edit re-runs it").
// Derived values (Ordered, Individual Units, Canceled / Returned at ASIN
// level, Shipped FBA, Received by Amazon, At Prep) are never written here;
// an ASIN row's Ordered (po_asins.qty) is recomputed from its lines exactly
// as the importer derives it (Σ qty ordered × yield; a bundle's sets = its
// scarcest component) whenever a line's qty, yield or ASIN mapping changes.
import type { QueryLike } from "./scheduler/types";
import { evaluateAutoClose, type AutoCloseOutcome } from "./po-close";
import { trueYield } from "./po-af-source";
import { asinUnitsFromLines, lineRatio, ratioYield, retailerUnitsAtPack, type YieldLine } from "../shared/yield";

export type Parsed = { ok: true; value: unknown } | { ok: false; error: string };
type Parser = (v: unknown) => Parsed;

const blank = (v: unknown) => v === null || v === undefined || (typeof v === "string" && v.trim() === "");

/** Free text; "" / null clears (NULL). */
export const textOrNull: Parser = (v) => blank(v) ? { ok: true, value: null } : typeof v === "string" || typeof v === "number" ? { ok: true, value: String(v).trim() } : { ok: false, error: "must be text" };
/** Required text (supplier, order #). */
export const requiredText: Parser = (v) => blank(v) ? { ok: false, error: "is required" } : typeof v === "string" || typeof v === "number" ? { ok: true, value: String(v).trim() } : { ok: false, error: "must be text" };
/** YYYY-MM-DD, a real calendar date. */
export const isoDate: Parser = (v) => {
  const s = typeof v === "string" ? v.trim() : "";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return { ok: false, error: "must be YYYY-MM-DD" };
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]) ? { ok: true, value: s } : { ok: false, error: "is not a real date" };
};
/** Money: a number (≥ 0 unless negative allowed), at most 2 dp (`decimals`: a unit price takes 6); "$1,234.50" accepted. "" → null when nullable, else 0. */
export function money(opts: { nullable?: boolean; negative?: boolean; decimals?: number } = {}): Parser {
  const dp = opts.decimals ?? 2;
  const re = new RegExp(`^-?\\d+(\\.\\d{1,${dp}})?$`);
  return (v) => {
    if (blank(v)) return { ok: true, value: opts.nullable ? null : "0" };
    const s = String(v).replace(/[$,\s]/g, "");
    if (!re.test(s)) return { ok: false, error: `must be an amount with at most ${dp} decimals` };
    if (!opts.negative && s.startsWith("-")) return { ok: false, error: "must not be negative" };
    return { ok: true, value: s };
  };
}
/** Percentage 0–100, up to 4 dp; "" → null. */
export const pctOrNull: Parser = (v) => {
  if (blank(v)) return { ok: true, value: null };
  const s = String(v).replace(/[%\s]/g, "");
  if (!/^\d+(\.\d{1,4})?$/.test(s) || Number(s) > 100) return { ok: false, error: "must be a percentage between 0 and 100" };
  return { ok: true, value: s };
};
/** Whole non-negative number; "" → null when nullable. */
export function intQty(opts: { nullable?: boolean; min?: number } = {}): Parser {
  return (v) => {
    if (blank(v)) return opts.nullable ? { ok: true, value: null } : { ok: false, error: "is required" };
    const s = String(v).trim();
    if (!/^\d+$/.test(s)) return { ok: false, error: "must be a whole number" };
    const n = Number(s);
    if (n < (opts.min ?? 0)) return { ok: false, error: `must be at least ${opts.min ?? 0}` };
    return { ok: true, value: n };
  };
}
/** A PO quantity (migration 062): ≥ min, at most 2 decimals; "" → null when nullable. */
export function decQty(opts: { nullable?: boolean; positive?: boolean } = {}): Parser {
  return (v) => {
    if (blank(v)) return opts.nullable ? { ok: true, value: null } : { ok: false, error: "is required" };
    const s = String(v).replace(/,/g, "").trim();
    if (!/^\d+(\.\d{1,2})?$/.test(s)) return { ok: false, error: "must be a number with at most 2 decimals" };
    if (opts.positive && Number(s) <= 0) return { ok: false, error: "must be more than 0" };
    return { ok: true, value: Number(s) };
  };
}
/** Yield (ASIN qty per product): > 0, up to 4 dp. */
export const yieldParser: Parser = (v) => {
  const s = blank(v) ? "" : String(v).trim();
  if (!/^\d+(\.\d{1,4})?$/.test(s) || Number(s) <= 0) return { ok: false, error: "must be a number greater than 0" };
  return { ok: true, value: s };
};
export const SOLD_AS = ["individual", "multi-pack", "bundle"] as const;
export const soldAsParser: Parser = (v) => (SOLD_AS as readonly string[]).includes(String(v)) ? { ok: true, value: String(v) } : { ok: false, error: `must be one of ${SOLD_AS.join(", ")}` };
/** An ASIN row's sold as: one of SOLD_AS, or null — not known ("Pack size missing"; Edit PO's new ASIN row with no pack chosen, 2026-11-06). */
export const soldAsOrNullParser: Parser = (v) => (v === null ? { ok: true, value: null } : soldAsParser(v));
export const asinParser: Parser = (v) => {
  const s = typeof v === "string" ? v.trim().toUpperCase() : "";
  return /^[A-Z0-9]{10}$/.test(s) ? { ok: true, value: s } : { ok: false, error: "must be a 10-character ASIN" };
};

/** §3 header fields (PO edit drawer). */
export const HEADER_FIELDS: Record<string, Parser> = {
  supplier: requiredText, order_id: requiredText, order_date: isoDate,
  subtotal: money(), tax: money(), sh_donations: money(), discount: money(), refund_amount: money(), order_total: money(),
  payment_method: textOrNull, weighted_gc_discount_pct: pctOrNull, promo: textOrNull, cashback_site: textOrNull, cashback_pct: pctOrNull,
  purchased_by: textOrNull, notes: textOrNull,
  // Alternate order #s (migration 086): comma-separated, as typed.
  alt_order_ids: (v) => { const r = textOrNull(v); return r.ok && r.value ? { ok: true, value: String(r.value).split(/[\s,;/]+/).filter(Boolean).join(", ") } : r; },
  // Capture PO patch (2026-10-31): the sheet fields AF lacked.
  email_used: textOrNull,
  cashback_status: (v) => (blank(v) ? { ok: true, value: null } : ["pending", "received", "denied"].includes(String(v)) ? { ok: true, value: String(v) } : { ok: false, error: "must be pending, received or denied" }),
  purchased_by_user_id: (v) => (blank(v) ? { ok: true, value: null } : /^\d+$/.test(String(v)) ? { ok: true, value: Number(v) } : { ok: false, error: "must be a user id" }),
  // SPEC §26: where the PO ships — drives the tracking routing rules.
  ships_to: (v) => (v === "velocity" || v === "home" ? { ok: true, value: v } : { ok: false, error: "must be velocity or home" }),
};
/** §3 product-line fields (action items keep their own route). `asin` re-maps the line. */
export const LINE_FIELDS: Record<string, Parser> = {
  // A unit price takes 6 decimals; line_total = the line's money as captured (migration 087, 2026-11-04), NULL = price × qty.
  product_name: textOrNull, supplier_sku: textOrNull, price: money({ nullable: true, decimals: 6 }), line_total: money({ nullable: true }),
  // Free-item deals (migration 097, 2026-11-06): the unit price before a multi-buy deal — the line's allocation weight.
  regular_price: money({ nullable: true, decimals: 6 }),
  qty_ordered: decQty({ positive: true }), qty_received: decQty({ nullable: true }), qty_returned: decQty({ nullable: true }), qty_canceled: decQty({ nullable: true }),
  // Exact yield (migration 080, 2026-11-02): two integers, never a decimal — the derived asin_qty_per_product is written alongside, read-only.
  retailer_units_per_product: intQty({ nullable: false, min: 1 }), asin_units_per_pack: intQty({ nullable: false, min: 1 }), notes: textOrNull, asin: asinParser,
};
/** §3 ASIN-row fields (the manual quantities, action items and Cancel ASIN keep their routes). */
export const ASIN_FIELDS: Record<string, Parser> = {
  sold_as: soldAsOrNullParser, units_per_pack: intQty({ nullable: true, min: 1 }), cost_per_unit: money({ nullable: true }), prep_cost: money({ nullable: true }),
  asin_name: textOrNull, notes: textOrNull,
  // Capture PO patch §7 (2026-10-31): the COGS adjustment (a v2 PO recomputes its COGS from it) and the two other costs.
  cogs_adjustment: money({ nullable: true, negative: true }), cogs_adjustment_reason: textOrNull, sourcing_cost: money({ nullable: true }), paid_cost: money({ nullable: true }),
};
/** Header / line / ASIN-row fields whose change should recompute a v2 PO's costs (routes call recomputePoCosts after the edit). */
// v3 (2026-11-04): tax and shipping are in COGS; the order total decides whether the line totals already net the discount.
export const COST_RELEVANT_FIELDS = new Set(["subtotal", "discount", "tax", "sh_donations", "order_total", "weighted_gc_discount_pct", "price", "line_total", "regular_price", "qty_ordered", "retailer_units_per_product", "asin_units_per_pack", "cogs_adjustment"]);

/** Validate a body against a field spec. Unknown keys are an error (a typo never silently does nothing). */
export function parseEdits(spec: Record<string, Parser>, body: unknown): { ok: true; edits: Record<string, unknown> } | { ok: false; error: string } {
  if (body == null || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "body must be an object of field: value" };
  const edits: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    const p = spec[k];
    if (!p) return { ok: false, error: `${k} is not an editable field (allowed: ${Object.keys(spec).join(", ")})` };
    const r = p(v);
    if (!r.ok) return { ok: false, error: `${k} ${r.error}` };
    edits[k] = r.value;
  }
  if (Object.keys(edits).length === 0) return { ok: false, error: "nothing to update" };
  return { ok: true, edits };
}

/** Canonical text of a stored / new value, for change detection and the log. Dates as YYYY-MM-DD, numbers without trailing zeros. */
export function asLogText(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`;
  if (Array.isArray(v)) return v.join(", ");
  const s = String(v);
  // Numbers lose trailing zeros ("12.50" → "12.5"); a leading-zero code (ISBN-style ASIN 0349125937) stays text.
  return /^-?(0|[1-9]\d*)(\.\d+)?$/.test(s) ? String(Number(s)) : s;
}

export interface FieldChange { field: string; old: string | null; new: string | null }
/** The fields whose value actually changes. */
export function changedFields(current: Record<string, unknown>, edits: Record<string, unknown>): FieldChange[] {
  const out: FieldChange[] = [];
  for (const [k, v] of Object.entries(edits)) {
    const o = asLogText(current[k]), n = asLogText(v);
    if (o !== n) out.push({ field: k, old: o, new: n });
  }
  return out;
}

export type EditEntity = "po" | "line" | "asin" | "shipment";
/** One po_edit_log row per changed field. */
/** opts.derived: a value AF computed (recomputePoCosts), not one a user typed — migration 091. */
export async function logEdits(query: QueryLike, poId: string, userId: number | null, entity: EditEntity, entityId: string | null, changes: readonly FieldChange[], opts: { derived?: boolean } = {}): Promise<void> {
  for (const c of changes) {
    if (opts.derived) await query(`INSERT INTO po_edit_log (po_id, user_id, entity, entity_id, field, old_value, new_value, derived) VALUES ($1, $2, $3, $4, $5, $6, $7, true)`,
      [poId, userId, entity, entityId, c.field, c.old, c.new]);
    else await query(`INSERT INTO po_edit_log (po_id, user_id, entity, entity_id, field, old_value, new_value) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [poId, userId, entity, entityId, c.field, c.old, c.new]);
  }
}

export class EditError extends Error { constructor(public status: number, message: string) { super(message); } }

/**
 * The importer's Ordered for an ASIN row, to 2 decimals (migration 062):
 * Σ(qty ordered × yield) for individual / multi-pack lines; for a bundle,
 * each component line gives its sets (qty × yield) and the bundle can only
 * be built as often as its scarcest component — the minimum (equal to the
 * sheet's N whenever the components agree). S = the bundle's line count.
 */
export function asinQtyFromLines(lines: ReadonlyArray<YieldLine>, soldAs: string): { qty: number; uniqueProducts: number | null } {
  // Exact since migration 080: a line with its two integers adds qty × retailer ÷ asin as a fraction, rounded once (2 dp, numeric(10,2)); a line without them adds qty × its stored yield read as the fraction it stands for (trueYield), as before.
  return asinUnitsFromLines(lines, soldAs, trueYield);
}

/** Recompute an ASIN row's Ordered (and a bundle's unique products) from its lines; logs a change. */
export async function recomputeAsinQty(query: QueryLike, poAsinId: string, userId: number | null): Promise<void> {
  const pa = (await query(`SELECT id, po_id, qty, sold_as, unique_products FROM po_asins WHERE id = $1`, [poAsinId])).rows[0];
  if (!pa) return;
  const lines = (await query(`SELECT qty_ordered, asin_qty_per_product, retailer_units_per_product, asin_units_per_pack FROM po_line_items WHERE po_asin_id = $1`, [poAsinId])).rows;
  if (lines.length === 0) return;
  const next = asinQtyFromLines(lines, String(pa.sold_as ?? "individual"));
  const changes = changedFields({ qty: pa.qty }, { qty: next.qty });
  const upChange = pa.sold_as === "bundle" ? changedFields({ unique_products: pa.unique_products }, { unique_products: next.uniqueProducts }) : [];
  if (changes.length + upChange.length === 0) return;
  await query(`UPDATE po_asins SET qty = $2, unique_products = CASE WHEN sold_as = 'bundle' THEN $3 ELSE unique_products END WHERE id = $1`, [poAsinId, next.qty, next.uniqueProducts]);
  await logEdits(query, String(pa.po_id), userId, "asin", poAsinId, [...changes, ...upChange]);
}

/** FBA shipments on a PO / ASIN row (§5.1): shipment rows, units, distinct FBA ids. */
export async function fbaShipmentsOf(query: QueryLike, where: { poId?: string; poAsinId?: string }): Promise<{ units: number; fbaIds: string[]; rows: number }> {
  const cond = where.poAsinId ? `s.po_asin_id = $1` : `pa.po_id = $1`;
  const rows = (await query(
    `SELECT s.qty_shipped, s.fba_shipment_ids FROM po_asin_shipments s JOIN po_asins pa ON pa.id = s.po_asin_id WHERE ${cond}`,
    [where.poAsinId ?? where.poId],
  )).rows as Array<{ qty_shipped: string | number; fba_shipment_ids: string[] | null }>;
  const ids = new Set<string>();
  for (const r of rows) for (const x of r.fba_shipment_ids ?? []) ids.add(x);
  const units = Math.round(rows.reduce((t, r) => t + (Number(r.qty_shipped) || 0), 0) * 100) / 100;
  return { units, fbaIds: Array.from(ids).sort(), rows: rows.length };
}

/** §5.1 message: "N units shipped to FBA in <FBA ids>. Reassign the shipment to another PO first." */
export function shipmentBlockMessage(s: { units: number; fbaIds: string[] }): string {
  const n = Number.isInteger(s.units) ? String(s.units) : s.units.toFixed(2);
  return `${n} unit${s.units === 1 ? "" : "s"} shipped to FBA in ${s.fbaIds.length > 0 ? s.fbaIds.join(", ") : "a shipment with no FBA id yet"}. Reassign the shipment to another PO first.`;
}

/** Find or create this PO's ASIN row for `asin` (a line re-map / a new line). New rows take title + primary SKU from the catalog. */
export async function ensureAsinRow(query: QueryLike, poId: string, asin: string, userId: number | null, defaults: { cost_per_unit?: string | null; prep_cost?: string | null; sold_as?: string; units_per_pack?: number } = {}): Promise<string> {
  const hit = (await query(`SELECT id FROM po_asins WHERE po_id = $1 AND asin = $2`, [poId, asin])).rows[0];
  if (hit) return String(hit.id);
  const cat = (await query(`SELECT title, primary_sku FROM asins WHERE asin = $1`, [asin])).rows[0];
  const soldAs = defaults.sold_as ?? "individual";
  const ins = await query(
    `INSERT INTO po_asins (po_id, asin, asin_name, sku, qty, cost_per_unit, prep_cost, sold_as, units_per_pack, unique_products)
     VALUES ($1, $2, $3, $4, 0, $5, $6, $7, $8, $9) RETURNING id`,
    [poId, asin, cat?.title ?? null, cat?.primary_sku ?? null, defaults.cost_per_unit ?? null, defaults.prep_cost ?? "0", soldAs, soldAs === "individual" ? 1 : (defaults.units_per_pack ?? 1), soldAs === "bundle" ? 1 : null],
  );
  const id = String(ins.rows[0].id);
  await logEdits(query, poId, userId, "asin", id, [{ field: "asin row added", old: null, new: asin }]);
  return id;
}

/** Remove an ASIN row whose last line has gone. Blocked when it carries an FBA shipment (§5.1). */
async function dropAsinRowIfEmpty(query: QueryLike, poAsinId: string, userId: number | null): Promise<void> {
  const left = (await query(`SELECT COUNT(*)::int AS n FROM po_line_items WHERE po_asin_id = $1`, [poAsinId])).rows[0]?.n ?? 0;
  if (Number(left) > 0) { await recomputeAsinQty(query, poAsinId, userId); return; }
  const pa = (await query(`SELECT po_id, asin FROM po_asins WHERE id = $1`, [poAsinId])).rows[0];
  if (!pa) return;
  const ship = await fbaShipmentsOf(query, { poAsinId });
  if (ship.rows > 0) throw new EditError(409, `${pa.asin}: ${shipmentBlockMessage(ship)}`);
  await query(`DELETE FROM po_asins WHERE id = $1`, [poAsinId]);
  await logEdits(query, String(pa.po_id), userId, "asin", poAsinId, [{ field: "asin row removed", old: String(pa.asin), new: null }]);
}

export interface EditResult { poId: string; changes: FieldChange[]; close: AutoCloseOutcome; warning?: string; asinPackSet?: AsinPackSetResult }

/** §3 header edit. supplier / order # stay unique together; changing order # warns (Velocity matching). */
export async function editPoHeader(query: QueryLike, poId: string, body: unknown, userId: number | null): Promise<EditResult> {
  const p = parseEdits(HEADER_FIELDS, body);
  if (!p.ok) throw new EditError(400, p.error);
  const cur = (await query(`SELECT * FROM purchase_orders WHERE id = $1`, [poId])).rows[0];
  if (!cur) throw new EditError(404, "PO not found");
  const changes = changedFields(cur, p.edits);
  if (changes.length > 0) {
    const supplier = String(p.edits.supplier ?? cur.supplier), orderId = String(p.edits.order_id ?? cur.order_id);
    if (changes.some((c) => c.field === "supplier" || c.field === "order_id")) {
      const dup = (await query(`SELECT id FROM purchase_orders WHERE supplier = $1 AND order_id = $2 AND id <> $3`, [supplier, orderId, poId])).rows[0];
      if (dup) throw new EditError(409, `a PO ${supplier} ${orderId} already exists`);
    }
    const cols = changes.map((c) => c.field);
    await query(`UPDATE purchase_orders SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(", ")}, updated_at = NOW() WHERE id = $1`, [poId, ...cols.map((c) => p.edits[c])]);
    await logEdits(query, poId, userId, "po", poId, changes);
  }
  const close = await evaluateAutoClose(poId, query);
  const warning = changes.some((c) => c.field === "order_id") ? ORDER_ID_WARNING : undefined;
  return { poId, changes, close, warning };
}
export const ORDER_ID_WARNING = "order # is how shipments are matched from Velocity; changing it re-matches on the next Sync Shipments";

/** §3 product-line edit, including re-mapping it to another ASIN (the ASIN row is created / removed as needed). */
export async function editLine(query: QueryLike, lineId: string, body: unknown, userId: number | null): Promise<EditResult> {
  const p = parseEdits(LINE_FIELDS, body);
  if (!p.ok) throw new EditError(400, p.error);
  const cur = (await query(`SELECT l.*, pa.asin FROM po_line_items l LEFT JOIN po_asins pa ON pa.id = l.po_asin_id WHERE l.id = $1`, [lineId])).rows[0];
  if (!cur) throw new EditError(404, "product line not found");
  const poId = String(cur.po_id);
  const ordered = Number(p.edits.qty_ordered ?? cur.qty_ordered ?? 0);
  for (const k of ["qty_canceled", "qty_returned", "qty_received"] as const) {
    const v = k in p.edits ? p.edits[k] : cur[k];
    if (v != null && Number(v) > ordered) throw new EditError(400, `${k} (${v}) cannot exceed qty ordered (${ordered})`);
  }
  // A captured line total holds only for its price and qty: a new price or qty without one goes back to price × qty.
  if (cur.line_total != null && !("line_total" in p.edits) && (("price" in p.edits && changedFields(cur, { price: p.edits.price }).length) || ("qty_ordered" in p.edits && changedFields(cur, { qty_ordered: p.edits.qty_ordered }).length))) p.edits.line_total = null;
  const changes = changedFields(cur, p.edits);
  // §5.1: no cancel on a product whose ASIN row has units shipped to FBA.
  if (cur.po_asin_id != null && changes.some((c) => c.field === "qty_canceled" && Number(c.new ?? 0) > Number(c.old ?? 0))) {
    const ship = await fbaShipmentsOf(query, { poAsinId: String(cur.po_asin_id) });
    if (ship.rows > 0) throw new EditError(409, `${cur.asin}: ${shipmentBlockMessage(ship)}`);
  }
  const remap = changes.find((c) => c.field === "asin");
  const cols = changes.map((c) => c.field).filter((f) => f !== "asin");
  const vals: unknown[] = cols.map((c) => p.edits[c]);
  // The derived yield follows the two integers (history / display column, migration 080).
  if (cols.includes("retailer_units_per_product") || cols.includes("asin_units_per_pack")) {
    const r = lineRatio({ retailer_units_per_product: (p.edits.retailer_units_per_product ?? cur.retailer_units_per_product) as number | null, asin_units_per_pack: (p.edits.asin_units_per_pack ?? cur.asin_units_per_pack) as number | null });
    if (r) { cols.push("asin_qty_per_product"); vals.push(ratioYield(r)); }
  }
  if (cols.length > 0) {
    await query(`UPDATE po_line_items SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(", ")} WHERE id = $1`, [lineId, ...vals]);
  }
  await logEdits(query, poId, userId, "line", lineId, changes);
  const oldPa = cur.po_asin_id == null ? null : String(cur.po_asin_id);
  if (remap) {
    const target = await ensureAsinRow(query, poId, String(p.edits.asin), userId);
    await query(`UPDATE po_line_items SET po_asin_id = $2 WHERE id = $1`, [lineId, target]);
    await recomputeAsinQty(query, target, userId);
    if (oldPa) await dropAsinRowIfEmpty(query, oldPa, userId);
  } else if (oldPa && changes.some((c) => c.field === "qty_ordered" || c.field === "retailer_units_per_product" || c.field === "asin_units_per_pack")) {
    await recomputeAsinQty(query, oldPa, userId);
  }
  return { poId, changes, close: await evaluateAutoClose(poId, query) };
}

/** §3 add a product line (mapped to an ASIN; the ASIN row is created when the PO has none for it). */
export async function addLine(query: QueryLike, poId: string, body: unknown, userId: number | null): Promise<EditResult & { lineId: string }> {
  const b = (body ?? {}) as Record<string, unknown>;
  if (!("asin" in b)) throw new EditError(400, "asin is required");
  if (!("qty_ordered" in b)) throw new EditError(400, "qty_ordered is required");
  // Exact yield (migration 080): retailer units / product defaults to 1, ASIN units / pack to the ASIN row's pack size; never a decimal.
  const p = parseEdits(LINE_FIELDS, { retailer_units_per_product: "1", ...b });
  if (!p.ok) throw new EditError(400, p.error);
  const po = (await query(`SELECT id FROM purchase_orders WHERE id = $1`, [poId])).rows[0];
  if (!po) throw new EditError(404, "PO not found");
  const paId = await ensureAsinRow(query, poId, String(p.edits.asin), userId);
  const pos = (await query(`SELECT COALESCE(MAX(position), -1) + 1 AS n FROM po_line_items WHERE po_asin_id = $1`, [paId])).rows[0]?.n ?? 0;
  const e = p.edits;
  const rowPack = (await query(`SELECT sold_as, units_per_pack FROM po_asins WHERE id = $1`, [paId])).rows[0];
  const ratio = lineRatio({ retailer_units_per_product: e.retailer_units_per_product as number, asin_units_per_pack: (e.asin_units_per_pack as number | undefined) ?? (rowPack?.sold_as === "individual" ? 1 : Number(rowPack?.units_per_pack) || 1) }) ?? { retailer: 1, asinUnits: 1 };
  const ins = await query(
    `INSERT INTO po_line_items (po_id, po_asin_id, position, product_name, supplier_sku, price, item_discount, qty_ordered, qty_received, qty_returned, qty_canceled, asin_qty_per_product, retailer_units_per_product, asin_units_per_pack, notes, line_total, regular_price)
     VALUES ($1, $2, $3, $4, $5, $6, 0, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING id`,
    [poId, paId, pos, e.product_name ?? null, e.supplier_sku ?? null, e.price ?? null, e.qty_ordered, e.qty_received ?? null, e.qty_returned ?? 0, e.qty_canceled ?? null, ratioYield(ratio), ratio.retailer, ratio.asinUnits, e.notes ?? null, e.line_total ?? null, e.regular_price ?? null],
  );
  const lineId = String(ins.rows[0].id);
  const changes: FieldChange[] = [{ field: "line added", old: null, new: `${e.product_name ?? "product"} × ${e.qty_ordered} → ${e.asin}` }];
  await logEdits(query, poId, userId, "line", lineId, changes);
  await recomputeAsinQty(query, paId, userId);
  return { poId, lineId, changes, close: await evaluateAutoClose(poId, query) };
}

/** §3 remove a product line (its ASIN row goes with its last line). Refused when the ASIN row has an FBA shipment (§5.1). */
export async function removeLine(query: QueryLike, lineId: string, userId: number | null): Promise<EditResult> {
  const cur = (await query(`SELECT l.*, pa.asin FROM po_line_items l LEFT JOIN po_asins pa ON pa.id = l.po_asin_id WHERE l.id = $1`, [lineId])).rows[0];
  if (!cur) throw new EditError(404, "product line not found");
  const poId = String(cur.po_id);
  const oldPa = cur.po_asin_id == null ? null : String(cur.po_asin_id);
  if (oldPa) {
    // §5.1: a product of an ASIN row with units shipped to FBA cannot be deleted.
    const ship = await fbaShipmentsOf(query, { poAsinId: oldPa });
    if (ship.rows > 0) throw new EditError(409, `${cur.asin}: ${shipmentBlockMessage(ship)}`);
  }
  await query(`DELETE FROM po_line_items WHERE id = $1`, [lineId]);
  const changes: FieldChange[] = [{ field: "line removed", old: `${cur.product_name ?? "product"} × ${cur.qty_ordered ?? "?"} → ${cur.asin ?? "?"}`, new: null }];
  await logEdits(query, poId, userId, "line", lineId, changes);
  if (oldPa) await dropAsinRowIfEmpty(query, oldPa, userId);
  return { poId, changes, close: await evaluateAutoClose(poId, query) };
}

/** §3 ASIN-row edit: sold as, units/pack (1 for individual), cost/unit, prep, title, notes. */
export async function editAsinRow(query: QueryLike, poAsinId: string, body: unknown, userId: number | null): Promise<EditResult> {
  const p = parseEdits(ASIN_FIELDS, body);
  if (!p.ok) throw new EditError(400, p.error);
  const cur = (await query(`SELECT * FROM po_asins WHERE id = $1`, [poAsinId])).rows[0];
  if (!cur) throw new EditError(404, "ASIN row not found");
  // The pack (2026-11-06): NULL = not known, never read as individual. Sold as and units / pack are written together.
  const soldAs = ("sold_as" in p.edits ? p.edits.sold_as : cur.sold_as) as string | null;
  const upp = ("units_per_pack" in p.edits ? p.edits.units_per_pack : cur.units_per_pack) as number | null;
  if (soldAs == null) {
    if ("units_per_pack" in p.edits && p.edits.units_per_pack != null) throw new EditError(400, "units_per_pack must be empty while sold as is not known");
    if ("sold_as" in p.edits) p.edits.units_per_pack = null;
  } else if (soldAs === "individual") {
    if ("units_per_pack" in p.edits && Number(p.edits.units_per_pack) !== 1) throw new EditError(400, "units_per_pack must be 1 for an individual ASIN");
    if (p.edits.sold_as === "individual") p.edits.units_per_pack = 1;
  } else if (soldAs === "multi-pack" && ("sold_as" in p.edits || "units_per_pack" in p.edits) && !(Number(upp) >= 2)) {
    throw new EditError(400, "a multi-pack needs units per pack (2 or more)");
  }
  const poId = String(cur.po_id);
  const changes = changedFields(cur, p.edits);
  if (changes.length > 0) {
    const cols = changes.map((c) => c.field);
    await query(`UPDATE po_asins SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(", ")} WHERE id = $1`, [poAsinId, ...cols.map((c) => p.edits[c])]);
    await logEdits(query, poId, userId, "asin", poAsinId, changes);
    // A pack chosen for a row whose pack was not known keeps each line's stored yield (the ASIN units ordered are the
    // known fact): the line's ASIN units / pack become the pack, its retailer units follow — 2/1 with a 2-pack → 4/2.
    // A line with no pack integers whose stored yield is a rounding of r ÷ the pack takes r / pack exactly (0.33 at ×3 → 1/3).
    const packChanged = changes.some((c) => c.field === "sold_as" || c.field === "units_per_pack");
    if (packChanged && soldAs != null && soldAs !== "bundle") await keepYieldOnPack(query, poId, poAsinId, soldAs === "individual" ? 1 : Number(upp), userId, cur.sold_as == null);
    if (packChanged) await recomputeAsinQty(query, poAsinId, userId);
  }
  const packSet = changes.some((c) => c.field === "sold_as" || c.field === "units_per_pack") && (soldAs === "individual" || soldAs === "multi-pack")
    ? await setUnknownAsinPack(query, String(cur.asin), soldAs, soldAs === "individual" ? 1 : Number(upp), userId, poAsinId) : null;
  return { poId, changes, close: await evaluateAutoClose(poId, query), ...(packSet ? { asinPackSet: packSet } : {}) };
}

export interface AsinPackSetResult { asin: string; sold_as: string; units_per_pack: number; openRows: number; closedRows: number; closedSkipped: number; lines: number }

/**
 * An ASIN with NO pack on record (Maria 2026-11-06): a pack entered on a PO sets the record without asking
 * (asin_field_log, source po_form) and fills that ASIN's other PO rows whose pack is not known. Each line's retailer
 * units come from its stored yield (a line's own integers keep their ratio; a NULL-integer line takes
 * round(yield × pack) when the stored 2-dp yield is that ratio within 0.005). An open row always takes the pack and
 * its lines take the integers when Σ ordered × retailer ÷ pack reproduces the row's stored Ordered within 0.01; a
 * closed row is filled only when it reproduces. Stored quantities and costs are never changed. A record that already
 * has a pack is left alone (a differing one is the form's "Update ASIN in AF" question). Bundles are not packs.
 */
export async function setUnknownAsinPack(query: QueryLike, asin: string, soldAs: "individual" | "multi-pack", pack: number, userId: number | null, sourcePoAsinId?: string): Promise<AsinPackSetResult | null> {
  const a = asin.toUpperCase();
  if (!(Number.isInteger(pack) && pack >= 1)) return null;
  const rec = (await query(`SELECT sold_as, units_per_pack FROM asins WHERE asin = $1`, [a])).rows[0];
  if (!rec || rec.sold_as != null) return null;
  // A pack entered on a PO is Maria's own: confirmed (source po_entry); an unreviewed suggestion it replaces is cleared.
  await query(`UPDATE asins SET sold_as = $2, units_per_pack = $3, pack_source = 'po_entry', ${CLEAR_PACK_SUGGESTION_SQL} WHERE asin = $1`, [a, soldAs, pack]);
  for (const c of changedFields({ sold_as: rec.sold_as, units_per_pack: rec.units_per_pack }, { sold_as: soldAs, units_per_pack: pack })) {
    await query(`INSERT INTO asin_field_log (asin, user_id, field, old_value, new_value, source) VALUES ($1, $2, $3, $4, $5, $6)`, [a, userId, c.field, c.old, c.new, "po_form"]);
  }
  return { asin: a, sold_as: soldAs, units_per_pack: pack, ...(await fillAsinPackGaps(query, a, soldAs, pack, userId, sourcePoAsinId)) };
}

/** The suggestion / review columns an ASIN's confirmed pack clears (migration 098). */
export const CLEAR_PACK_SUGGESTION_SQL = `pack_suggested_sold_as = NULL, pack_suggested_units = NULL, pack_suggestion_source = NULL, pack_review_reason = NULL, pack_note = NULL`;

/**
 * An ASIN's confirmed pack fills its PO rows with no pack (Maria 2026-11-06): an open row always (its lines get the
 * pack integers when Σ ordered × retailer ÷ pack reproduces its stored Ordered within 0.01), a closed row only when
 * it reproduces. Stored quantities and costs never change; History on every row and line.
 */
export async function fillAsinPackGaps(query: QueryLike, asin: string, soldAs: "individual" | "multi-pack", pack: number, userId: number | null, excludePoAsinId?: string): Promise<Omit<AsinPackSetResult, "asin" | "sold_as" | "units_per_pack">> {
  const a = asin.toUpperCase();
  const out = { openRows: 0, closedRows: 0, closedSkipped: 0, lines: 0 };
  const rows = (await query(
    `SELECT pa.id, pa.po_id, pa.qty, p.closed_at IS NOT NULL AS closed FROM po_asins pa JOIN purchase_orders p ON p.id = pa.po_id
      WHERE pa.asin = $1 AND pa.sold_as IS NULL AND pa.id::text <> $2`, [a, excludePoAsinId ?? ""],
  )).rows;
  for (const r of rows) {
    const lines = (await query(`SELECT id, qty_ordered, retailer_units_per_product, asin_units_per_pack, asin_qty_per_product FROM po_line_items WHERE po_asin_id = $1`, [r.id])).rows;
    const fit = linesAtPack(lines, pack);
    const reproduces = fit != null && lines.length > 0 && Math.abs(fit.units - Number(r.qty)) <= 0.01 + 1e-9;
    if (r.closed && !reproduces) { out.closedSkipped++; continue; }
    const poId = String(r.po_id);
    await query(`UPDATE po_asins SET sold_as = $2, units_per_pack = $3 WHERE id = $1`, [r.id, soldAs, pack]);
    await logEdits(query, poId, userId, "asin", String(r.id), [{ field: "sold_as (ASIN pack set)", old: null, new: soldAs }, { field: "units_per_pack (ASIN pack set)", old: null, new: String(pack) }]);
    if (r.closed) out.closedRows++; else out.openRows++;
    if (!reproduces) continue;
    for (const l of fit!.lines) {
      if (Number(l.cur.retailer_units_per_product) === l.retailer && Number(l.cur.asin_units_per_pack) === pack) continue;
      await query(`UPDATE po_line_items SET retailer_units_per_product = $2, asin_units_per_pack = $3 WHERE id = $1`, [l.cur.id, l.retailer, pack]);
      await logEdits(query, poId, userId, "line", String(l.cur.id), changedFields(l.cur, { retailer_units_per_product: l.retailer, asin_units_per_pack: pack }).map((c) => ({ ...c, field: `${c.field} (ASIN pack set)` })));
      out.lines++;
    }
  }
  return out;
}

/** Each line's retailer units at this pack (its own ratio kept, else its stored yield within 0.005 of r ÷ pack) and Σ ordered × r ÷ pack; null when a line has no such whole number. */
export function linesAtPack<L extends { qty_ordered: unknown; retailer_units_per_product: unknown; asin_units_per_pack: unknown; asin_qty_per_product: unknown }>(lines: L[], pack: number): { units: number; lines: Array<{ cur: L; retailer: number }> } | null {
  const out: Array<{ cur: L; retailer: number }> = [];
  let units = 0;
  for (const l of lines) {
    const ratio = lineRatio(l as any);
    let r: number;
    if (ratio) { const k = (ratio.retailer * pack) / ratio.asinUnits; if (!Number.isInteger(k)) return null; r = k; }
    else { const k = retailerUnitsAtPack(l.asin_qty_per_product as any, pack); if (k == null) return null; r = k; }
    out.push({ cur: l, retailer: r });
    units += (Number(l.qty_ordered) || 0) * r / pack;
  }
  return { units: Math.round(units * 100) / 100, lines: out };
}

/** The ASIN row's lines take the pack as their ASIN units / pack, the yield unchanged; a line the pack cannot express in whole retailer units is left as it is. */
async function keepYieldOnPack(query: QueryLike, poId: string, poAsinId: string, pack: number, userId: number | null, scaleRatios: boolean): Promise<void> {
  if (!(Number.isInteger(pack) && pack >= 1)) return;
  const lines = (await query(`SELECT id, retailer_units_per_product, asin_units_per_pack, asin_qty_per_product FROM po_line_items WHERE po_asin_id = $1`, [poAsinId])).rows;
  for (const l of lines) {
    const R = Number(l.retailer_units_per_product), U = Number(l.asin_units_per_pack);
    if (!(Number.isInteger(R) && R > 0 && Number.isInteger(U) && U > 0)) {
      const r = retailerUnitsAtPack(l.asin_qty_per_product, pack);
      if (r == null) continue;
      const exact = { retailer_units_per_product: r, asin_units_per_pack: pack };
      await query(`UPDATE po_line_items SET retailer_units_per_product = $2, asin_units_per_pack = $3 WHERE id = $1`, [l.id, r, pack]);
      await logEdits(query, poId, userId, "line", String(l.id), changedFields({ retailer_units_per_product: l.retailer_units_per_product, asin_units_per_pack: l.asin_units_per_pack }, exact));
      continue;
    }
    if (!scaleRatios || U === pack || (R * pack) % U !== 0) continue;
    const next = { retailer_units_per_product: (R * pack) / U, asin_units_per_pack: pack };
    await query(`UPDATE po_line_items SET retailer_units_per_product = $2, asin_units_per_pack = $3 WHERE id = $1`, [l.id, next.retailer_units_per_product, next.asin_units_per_pack]);
    await logEdits(query, poId, userId, "line", String(l.id), changedFields(l, next));
  }
}

/**
 * Pack-size backfill (2026-10-29): a 2026 row whose Col AX was blank was
 * imported as individual ×1. Reset it to NULL (not filled in) so shipment
 * sync A fills it from Velocity, or it shows "Pack size missing". Only an
 * untouched default is reset — individual ×1 with no sold_as /
 * units_per_pack edit in the log; anything else is left alone.
 */
export async function resetDefaultedPackSize(query: QueryLike, poAsinId: string, userId: number | null): Promise<{ poId: string; reset: boolean }> {
  const cur = (await query(`SELECT id, po_id, sold_as, units_per_pack FROM po_asins WHERE id = $1`, [poAsinId])).rows[0];
  if (!cur) throw new EditError(404, "ASIN row not found");
  const poId = String(cur.po_id);
  const edited = (await query(`SELECT 1 FROM po_edit_log WHERE entity = 'asin' AND entity_id = $1 AND field IN ('sold_as', 'units_per_pack') LIMIT 1`, [poAsinId])).rows.length > 0;
  if (cur.sold_as !== "individual" || Number(cur.units_per_pack ?? 1) !== 1 || edited) return { poId, reset: false };
  await query(`UPDATE po_asins SET sold_as = NULL, units_per_pack = NULL WHERE id = $1`, [poAsinId]);
  await logEdits(query, poId, userId, "asin", poAsinId, [{ field: "sold_as", old: "individual", new: null }, { field: "units_per_pack", old: "1", new: null }]);
  return { poId, reset: true };
}

/** History tab: the PO's edit log, newest first, with the editor's name. */
export async function loadPoHistory(query: QueryLike, poId: string, limit = 500): Promise<any[]> {
  return (await query(
    `SELECT e.id, e.at, e.entity, e.entity_id, e.field, e.old_value, e.new_value, e.user_id, u.display_name AS user_name,
            CASE e.entity WHEN 'line' THEN (SELECT l.product_name FROM po_line_items l WHERE l.id::text = e.entity_id)
                          WHEN 'asin' THEN (SELECT pa.asin FROM po_asins pa WHERE pa.id::text = e.entity_id) END AS entity_label
       FROM po_edit_log e LEFT JOIN users u ON u.id = e.user_id
      WHERE e.po_id = $1 ORDER BY e.at DESC, e.id DESC LIMIT ${Math.max(1, Math.min(limit, 2000))}`,
    [poId],
  )).rows;
}
