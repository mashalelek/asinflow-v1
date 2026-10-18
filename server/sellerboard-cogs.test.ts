import { describe, it, expect, vi } from "vitest";
import * as XLSX from "xlsx";

// po-af-owned §2.4 (2026-10-18): Export SB COGS reads the AF PO tables
// (loadAfPoRows), not the Orders sheet; GOOGLE_SHEET_ID is not needed.
const afRows: any[] = [];
vi.mock("./po-af-source", () => ({ loadAfPoRows: async () => ({ rows: afRows, rawRowsRead: afRows.length, blankAsinRows: 0 }) }));
vi.mock("./google-sheets", () => ({ fetchSheetRowsWithMeta: async () => { throw new Error("the Orders sheet must not be read"); } }));
vi.mock("./db", () => ({ query: async () => ({ rows: [], rowCount: 0 }) }));

import { buildSellerboardCogs } from "./sellerboard-cogs";

const template = () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([{ ASIN: "B0TEST0001", SKU: "SKU-1" }]), "TDSheet");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
};
const r = (o: any) => ({ sheetRow: 2, status: "Ordered", asin: "B0TEST0001", cogs: 10, prepCost: 1, qty: 4, qtyRaw: "4", orderDate: "9/1/2026", ...o });

describe("buildSellerboardCogs source", () => {
  it("builds from the AF PO rows with no GOOGLE_SHEET_ID; canceled lines excluded", async () => {
    const saved = process.env.GOOGLE_SHEET_ID; delete process.env.GOOGLE_SHEET_ID;
    try {
      afRows.splice(0, afRows.length, r({}), r({ status: "Closed, Canceled", qtyRaw: "9" }));
      const out = await buildSellerboardCogs(template());
      expect(out.rows).toEqual([{ ASIN: "B0TEST0001", SKU: "SKU-1", CostPeriodStartDate: "9/1/2026", Cost: "11.00", BatchQuantity: "4" }]);
      expect(out.summary.rawRowsRead).toBe(2);
      expect(out.summary.skips.excludedByStatus).toBe(1);
    } finally { if (saved !== undefined) process.env.GOOGLE_SHEET_ID = saved; }
  });
});
