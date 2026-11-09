import { describe, it, expect } from "vitest";
import { howItGotIn, sheetCostFor, blankOnboardingResult } from "./asin-estimates-backfill";

describe("backfill:asin-estimates — the pure rules (2026-11-09)", () => {
  it("how the row got in: lead source first, then the provenance tag, else upload / extension", () => {
    expect(howItGotIn({ lead_source: "ER", tags: [] })).toBe("Sync Sourcing (ER sheet)");
    expect(howItGotIn({ lead_source: "MP", tags: [] })).toMatch(/Master sheet/);
    expect(howItGotIn({ lead_source: null, tags: ["Sales import"] })).toMatch(/Sales import/);
    expect(howItGotIn({ lead_source: null, tags: ["SC import"] })).toMatch(/SC discovery/);
    expect(howItGotIn({ lead_source: null, tags: ["Other"] })).toMatch(/Upload File \/ extension/);
  });
  it("the sheet's COGS: ER col M for an ER lead (first non-empty top-down), the Master cost for the rest, null when no row carries one", () => {
    const sheets = { er: [{ asin: "B0GQW2H66Z", cogs: null }, { asin: "B0GQW2H66Z", cogs: 15.3 }, { asin: "B0ONLYER00", cogs: 2 }], master: [{ asin: "B0MASTER01", cogs: 7.35 }, { asin: "B0GQW2H66Z", cogs: 99 }] };
    expect(sheetCostFor("b0gqw2h66z", "ER", sheets)).toEqual({ cogs: 15.3, from: "er" });
    expect(sheetCostFor("B0MASTER01", "MP", sheets)).toEqual({ cogs: 7.35, from: "master" });
    expect(sheetCostFor("B0ONLYER00", null, sheets)).toEqual({ cogs: 2, from: "er" });   // no lead source, only the ER sheet names it
    expect(sheetCostFor("B0NOWHERE0", "ER", sheets)).toEqual({ cogs: null, from: null });
  });
  it("the blank onboarding result carries the COGS as given — null stays null, never a synthetic 0", () => {
    expect(blankOnboardingResult("B0X", 6.94).cogs).toBe(6.94);
    expect(blankOnboardingResult("B0X", null).cogs).toBeNull();
    expect(blankOnboardingResult("B0X", null).eligibilityData).toEqual({ status: "check" });
    expect(blankOnboardingResult("B0X", null).pricingData.lowestFbaPrice).toBeNull();
  });
});
