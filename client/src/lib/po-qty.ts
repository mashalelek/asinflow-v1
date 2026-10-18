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
