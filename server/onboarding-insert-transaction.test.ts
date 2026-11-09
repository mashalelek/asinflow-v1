// Onboarding writes one ASIN's rows in ONE transaction, or none (Maria 2026-11-09).
// Background: from 2026-11-06 to 2026-11-09 the estimates INSERT was refused by
// Postgres (parameter $16 typed twice) and the sink logged it away — 18 ER
// leads existed in `asins` with no `asin_estimates` row, their onboarding job
// #527 ran, and every component UPDATE matched zero rows. Now the insert-only
// path BEGINs, writes asins + asin_estimates (+ CSV COGS / notes / pack),
// checks both rows exist, COMMITs — and on any failure ROLLBACKs and REJECTS,
// so writeResult can name the ASIN on the stream and keep it out of the job.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

let statements: string[] = [];
let failOn: RegExp | null = null;
let estimatesRows = 0;
let estimatesInsertWrites = true; // false = the INSERT "succeeds" with no row (the shape of an error swallowed elsewhere)
let released = 0;

vi.mock("./log", () => ({ log: () => {} }));
vi.mock("./db", () => {
  const run = async (text: string, values?: any[]) => {
    const t = text.trim();
    statements.push(t.split("\n")[0].slice(0, 60));
    if (failOn && failOn.test(t)) { const e: any = new Error("inconsistent types deduced for parameter $16"); e.code = "42P08"; throw e; }
    if (/^INSERT INTO asins /.test(t)) return { rows: [{ inserted: true }], rowCount: 1 };
    if (/^INSERT INTO asin_estimates/.test(t)) { if (estimatesInsertWrites) estimatesRows = 1; return { rows: [], rowCount: estimatesInsertWrites ? 1 : 0 }; }
    if (/^SELECT \(SELECT count\(\*\) FROM asins/.test(t)) return { rows: [{ a: 1, e: estimatesRows }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  const client = { query: run, release: () => { released++; } };
  return {
    isDbAvailable: () => true,
    query: run,
    pool: { connect: async () => client },
    default: { connect: async () => client, query: run },
  };
});

import { mainCatalogSink } from "./routes";

const result: any = {
  asin: "B0NEWASIN1", cogs: 6.94, buyLink: null,
  pricingData: { lowestFbaPrice: null, buyBoxPrice: null, buyBoxFulfillment: null, lowestPrice: null, avg30DayPrice: null, avg90DayPrice: null, numberOfSellers: null, sellersFba: null, sellersFbm: null },
  feesData: { fbaFulfillmentFee: null, referralFee: null, feesEstimatePrice: null },
  catalogData: { weightLbs: null, title: null, brand: null, imageUrl: null, bsrRank: null, bsrCategory: null },
  eligibilityData: { status: "check" },
};
const opts = { fromCsvUpload: true, inputNotes: "VA note", inputPromoNotes: null, inputLeadSource: "ER" as const, insertOnly: true };

beforeEach(() => { statements = []; failOn = null; estimatesRows = 0; estimatesInsertWrites = true; released = 0; });

describe("the insert-only sink path", () => {
  it("BEGIN → asins → asin_estimates → both-rows check → COMMIT, on one client, released after", async () => {
    await mainCatalogSink.persistResult(result, opts);
    expect(statements[0]).toBe("BEGIN");
    expect(statements.at(-1)).toBe("COMMIT");
    expect(statements.some((s) => s.startsWith("INSERT INTO asins "))).toBe(true);
    expect(statements.some((s) => s.startsWith("INSERT INTO asin_estimates"))).toBe(true);
    expect(statements.some((s) => s.startsWith("SELECT (SELECT count(*) FROM asins"))).toBe(true);
    expect(statements).not.toContain("ROLLBACK");
    expect(released).toBe(1);
  });

  it("the estimates INSERT refused by Postgres (the $16 regression): ROLLBACK, the promise REJECTS with the cause, nothing committed", async () => {
    failOn = /^INSERT INTO asin_estimates/;
    await expect(mainCatalogSink.persistResult(result, opts)).rejects.toThrow(/inconsistent types deduced for parameter \$16/);
    expect(statements).toContain("ROLLBACK");
    expect(statements).not.toContain("COMMIT");
    expect(released).toBe(1);
  });

  it("both rows must exist before COMMIT: an estimates statement that silently wrote nothing still rolls back", async () => {
    estimatesInsertWrites = false;
    await expect(mainCatalogSink.persistResult(result, opts)).rejects.toThrow(/asin_estimates 0 — expected 1 and 1/);
    expect(statements).toContain("ROLLBACK");
    expect(statements).not.toContain("COMMIT");
    expect(released).toBe(1);
  });

  it("the Analyze (not insert-only) path is unchanged: no transaction, errors still logged and swallowed", async () => {
    failOn = /^INSERT INTO asin_estimates/;
    await expect(mainCatalogSink.persistResult(result, { ...opts, insertOnly: false })).resolves.toBeUndefined();
    expect(statements).not.toContain("BEGIN");
  });
});

describe("writeResult on the insert-only path (source)", () => {
  const src = readFileSync(join(__dirname, "routes.ts"), "utf8");
  const fn = src.slice(src.indexOf("async function writeResult("), src.indexOf("async function runSheetsSync"));
  it("a rejected insert becomes an `insert_failed` message for that ASIN, no `result` row, and returns false", () => {
    expect(fn).toMatch(/type: "insert_failed", data: \{ asin, message \}/);
    expect(fn).toMatch(/if \(!insertOnly\) emit\(JSON\.stringify\(\{ type: "result"/);
    expect(fn).toMatch(/if \(insertOnly\) emit\(JSON\.stringify\(\{ type: "result", data: result \}\)/);
    expect(fn).toMatch(/return false;/);
  });
  it("insertNewAsinRows collects the failed ASINs and onboardNewAsins returns them; sales and SC-discovery onboarding read the list", () => {
    expect(src).toMatch(/\): Promise<\{ failed: string\[\] \}> \{\n    const allResults = new Map<string, AsinResult>\(\);\n    const failed: string\[\] = \[\];/);
    expect(src).toMatch(/const ok = await writeResult\([^\n]*true\);\n\s*if \(!ok\) failed\.push\(input\.asin\.toUpperCase\(\)\);/);
    expect(src).toMatch(/Promise<\{ jobId: number \| null; failed: string\[\] \}>/);
    expect(src).toMatch(/const \{ failed \} = await insertNewAsinRows\(inputs, \(\) => \{\}, mainCatalogSink\);/);
    expect(src).toMatch(/const onboarded = await onboardNewAsins\(inputs, \(\) => \{\}, mainCatalogSink, "sc_discovery"\);/);
  });
});
