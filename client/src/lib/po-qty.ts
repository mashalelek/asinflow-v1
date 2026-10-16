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

/** Individual Units Ordered (col 10) = Ordered × Units/Pack (P1). */
export function individualUnits(qty: number, unitsPerPack: number): number {
  return qty * unitsPerPack;
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
] as const;
