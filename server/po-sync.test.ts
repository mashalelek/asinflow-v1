import { describe, it, expect, vi, beforeEach } from "vitest";

// Pins the §2 PO-sync estimated_cogs rule (corrected 2026-08-11): the PO
// value overwrites (source → 'po_sheet') for ANY source except 'manual' —
// csv/imported yield to PO; manual sticks. The old po_sheet/NULL-only check
// silently froze csv-seeded rows (83 drifted rows, diagnosed 2026-08-10).
//
// server/index.ts is mocked (importing it boots Express — same rationale as
// route-inventory.test.ts). ./db and ./google-sheets are mocked so
// runSheetsSync runs against a scripted sheet + captured SQL.
vi.mock("./index", () => ({ log: () => {} }));

const updates: Array<{ sql: string; params: any[] }> = [];
let sourcesByAsin: Record<string, { est: string | null; act: string | null }> = {};
let staleOrderedAsins: string[] = []; // rows returned for the clearing pass's non-zero ordered_qty scan
let rawRowsRead = 3;                  // fail-closed tripwire input (SPEC §11)

vi.mock("./db", () => ({
  default: { query: async () => ({ rows: [], rowCount: 0 }) },
  isDbAvailable: () => true,
  query: async (sql: string, params?: any[]) => {
    const asin = params?.[params.length - 1];
    if (/SELECT cogs_source FROM asin_estimates/.test(sql)) {
      return { rows: [{ cogs_source: sourcesByAsin[params![0]]?.act ?? null }], rowCount: 1 };
    }
    if (/SELECT estimated_cogs_source FROM asin_estimates/.test(sql)) {
      return { rows: [{ estimated_cogs_source: sourcesByAsin[params![0]]?.est ?? null }], rowCount: 1 };
    }
    if (/SELECT asin FROM asin_estimates WHERE ordered_qty/.test(sql)) {
      return { rows: staleOrderedAsins.map((asin) => ({ asin })), rowCount: staleOrderedAsins.length };
    }
    if (/^UPDATE asin_estimates SET/.test(sql)) {
      updates.push({ sql, params: params ?? [] });
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  },
  ensureUsersTable: async () => {},
  ensureSettingsTable: async () => {},
}));

const sheetEntries = () =>
  new Map(Object.entries({
    CSVASIN0001: { cogs: 12.64, prepCost: null, orderedQty: 10, supplier: null },
    MANASIN0001: { cogs: 9.99, prepCost: null, orderedQty: 5, supplier: null },
    NULASIN0001: { cogs: 4.2, prepCost: null, orderedQty: 1, supplier: null },
  }));

vi.mock("./google-sheets", () => ({
  fetchSheetData: async () => sheetEntries(),
  fetchSheetDataWithMeta: async () => ({ data: sheetEntries(), rawRowsRead }),
  fetchSheetRows: async () => [],
}));

import { getRunSheetsSync } from "./routes";

beforeEach(() => {
  updates.length = 0;
  staleOrderedAsins = [];
  rawRowsRead = 3;
  process.env.GOOGLE_SHEET_ID = "test-sheet"; // fetchSheetData is mocked; only the guard reads this
});

describe("runSheetsSync estimated_cogs rule (§2, corrected 2026-08-11)", () => {
  it("csv-source row + PO value → estimated_cogs overwritten, source 'po_sheet'", async () => {
    sourcesByAsin = { CSVASIN0001: { est: "csv", act: "po_sheet" } };
    await getRunSheetsSync()(new Set(["CSVASIN0001"]));
    const u = updates.find((x) => x.params[x.params.length - 1] === "CSVASIN0001")!;
    expect(u.sql).toContain("estimated_cogs =");
    expect(u.sql).toContain("estimated_cogs_source =");
    expect(u.params).toContain(12.64);
    expect(u.params).toContain("po_sheet");
  });

  it("manual-source row → estimate untouched (actuals still sync)", async () => {
    sourcesByAsin = { MANASIN0001: { est: "manual", act: "po_sheet" } };
    await getRunSheetsSync()(new Set(["MANASIN0001"]));
    const u = updates.find((x) => x.params[x.params.length - 1] === "MANASIN0001")!;
    expect(u.sql).not.toContain("estimated_cogs =");
    // actual branch unaffected by the estimate rule:
    expect(u.sql).toContain("actual_cogs =");
  });

  it("NULL-source row → estimate set (unchanged from the old rule)", async () => {
    sourcesByAsin = { NULASIN0001: { est: null, act: null } };
    await getRunSheetsSync()(new Set(["NULASIN0001"]));
    const u = updates.find((x) => x.params[x.params.length - 1] === "NULASIN0001")!;
    expect(u.sql).toContain("estimated_cogs =");
    expect(u.params).toContain("po_sheet");
  });
});

// Pins the ordered_qty clearing pass (SPEC §11, 2026-08-23): an ASIN with
// non-zero ordered_qty but zero rows in the current read is zeroed — all of
// them on full-catalog runs, only in-filter ones on scoped runs — and the
// pass fails closed on an empty read (rawRowsRead = 0 clears nothing).
describe("runSheetsSync ordered_qty clearing pass (§11, 2026-08-23)", () => {
  const clearsFor = (asin: string) =>
    updates.filter((x) => /SET ordered_qty = 0/.test(x.sql) && x.params[0] === asin);

  it("full-catalog run clears every vanished ASIN and reports it", async () => {
    staleOrderedAsins = ["GONEASIN001", "GONEASIN002", "CSVASIN0001"];
    const r = await getRunSheetsSync()();
    expect(clearsFor("GONEASIN001")).toHaveLength(1);
    expect(clearsFor("GONEASIN002")).toHaveLength(1);
    expect(clearsFor("CSVASIN0001")).toHaveLength(0); // present in the read — not "vanished"
    expect(r.cleared).toBe(2);
    expect(r.clearedAsins.sort()).toEqual(["GONEASIN001", "GONEASIN002"]);
  });

  it("scoped run clears only in-filter vanished ASINs", async () => {
    staleOrderedAsins = ["GONEASIN001", "GONEASIN002"];
    const r = await getRunSheetsSync()(new Set(["GONEASIN001", "CSVASIN0001"]));
    expect(clearsFor("GONEASIN001")).toHaveLength(1);
    expect(clearsFor("GONEASIN002")).toHaveLength(0); // outside scope — untouched
    expect(r.cleared).toBe(1);
    expect(r.clearedAsins).toEqual(["GONEASIN001"]);
  });

  it("scoped run not covering the vanished ASINs clears nothing", async () => {
    staleOrderedAsins = ["GONEASIN001", "GONEASIN002"];
    const r = await getRunSheetsSync()(new Set(["CSVASIN0001"]));
    expect(updates.some((x) => /SET ordered_qty = 0/.test(x.sql))).toBe(false);
    expect(r.cleared).toBe(0);
  });

  it("fail-closed: rawRowsRead = 0 clears nothing", async () => {
    staleOrderedAsins = ["GONEASIN001"];
    rawRowsRead = 0;
    const r = await getRunSheetsSync()();
    expect(updates.some((x) => /SET ordered_qty = 0/.test(x.sql))).toBe(false);
    expect(r.cleared).toBe(0);
  });

  it("clears ordered_qty ONLY — never the cost snapshot columns", async () => {
    staleOrderedAsins = ["GONEASIN001"];
    await getRunSheetsSync()();
    const clear = clearsFor("GONEASIN001")[0];
    expect(clear.sql).toBe("UPDATE asin_estimates SET ordered_qty = 0 WHERE asin = $1");
  });
});
