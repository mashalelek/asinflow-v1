// PO quantity formatting (patch §4.1): quantities are ASIN (sellable-pack)
// counts, numeric(10,2); NULL = not tracked; fractional values are legal
// (7 units of a 6-pack = 1.17) and show 2 decimals ONLY when non-integer.
import { PER_ASIN_UNIT, QTY_KIND } from "@shared/quantity-kinds";

export function qtyNumber(v: string | number | null | undefined): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

/** "—" for NULL, "12" for integers, "1.17" otherwise. */
export function fmtQty(v: string | number | null | undefined): string {
  const n = qtyNumber(v);
  if (n == null) return "—";
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

/**
 * §4.3: an ASIN-level quantity expressed in Product units for a
 * 1:1 line: Product units = ASIN units ÷ yield, where yield =
 * asin_qty_per_product (ASIN units per Product unit; 0.33 for a 3-pack sold
 * as three singles, 6 for a case of 12 sold as 2-packs). NULL in → NULL;
 * a missing/zero yield reads as 1.
 */
export function productQtyFromAsin(asinQty: string | number | null | undefined, yieldPerProduct: string | number | null | undefined): number | null {
  const q = qtyNumber(asinQty);
  if (q == null) return null;
  const y = qtyNumber(yieldPerProduct);
  const divisor = y == null || y === 0 ? 1 : y;
  return Math.round((q / divisor) * 100) / 100;
}

/** Ordered in Individual units (col 10) = Ordered (ASIN units) × Individual units per ASIN unit (P1). */
export function individualUnits(qty: number | string, unitsPerPack: number): number {
  return Math.round(Number(qty) * unitsPerPack * 100) / 100; // decimals since migration 062
}

/** Tooltip on Received by Velocity and At Prep Center (Maria 2026-11-02). */
export const VELOCITY_QTY_TITLE = "Received by Velocity = every ASIN unit Velocity has ever checked in for this line (Velocity counts Individual units; shown ÷ Individual units per ASIN unit); At Prep Center = of those, the ASIN units still at Velocity.";

/** §4 column model — order and names, shared by the nested rows and the detail ASINs tab. `kind`: the quantity kind shown as the muted line above the header (SPEC §22 "Quantity vocabulary"). */
export const PO_ASIN_COLUMNS = [
  { key: "asin", label: "ASIN", align: "left" },
  { key: "title", label: "Title", align: "left" },
  { key: "sku", label: "Amazon SKU", align: "left" },
  { key: "ordered", label: "Ordered", align: "right", kind: QTY_KIND.asin },
  { key: "cost_per_unit", label: "Cost/Unit", align: "right" },
  { key: "total_cost", label: "Total Cost", align: "right" },
  { key: "prep", label: "Prep", align: "right" },
  { key: "sold_as", label: "Sold As", align: "left" },
  { key: "units_per_pack", label: PER_ASIN_UNIT, align: "right" },
  { key: "individual_units", label: "Ordered", align: "right", kind: QTY_KIND.individual },
  { key: "canceled", label: "Canceled", align: "right", kind: QTY_KIND.asin },
  { key: "returned", label: "Returned", align: "right", kind: QTY_KIND.asin },
  { key: "shipped_supplier", label: "Shipped by Supplier", align: "right", kind: QTY_KIND.asin },
  // Received by Velocity (Maria 2026-11-02): Velocity's cumulative check-in count, which At Prep Center (quantity_remaining) loses once units ship.
  { key: "received_velocity", label: "Received by Velocity", align: "right", kind: QTY_KIND.asin },
  { key: "at_prep", label: "At Prep Center", align: "right", kind: QTY_KIND.asin },
  { key: "at_warehouse", label: "At CQG Warehouse", align: "right", kind: QTY_KIND.asin },
  { key: "lost_damaged_us", label: "Lost / damaged by us", align: "right", kind: QTY_KIND.asin },
  { key: "shipped_fba", label: "Shipped FBA", align: "right", kind: QTY_KIND.asin },
  { key: "received_amazon", label: "Received by Amazon", align: "right", kind: QTY_KIND.asin },
  { key: "shipments", label: "Shipment IDs", align: "left" },
  // Row-level Status (2026-10-17): union of the ASIN's product lines; editable,
  // write-through to every line. Product rows carry their own.
  { key: "action_items", label: "Action Items", align: "left" },
] as const;

/**
 * How the table shows the §4 model (Maria 2026-11-05: the expanded ASIN table
 * clipped its right-hand columns at 1440 — 21 columns at 160 rem). Same values,
 * same order, 17 columns: ASIN · Amazon SKU over the Title in one Product
 * cell (the ASINs page's pattern), the Individual units under Ordered,
 * Individual units per ASIN unit under Sold As. `of`: the model columns each one shows.
 * Since 2026-11-09 every quantity column shows its Individual count in grey
 * under the main number (SPEC §22 "Quantity vocabulary").
 */
export const PO_ASIN_DISPLAY_COLUMNS = [
  { key: "product", label: "Product", align: "left", of: ["asin", "sku", "title"] },
  { key: "ordered", label: "Ordered", align: "right", kind: QTY_KIND.asin, of: ["ordered", "individual_units"] },
  { key: "cost_per_unit", label: "Cost/Unit", align: "right", of: ["cost_per_unit"] },
  { key: "total_cost", label: "Total Cost", align: "right", of: ["total_cost"] },
  { key: "prep", label: "Prep", align: "right", of: ["prep"] },
  { key: "sold_as", label: "Sold As", align: "left", of: ["sold_as", "units_per_pack"] },
  { key: "canceled", label: "Canceled", align: "right", kind: QTY_KIND.asin, of: ["canceled"] },
  { key: "returned", label: "Returned", align: "right", kind: QTY_KIND.asin, of: ["returned"] },
  { key: "shipped_supplier", label: "Shipped by Supplier", align: "right", kind: QTY_KIND.asin, of: ["shipped_supplier"] },
  { key: "received_velocity", label: "Received by Velocity", align: "right", kind: QTY_KIND.asin, of: ["received_velocity"] },
  { key: "at_prep", label: "At Prep Center", align: "right", kind: QTY_KIND.asin, of: ["at_prep"] },
  { key: "at_warehouse", label: "At CQG Warehouse", align: "right", kind: QTY_KIND.asin, of: ["at_warehouse"] },
  { key: "lost_damaged_us", label: "Lost / damaged by us", align: "right", kind: QTY_KIND.asin, of: ["lost_damaged_us"] },
  { key: "shipped_fba", label: "Shipped FBA", align: "right", kind: QTY_KIND.asin, of: ["shipped_fba"] },
  { key: "received_amazon", label: "Received by Amazon", align: "right", kind: QTY_KIND.asin, of: ["received_amazon"] },
  { key: "shipments", label: "Shipment IDs", align: "left", of: ["shipments"] },
  { key: "action_items", label: "Action Items", align: "left", of: ["action_items"] },
] as const;
