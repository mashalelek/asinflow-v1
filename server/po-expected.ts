// The two quantity views of migration 101 (SPEC §22 "Supplier claims" §4.6, D17): po_line_expected (per
// product line) and po_asin_expected (per ASIN row) carry every PO quantity in Individual, Product and ASIN
// units from the stored Individual base. Every reader of a net quantity — On Order, auto-close, the
// Velocity plan, the PO editor's rows, the Dashboard, the exports — selects from them; nothing divides by
// a pack size on its own. This module is the one place that names their columns for the TypeScript side,
// plus the two conversions the WRITERS need (what AF types or imports in ASIN / Product units → the stored
// Individual units, and back).
//
// Legacy rows (qty_basis = asin_legacy / product_legacy — the pack size was not known at the migration):
// the views read their stored ASIN / Product numbers as before and give NULL for the Individual columns;
// writers store in the row's basis (storedQtyFor* below) until the row converts (the migration's triggers,
// the moment sold_as + units_per_pack / retailer_units_per_product arrive).

/** The ASIN-row API fields (ASIN units, the names every client and reader has always used) ← po_asin_expected columns. */
export const ASIN_ROW_QTY_FIELDS = {
  qty: "ordered_asin",
  qty_shipped_supplier: "shipped_supplier_asin",
  received_velocity: "received_velocity_asin",
  qty_at_prep: "at_prep_asin",
  qty_at_warehouse: "at_warehouse_asin",
  qty_lost_damaged_us: "lost_damaged_us_asin",
  qty_shipped_fba: "shipped_fba_asin",
  qty_received_amazon: "received_amazon_asin",
  unreimbursed_loss_qty: "loss_asin",
  qty_canceled_asin: "canceled_asin",
  qty_returned_asin: "returned_asin",
  qty_expected_asin: "expected_asin",
} as const;
/** The Individual-units twins the API adds (NULL on a legacy row). */
export const ASIN_ROW_INDIVIDUAL_FIELDS = {
  qty_individual: "ordered_individual",
  qty_shipped_supplier_individual: "shipped_supplier_individual",
  received_velocity_individual: "received_velocity_individual",
  qty_at_prep_individual: "at_prep_individual",
  qty_at_warehouse_individual: "at_warehouse_individual",
  qty_lost_damaged_us_individual: "lost_damaged_us_individual",
  qty_shipped_fba_individual: "shipped_fba_individual",
  qty_received_amazon_individual: "received_amazon_individual",
  qty_canceled_individual: "canceled_individual",
  qty_returned_individual: "returned_individual",
  qty_expected_individual: "expected_individual",
} as const;

/**
 * The SELECT list that overlays an ASIN row's stored quantity columns with the view's ASIN-unit values under the
 * same names, plus the Individual twins, open_claims, qty_basis and product_pack. Written AFTER `pa.*` in a
 * SELECT, so the later duplicate column wins in node-pg's row object (checked by server/po-expected.db.test.ts).
 * `e` must be the po_asin_expected alias joined ON e.id = pa.id.
 */
export const ASIN_ROW_VIEW_SELECT = (e = "e") => [
  ...Object.entries(ASIN_ROW_QTY_FIELDS).map(([api, col]) => `${e}.${col} AS ${api}`),
  ...Object.entries(ASIN_ROW_INDIVIDUAL_FIELDS).map(([api, col]) => `${e}.${col} AS ${api}`),
  `${e}.open_claims AS open_claims`, `${e}.qty_basis AS qty_basis`, `${e}.product_pack AS product_pack`, `${e}.fully_canceled AS fully_canceled`,
].join(", ");

/** The line API fields (Product units, as always) ← po_line_expected columns, plus the Individual / ASIN twins. */
export const LINE_VIEW_SELECT = (e = "le") => [
  `${e}.ordered_product AS qty_ordered`, `${e}.received_product AS qty_received`,
  `${e}.ordered_individual AS qty_ordered_individual`, `${e}.received_individual AS qty_received_individual`,
  `${e}.ordered_asin AS qty_ordered_asin`, `${e}.canceled_product AS qty_canceled`, `${e}.returned_product AS qty_returned`,
  `${e}.canceled_individual AS qty_canceled_individual`, `${e}.returned_individual AS qty_returned_individual`,
  `${e}.claimed_individual AS qty_claimed_individual`, `${e}.expected_product AS qty_expected`, `${e}.expected_individual AS qty_expected_individual`,
  `${e}.qty_basis AS qty_basis`, `${e}.fully_canceled AS fully_canceled`,
].join(", ");

const num = (v: unknown): number | null => (v == null || v === "" ? null : Number(v));
const r2 = (v: number) => Math.round(v * 100) / 100;

export interface AsinRowBasis { qty_basis?: string | null; sold_as?: string | null; units_per_pack?: number | string | null }
export interface LineBasis { qty_basis?: string | null; retailer_units_per_product?: number | string | null }

/** An ASIN row's pack factor for storing: Individual per ASIN unit on a converted row (a bundle's N), 1 on a legacy row (ASIN units as stored). */
export function asinRowFactor(row: AsinRowBasis): number {
  if (row.qty_basis === "asin_legacy") return 1;
  const upp = num(row.units_per_pack);
  return upp != null && upp >= 1 ? upp : 1;
}
/** A line's pack factor for storing: Individual per Product unit on a converted line, 1 on a legacy line (Product units as stored). */
export function lineFactor(line: LineBasis): number {
  if (line.qty_basis === "product_legacy") return 1;
  const r = num(line.retailer_units_per_product);
  return r != null && r >= 1 ? r : 1;
}
/** ASIN units (what the form / a sheet / a Velocity ÷ gave) → the value to store on this row. */
export function storedQtyForAsinRow(asinUnits: number | null, row: AsinRowBasis): number | null {
  return asinUnits == null ? null : r2(asinUnits * asinRowFactor(row));
}
/** Product units (a typed line qty) → the value to store on this line. */
export function storedQtyForLine(productUnits: number | null, line: LineBasis): number | null {
  return productUnits == null ? null : r2(productUnits * lineFactor(line));
}
/** The stored value back to ASIN units / Product units (the view does this in SQL; for code that already holds the row). */
export function asinUnitsOf(stored: number | string | null | undefined, row: AsinRowBasis): number | null {
  const v = num(stored);
  return v == null ? null : r2(v / asinRowFactor(row));
}
export function productUnitsOf(stored: number | string | null | undefined, line: LineBasis): number | null {
  const v = num(stored);
  return v == null ? null : r2(v / lineFactor(line));
}
/** Individual units of a converted row / line (NULL on a legacy one — the pack is not known). */
export function individualOf(stored: number | string | null | undefined, basis: { qty_basis?: string | null }): number | null {
  const v = num(stored);
  return v == null || basis.qty_basis === "asin_legacy" || basis.qty_basis === "product_legacy" ? null : v;
}
