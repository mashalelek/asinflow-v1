import { describe, it, expect } from "vitest";
import { getRowValue } from "./results-table";
import { calculateProfit, appliesDgHazmatSurcharge, type AsinResult, type Settings } from "@shared/schema";
import { defaultSettings } from "@/lib/settings";

// ONE profit computation (2026-09-09): getRowValue — the value source for
// sort, filter, AND export — must consult the same inbound toggle the
// rendered cells pass to calculateProfit. Before this fix getRowValue
// hard-coded includeInboundShipping=true, so sorting by Profit/Unit with
// inbound OFF ordered rows by numbers the table wasn't showing.

function row(asin: string, price: number, cogs: number, weightLbs: number): AsinResult {
  return {
    asin, cogs, estimatedCogs: cogs, actualCogs: null,
    buyLink: null, prepOverride: null, storageOverride: null,
    pricingData: {
      lowestFbaPrice: price, buyBoxPrice: null, buyBoxFulfillment: null,
      lowestPrice: price, avg30DayPrice: null, avg90DayPrice: null,
      numberOfSellers: null, sellersFba: 1, sellersFbm: 0,
    },
    feesData: { fbaFulfillmentFee: 3, referralFee: price * 0.15, feesEstimatePrice: price },
    catalogData: { weightLbs, title: asin, brand: null, imageUrl: null, bsrRank: null, bsrCategory: null },
    eligibilityData: { status: "yes" },
    error: null,
  } as AsinResult;
}

// Heavy rows: inbound (weight × rate) flips the profit ORDER when included.
// A: high price, very heavy. B: lower price, light.
const settings: Settings = { ...defaultSettings, inboundShippingCost: 2 };
const A = row("B0PARITYAA", 30, 10, 8);   // inbound $16 when included
const B = row("B0PARITYBB", 27, 10, 0.5); // inbound $1

const rendered = (r: AsinResult, inbound: boolean) =>
  calculateProfit(
    r.pricingData.lowestFbaPrice!, r.estimatedCogs!,
    r.feesData.fbaFulfillmentFee ?? 0, r.feesData.referralFee ?? 0,
    r.feesData.feesEstimatePrice, r.catalogData.weightLbs,
    settings.prepCost,
    settings.storageFee, settings, inbound, appliesDgHazmatSurcharge(r), null,
  ).profit;

describe("profit parity — one computation for render, sort, filter, export", () => {
  it("sorting by profit with inbound OFF matches the rendered values' order (and differs from inbound ON)", () => {
    for (const inbound of [false, true]) {
      const sortVals = [A, B].map((r) => getRowValue(r, "profit", "lowestFba", settings, inbound) as number);
      const renderVals = [A, B].map((r) => rendered(r, inbound));
      expect(sortVals).toEqual(renderVals); // same numbers → same order, always
    }
    // And the toggle genuinely changes the order (the fixture is meaningful):
    const off = [A, B].sort((a, b) => (getRowValue(b, "profit", "lowestFba", settings, false) as number) - (getRowValue(a, "profit", "lowestFba", settings, false) as number)).map((r) => r.asin);
    const on = [A, B].sort((a, b) => (getRowValue(b, "profit", "lowestFba", settings, true) as number) - (getRowValue(a, "profit", "lowestFba", settings, true) as number)).map((r) => r.asin);
    expect(off).toEqual(["B0PARITYAA", "B0PARITYBB"]);
    expect(on).toEqual(["B0PARITYBB", "B0PARITYAA"]);
  });

  it("export value for a row equals the table's value under the same toggle", () => {
    // Export goes through the same getRowValue with the passed toggle — pin
    // the actual numbers for one row under both toggle states.
    const offVal = getRowValue(A, "profit", "lowestFba", settings, false) as number;
    const onVal = getRowValue(A, "profit", "lowestFba", settings, true) as number;
    expect(offVal).toBeCloseTo(rendered(A, false), 6);
    expect(onVal).toBeCloseTo(rendered(A, true), 6);
    expect(offVal - onVal).toBeCloseTo(16, 6); // 8 lb × $2/lb inbound
  });
});
