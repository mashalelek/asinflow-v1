import { describe, it, expect } from "vitest";

// Pins the importer's row-classification buckets — above all the
// blank_order_id guard (SPEC §22, 2026-08-24): a row with a parseable date
// but a blank/whitespace Order ID is an in-progress sheet entry and must
// land in its own row-identified bucket, never group as (supplier, "") and
// import. Found live: a mid-entry chewy.com row on the 2026-08-24 dry run.
import { classifyRows } from "./po-import-classify";

// COL indices from the importer: orderId 1, orderDate 2, supplier 4, asin 7.
function row(cells: Record<number, string>, srcRow: number) {
  const c: string[] = Array(52).fill("");
  for (const [i, v] of Object.entries(cells)) c[Number(i)] = v;
  return { cells: c, srcRow };
}

describe("classifyRows blank_order_id guard (§22, 2026-08-24)", () => {
  it("parseable 2026 date + blank Order ID → blank_order_id, row-identified, never imported", () => {
    const r = classifyRows([row({ 2: "8/24/2026", 4: "chewy.com", 7: "B000000001" }, 730)]);
    expect(r.blankOrderId).toBe(1);
    expect(r.rows).toHaveLength(0);
    expect(r.notes[0]).toContain("row 730");
    expect(r.notes[0]).toContain("chewy.com");
    expect(r.notes[0]).toContain("BLANK Order ID");
  });

  it("whitespace-only Order ID is blank (trimmed)", () => {
    const r = classifyRows([row({ 1: "   ", 2: "8/24/2026", 4: "chewy.com", 7: "B000000001" }, 5)]);
    expect(r.blankOrderId).toBe(1);
    expect(r.rows).toHaveLength(0);
  });

  it("blank Order ID + unparseable date stays a totals row", () => {
    const r = classifyRows([row({ 27: "$1,234.56" }, 3)]);
    expect(r.totalsRow).toBe(1);
    expect(r.blankOrderId).toBe(0);
  });

  it("blank Order ID + pre-2026 date buckets as nonYear2026 (year filter wins)", () => {
    const r = classifyRows([row({ 2: "8/24/2025", 4: "chewy.com", 7: "B000000001" }, 9)]);
    expect(r.nonYear2026).toBe(1);
    expect(r.blankOrderId).toBe(0);
  });

  it("filled Order ID + 2026 date imports; identity closes over a mixed set", () => {
    const input = [
      row({ 1: "555001", 2: "8/24/2026", 4: "chewy.com", 7: "B000000001" }, 2), // imports
      row({ 2: "8/24/2026", 4: "chewy.com", 7: "B000000002" }, 3),              // blank_order_id
      row({}, 4),                                                                // all-blank
      row({ 27: "$99.00" }, 5),                                                  // totals row
      row({ 1: "555002", 2: "1/1/2024", 7: "B000000003" }, 6),                   // nonYear2026
      row({ 1: "555003", 2: "8/24/2026" }, 7),                                   // noAsin
    ];
    const r = classifyRows(input);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].dateIso).toBe("2026-08-24");
    expect({
      totalsRow: r.totalsRow, blankRows: r.blankRows, nonYear2026: r.nonYear2026,
      blankOrderId: r.blankOrderId, noAsin: r.noAsin,
    }).toEqual({ totalsRow: 1, blankRows: 1, nonYear2026: 1, blankOrderId: 1, noAsin: 1 });
    const sum = r.totalsRow + r.blankRows + r.nonYear2026 + r.blankOrderId + r.noAsin + r.rows.length;
    expect(sum).toBe(input.length);
  });
});
