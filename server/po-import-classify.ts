// PO import — row classification, extracted from script/import-po-2026.ts
// (2026-10-03). Pure, no module state, no I/O.
//
// WHY it lives here and not in the script: po-import-classify.test.ts needs
// classifyRows, and importing it from the script dragged the script's entire
// one-off driver into the test typecheck (`npm run check:tests`) — 30 errors
// in code that is not test code and has never been in any tsconfig. The
// script imports these back, so there is still exactly ONE definition of
// each; only the import direction changed.
//
// The script owns everything else: sheet/CSV reading, cleanup hits,
// grouping, the SQL emit. Nothing here touches them.

// Column indices into the PO sheet's A:AZ row (shared with the importer).
export const COL = {
  rcpt: 0, orderId: 1, orderDate: 2, status: 3, supplier: 4,
  skuUpc: 5, productName: 6, asin: 7, asinName: 8,
  price: 10, qtyOrdered: 11, qtyReceived: 12, asinQtyTotal: 13,
  qtyReturned: 17, uniqueProductsPerAsin: 18, asinQtyPerProduct: 19, // Col R (renamed qty_returned, migration 030)
  lossQty: 21, lossAmount: 22, adjProductCost: 23, adjCogs: 24,
  subtotal: 27, tax: 28, shDonations: 29, discount: 30, refundAmount: 31, orderTotal: 32,
  paymentMethod: 34, weightedGcPct: 35, promo: 36, cashbackSite: 37, cashbackPct: 38,
  purchasedBy: 39, subscription: 40, notes: 41, prepCost: 44, emailUsed: 45,
  soldAs: 49, unitsPerPack: 50,
} as const;

export const t = (v: string | undefined) => String(v ?? "").trim();

// Order Date: split on "/" — NEVER new Date(str).
export function parseDateMDY(raw: string): { iso: string; year: number } | null {
  const parts = t(raw).split("/");
  if (parts.length !== 3) return null;
  const [m, d, y] = parts.map((p) => Number(p.trim()));
  if (!Number.isInteger(m) || !Number.isInteger(d) || !Number.isInteger(y)) return null;
  return { iso: `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`, year: y };
}

// ── row classification (identity buckets) ────────────────────────────────────
// Pure + exported so the blank_order_id guard is unit-testable without
// running the importer. Buckets are mutually exclusive and, with importedRows,
// must sum back to rawRowsRead (the printed identity).
export interface ClassifyResult {
  totalsRow: number;
  blankRows: number;
  nonYear2026: number;
  blankOrderId: number;
  noAsin: number;
  rows: Array<{ cells: string[]; srcRow: number; dateIso: string }>;
  notes: string[];
}

/**
 * `allYears` (2026-10-18, PO history import): keep rows of every year. The
 * frozen 2026 importer script calls it without options and stays 2026-only;
 * the repeatable sheet sync passes { allYears: true }.
 */
export function classifyRows(dataRows: Array<{ cells: string[]; srcRow: number }>, opts: { allYears?: boolean } = {}): ClassifyResult {
  let totalsRow = 0, blankRows = 0, nonYear2026 = 0, blankOrderId = 0, noAsin = 0;
  const rows: ClassifyResult["rows"] = [];
  const notes: string[] = [];
  for (const r of dataRows) {
    const c = r.cells;
    const allBlank = c.every((x) => t(x) === "");
    if (allBlank) { blankRows++; continue; }
    const orderId = t(c[COL.orderId]);
    const date = parseDateMDY(c[COL.orderDate]);
    if (orderId === "" && date === null) { totalsRow++; continue; }
    if (date === null || (!opts.allYears && date.year !== 2026)) { nonYear2026++; continue; }
    // Blank-Order-ID guard (2026-08-24): a parseable date with no Order ID is
    // an in-progress sheet row — it must never group as (supplier, "") and
    // import. Own bucket, row-identified.
    if (orderId === "") {
      blankOrderId++;
      notes.push(`row ${r.srcRow}: parseable date ${date.iso} but BLANK Order ID (supplier ${JSON.stringify(t(c[COL.supplier]))}) — row skipped to blank_order_id`);
      continue;
    }
    if (t(c[COL.asin]) === "") { noAsin++; notes.push(`row ${r.srcRow}: order ${orderId} has no ASIN — row skipped`); continue; }
    rows.push({ cells: c, srcRow: r.srcRow, dateIso: date.iso });
  }
  return { totalsRow, blankRows, nonYear2026, blankOrderId, noAsin, rows, notes };
}
