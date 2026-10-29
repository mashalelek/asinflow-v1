import { describe, it, expect, vi, beforeEach } from "vitest";
import * as XLSX from "xlsx";

// Pins the Amazon sourcing-cost export contract: we fill exactly one column
// ("Seller New Cost") of Amazon's own workbook, only for ASINs purchased in the
// selected window, only from po_sheet-sourced actual_cogs, and never resubmit a
// cost Amazon already approved from us.
//
// server/index.ts is mocked (importing it boots Express). ./db and
// ./google-sheets are mocked so the builder runs against a scripted PO sheet
// and scripted cost rows.
vi.mock("./log", () => ({ log: () => {} }));
vi.mock("./db", () => ({ query: async () => ({ rows: [] }), isDbAvailable: () => true }));

let sheetRows: any[] = [];
let rawRowsRead = 0;
let blankAsinRows = 0;

// Since po-af-owned §2.4 (2026-10-18) the rows come from the AF PO tables.
vi.mock("./po-af-source", () => ({
  loadAfPoRows: async () => ({ rows: sheetRows, rawRowsRead, blankAsinRows }),
}));
vi.mock("./google-sheets", () => ({
  fetchSheetRowsWithMeta: async () => { throw new Error("the Orders sheet must not be read"); },
}));

import { buildSourcingCost, sourcingCostFilename, parseYMDLocal } from "./sourcing-cost";

const HEADERS = [
  "Asin", "Fnsku", "Amazon Estimated Cost", "Latest Approved Cost",
  "Source of Latest Approved Cost", "Currency", "Date of Last Updated Cost",
  "Seller New Cost",
];

// Mirrors the real Amazon download: sheet named Part_1, ISO timestamp strings,
// "Seller New Cost" present but empty.
function makeWorkbook(
  rows: Array<[string, string, number, number, string]>,
  sheetName = "Part_1",
): Buffer {
  const aoa = [HEADERS, ...rows.map(([asin, fnsku, est, approved, src]) => [
    asin, fnsku, est, approved, src, "USD", "2026-07-11T13:42:31.279540911Z", "",
  ])];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  return XLSX.write(wb, { bookType: "xlsx", type: "buffer" }) as Buffer;
}

// Read the produced workbook back as objects.
function readBack(buf: Buffer, sheetName = "Part_1"): any[] {
  const wb = XLSX.read(buf, { type: "buffer" });
  return XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: "" });
}

function poRow(asin: string, orderDate: string, status: string | null = "ordered") {
  return { sheetRow: 2, status, asin, orderDate, cogs: null, prepCost: null, qty: 1, qtyRaw: "1", supplier: null, orderNumber: null, retailer: null, itemName: null, soldAs: null, unitsPerPack: null, quantity: null };
}

const FROM = parseYMDLocal("2026-08-01")!;
const TO = parseYMDLocal("2026-08-31")!;

// Scripted DB: asin -> { actual_cogs, cogs_source }. Absent = no estimates row.
function mkQuery(costs: Record<string, { actual_cogs: any; cogs_source: string | null }>) {
  return async (_sql: string, params?: any[]) => ({
    rows: (params?.[0] ?? []).map((asin: string) => ({
      asin,
      actual_cogs: costs[asin]?.actual_cogs ?? null,
      cogs_source: costs[asin]?.cogs_source ?? null,
    })),
  });
}

beforeEach(() => {
  sheetRows = [];
  rawRowsRead = 0;
  blankAsinRows = 0;
  delete process.env.GOOGLE_SHEET_ID; // not needed any more (po-af-owned §2.4)
});

