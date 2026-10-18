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

let sheetOverride: Map<string, any> | null = null;
// Since po-af-owned §2.4 (2026-10-18) the source is the AF PO tables
// (loadAfAsinCostMap), not the Orders sheet; the scripted map stands in.
const afCalls: Array<string[] | undefined> = [];
vi.mock("./po-af-source", () => ({
  loadAfAsinCostMap: async (_q: unknown, asins?: string[]) => { afCalls.push(asins); return { data: sheetOverride ?? sheetEntries(), rowsRead: rawRowsRead }; },
}));
vi.mock("./google-sheets", () => ({
  fetchSheetData: async () => { throw new Error("the Orders sheet must not be read"); },
  fetchSheetDataWithMeta: async () => { throw new Error("the Orders sheet must not be read"); },
  fetchSheetRows: async () => [],
}));

import { getRunSheetsSync } from "./routes";

beforeEach(() => {
  updates.length = 0;
  sheetOverride = null;
  staleOrderedAsins = [];
  rawRowsRead = 3;
  afCalls.length = 0;
});

describe("runSheetsSync reads the AF PO tables (po-af-owned §2.4)", () => {
  it("works with no GOOGLE_SHEET_ID and passes the ASIN filter to the AF reader", async () => {
    const saved = process.env.GOOGLE_SHEET_ID; delete process.env.GOOGLE_SHEET_ID;
    try {
      sourcesByAsin = { CSVASIN0001: { est: "csv", act: null } };
      const r = await getRunSheetsSync()(new Set(["CSVASIN0001"]));
      expect(r.updated).toBe(1);
      expect(afCalls).toEqual([["CSVASIN0001"]]);
      await getRunSheetsSync()();
      expect(afCalls[1]).toBeUndefined();
    } finally { if (saved !== undefined) process.env.GOOGLE_SHEET_ID = saved; }
  });
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

// 2026-10-17 (patch asins-on-order-from-pos §3.4): runSheetsSync no longer
// writes asin_estimates.ordered_qty, and the 2026-08-23 clearing pass went
// with it — On Order / Pipeline are derived from the PO tables. `cleared`
// stays 0 in the result for the callers.
describe("runSheetsSync never touches ordered_qty (2026-10-17)", () => {
  it("the per-ASIN UPDATE carries cogs / prep only; nothing scans or zeroes ordered_qty", async () => {
    staleOrderedAsins = ["GONEASIN001", "GONEASIN002"];
    const r = await getRunSheetsSync()();
    expect(updates.length).toBeGreaterThan(0);
    for (const u of updates) expect(u.sql).not.toMatch(/ordered_qty/);
    expect(updates.some((x) => /SET ordered_qty = 0/.test(x.sql))).toBe(false);
    expect(r.cleared).toBe(0);
    expect(r.clearedAsins).toEqual([]);
  });

  it("a sheet row with no cost and no prep writes nothing (counted skipped)", async () => {
    sourcesByAsin = { NULASIN0001: { est: null, act: null } };
    const entries = sheetEntries(); entries.set("NULASIN0001", { cogs: null, prepCost: null, orderedQty: 7, supplier: null } as any);
    sheetOverride = entries;
    const r = await getRunSheetsSync()(new Set(["NULASIN0001"]));
    expect(updates.filter((x) => x.params[x.params.length - 1] === "NULASIN0001")).toHaveLength(0);
    expect(r.skipped).toBe(3); // the row itself + the two out-of-filter entries
    expect(r.updated).toBe(0);
  });
});

