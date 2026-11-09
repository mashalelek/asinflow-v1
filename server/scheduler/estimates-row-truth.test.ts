// Every component that writes asin_estimates counts rowCount, and a scoped ASIN with no estimates row is named
// `error: no asin_estimates row` per ASIN (Maria 2026-11-09). From 11/6 to 11/9, 18 ASINs had an asins row and no
// estimates row: 10 Prices and 11 Sellers reported "updated 18" on UPDATEs that matched nothing, 13 Fees said
// skipped_no_price, and only the daily 8 Gating step named the cause.
import { describe, it, expect, vi } from "vitest";

vi.mock("../log", () => ({ log: () => {} }));
vi.mock("../spapi-auth", () => ({
  spApiPost: async (_uri: string, body: any) => ({ responses: body.requests.map(() => ({ status: { statusCode: 200 }, body: { payload: { ok: 1 } } })) }),
}));
vi.mock("../offers-parse", () => ({
  parseOffersPayload: () => ({ lowestFbaPrice: 10, buyBoxPrice: 10, buyBoxFulfillment: "FBA", lowestPrice: 10, numberOfSellers: 2, sellersFba: 1, sellersFbm: 1, competitivePriceThreshold: null, noOffers: false }),
}));
const dbSql: Array<{ sql: string; params: any[] }> = [];
let feeRowsNoRow = new Set<string>();
let updateRowCount = 1;
vi.mock("../db", () => ({
  query: async (s: string, params: any[] = []) => {
    dbSql.push({ sql: s, params });
    if (/FROM asins a LEFT JOIN asin_estimates/.test(s)) return { rows: params[0].map((asin: string) => ({ asin, lowest_fba_price: feeRowsNoRow.has(asin) ? null : "20.00", buy_box_price: null, lowest_price: null, bsr_category: null, no_row: feeRowsNoRow.has(asin) })) };
    if (/^\s*UPDATE asin_estimates/.test(s)) return { rows: [], rowCount: updateRowCount };
    return { rows: [], rowCount: 1 };
  },
}));
vi.mock("../product-info-batch", () => ({
  fetchFeesBatch: async (items: Array<{ asin: string }>) => new Map(items.map((it) => [it.asin, { kind: "parsed", fees: { fbaFulfillmentFee: 3, referralFee: 1, feesEstimatePrice: 20, fbaFeePromotion: null, feeSource: "spapi" } }])),
}));

import { runPricePass } from "../price-sync";
import { runFeesPass, runFeesStage } from "../refresh-job";
import { NO_ESTIMATES_ROW, failuresOf } from "./step-failures";
import { profit } from "./components/14-profit";
import { bsr } from "./components/04-bsr";

const ctxFor = (scope: string[], query: any, cache = new Map<string, unknown>()): any => ({
  job: { id: 1, scope_asins: scope } as any, query, log: () => {}, sellerId: "S", asins: scope, scopeAsins: scope, checkpoint: async () => {}, cache,
});

describe("10 Prices: a writer that finds no row", () => {
  it("counts the ASIN as error with the named outcome, leaves it out of `parsed` (so 11 / 12 cannot claim it), still updates the others", async () => {
    const written: string[] = [];
    const r = await runPricePass(["B0HASROW00", "B0NOROW000"], async (asin) => { written.push(asin); return asin !== "B0NOROW000"; });
    expect(r.counts.updated).toBe(1);
    expect(r.counts.error).toBe(1);
    expect(r.outcomes).toEqual({ B0NOROW000: NO_ESTIMATES_ROW });
    expect(Array.from(r.parsed.keys())).toEqual(["B0HASROW00"]);
    expect(written).toEqual(["B0HASROW00", "B0NOROW000"]);
    expect(failuresOf({ counts: r.counts, outcomes: r.outcomes }).asins.get("B0NOROW000")).toBe(NO_ESTIMATES_ROW); // a step failure
  });
  it("a void writer (Bulk Calc's) is still 'written'", async () => {
    const r = await runPricePass(["B0HASROW00"], async () => {});
    expect(r.counts).toMatchObject({ updated: 1, error: 0 });
    expect(r.outcomes).toEqual({});
  });
});

