// The three net-quantity readers EXACTLY as they were before claims commit 1 (migration 101) — frozen from commit
// a1e946b (2026-11-09) so the dry run can compute On Order, the auto-close verdict and the Velocity plan rows the OLD
// way on a pre-migration database and compare them with the new readers after the migration (SPEC patch §9 commit 1:
// "proves On Order / auto-close / Velocity plan identical before and after for every production PO").
//
// Nothing in the app imports this file; server/claims-proof.test.ts checks the compare logic and that these strings
// still name the pre-migration columns (qty_canceled, qty_returned, final_qty), which the live schema no longer has.
import type { QueryLike } from "../scheduler/types";
import { lineRatio, ratioYield } from "../../shared/yield";
import type { SheetRow } from "../google-sheets";
import { NEWEST_PO_ORDER } from "../po-entry-seq";
import { openLineItemsSql, EXTRA_UNITS_EXISTS_SQL, PACK_SIZE_MISMATCH_CLOSE_EXISTS_SQL } from "../po-action-items";
import { replacementTrackingItemsSql } from "../tracking-replacement-pair";
import { EXTRA_UNITS_SHIPPED, PACK_SIZE_MISMATCH, PACK_SIZE_MISSING } from "../po-status-map";
import { trueYield, lineAsinQty } from "../po-af-source";

const n = (v: unknown): number => (v == null ? 0 : typeof v === "number" ? v : parseFloat(String(v)) || 0);
const r2 = (v: number) => Math.round(v * 100) / 100;

// ── 1. On Order (server/asin-po-pipeline.ts before 101) ──
export const OLD_LINE_YIELD_SQL = `COALESCE(l.retailer_units_per_product::numeric / l.asin_units_per_pack, l.asin_qty_per_product, 1)`;
const OLD_DIVISOR = `(CASE WHEN pa.sold_as = 'bundle' AND COALESCE(pa.unique_products, 0) > 1 THEN pa.unique_products ELSE 1 END)`;
export const OLD_PIPELINE_ROWS_SQL = `
  WITH ln AS (
    SELECT l.po_asin_id,
           COUNT(*) AS n,
           COUNT(*) FILTER (WHERE l.qty_canceled IS NULL) AS canceled_untracked,
           SUM(l.qty_canceled * ${OLD_LINE_YIELD_SQL}) AS canceled_sum,
           COUNT(*) FILTER (WHERE l.qty_returned IS NULL) AS returned_untracked,
           SUM(l.qty_returned * ${OLD_LINE_YIELD_SQL}) AS returned_sum
      FROM po_line_items l
     GROUP BY l.po_asin_id
  )
  SELECT pa.asin, (p.closed_at IS NOT NULL) AS closed,
         (p.order_date >= COALESCE((SELECT MIN(shipped_at) FROM velocity_shipments), $1::date, DATE '9999-12-31')) AS reconciled,
         pa.qty, pa.qty_lost_damaged_us, pa.qty_at_prep, pa.qty_at_warehouse, pa.qty_shipped_fba, pa.qty_received_amazon,
         CASE WHEN COALESCE(ln.n, 0) = 0 OR ln.canceled_untracked > 0 THEN NULL ELSE ln.canceled_sum / ${OLD_DIVISOR} END AS qty_canceled_asin,
         CASE WHEN COALESCE(ln.n, 0) = 0 OR ln.returned_untracked > 0 THEN NULL ELSE ln.returned_sum / ${OLD_DIVISOR} END AS qty_returned_asin
    FROM po_asins pa JOIN purchase_orders p ON p.id = pa.po_id
    LEFT JOIN ln ON ln.po_asin_id = pa.id`;
export interface OldPipelineRow { asin: string; closed: boolean; reconciled: boolean; qty: unknown; qty_canceled_asin: unknown; qty_returned_asin: unknown; qty_lost_damaged_us: unknown; qty_at_prep: unknown; qty_at_warehouse: unknown; qty_shipped_fba: unknown }
export interface AsinPipeline { on_order: number; at_prep: number; at_warehouse: number; open_po_count: number }
export function oldComputePipeline(rows: OldPipelineRow[]): Map<string, AsinPipeline> {
  const out = new Map<string, AsinPipeline>();
  for (const r of rows) {
    const asin = String(r.asin).trim().toUpperCase();
    const p = out.get(asin) ?? { on_order: 0, at_prep: 0, at_warehouse: 0, open_po_count: 0 };
    const expected = n(r.qty) - n(r.qty_canceled_asin) - n(r.qty_returned_asin) - n(r.qty_lost_damaged_us);
    const shipped = n(r.qty_shipped_fba), atPrep = n(r.qty_at_prep), atWarehouse = n(r.qty_at_warehouse);
    if (r.reconciled && !r.closed) p.on_order += Math.max(expected - shipped - atPrep - atWarehouse, 0);
    p.at_prep += atPrep;
    p.at_warehouse += atWarehouse;
    if (!r.closed) p.open_po_count += 1;
    out.set(asin, p);
  }
  for (const p of Array.from(out.values())) { p.on_order = r2(p.on_order); p.at_prep = r2(p.at_prep); p.at_warehouse = r2(p.at_warehouse); }
  return out;
}
export async function oldLoadAsinPipeline(query: QueryLike, start: string | null): Promise<Map<string, AsinPipeline>> {
  return oldComputePipeline((await query(OLD_PIPELINE_ROWS_SQL, [start])).rows as OldPipelineRow[]);
}

