import { describe, it, expect } from "vitest";
import { getActualProfit } from "./profit";
import { defaultSettings } from "./settings";
import type { AsinResult } from "@shared/schema";

// Finances API patch (commit 8, SPEC §6): the stored facts win over the estimated-fee math; the fallback stays for an uncovered range.
const base = (): AsinResult => ({
  asin: "B0FINTEST1", cogs: 10, estimatedCogs: 10, actualCogs: 10, buyLink: null, prepOverride: null, storageOverride: null,
  pricingData: { lowestFbaPrice: 30, buyBoxPrice: null, buyBoxFulfillment: null, lowestPrice: 30, avg30DayPrice: null, avg90DayPrice: null, numberOfSellers: null, sellersFba: 1, sellersFbm: 0 },
  feesData: { fbaFulfillmentFee: 3, referralFee: 4.5, feesEstimatePrice: 30 },
  catalogData: { weightLbs: 1, title: "t", brand: null, imageUrl: null, bsrRank: null, bsrCategory: null },
  eligibilityData: { status: "yes" }, error: null,
  actuals: { units_sold: 26, revenue: 2330.82, units_refunded: 1, refund_amount: 89.99, days_with_sales: 20, days_in_stock: 30 },
} as any);

describe("getActualProfit with Finances facts", () => {
  it("returns the range's Net profit, per unit, margin and ROI from actuals.fin", () => {
    const r = base();
    r.actuals!.fin = { sales: 2330.82, units: 26, refunds: 1, refund_amount: 89.99, refund_cost: -79.19, amazon_fees: -793.74, cogs: -1066.46, prep: -31.2, cost_of_goods: -1009.18, net_profit: 448.71, est_payout: 1457.89, cogs_missing_units: 0 };
    const p = getActualProfit(r, defaultSettings, true)!;
    expect(p.totalProfit).toBe(448.71); expect(p.profitPerUnit).toBeCloseTo(448.71 / 26, 6);
    expect(p.margin).toBeCloseTo(19.25, 1); expect(p.roi).toBeCloseTo(44.46, 1); expect(p.unitsSold).toBe(26); expect(p.revenue).toBe(2330.82);
  });
  it("without fin the estimated-fee math still answers; with no Actual COGS it is null", () => {
    const r = base();
    const p = getActualProfit(r, defaultSettings, true)!;
    expect(p.unitsSold).toBe(26); expect(typeof p.totalProfit).toBe("number");
    r.actualCogs = null; expect(getActualProfit(r, defaultSettings, true)).toBeNull();
    r.actuals = null as any; expect(getActualProfit(r, defaultSettings, true)).toBeNull();
  });
});
