// AF PO tables as the data source for every former Orders-sheet reader
// (patch docs/claude_spec-patch-po-af-owned.md §2.4, 2026-10-18). The sheet
// is intake-only now; these readers no longer touch it:
//   - loadAfAsinCostMap  — the per-ASIN cost / prep / supplier map the sheet
//     COGS half (runSheetsSync), the COGS reset / sync-from-PO routes and the
//     onboarding supplier fallback used (SheetAsinData shape).
//   - loadAfPoRows       — sheet-shaped rows (SheetRow) for Upload to Velocity
//     (CSV + plan), Export SB COGS and the sourcing-cost export.
// "Newest" = order_date DESC, entry_seq DESC (po-entry-seq.ts), the same
// order the newest-first sheet had. A product line or ASIN row is
// "canceled" when every line is canceled for its full ordered quantity.
// Imports nothing that boots Express (no ./index) — scripts may use it.
import type { QueryLike } from "./scheduler/types";
import type { SheetAsinData, SheetRow } from "./google-sheets";
import { NEWEST_PO_ORDER } from "./po-entry-seq";

const num = (v: unknown): number | null => (v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const str = (v: unknown): string | null => (v == null || v === "" ? null : String(v));
const mdy = (d: unknown): string | null => {
  if (d == null) return null;
  const s = d instanceof Date ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}` : String(d).slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m ? `${Number(m[2])}/${Number(m[3])}/${m[1]}` : null;
};
const lineCanceled = `(l.qty_canceled IS NOT NULL AND l.qty_canceled >= COALESCE(l.qty_ordered, 0))`;

/**
 * Per ASIN: the newest ASIN row whose lines are not all canceled → cost/unit,
 * prep (NULL = not recorded → 0, the sheet reader's "blank prep = $0" rule),
 * supplier. orderedQty is 0 (On Order comes from asin-po-pipeline.ts).
 */
export async function loadAfAsinCostMap(query: QueryLike, asins?: readonly string[]): Promise<{ data: Map<string, SheetAsinData>; rowsRead: number }> {
  const filter = asins && asins.length > 0 ? `AND pa.asin = ANY($1::text[])` : "";
  const rows = (await query(
    `SELECT DISTINCT ON (pa.asin) pa.asin, pa.cost_per_unit, pa.prep_cost, p.supplier
       FROM po_asins pa JOIN purchase_orders p ON p.id = pa.po_id
      WHERE NOT COALESCE((SELECT bool_and(${lineCanceled}) FROM po_line_items l WHERE l.po_asin_id = pa.id), false) ${filter}
      ORDER BY pa.asin, ${NEWEST_PO_ORDER}`,
    asins && asins.length > 0 ? [asins.map((a) => a.toUpperCase())] : [],
  )).rows as any[];
  const data = new Map<string, SheetAsinData>();
  for (const r of rows) data.set(String(r.asin), { cogs: num(r.cost_per_unit), prepCost: num(r.prep_cost) ?? 0, orderedQty: 0, supplier: str(r.supplier) });
  const total = (await query(`SELECT COUNT(*)::int AS n FROM po_asins`)).rows[0]?.n ?? 0;
  return { data, rowsRead: Number(total) };
}

/**
 * U for a single-line ASIN row. po_asins.qty is an integer, so a pack order
 * whose units do not divide by units/pack (5 units of a 2-pack = 2.5 packs)
 * was stored rounded (3). The sheet carried 2.5 and Upload to Velocity
 * skipped it as invalid_pack_math; return the fractional pack count in that
 * case so the same fail-closed skip fires. Otherwise the stored qty (the
 * stored yields are 2 dp, so qty_ordered × yield is noisy: 48 × 0.33).
 */
export function singleLineQty(asinQty: number, ordered: number | null, yieldT: number | null, upp: number): number {
  if (upp > 1 && ordered != null && yieldT != null) {
    const units = Math.round(ordered * yieldT * upp);
    if (Math.abs(ordered * yieldT * upp - units) < 0.05 && units % upp !== 0) return Math.round((units / upp) * 100) / 100;
  }
  return asinQty;
}

/**
 * One SheetRow per product line, newest PO first (the sheet's order). Field
 * mapping: D status ← "Closed" when the PO is closed, "Canceled" when the line
 * is fully canceled; U qty ← the line's ASIN qty (singleLineQty for a single
 * line; ÷ unique_products for a bundle component; qty × yield for an S=1
 * multi-line group); AZ quantity ← units (bundle: sets × units per bundle,
 * the sheet's N × AY; otherwise U × units/pack); AX / AY /
 * S / T from the ASIN row and line. rawRowsRead = lines read.
 */
export async function loadAfPoRows(query: QueryLike): Promise<{ rows: SheetRow[]; rawRowsRead: number; blankAsinRows: number }> {
  const rs = (await query(
    `SELECT p.order_id, p.order_date, p.supplier, p.closed_at IS NOT NULL AS closed,
            pa.asin, pa.asin_name, pa.qty AS asin_qty, pa.cost_per_unit, pa.prep_cost, pa.sold_as, pa.units_per_pack, pa.unique_products,
            l.position, l.product_name, l.qty_ordered, l.asin_qty_per_product, ${lineCanceled} AS canceled,
            (SELECT COUNT(*)::int FROM po_line_items l2 WHERE l2.po_asin_id = pa.id) AS line_count
       FROM po_line_items l JOIN po_asins pa ON pa.id = l.po_asin_id JOIN purchase_orders p ON p.id = pa.po_id
      ORDER BY ${NEWEST_PO_ORDER}, pa.asin, l.position`,
  )).rows as any[];
  const rows: SheetRow[] = rs.map((r, i) => {
    const asinQty = num(r.asin_qty) ?? 0;
    const lines = Number(r.line_count) || 1;
    const bundle = String(r.sold_as) === "bundle" && (num(r.unique_products) ?? 1) > 1;
    const upp = num(r.units_per_pack) ?? 1;
    const lineQty = bundle ? asinQty / (num(r.unique_products) ?? 1)
      : lines === 1 ? singleLineQty(asinQty, num(r.qty_ordered), num(r.asin_qty_per_product), upp)
      : Math.round((num(r.qty_ordered) ?? 0) * (num(r.asin_qty_per_product) ?? 1) * 100) / 100;
    const status = [r.closed ? "Closed" : null, r.canceled ? "Canceled" : null].filter(Boolean).join(", ") || "Ordered";
    return {
      sheetRow: i + 2,
      status,
      asin: String(r.asin),
      cogs: num(r.cost_per_unit),
      prepCost: num(r.prep_cost),
      qty: lineQty,
      qtyRaw: String(lineQty),
      supplier: str(r.supplier),
      orderNumber: str(r.order_id),
      orderDate: mdy(r.order_date),
      retailer: str(r.supplier),
      itemName: str(r.asin_name),
      productName: str(r.product_name),
      qtyOrderedL: r.qty_ordered == null ? null : String(r.qty_ordered),
      setsN: String(bundle || lines > 1 ? asinQty : lineQty),
      uniqueS: String(num(r.unique_products) ?? 1),
      yieldT: r.asin_qty_per_product == null ? null : String(Number(r.asin_qty_per_product)),
      soldAs: str(r.sold_as),
      unitsPerPack: String(upp),
      // AZ: total units — sets × units per bundle for a bundle, packs × units/pack otherwise.
      quantity: String(Math.round((bundle ? asinQty : lineQty) * upp * 100) / 100),
    };
  });
  return { rows, rawRowsRead: rows.length, blankAsinRows: 0 };
}