describe("13 Fees", () => {
  it("runFeesPass: a writer that finds no row → error + named outcome, not updated", async () => {
    const r = await runFeesPass([{ asin: "B0HASROW00", price: 20 }, { asin: "B0NOROW000", price: 20 }], async (asin) => asin !== "B0NOROW000");
    expect(r.counts).toEqual({ updated: 1, error: 1 });
    expect(r.outcomes).toEqual({ B0NOROW000: NO_ESTIMATES_ROW });
  });
  it("runFeesStage: a scoped ASIN with no estimates row is the named error (not skipped_no_price), and no fee_error is recorded on a row that does not exist", async () => {
    dbSql.length = 0; feeRowsNoRow = new Set(["B0NOROW000"]); updateRowCount = 1;
    const r = await runFeesStage({ filter: new Set(["B0HASROW00", "B0NOROW000"]), dryRun: false, emit: () => {}, skipAsins: new Set() });
    expect(r.outcomes).toEqual({ B0NOROW000: NO_ESTIMATES_ROW });
    expect(r.counts).toMatchObject({ updated: 1, skipped_no_price: 0, error: 1 });
    expect(dbSql.filter((c) => /SET fee_error = \$2/.test(c.sql))).toEqual([]);
  });
  it("runFeesStage: the fee UPDATE itself matching no row is the same named error", async () => {
    dbSql.length = 0; feeRowsNoRow = new Set(); updateRowCount = 0;
    const r = await runFeesStage({ filter: new Set(["B0HASROW00"]), dryRun: false, emit: () => {}, skipAsins: new Set() });
    expect(r.outcomes).toEqual({ B0HASROW00: NO_ESTIMATES_ROW });
    expect(r.counts).toMatchObject({ updated: 0, error: 1 });
    updateRowCount = 1;
  });
});

describe("14 Profit (hourly): a scoped ASIN the estimates table lacks is named per ASIN", () => {
  it("missing_row counted AND the ASIN's outcome set, so the hourly pass fails the step", async () => {
    const query = async () => ({ rows: [{ asin: "B0HASROW00", has_price: true, has_fee: true, has_cogs: true }], rowCount: 1 });
    const r = await profit.run(ctxFor(["B0HASROW00", "B0NOROW000"], query));
    expect(r.counts).toEqual({ complete: 1, incomplete: 0, missing_row: 1 });
    expect(r.outcomes).toEqual({ B0NOROW000: NO_ESTIMATES_ROW });
  });
});

describe("4 BSR (daily): the UPDATE matching no row", () => {
  it("is the named error, no history snapshot is written for it, the other ASIN proceeds", async () => {
    const sql: string[] = [];
    const query = async (s: string, params: any[] = []) => {
      sql.push(s.trim().split("\n")[0]);
      if (/^UPDATE asin_estimates/.test(s.trim())) return { rows: [], rowCount: params[0] === "B0NOROW000" ? 0 : 1 };
      return { rows: [], rowCount: 1 };
    };
    const cache = new Map<string, unknown>([["catalog:results", new Map([
      ["B0HASROW00", { kind: "parsed", data: { bsrRank: 10, bsrCategory: "Toys" } }],
      ["B0NOROW000", { kind: "parsed", data: { bsrRank: 20, bsrCategory: "Toys" } }],
    ])]]);
    const r = await bsr.run(ctxFor(["B0HASROW00", "B0NOROW000"], query, cache));
    expect(r.counts).toMatchObject({ updated: 1, error: 1, history_rows: 1 });
    expect(r.outcomes).toEqual({ B0NOROW000: NO_ESTIMATES_ROW });
    expect(sql.filter((s) => s.startsWith("INSERT INTO asin_estimates_history"))).toHaveLength(1);
  });
});
