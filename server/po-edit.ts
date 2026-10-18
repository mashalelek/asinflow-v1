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
/** Money: a number (≥ 0 unless negative allowed), at most 2 dp; "$1,234.50" accepted. "" → null when nullable, else 0. */
export function money(opts: { nullable?: boolean; negative?: boolean } = {}): Parser {
  return (v) => {
    if (blank(v)) return { ok: true, value: opts.nullable ? null : "0" };
    const s = String(v).replace(/[$,\s]/g, "");
    if (!/^-?\d+(\.\d{1,2})?$/.test(s)) return { ok: false, error: "must be an amount with at most 2 decimals" };
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
};
/** §3 product-line fields (action items keep their own route). `asin` re-maps the line. */
export const LINE_FIELDS: Record<string, Parser> = {
  product_name: textOrNull, supplier_sku: textOrNull, price: money({ nullable: true }),
  qty_ordered: decQty({ positive: true }), qty_received: decQty({ nullable: true }), qty_returned: decQty({ nullable: true }), qty_canceled: decQty({ nullable: true }),
  asin_qty_per_product: yieldParser, notes: textOrNull, asin: asinParser,
};
/** §3 ASIN-row fields (the manual quantities, action items and Cancel ASIN keep their routes). */
export const ASIN_FIELDS: Record<string, Parser> = {
  sold_as: soldAsParser, units_per_pack: intQty({ nullable: false, min: 1 }), cost_per_unit: money({ nullable: true }), prep_cost: money({ nullable: true }),
  asin_name: textOrNull, notes: textOrNull,
};

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
export async function logEdits(query: QueryLike, poId: string, userId: number | null, entity: EditEntity, entityId: string | null, changes: readonly FieldChange[]): Promise<void> {
  for (const c of changes) {
    await query(`INSERT INTO po_edit_log (po_id, user_id, entity, entity_id, field, old_value, new_value) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
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
export function asinQtyFromLines(lines: ReadonlyArray<{ qty_ordered: number | string | null; asin_qty_per_product: number | string | null }>, soldAs: string): { qty: number; uniqueProducts: number | null } {
  const per = lines.map((l) => (Number(l.qty_ordered) || 0) * trueYield(Number(l.asin_qty_per_product ?? 1) || 1));
  const c2 = (x: number) => Math.round(x * 100) / 100; // numeric(10,2) since migration 062
  if (soldAs === "bundle") return { qty: per.length === 0 ? 0 : c2(Math.min(...per)), uniqueProducts: Math.max(lines.length, 1) };
  return { qty: c2(per.reduce((t, x) => t + x, 0)), uniqueProducts: null };
}

/** Recompute an ASIN row's Ordered (and a bundle's unique products) from its lines; logs a change. */
export async function recomputeAsinQty(query: QueryLike, poAsinId: string, userId: number | null): Promise<void> {
  const pa = (await query(`SELECT id, po_id, qty, sold_as, unique_products FROM po_asins WHERE id = $1`, [poAsinId])).rows[0];
  if (!pa) return;
  const lines = (await query(`SELECT qty_ordered, asin_qty_per_product FROM po_line_items WHERE po_asin_id = $1`, [poAsinId])).rows;
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

export interface EditResult { poId: string; changes: FieldChange[]; close: AutoCloseOutcome; warning?: string }

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
  const changes = changedFields(cur, p.edits);
  // §5.1: no cancel on a product whose ASIN row has units shipped to FBA.
  if (cur.po_asin_id != null && changes.some((c) => c.field === "qty_canceled" && Number(c.new ?? 0) > Number(c.old ?? 0))) {
    const ship = await fbaShipmentsOf(query, { poAsinId: String(cur.po_asin_id) });
    if (ship.rows > 0) throw new EditError(409, `${cur.asin}: ${shipmentBlockMessage(ship)}`);
  }
  const remap = changes.find((c) => c.field === "asin");
  const cols = changes.map((c) => c.field).filter((f) => f !== "asin");
  if (cols.length > 0) {
    await query(`UPDATE po_line_items SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(", ")} WHERE id = $1`, [lineId, ...cols.map((c) => p.edits[c])]);
  }
  await logEdits(query, poId, userId, "line", lineId, changes);
  const oldPa = cur.po_asin_id == null ? null : String(cur.po_asin_id);
  if (remap) {
    const target = await ensureAsinRow(query, poId, String(p.edits.asin), userId);
    await query(`UPDATE po_line_items SET po_asin_id = $2 WHERE id = $1`, [lineId, target]);
    await recomputeAsinQty(query, target, userId);
    if (oldPa) await dropAsinRowIfEmpty(query, oldPa, userId);
  } else if (oldPa && changes.some((c) => c.field === "qty_ordered" || c.field === "asin_qty_per_product")) {
    await recomputeAsinQty(query, oldPa, userId);
  }
  return { poId, changes, close: await evaluateAutoClose(poId, query) };
}

/** §3 add a product line (mapped to an ASIN; the ASIN row is created when the PO has none for it). */
export async function addLine(query: QueryLike, poId: string, body: unknown, userId: number | null): Promise<EditResult & { lineId: string }> {
  const b = (body ?? {}) as Record<string, unknown>;
  if (!("asin" in b)) throw new EditError(400, "asin is required");
  if (!("qty_ordered" in b)) throw new EditError(400, "qty_ordered is required");
  const p = parseEdits(LINE_FIELDS, { asin_qty_per_product: "1", ...b });
  if (!p.ok) throw new EditError(400, p.error);
  const po = (await query(`SELECT id FROM purchase_orders WHERE id = $1`, [poId])).rows[0];
  if (!po) throw new EditError(404, "PO not found");
  const paId = await ensureAsinRow(query, poId, String(p.edits.asin), userId);
  const pos = (await query(`SELECT COALESCE(MAX(position), -1) + 1 AS n FROM po_line_items WHERE po_asin_id = $1`, [paId])).rows[0]?.n ?? 0;
  const e = p.edits;
  const ins = await query(
    `INSERT INTO po_line_items (po_id, po_asin_id, position, product_name, supplier_sku, price, item_discount, qty_ordered, qty_received, qty_returned, qty_canceled, asin_qty_per_product, notes)
     VALUES ($1, $2, $3, $4, $5, $6, 0, $7, $8, $9, $10, $11, $12) RETURNING id`,
    [poId, paId, pos, e.product_name ?? null, e.supplier_sku ?? null, e.price ?? null, e.qty_ordered, e.qty_received ?? null, e.qty_returned ?? 0, e.qty_canceled ?? null, e.asin_qty_per_product, e.notes ?? null],
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
  const soldAs = String(p.edits.sold_as ?? cur.sold_as ?? "individual");
  if (soldAs === "individual") {
    if ("units_per_pack" in p.edits && Number(p.edits.units_per_pack) !== 1) throw new EditError(400, "units_per_pack must be 1 for an individual ASIN");
    if (p.edits.sold_as === "individual") p.edits.units_per_pack = 1;
  }
  const poId = String(cur.po_id);
  const changes = changedFields(cur, p.edits);
  if (changes.length > 0) {
    const cols = changes.map((c) => c.field);
    await query(`UPDATE po_asins SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(", ")} WHERE id = $1`, [poAsinId, ...cols.map((c) => p.edits[c])]);
    await logEdits(query, poId, userId, "asin", poAsinId, changes);
    if (changes.some((c) => c.field === "sold_as")) await recomputeAsinQty(query, poAsinId, userId);
  }
  return { poId, changes, close: await evaluateAutoClose(poId, query) };
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
