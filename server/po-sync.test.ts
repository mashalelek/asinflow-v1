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
    if (/^UPDATE asin_estimates SET/.test(sql)) {
      updates.push({ sql, params: params ?? [] });
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  },
  ensureUsersTable: async () => {},
  ensureSettingsTable: async () => {},
}));

vi.mock("./google-sheets", () => ({
  fetchSheetData: async () =>
    new Map(Object.entries({
      CSVASIN0001: { cogs: 12.64, prepCost: null, orderedQty: 10, supplier: null },
      MANASIN0001: { cogs: 9.99, prepCost: null, orderedQty: 5, supplier: null },
      NULASIN0001: { cogs: 4.2, prepCost: null, orderedQty: 1, supplier: null },
    })),
  fetchSheetRows: async () => [],
}));

import { getRunSheetsSync } from "./routes";

beforeEach(() => {
  updates.length = 0;
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
