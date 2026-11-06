// Fees (Maria 2026-11-06): the fee BEFORE Amazon's fee promotion is stored, with the promotion beside it; a failure never
// touches the stored fee and is recorded instead (stale); a client-side error on an ASIN without catalog dimensions says so.
import { describe, it, expect, vi } from "vitest";
vi.mock("./log", () => ({ log: () => {} }));
const sql: Array<{ sql: string; params: any[] }> = [];
vi.mock("./db", () => ({
  query: async (s: string, params: any[] = []) => {
    sql.push({ sql: s, params });
    if (/FROM asins a LEFT JOIN asin_estimates/.test(s)) return { rows: params[0].map((asin: string) => ({ asin, lowest_fba_price: "42.49", buy_box_price: null, lowest_price: null, bsr_category: null })) };
    if (/FROM asins WHERE asin = ANY/.test(s)) return { rows: [{ asin: "B07GG6BNFV", weight_lb: "1.2", length_in: null, width_in: null, height_in: null }, { asin: "B0000DIMOK", weight_lb: "1", length_in: "5", width_in: "4", height_in: "3" }] };
    return { rows: [], rowCount: 1 };
  },
}));
vi.mock("./product-info-batch", () => ({
  fetchFeesBatch: async (items: Array<{ asin: string }>) => new Map(items.map((it) => [it.asin,
    it.asin === "B00D1QW6SY" ? { kind: "parsed", fees: { fbaFulfillmentFee: 4.11, referralFee: 1.65, feesEstimatePrice: 10.99, fbaFeePromotion: 4.11, feeSource: "spapi" } }
    : it.asin === "B0000000T1" ? { kind: "error", message: "There is an internal service failure." }
    : { kind: "error", message: "There is an client-side error. Please verify your inputs." }])),
}));
import { parseFeeResult } from "./spapi";
import { runFeesStage, NO_DIMENSIONS_FEE_ERROR } from "./refresh-job";

const result = (fba: { amount: number; promo: number; final: number }) => ({
  Status: "Success",
  FeesEstimate: {
    TotalFeesEstimate: { Amount: 1.65 + fba.final, CurrencyCode: "USD" },
    FeeDetailList: [
      { FeeType: "ReferralFee", FeeAmount: { Amount: 1.65 }, FeePromotion: { Amount: 0 }, FinalFee: { Amount: 1.65 } },
      { FeeType: "FBAFees", FeeAmount: { Amount: fba.amount }, FeePromotion: { Amount: fba.promo }, FinalFee: { Amount: fba.final } },
    ],
  },
});

describe("parseFeeResult: fee promotions (Maria 2026-11-06)", () => {
  it("B00D1QW6SY $10.99: FBAFees 4.11 fully waived → fee 4.11 before the promotion, promotion 4.11 (was: all null, \"no fee in response\")", () => {
    expect(parseFeeResult("B00D1QW6SY", result({ amount: 4.11, promo: 4.11, final: 0 }), 10.99)).toMatchObject({ fbaFulfillmentFee: 4.11, referralFee: 1.65, fbaFeePromotion: 4.11, feeSource: "spapi" });
  });
  it("a partial promotion: the fee before it, the promotion recorded; none → null", () => {
    expect(parseFeeResult("B0X", result({ amount: 5, promo: 1, final: 4 }), 20)).toMatchObject({ fbaFulfillmentFee: 5, fbaFeePromotion: 1 });
    expect(parseFeeResult("B0X", result({ amount: 5, promo: 0, final: 5 }), 20)).toMatchObject({ fbaFulfillmentFee: 5, fbaFeePromotion: null });
  });
});

describe("runFeesStage: what a fee write and a fee failure store", () => {
  it("success: fee, promotion, date, error cleared · failure: only the error and its date · client-side + no dimensions: named", async () => {
    sql.length = 0;
    const r = await runFeesStage({ filter: new Set(["B00D1QW6SY", "B0000000T1", "B07GG6BNFV", "B0000DIMOK"]), dryRun: false, emit: () => {}, skipAsins: new Set() });
    expect(r.outcomes).toEqual({
      B0000000T1: "error: There is an internal service failure.",
      B07GG6BNFV: NO_DIMENSIONS_FEE_ERROR,
      B0000DIMOK: "error: There is an client-side error. Please verify your inputs.",
    });
    const ok = sql.find((c) => /SET fba_fee = \$2/.test(c.sql))!;
    expect(ok.sql).toMatch(/fba_fee_promotion = \$5, fee_fetched_at = NOW\(\), fee_error = NULL, fee_error_at = NULL/);
    expect(ok.params).toEqual(["B00D1QW6SY", 4.11, 1.65, 10.99, 4.11]);
    const errs = sql.filter((c) => /SET fee_error = \$2, fee_error_at = NOW\(\)/.test(c.sql));
    expect(errs.map((c) => c.params)).toEqual([["B0000000T1", "There is an internal service failure."], ["B07GG6BNFV", "no FBA estimate: catalog lacks package dimensions/weight"], ["B0000DIMOK", "There is an client-side error. Please verify your inputs."]]);
    // A failure writes nothing but the error: no fee column in any failure write.
    for (const c of errs) expect(c.sql).not.toMatch(/fba_fee\b|referral_fee|fee_source/);
  });
  it("a dry run records nothing", async () => {
    sql.length = 0;
    await runFeesStage({ filter: new Set(["B0000000T1"]), dryRun: true, emit: () => {}, skipAsins: new Set() });
    expect(sql.some((c) => /UPDATE/.test(c.sql))).toBe(false);
  });
});