// ── 2. Auto-close (server/po-close.ts + po-queries.ts + po-action-items.ts before 101) ──
const oldDerivedFromLines = (col: string) =>
  `(SELECT CASE WHEN COUNT(*) = 0 OR COUNT(*) FILTER (WHERE l.${col} IS NULL) > 0 THEN NULL
                ELSE SUM(l.${col} * ${OLD_LINE_YIELD_SQL})
                     / (CASE WHEN pa.sold_as = 'bundle' AND COALESCE(pa.unique_products, 0) > 1 THEN pa.unique_products ELSE 1 END) END
      FROM po_line_items l WHERE l.po_asin_id = pa.id)`;
export const OLD_CLOSE_ROWS_SQL = `SELECT pa.po_id, pa.qty, pa.qty_lost_damaged_us, pa.qty_shipped_fba,
       ${oldDerivedFromLines("qty_canceled")} AS qty_canceled_asin, ${oldDerivedFromLines("qty_returned")} AS qty_returned_asin
  FROM po_asins pa`;
const oldPackMissing = (a: string) => `(${a}.sold_as IS NULL AND EXISTS (SELECT 1 FROM po_line_items lx WHERE lx.po_asin_id = ${a}.id
  AND COALESCE(lx.qty_ordered, 0) > 0 AND COALESCE(lx.qty_canceled, 0) < lx.qty_ordered AND (lx.final_qty IS NULL OR lx.final_qty > 0))
  AND EXISTS (SELECT 1 FROM purchase_orders px WHERE px.id = ${a}.po_id AND px.closed_at IS NULL))`;
/** The old close set: stored items + Extra units + pack items + the open-DEFECT item (094) + the replacement pair. */
export const OLD_PO_CLOSE_ACTION_ITEMS_SQL = `ARRAY(${openLineItemsSql("l.po_id = p.id")}
  UNION SELECT '${EXTRA_UNITS_SHIPPED}' WHERE ${EXTRA_UNITS_EXISTS_SQL}
  UNION SELECT '${PACK_SIZE_MISSING}' WHERE EXISTS (SELECT 1 FROM po_asins pk WHERE pk.po_id = p.id AND ${oldPackMissing("pk")})
  UNION SELECT '${PACK_SIZE_MISMATCH}' WHERE ${PACK_SIZE_MISMATCH_CLOSE_EXISTS_SQL}
  UNION SELECT 'Missing / damaged from supplier' WHERE EXISTS (SELECT 1 FROM po_line_defects d WHERE d.po_id = p.id AND d.status = 'open')
  ${replacementTrackingItemsSql("p.id")})`;
export interface OldCloseRow { qty: unknown; qty_canceled_asin: unknown; qty_returned_asin: unknown; qty_lost_damaged_us: unknown; qty_shipped_fba: unknown }
export function oldAllUnitsAccounted(rows: OldCloseRow[]): boolean {
  if (rows.length === 0) return false;
  let anyShipped = false;
  for (const r of rows) {
    const shipped = n(r.qty_shipped_fba);
    const due = n(r.qty) - n(r.qty_canceled_asin) - n(r.qty_returned_asin) - n(r.qty_lost_damaged_us);
    if (shipped < due) return false;
    if (shipped > 0) anyShipped = true;
  }
  return anyShipped;
}
/** Per PO: the old verdict (every unit accounted for AND no blocking item). */
export async function oldAutoCloseVerdicts(query: QueryLike): Promise<Map<string, { verdict: boolean; items: string[] }>> {
  const rows = (await query(OLD_CLOSE_ROWS_SQL)).rows as Array<OldCloseRow & { po_id: string }>;
  const byPo = new Map<string, OldCloseRow[]>();
  for (const r of rows) { const k = String(r.po_id); if (!byPo.has(k)) byPo.set(k, []); byPo.get(k)!.push(r); }
  const items = (await query(`SELECT p.id, ${OLD_PO_CLOSE_ACTION_ITEMS_SQL} AS items FROM purchase_orders p`)).rows as Array<{ id: string; items: string[] }>;
  const out = new Map<string, { verdict: boolean; items: string[] }>();
  for (const p of items) out.set(String(p.id), { verdict: (p.items ?? []).length === 0 && oldAllUnitsAccounted(byPo.get(String(p.id)) ?? []), items: p.items ?? [] });
  return out;
}