describe("buildSourcingCost", () => {
  it("writes the PO cost into Seller New Cost and leaves every other column alone", async () => {
    sheetRows = [poRow("B001", "8/12/2026")];
    rawRowsRead = 1;
    const wb = makeWorkbook([["B001", "X001", 1.51, 1.51, "AMAZON"]]);

    const { buffer, summary } = await buildSourcingCost(wb, FROM, TO, mkQuery({
      B001: { actual_cogs: "4.96", cogs_source: "po_sheet" },
    }));

    const out = readBack(buffer);
    expect(out).toHaveLength(1);
    expect(out[0]["Seller New Cost"]).toBe(4.96);
    // Amazon's own columns survive the round-trip byte-for-byte.
    expect(out[0]["Asin"]).toBe("B001");
    expect(out[0]["Fnsku"]).toBe("X001");
    expect(out[0]["Amazon Estimated Cost"]).toBe(1.51);
    expect(out[0]["Latest Approved Cost"]).toBe(1.51);
    expect(out[0]["Source of Latest Approved Cost"]).toBe("AMAZON");
    expect(out[0]["Currency"]).toBe("USD");
    // The ISO timestamp must stay a STRING — a date coercion here would be
    // silently rejected by Amazon's parser.
    expect(out[0]["Date of Last Updated Cost"]).toBe("2026-07-11T13:42:31.279540911Z");
    expect(summary.rowsWritten).toBe(1);
    expect(summary.asinsWritten).toBe(1);
  });

  it("fans one ASIN cost out to every FNSKU row Amazon lists for it", async () => {
    sheetRows = [poRow("B001", "8/12/2026")];
    rawRowsRead = 1;
    const wb = makeWorkbook([
      ["B001", "X001", 3.34, 3.34, "AMAZON"],
      ["B001", "X002", 3.40, 3.40, "AMAZON"],
      ["B001", "X003", 3.41, 3.41, "AMAZON"],
    ]);

    const { buffer, summary } = await buildSourcingCost(wb, FROM, TO, mkQuery({
      B001: { actual_cogs: 4.96, cogs_source: "po_sheet" },
    }));

    expect(readBack(buffer).map((r) => r["Seller New Cost"])).toEqual([4.96, 4.96, 4.96]);
    expect(summary.rowsWritten).toBe(3);
    expect(summary.asinsWritten).toBe(1); // ASIN-level, not row-level
  });

  it("does not resubmit a cost Amazon already approved from us", async () => {
    sheetRows = [poRow("B001", "8/12/2026")];
    rawRowsRead = 1;
    const wb = makeWorkbook([["B001", "X001", 3.34, 4.96, "SELLER"]]);

    const { buffer, summary } = await buildSourcingCost(wb, FROM, TO, mkQuery({
      B001: { actual_cogs: 4.96, cogs_source: "po_sheet" },
    }));

    expect(readBack(buffer)[0]["Seller New Cost"]).toBe("");
    expect(summary.rowsWritten).toBe(0);
    expect(summary.skips.alreadyApproved).toBe(1);
  });

  it("DOES submit when the matching approved cost came from Amazon, not us", async () => {
    sheetRows = [poRow("B001", "8/12/2026")];
    rawRowsRead = 1;
    const wb = makeWorkbook([["B001", "X001", 4.96, 4.96, "AMAZON"]]);

    const { buffer, summary } = await buildSourcingCost(wb, FROM, TO, mkQuery({
      B001: { actual_cogs: 4.96, cogs_source: "po_sheet" },
    }));

    expect(readBack(buffer)[0]["Seller New Cost"]).toBe(4.96);
    expect(summary.skips.alreadyApproved).toBe(0);
  });

  it("submits a changed cost even where we are the approved source", async () => {
    sheetRows = [poRow("B001", "8/12/2026")];
    rawRowsRead = 1;
    const wb = makeWorkbook([["B001", "X001", 3.34, 4.96, "SELLER"]]);

    const { buffer } = await buildSourcingCost(wb, FROM, TO, mkQuery({
      B001: { actual_cogs: 5.25, cogs_source: "po_sheet" },
    }));

    expect(readBack(buffer)[0]["Seller New Cost"]).toBe(5.25);
  });

  it("refuses any cost that is not po_sheet-sourced, and names it", async () => {
    sheetRows = [poRow("B001", "8/12/2026"), poRow("B002", "8/13/2026"), poRow("B003", "8/14/2026")];
    rawRowsRead = 3;
    const wb = makeWorkbook([
      ["B001", "X001", 1, 1, "AMAZON"],
      ["B002", "X002", 1, 1, "AMAZON"],
      ["B003", "X003", 1, 1, "AMAZON"],
    ]);

    const { buffer, summary, details } = await buildSourcingCost(wb, FROM, TO, mkQuery({
      B001: { actual_cogs: 4.96, cogs_source: "po_sheet" },
      B002: { actual_cogs: 7.10, cogs_source: "manual" },
      B003: { actual_cogs: 2.00, cogs_source: "csv" },
    }));

    const out = readBack(buffer);
    expect(out.map((r) => r["Seller New Cost"])).toEqual([4.96, "", ""]);
    expect(summary.skips.notPoSourced).toBe(2);
    expect(details.notPoSourcedAsins.map((x) => x.asin).sort()).toEqual(["B002", "B003"]);
  });

  it("skips purchased ASINs with no estimates row, or a null / non-positive cost", async () => {
    sheetRows = [poRow("B001", "8/12/2026"), poRow("B002", "8/13/2026"), poRow("B003", "8/14/2026")];
    rawRowsRead = 3;
    const wb = makeWorkbook([
      ["B001", "X001", 1, 1, "AMAZON"],
      ["B002", "X002", 1, 1, "AMAZON"],
      ["B003", "X003", 1, 1, "AMAZON"],
    ]);

    const { summary, details } = await buildSourcingCost(wb, FROM, TO, mkQuery({
      B002: { actual_cogs: null, cogs_source: "po_sheet" },
      B003: { actual_cogs: 0, cogs_source: "po_sheet" },
    }));

    expect(summary.skips.noCogsRow).toBe(1);
    expect(details.noCogsRowAsins).toEqual(["B001"]);
    expect(summary.skips.badCost).toBe(2);
    expect(details.badCostAsins.map((x) => x.asin).sort()).toEqual(["B002", "B003"]);
    expect(summary.rowsWritten).toBe(0);
  });

  it("scopes to the selected window and drops canceled rows", async () => {
    sheetRows = [
      poRow("B001", "8/12/2026"),               // in range
      poRow("B002", "7/30/2026"),               // before
      poRow("B003", "9/02/2026"),               // after
      poRow("B004", "8/15/2026", "canceled"),   // canceled
      poRow("B005", "not-a-date"),              // unparseable
    ];
    // rawRowsRead is the TOTAL the sheet API returned, blanks included: 5
    // parsed rows + 2 blank-ASIN spacers dropped upstream.
    rawRowsRead = 7;
    blankAsinRows = 2;
    const wb = makeWorkbook([
      ["B001", "X001", 1, 1, "AMAZON"], ["B002", "X002", 1, 1, "AMAZON"],
      ["B003", "X003", 1, 1, "AMAZON"], ["B004", "X004", 1, 1, "AMAZON"],
      ["B005", "X005", 1, 1, "AMAZON"],
    ]);
    const costs = Object.fromEntries(
      ["B001", "B002", "B003", "B004", "B005"].map((a) => [a, { actual_cogs: 3, cogs_source: "po_sheet" }]),
    );

    const { buffer, summary } = await buildSourcingCost(wb, FROM, TO, mkQuery(costs));

    expect(readBack(buffer).map((r) => r["Seller New Cost"])).toEqual([3, "", "", "", ""]);
    expect(summary.purchasedAsins).toBe(1);
    expect(summary.skips.excludedByStatus).toBe(1);
    expect(summary.skips.excludedOutOfRange).toBe(2);
    expect(summary.skips.badOrMissingDate).toBe(1);

    // Row-accounting identity: every sheet row read lands in exactly one bucket.
    const s = summary.skips;
    expect(
      summary.blankAsinRows + s.excludedByStatus + s.badOrMissingDate +
      s.excludedOutOfRange + summary.includedRows,
    ).toBe(summary.rawRowsRead);
  });

  it("includes the window boundaries", async () => {
    sheetRows = [poRow("B001", "8/1/2026"), poRow("B002", "8/31/2026")];
    rawRowsRead = 2;
    const wb = makeWorkbook([["B001", "X001", 1, 1, "AMAZON"], ["B002", "X002", 1, 1, "AMAZON"]]);
    const { summary } = await buildSourcingCost(wb, FROM, TO, mkQuery({
      B001: { actual_cogs: 3, cogs_source: "po_sheet" },
      B002: { actual_cogs: 4, cogs_source: "po_sheet" },
    }));
    expect(summary.skips.excludedOutOfRange).toBe(0);
    expect(summary.purchasedAsins).toBe(2);
  });

  it("names ASINs that have a PO cost but are absent from Amazon's workbook", async () => {
    sheetRows = [poRow("B001", "8/12/2026"), poRow("B999", "8/13/2026")];
    rawRowsRead = 2;
    const wb = makeWorkbook([["B001", "X001", 1, 1, "AMAZON"]]);

    const { summary, details } = await buildSourcingCost(wb, FROM, TO, mkQuery({
      B001: { actual_cogs: 4.96, cogs_source: "po_sheet" },
      B999: { actual_cogs: 8.00, cogs_source: "po_sheet" },
    }));

    expect(summary.skips.notInWorkbook).toBe(1);
    expect(details.notInWorkbookAsins).toEqual(["B999"]);
    expect(summary.rowsWritten).toBe(1);
  });

  it("spans every Part_N sheet", async () => {
    sheetRows = [poRow("B001", "8/12/2026"), poRow("B002", "8/12/2026")];
    rawRowsRead = 2;
    const ws1 = XLSX.utils.aoa_to_sheet([HEADERS, ["B001", "X001", 1, 1, "AMAZON", "USD", "t", ""]]);
    const ws2 = XLSX.utils.aoa_to_sheet([HEADERS, ["B002", "X002", 1, 1, "AMAZON", "USD", "t", ""]]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws1, "Part_1");
    XLSX.utils.book_append_sheet(wb, ws2, "Part_2");
    const buf = XLSX.write(wb, { bookType: "xlsx", type: "buffer" }) as Buffer;

    const { buffer, summary } = await buildSourcingCost(buf, FROM, TO, mkQuery({
      B001: { actual_cogs: 4.96, cogs_source: "po_sheet" },
      B002: { actual_cogs: 7.25, cogs_source: "po_sheet" },
    }));

    expect(summary.sheetsScanned).toBe(2);
    expect(readBack(buffer, "Part_1")[0]["Seller New Cost"]).toBe(4.96);
    expect(readBack(buffer, "Part_2")[0]["Seller New Cost"]).toBe(7.25);
  });

  it("refuses a workbook that is not the Amazon bulk-update download", async () => {
    sheetRows = [];
    const wb = makeWorkbook([["B001", "X001", 1, 1, "AMAZON"]], "Sheet1");
    await expect(buildSourcingCost(wb, FROM, TO, mkQuery({}))).rejects.toThrow(/No Part_N sheet/);
  });

  it("refuses a Part_N sheet missing a column we depend on", async () => {
    sheetRows = [];
    const ws = XLSX.utils.aoa_to_sheet([["Asin", "Fnsku"], ["B001", "X001"]]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Part_1");
    const buf = XLSX.write(wb, { bookType: "xlsx", type: "buffer" }) as Buffer;
    await expect(buildSourcingCost(buf, FROM, TO, mkQuery({}))).rejects.toThrow(/Seller New Cost/);
  });

  it("locates columns by header text, not position", async () => {
    sheetRows = [poRow("B001", "8/12/2026")];
    rawRowsRead = 1;
    // Same columns, deliberately reordered.
    const ws = XLSX.utils.aoa_to_sheet([
      ["Seller New Cost", "Currency", "Asin", "Latest Approved Cost", "Source of Latest Approved Cost", "Fnsku"],
      ["", "USD", "B001", 1.51, "AMAZON", "X001"],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Part_1");
    const buf = XLSX.write(wb, { bookType: "xlsx", type: "buffer" }) as Buffer;

    const { buffer } = await buildSourcingCost(buf, FROM, TO, mkQuery({
      B001: { actual_cogs: 4.96, cogs_source: "po_sheet" },
    }));
    const out = readBack(buffer);
    expect(out[0]["Seller New Cost"]).toBe(4.96);
    expect(out[0]["Asin"]).toBe("B001");
  });

  // ── Reduction guard ────────────────────────────────────────────────────
  // Measured on the first live upload: Amazon took 73.5% of reductions and
  // only 17.2% of increases, so an unguarded run walks the reimbursement basis
  // down and cannot easily walk it back.
  it("never submits a cost below the approved value, whatever the source", async () => {
    sheetRows = [poRow("B001", "8/12/2026"), poRow("B002", "8/13/2026")];
    rawRowsRead = 2;
    const wb = makeWorkbook([
      ["B001", "X001", 3.00, 9.00, "SELLER"],
      ["B002", "X002", 3.00, 9.00, "AMAZON"],
    ]);

    const { buffer, summary, details } = await buildSourcingCost(wb, FROM, TO, mkQuery({
      B001: { actual_cogs: 2.80, cogs_source: "po_sheet" },
      B002: { actual_cogs: 2.80, cogs_source: "po_sheet" },
    }));

    expect(readBack(buffer).map((r) => r["Seller New Cost"])).toEqual(["", ""]);
    expect(summary.skips.wouldLowerApproved).toBe(2);
    expect(summary.rowsWritten).toBe(0);
    expect(details.wouldLowerAsins).toEqual([
      { asin: "B001", approved: 9, cost: 2.8, source: "SELLER" },
      { asin: "B002", approved: 9, cost: 2.8, source: "AMAZON" },
    ]);
  });

  it("still submits increases", async () => {
    sheetRows = [poRow("B001", "8/12/2026")];
    rawRowsRead = 1;
    const wb = makeWorkbook([["B001", "X001", 3.00, 4.00, "SELLER"]]);
    const { buffer, summary } = await buildSourcingCost(wb, FROM, TO, mkQuery({
      B001: { actual_cogs: 4.01, cogs_source: "po_sheet" },
    }));
    expect(readBack(buffer)[0]["Seller New Cost"]).toBe(4.01);
    expect(summary.skips.wouldLowerApproved).toBe(0);
  });

  it("counts an exact match as already-approved, not as a reduction", async () => {
    sheetRows = [poRow("B001", "8/12/2026")];
    rawRowsRead = 1;
    const wb = makeWorkbook([["B001", "X001", 3.00, 4.96, "SELLER"]]);
    const { summary } = await buildSourcingCost(wb, FROM, TO, mkQuery({
      B001: { actual_cogs: 4.96, cogs_source: "po_sheet" },
    }));
    expect(summary.skips.alreadyApproved).toBe(1);
    expect(summary.skips.wouldLowerApproved).toBe(0);
  });

  it("writes when Amazon has no approved value to protect", async () => {
    sheetRows = [poRow("B001", "8/12/2026")];
    rawRowsRead = 1;
    // Blank "Latest Approved Cost" — nothing to lower, so the guard stays out.
    const ws = XLSX.utils.aoa_to_sheet([HEADERS, ["B001", "X001", 3.0, "", "", "USD", "t", ""]]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Part_1");
    const buf = XLSX.write(wb, { bookType: "xlsx", type: "buffer" }) as Buffer;

    const { buffer, summary } = await buildSourcingCost(buf, FROM, TO, mkQuery({
      B001: { actual_cogs: 1.25, cogs_source: "po_sheet" },
    }));
    expect(readBack(buffer)[0]["Seller New Cost"]).toBe(1.25);
    expect(summary.skips.wouldLowerApproved).toBe(0);
  });

  it("guards per FNSKU row, not per ASIN", async () => {
    sheetRows = [poRow("B001", "8/12/2026")];
    rawRowsRead = 1;
    // Same ASIN, different approved values across its FNSKUs — one is above our
    // cost and must be protected, the other is below and should be raised.
    const wb = makeWorkbook([
      ["B001", "X001", 3.00, 9.00, "SELLER"],
      ["B001", "X002", 3.00, 2.00, "AMAZON"],
    ]);
    const { buffer, summary } = await buildSourcingCost(wb, FROM, TO, mkQuery({
      B001: { actual_cogs: 5.00, cogs_source: "po_sheet" },
    }));
    expect(readBack(buffer).map((r) => r["Seller New Cost"])).toEqual(["", 5]);
    expect(summary.skips.wouldLowerApproved).toBe(1);
    expect(summary.rowsWritten).toBe(1);
  });

  it("rounds half-up to cents", async () => {
    sheetRows = [poRow("B001", "8/12/2026")];
    rawRowsRead = 1;
    const wb = makeWorkbook([["B001", "X001", 1, 1, "AMAZON"]]);
    const { buffer } = await buildSourcingCost(wb, FROM, TO, mkQuery({
      B001: { actual_cogs: "4.955", cogs_source: "po_sheet" },
    }));
    expect(readBack(buffer)[0]["Seller New Cost"]).toBe(4.96);
  });
});

describe("sourcingCostFilename", () => {
  it("carries the window so the history list is self-describing", () => {
    expect(sourcingCostFilename(FROM, TO)).toBe("amzn-sourcing-cost-2026-08-01_2026-08-31.xlsx");
  });
});

describe("parseYMDLocal", () => {
  it("parses to LOCAL midnight, not UTC", () => {
    const d = parseYMDLocal("2026-08-19")!;
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(7);
    expect(d.getDate()).toBe(19); // would be the 18th under a UTC string parse
  });

  it("rejects junk and rollovers", () => {
    expect(parseYMDLocal("8/19/2026")).toBeNull();
    expect(parseYMDLocal("2026-02-30")).toBeNull();
    expect(parseYMDLocal("")).toBeNull();
    expect(parseYMDLocal(null)).toBeNull();
  });
});
