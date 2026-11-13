// The Orders-sheet row shapes — the ONLY thing left of the sheet client (D8 unplug, 2026-11-13: AF has no access to
// the Orders sheet; the share is removed, GOOGLE_SHEET_ID is deleted, server/sheet-read.ts is gone). The shapes stay
// because every former reader builds them from AF's PO tables (server/po-af-source.ts: loadAfAsinCostMap /
// loadAfPoRows) — the column letters in the comments are the sheet-era names the readers still use.

/** Per ASIN: the newest non-canceled PO ASIN row's cost, prep and supplier (loadAfAsinCostMap). */
export interface SheetAsinData {
  cogs: number | null;
  prepCost: number | null;
  /** Always 0 since 2026-10-17: On Order comes from the PO tables (asin-po-pipeline.ts). */
  orderedQty: number;
  supplier: string | null;
}

/** One row per product line, in the sheet's row shape (loadAfPoRows): the Velocity export, the SB COGS export and the sourcing-cost export read it. */
export interface SheetRow {
  sheetRow: number;        // 1-based row number (A2 = row 2); lines are numbered the same way
  status: string | null;   // D — "Closed" when the PO is closed, "Canceled" when the line is fully canceled
  asin: string;            // H
  cogs: number | null;     // Y
  prepCost: number | null; // AS
  qty: number | null;      // U — ASIN units
  qtyRaw: string;          // U verbatim, for skip diagnostics
  supplier: string | null; // E
  orderNumber: string | null;  // B
  orderDate: string | null;    // C (M/D/YYYY)
  retailer: string | null;     // E (alias of the supplier column)
  itemName: string | null;     // I
  // Bundle-derivation columns (2026-08-31, SPEC §11 Bundles) — verbatim strings.
  productName: string | null;  // G — component item_name
  qtyOrderedL: string | null;  // L — supplier qty ordered
  setsN: string | null;        // N — bundle set count
  uniqueS: string | null;      // S — unique products per ASIN (>= 2 = bundle)
  yieldT: string | null;       // T — component yield
  soldAs: string | null;       // AX
  unitsPerPack: string | null; // AY
  quantity: string | null;     // AZ — total Individual units
  /** The PO's ships_to. A Home PO is never pre-ticked for Velocity (SPEC §11). */
  shipsTo?: "home" | "velocity";
  // po-af-source, 2026-11-05: po_asins.qty was NULL (the quantity was recomputed from the line's retailer qty), and
  // the product line's 1-based position on its PO — for the Velocity skip message.
  asinUnitsMissing?: boolean;
  lineNumber?: number;
  /** The PO ASIN row (po_asins.id) the line belongs to — the Upload plan sums a row's lines (2026-11-07). */
  poAsinId?: string;
  /** The PO's alternate order #s (purchase_orders.alt_order_ids) — a Velocity order under one of them is this row's (an order # renamed after upload, 2026-11-13). */
  altOrderIds?: string[];
}