// ── 3. The Velocity plan's PO rows (server/po-af-source.ts loadAfPoRows before 101) ──
const num = (v: unknown): number | null => (v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const str = (v: unknown): string | null => (v == null || v === "" ? null : String(v));
const mdy = (d: unknown): string | null => {
  if (d == null) return null;
  const s = d instanceof Date ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}` : String(d).slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m ? `${Number(m[2])}/${Number(m[3])}/${m[1]}` : null;
};
const oldLineCanceled = `(l.qty_canceled IS NOT NULL AND l.qty_canceled >= COALESCE(l.qty_ordered, 0))`;
export async function oldLoadAfPoRows(query: QueryLike): Promise<SheetRow[]> {
  const rs = (await query(
    `SELECT p.order_id, p.order_date, p.supplier, p.closed_at IS NOT NULL AS closed, p.ships_to,
            pa.id AS po_asin_id, pa.asin, pa.asin_name, pa.qty AS asin_qty, pa.cost_per_unit, pa.prep_cost, pa.sold_as, pa.units_per_pack, pa.unique_products,
            l.position, l.product_name, l.qty_ordered, l.asin_qty_per_product, l.retailer_units_per_product, l.asin_units_per_pack, l.units_per_bundle, ${oldLineCanceled} AS canceled,
            (SELECT COUNT(*)::int FROM po_line_items l2 WHERE l2.po_asin_id = pa.id) AS line_count
       FROM po_line_items l JOIN po_asins pa ON pa.id = l.po_asin_id JOIN purchase_orders p ON p.id = pa.po_id
      ORDER BY ${NEWEST_PO_ORDER}, pa.asin, l.position`,
  )).rows as any[];
  return rs.map((r, i) => {
    const asinUnitsMissing = r.asin_qty == null;
    const asinQty = num(r.asin_qty) ?? 0;
    const lines = Number(r.line_count) || 1;
    const bundle = String(r.sold_as) === "bundle" && (num(r.unique_products) ?? 1) > 1;
    const upp = num(r.units_per_pack) ?? 1;
    const ratio = lineRatio(r);
    const yieldNum = ratio ? ratio.retailer / ratio.asinUnits : num(r.asin_qty_per_product);
    const lineQty = asinUnitsMissing && num(r.qty_ordered) != null && yieldNum != null
      ? Math.round(((num(r.qty_ordered)! * yieldNum) / ((num(r.unique_products) ?? 1) || 1)) * 1e6) / 1e6
      : lineAsinQty(asinQty, num(r.qty_ordered), yieldNum, num(r.unique_products) ?? 1, lines, !!ratio);
    const status = [r.closed ? "Closed" : null, r.canceled ? "Canceled" : null].filter(Boolean).join(", ") || "Ordered";
    return {
      sheetRow: i + 2, status, asin: String(r.asin), cogs: num(r.cost_per_unit), prepCost: num(r.prep_cost), qty: lineQty, qtyRaw: String(lineQty),
      supplier: str(r.supplier), orderNumber: str(r.order_id), orderDate: mdy(r.order_date), retailer: str(r.supplier), itemName: str(r.asin_name), productName: str(r.product_name),
      qtyOrderedL: r.qty_ordered == null ? null : String(r.qty_ordered),
      setsN: String(bundle || lines > 1 ? asinQty : lineQty), uniqueS: String(num(r.unique_products) ?? 1),
      yieldT: bundle && ratio ? String(ratio.retailer) : ratio ? ratioYield(ratio) : r.asin_qty_per_product == null ? null : String(Number(r.asin_qty_per_product)),
      soldAs: str(r.sold_as), unitsPerPack: String(upp),
      quantity: String(Math.round((bundle ? asinQty : lineQty) * upp * 100) / 100),
      shipsTo: r.ships_to === "home" ? "home" : "velocity", asinUnitsMissing, lineNumber: (Number(r.position) || 0) + 1, poAsinId: String(r.po_asin_id),
    } as SheetRow;
  });
}
void trueYield;
