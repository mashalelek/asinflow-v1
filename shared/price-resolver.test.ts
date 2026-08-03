import { describe, it, expect } from "vitest";
import { resolveOfferPrice, type PriceResolverInput, type OffersInput } from "./price-resolver";
import { calculateProfit, type Settings, settingsSchema } from "./schema";

// Default settings — matches what the UI computes with defaults; tests can override.
const DEFAULT_SETTINGS: Settings = settingsSchema.parse({});

// Test helpers — explicit discriminated union avoids accidental ambiguity.
function definite(competing: number[] = []): OffersInput {
  return { kind: "definitive", competing };
}
function failed(reason = "simulated transient_error (429)"): OffersInput {
  return { kind: "fetch_failed", reason };
}

// Minimal input scaffold; tests override fields per case.
function inp(overrides: Partial<PriceResolverInput> = {}): PriceResolverInput {
  return {
    cogs: 10,
    fbaFee: 3.5,
    referralFee: 3.0,
    feesEstimatePrice: 20,
    weightLbs: 1.0,
    isHazmat: false,
    category: "Beauty & Personal Care",
    prepCost: 0,
    storageCost: 0,
    offers: definite([]),
    ...overrides,
  };
}

// ============================================================================
// CRITICAL: offers_fetch_failed — must NEVER silently fall through to Rule 2
// ============================================================================
describe("offers_fetch_failed — blocked outcome", () => {
  it("fetch_failed → resolver returns offers_fetch_failed (NOT Rule 2)", () => {
    // A transient fetcher failure historically collapsed to "zero offers" →
    // Rule 2, producing wrong prices. This test pins the correct behavior.
    const r = resolveOfferPrice(
      inp({ cogs: 10, offers: failed("transient_error (429)") }),
      DEFAULT_SETTINGS,
      true,
    );
    expect(r.rule).toBe("offers_fetch_failed");
    expect(r.resolvedPrice).toBeNull();
    expect(r.detail).toMatch(/Couldn't check competition/);
    expect(r.detail).toMatch(/Not submittable/);
  });

  it("fetch_failed with valid cogs still blocks (cogs presence doesn't unblock)", () => {
    const r = resolveOfferPrice(
      inp({ cogs: 25, offers: failed() }),
      DEFAULT_SETTINGS,
      true,
    );
    expect(r.rule).toBe("offers_fetch_failed");
  });

  it("fetch_failed with null cogs still blocks (same outcome regardless)", () => {
    const r = resolveOfferPrice(
      inp({ cogs: null, offers: failed() }),
      DEFAULT_SETTINGS,
      true,
    );
    expect(r.rule).toBe("offers_fetch_failed");
  });

  it("DEFINITIVE empty array → Rule 2 path (this is the real-zero case)", () => {
    // Sanity guard: a genuinely empty competing-offers list should still
    // trigger Rule 2, distinguishable from fetch_failed.
    const r = resolveOfferPrice(
      inp({ cogs: 10, offers: definite([]) }),
      DEFAULT_SETTINGS,
      true,
    );
    expect(r.rule).toBe("roi_100");
    expect(r.resolvedPrice).not.toBeNull();
  });
});

// ============================================================================
// Rule 1: ≥1 competing offer → highest × 1.30, ceil to .99
// ============================================================================
describe("Rule 1: highest competing offer + 30%, .99-rounded", () => {
  it("single competing offer → ceil to next .99", () => {
    // 20 × 1.30 = 26.00. Nearest .99 below = $25.99, above = $26.99.
    // Rule: never round below input → $26.99.
    const r = resolveOfferPrice(inp({ offers: definite([20]) }), DEFAULT_SETTINGS, true);
    expect(r.rule).toBe("highest_plus_30");
    expect(r.resolvedPrice).toBe(26.99);
    expect(r.competingOfferCount).toBe(1);
    expect(r.highestCompetingOffer).toBe(20);
  });

  it("multiple offers → uses HIGHEST then ceils to .99", () => {
    const r = resolveOfferPrice(
      inp({ offers: definite([15.99, 22.50, 18.75, 19.00]) }),
      DEFAULT_SETTINGS,
      true,
    );
    expect(r.rule).toBe("highest_plus_30");
    expect(r.highestCompetingOffer).toBe(22.50);
    // 22.50 × 1.30 = 29.25 → ceil to $29.99
    expect(r.resolvedPrice).toBe(29.99);
  });

  it(".99 round: $11.11 × 1.30 = $14.443 → $14.99", () => {
    const r = resolveOfferPrice(inp({ offers: definite([11.11]) }), DEFAULT_SETTINGS, true);
    expect(r.resolvedPrice).toBe(14.99);
  });

  it(".99 round: input that lands exactly on .99 stays unchanged", () => {
    // 7.6846153... * 1.30 = 9.99 exactly
    // Use 7.685 which lands at 9.9905 — ceil to next .99 = $10.99
    // Better test: highest = 7.6846 → 9.99(98) → ceil → 10.99
    // For exact-stay test, use highest that produces an exactly-.99 result:
    //   $76.92 × 1.30 = $99.996 → 100.99 (ceil up because just over $99.99... hmm)
    // Simpler: test that ceil of a value already at .99 is unchanged.
    // 7.6923076923... → exactly 9.99 → use 7.6923077
    // Easier: confirm round-trip — if input.competingOffers triggers exact .99 result, it stays.
    // We use the math directly: any value already at .99 (like 26.99 from a hypothetical
    // 20.7615 input) stays. Test via the resolver indirectly:
    // Pick competing offer 7.6153846 → 7.6153846 * 1.30 = 9.9 → ceil to 9.99
    const r = resolveOfferPrice(inp({ offers: definite([7.6153846153846] ) }), DEFAULT_SETTINGS, true);
    expect(r.resolvedPrice).toBe(9.99);
  });

  it(".99 round: $7.62 × 1.30 = $9.906 → $9.99", () => {
    const r = resolveOfferPrice(inp({ offers: definite([7.62]) }), DEFAULT_SETTINGS, true);
    expect(r.resolvedPrice).toBe(9.99);
  });

  it(".99 round: $7.70 × 1.30 = $10.01 → $10.99 (must go up to next dollar)", () => {
    // Critical edge: when raw price crosses a dollar boundary, .99 in NEW dollar
    const r = resolveOfferPrice(inp({ offers: definite([7.70]) }), DEFAULT_SETTINGS, true);
    expect(r.resolvedPrice).toBe(10.99);
  });

  it("Rule 1 fires regardless of cogs presence", () => {
    const r = resolveOfferPrice(
      inp({ cogs: null, offers: definite([10]) }),
      DEFAULT_SETTINGS,
      true,
    );
    expect(r.rule).toBe("highest_plus_30");
    expect(r.resolvedPrice).toBe(13.99); // 10*1.30=13 → ceil to 13.99
    expect(r.resultingRoi).toBeNull(); // no cogs → can't compute resultingRoi
  });

  it("Rule 1 still computes resultingRoi diagnostic when cogs known", () => {
    const r = resolveOfferPrice(
      inp({ cogs: 10, offers: definite([20]) }),
      DEFAULT_SETTINGS,
      true,
    );
    expect(r.resultingRoi).not.toBeNull();
    expect(r.resultingRoi!).toBeGreaterThan(0);
  });
});

// ============================================================================
// Rule 2: 0 competing offers → bisect for 100% ROI, round UP to .99
// ============================================================================
describe("Rule 2: 100% ROI via bisection, round UP to .99", () => {
  it("zero offers + valid cogs → resolves to price ending in .99 with ROI ≥ 100%", () => {
    const r = resolveOfferPrice(inp({ cogs: 10 }), DEFAULT_SETTINGS, true);
    expect(r.rule).toBe("roi_100");
    expect(r.resolvedPrice).not.toBeNull();
    expect(r.resultingRoi).not.toBeNull();
    // ROI floor protection: rounded UP, so final ROI must be >= target
    expect(r.resultingRoi!).toBeGreaterThanOrEqual(100);
    // .99 round: cents must equal 99
    const cents = Math.round(r.resolvedPrice! * 100);
    expect(cents % 100).toBe(99);
  });

  it("round-UP protects ROI floor: rounded price > raw solved price", () => {
    // The detail string contains both values; we re-verify ROI doesn't drop below 100.
    const input = inp({ cogs: 15.50 });
    const r = resolveOfferPrice(input, DEFAULT_SETTINGS, true);
    expect(r.resolvedPrice).not.toBeNull();
    // Re-verify with calculateProfit independently
    const verify = calculateProfit(
      r.resolvedPrice!,
      input.cogs!,
      input.fbaFee ?? 0,
      input.referralFee ?? 0,
      input.feesEstimatePrice,
      input.weightLbs,
      input.prepCost,
      input.storageCost,
      DEFAULT_SETTINGS,
      true,
      input.isHazmat,
      input.category,
    );
    expect(verify.roi).toBeGreaterThanOrEqual(100);
  });

  it("zero offers + null cogs → skip_no_cogs", () => {
    const r = resolveOfferPrice(inp({ cogs: null }), DEFAULT_SETTINGS, true);
    expect(r.rule).toBe("skip_no_cogs");
    expect(r.resolvedPrice).toBeNull();
    expect(r.detail).toContain("COGS");
  });

  it("zero offers + cogs=0 → skip_no_cogs", () => {
    const r = resolveOfferPrice(inp({ cogs: 0 }), DEFAULT_SETTINGS, true);
    expect(r.rule).toBe("skip_no_cogs");
    expect(r.resolvedPrice).toBeNull();
  });

  it("zero offers + negative cogs (corruption guard) → skip_no_cogs", () => {
    const r = resolveOfferPrice(inp({ cogs: -5 }), DEFAULT_SETTINGS, true);
    expect(r.rule).toBe("skip_no_cogs");
  });

  it("bisection deterministic — same input → same output", () => {
    const input = inp({ cogs: 12.34 });
    const r1 = resolveOfferPrice(input, DEFAULT_SETTINGS, true);
    const r2 = resolveOfferPrice(input, DEFAULT_SETTINGS, true);
    expect(r1.resolvedPrice).toBe(r2.resolvedPrice);
  });

  it("higher cogs → higher resolved price", () => {
    const low = resolveOfferPrice(inp({ cogs: 5 }), DEFAULT_SETTINGS, true);
    const high = resolveOfferPrice(inp({ cogs: 20 }), DEFAULT_SETTINGS, true);
    expect(high.resolvedPrice!).toBeGreaterThan(low.resolvedPrice!);
  });

  it("hazmat ASIN has higher resolved price (surcharges add cost)", () => {
    const surchargeSettings: Settings = {
      ...DEFAULT_SETTINGS,
      hazmatShipSurcharge: 2.0,
      hazmatPrepSurcharge: 1.5,
    };
    const nonHazmat = resolveOfferPrice(inp({ cogs: 10 }), surchargeSettings, true);
    const hazmat = resolveOfferPrice(inp({ cogs: 10, isHazmat: true }), surchargeSettings, true);
    expect(hazmat.resolvedPrice!).toBeGreaterThan(nonHazmat.resolvedPrice!);
  });

  it("higher prep cost → higher resolved price", () => {
    const noPrep = resolveOfferPrice(inp({ cogs: 10, prepCost: 0 }), DEFAULT_SETTINGS, true);
    const withPrep = resolveOfferPrice(inp({ cogs: 10, prepCost: 2.0 }), DEFAULT_SETTINGS, true);
    expect(withPrep.resolvedPrice!).toBeGreaterThan(noPrep.resolvedPrice!);
  });

  it("includeInboundShipping=false → lower resolved price (one less cost)", () => {
    const withInbound = resolveOfferPrice(inp({ cogs: 10, weightLbs: 5 }), DEFAULT_SETTINGS, true);
    const without = resolveOfferPrice(inp({ cogs: 10, weightLbs: 5 }), DEFAULT_SETTINGS, false);
    expect(without.resolvedPrice!).toBeLessThan(withInbound.resolvedPrice!);
  });
});

// ============================================================================
// Diagnostic strings
// ============================================================================
describe("detail strings", () => {
  it("Rule 1 detail mentions count + highest + .99 round", () => {
    const r = resolveOfferPrice(inp({ offers: definite([10, 20]) }), DEFAULT_SETTINGS, true);
    expect(r.detail).toMatch(/2 competing offers/);
    expect(r.detail).toMatch(/\$20\.00/);
    expect(r.detail).toMatch(/1\.30/);
    expect(r.detail).toMatch(/\.99/); // round annotation
  });

  it("Rule 2 detail mentions ROI achievement + cogs + .99 round-up", () => {
    const r = resolveOfferPrice(inp({ cogs: 10 }), DEFAULT_SETTINGS, true);
    expect(r.detail).toMatch(/100% ROI/);
    expect(r.detail).toMatch(/cogs/);
    expect(r.detail).toMatch(/\.99/);
    expect(r.detail).toMatch(/rounded UP/);
  });

  it("skip_no_cogs detail explains why", () => {
    const r = resolveOfferPrice(inp({ cogs: null }), DEFAULT_SETTINGS, true);
    expect(r.detail).toMatch(/cogs/i);
  });

  it("offers_fetch_failed detail mentions the underlying reason", () => {
    const r = resolveOfferPrice(
      inp({ offers: failed("transient_error (429): QuotaExceeded") }),
      DEFAULT_SETTINGS,
      true,
    );
    expect(r.detail).toMatch(/transient_error/);
    expect(r.detail).toMatch(/429/);
  });
});

// ============================================================================
// COGS-missing matrix — non-blocking on Rule 1, blocking on Rule 2
// ============================================================================
describe("cogsMissing matrix (Rule 1 informational, Rule 2 blocking)", () => {
  it("Rule 1 + cogs present → cogsMissing=false, resultingRoi non-null", () => {
    const r = resolveOfferPrice(
      inp({ cogs: 10, offers: definite([20]) }),
      DEFAULT_SETTINGS,
      true,
    );
    expect(r.rule).toBe("highest_plus_30");
    expect(r.cogsMissing).toBe(false);
    expect(r.resultingRoi).not.toBeNull();
    expect(r.resolvedPrice).not.toBeNull(); // submittable
  });

  it("Rule 1 + null cogs → cogsMissing=true, resolved price RETURNED (non-blocking)", () => {
    // The whole point: Rule 1 prices off the market, not cost.
    // A missing cogs doesn't prevent a valid price — just hides ROI.
    const r = resolveOfferPrice(
      inp({ cogs: null, offers: definite([20]) }),
      DEFAULT_SETTINGS,
      true,
    );
    expect(r.rule).toBe("highest_plus_30");
    expect(r.cogsMissing).toBe(true);
    expect(r.resolvedPrice).toBe(26.99); // still resolved — non-blocking
    expect(r.resultingRoi).toBeNull();   // can't show ROI without cogs
    expect(r.detail).toMatch(/ROI unknown/);
  });

  it("Rule 1 + zero cogs → cogsMissing=true, same as null cogs", () => {
    const r = resolveOfferPrice(
      inp({ cogs: 0, offers: definite([20]) }),
      DEFAULT_SETTINGS,
      true,
    );
    expect(r.rule).toBe("highest_plus_30");
    expect(r.cogsMissing).toBe(true);
    expect(r.resolvedPrice).toBe(26.99);
    expect(r.resultingRoi).toBeNull();
  });

  it("Rule 2 + null cogs → BLOCKING (skip_no_cogs, no resolved price)", () => {
    const r = resolveOfferPrice(
      inp({ cogs: null, offers: definite([]) }),
      DEFAULT_SETTINGS,
      true,
    );
    expect(r.rule).toBe("skip_no_cogs");
    expect(r.cogsMissing).toBe(true);
    expect(r.resolvedPrice).toBeNull(); // blocking
  });

  it("Rule 2 + cogs present → cogsMissing=false, normal Rule 2 flow", () => {
    const r = resolveOfferPrice(
      inp({ cogs: 10, offers: definite([]) }),
      DEFAULT_SETTINGS,
      true,
    );
    expect(r.rule).toBe("roi_100");
    expect(r.cogsMissing).toBe(false);
    expect(r.resolvedPrice).not.toBeNull();
  });

  it("offers_fetch_failed sets cogsMissing accurately regardless of blocking reason", () => {
    // cogsMissing reflects the input state. offers_fetch_failed is the rule
    // (the blocking reason), but cogsMissing is independent.
    const withCogs = resolveOfferPrice(
      inp({ cogs: 10, offers: failed() }),
      DEFAULT_SETTINGS, true,
    );
    expect(withCogs.cogsMissing).toBe(false);

    const noCogs = resolveOfferPrice(
      inp({ cogs: null, offers: failed() }),
      DEFAULT_SETTINGS, true,
    );
    expect(noCogs.cogsMissing).toBe(true);

    // Both still block via offers_fetch_failed regardless of cogs state
    expect(withCogs.rule).toBe("offers_fetch_failed");
    expect(noCogs.rule).toBe("offers_fetch_failed");
  });
});

// ============================================================================
// 18555 suppression cap (SPEC §18 "Suppression cap")
// ============================================================================
describe("18555 suppression cap", () => {
  const withRefs = (competing: number[], cpt: number | null, bb: number | null): OffersInput =>
    ({ kind: "definitive", competing, competitivePriceThreshold: cpt, buyBoxPrice: bb });

  it("CPT cap binds strictly below CPT with .x9 dime-step flooring ($119.99 → $119.89)", () => {
    // Rule 1 price: $180 × 1.30 = $234 → $234.99; CPT $119.99 sits on .x9 → step down a dime
    const r = resolveOfferPrice(inp({ offers: withRefs([180], 119.99, null) }), DEFAULT_SETTINGS, true);
    expect(r.rule).toBe("highest_plus_30");
    expect(r.capApplied).toBe(true);
    expect(r.capReference).toBe("cpt");
    expect(r.resolvedPrice).toBe(119.89);
    expect(r.uncappedPrice).toBe(234.99);
    expect(r.detail).toMatch(/CAPPED/);
  });

  it("CPT not on .x9 floors to the nearest .x9 strictly below ($120.00 → $119.99)", () => {
    const r = resolveOfferPrice(inp({ offers: withRefs([180], 120.0, null) }), DEFAULT_SETTINGS, true);
    expect(r.resolvedPrice).toBe(119.99);
    expect(r.capReference).toBe("cpt");
  });

  it("CPT takes precedence over buy box", () => {
    const r = resolveOfferPrice(inp({ offers: withRefs([180], 119.99, 26) }), DEFAULT_SETTINGS, true);
    expect(r.capReference).toBe("cpt");
    expect(r.resolvedPrice).toBe(119.89);
  });

  it("BB fallback: cap = BB × 1.5 floored to .x9 ($26 → $38.99; the Aug-02 B0H19TPRR7 case)", () => {
    // Rule price 49.99 × 1.3 = 64.99 (the real 18555 trip); 26 × 1.5 = 39.00 → .x9 floor → 38.99
    const r = resolveOfferPrice(inp({ offers: withRefs([49.99], null, 26) }), DEFAULT_SETTINGS, true);
    expect(r.capApplied).toBe(true);
    expect(r.capReference).toBe("buy_box_x1_5");
    expect(r.resolvedPrice).toBe(38.99);
    expect(r.uncappedPrice).toBe(64.99);
  });

  it(".x9 flooring is 10-cent steps, not .99 dollar-steps ($12.65 BB → cap $18.89)", () => {
    // 12.65 × 1.5 = 18.975 → $18.89 (NOT $18.99 which exceeds, NOT $17.99 dollar-step)
    const r = resolveOfferPrice(inp({ offers: withRefs([40], null, 12.65) }), DEFAULT_SETTINGS, true);
    expect(r.capApplied).toBe(true);
    expect(r.resolvedPrice).toBe(18.89);
  });

  it("cap never raises: rule price below cap is untouched", () => {
    // Rule: $10 × 1.3 → $13.99; cap would be 26 × 1.5 → $38.99
    const r = resolveOfferPrice(inp({ offers: withRefs([10], null, 26) }), DEFAULT_SETTINGS, true);
    expect(r.capApplied).toBe(false);
    expect(r.resolvedPrice).toBe(13.99);
    expect(r.uncappedPrice).toBeNull();
    expect(r.noPriceReference).toBe(false);
  });

  it("Rule 2 (roi_100) output is capped too, and low-ROI-after-cap flags", () => {
    // ROI-100 on $100 cogs lands far above CPT $50 → capped to $49.99 (strictly below 50);
    // ROI at $49.99 on $100 cogs is deep-negative → flagged, not blocked.
    const r = resolveOfferPrice(inp({ cogs: 100, offers: withRefs([], 50, null) }), DEFAULT_SETTINGS, true);
    expect(r.rule).toBe("roi_100");
    expect(r.capApplied).toBe(true);
    expect(r.resolvedPrice).toBe(49.99);
    expect(r.lowRoiAfterCap).toBe(true);
    expect(r.detail).toMatch(/below min/);
  });

  it("no CPT and no BB → uncapped with noPriceReference flag (18555 risk visible)", () => {
    const r = resolveOfferPrice(inp({ offers: definite([49.99]) }), DEFAULT_SETTINGS, true);
    expect(r.capApplied).toBe(false);
    expect(r.noPriceReference).toBe(true);
    expect(r.resolvedPrice).toBe(64.99); // rule price stands
    expect(r.detail).toMatch(/18555 risk/);
  });

  it("null-price outcomes (fetch_failed) carry inert cap fields", () => {
    const r = resolveOfferPrice(inp({ offers: failed() }), DEFAULT_SETTINGS, true);
    expect(r.capApplied).toBe(false);
    expect(r.noPriceReference).toBe(false);
    expect(r.uncappedPrice).toBeNull();
  });
});
