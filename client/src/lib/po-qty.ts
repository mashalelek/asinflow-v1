// PO quantity formatting (patch §4.1): quantities are ASIN (sellable-pack)
// counts, numeric(10,2); NULL = not tracked; fractional values are legal
// (7 units of a 6-pack = 1.17) and show 2 decimals ONLY when non-integer.

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
 * §4.3: an ASIN-level quantity expressed in product (supplier) units for a
 * 1:1 line: product qty = ASIN qty ÷ yield, where yield =
 * asin_qty_per_product (ASIN units per product unit; 0.33 for a 3-pack sold
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

/** Individual Units Ordered (col 10) = Ordered × Units/Pack (P1). */
export function individualUnits(qty: number | string, unitsPerPack: number): number {
  return Math.round(Number(qty) * unitsPerPack * 100) / 100; // decimals since migration 062
}

/** Tooltip on Received by Velocity and At Prep Center (Maria 2026-11-02). */
export const VELOCITY_QTY_TITLE = "Received by Velocity = all units Velocity has ever checked in for this line; At Prep Center = of those, still at Velocity.";

/** §4 column model — order and names, shared by the nested rows and the detail ASINs tab. */
export const PO_ASIN_COLUMNS = [
  { key: "asin", label: "ASIN", align: "left" },
  { key: "title", label: "Title", align: "left" },
  { key: "sku", label: "Amazon SKU", align: "left" },
  { key: "ordered", label: "Ordered", align: "right" },
  { key: "cost_per_unit", label: "Cost/Unit", align: "right" },
  { key: "total_cost", label: "Total Cost", align: "right" },
  { key: "prep", label: "Prep", align: "right" },
  { key: "sold_as", label: "Sold As", align: "left" },
  { key: "units_per_pack", label: "Units/Pack", align: "right" },
  { key: "individual_units", label: "Individual Units Ordered", align: "right" },
  { key: "canceled", label: "Canceled", align: "right" },
  { key: "returned", label: "Returned", align: "right" },
  { key: "shipped_supplier", label: "Shipped by Supplier", align: "right" },
  // Received by Velocity (Maria 2026-11-02): Velocity's cumulative check-in count, which At Prep Center (quantity_remaining) loses once units ship.
  { key: "received_velocity", label: "Received by Velocity", align: "right" },
  { key: "at_prep", label: "At Prep Center", align: "right" },
  { key: "at_warehouse", label: "At CQG Warehouse", align: "right" },
  { key: "lost_damaged_us", label: "Lost/damaged by us", align: "right" },
  { key: "shipped_fba", label: "Shipped FBA", align: "right" },
  { key: "received_amazon", label: "Received by Amazon", align: "right" },
  { key: "shipments", label: "Shipment IDs", align: "left" },
  // Row-level Status (2026-10-17): union of the ASIN's product lines; editable,
  // write-through to every line. Product rows carry their own.
  { key: "action_items", label: "Action Items", align: "left" },
] as const;

/**
 * How the table shows the §4 model (Maria 2026-11-05: the expanded ASIN table
 * clipped its right-hand columns at 1440 — 21 columns at 160 rem). Same values,
 * same order, 17 columns: ASIN · Amazon SKU over the Title in one Product
 * cell (the ASINs page's pattern), Individual Units Ordered under Ordered,
 * Units/Pack under Sold As. `of`: the model columns each one shows.
 */
export const PO_ASIN_DISPLAY_COLUMNS = [
  { key: "product", label: "Product", align: "left", of: ["asin", "sku", "title"] },
  { key: "ordered", label: "Ordered", align: "right", of: ["ordered", "individual_units"] },
  { key: "cost_per_unit", label: "Cost/Unit", align: "right", of: ["cost_per_unit"] },
  { key: "total_cost", label: "Total Cost", align: "right", of: ["total_cost"] },
  { key: "prep", label: "Prep", align: "right", of: ["prep"] },
  { key: "sold_as", label: "Sold As", align: "left", of: ["sold_as", "units_per_pack"] },
  { key: "canceled", label: "Canceled", align: "right", of: ["canceled"] },
  { key: "returned", label: "Returned", align: "right", of: ["returned"] },
  { key: "shipped_supplier", label: "Shipped by Supplier", align: "right", of: ["shipped_supplier"] },
  { key: "received_velocity", label: "Received by Velocity", align: "right", of: ["received_velocity"] },
  { key: "at_prep", label: "At Prep Center", align: "right", of: ["at_prep"] },
  { key: "at_warehouse", label: "At CQG Warehouse", align: "right", of: ["at_warehouse"] },
  { key: "lost_damaged_us", label: "Lost / damaged by us", align: "right", of: ["lost_damaged_us"] },
  { key: "shipped_fba", label: "Shipped FBA", align: "right", of: ["shipped_fba"] },
  { key: "received_amazon", label: "Received by Amazon", align: "right", of: ["received_amazon"] },
  { key: "shipments", label: "Shipment IDs", align: "left", of: ["shipments"] },
  { key: "action_items", label: "Action Items", align: "left", of: ["action_items"] },
] as const;
