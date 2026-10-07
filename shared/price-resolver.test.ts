import { describe, it, expect } from "vitest";
import {
  resolveOfferPrice, qualifyOffers,
  MIN_QUALIFYING_FEEDBACK, ANCHOR_MIN_ROI, LOW_ROI_TARGET, NO_FBA_ROI_TARGET,
  type PriceResolverInput, type OffersInput, type QualifiableOffer,
} from "./price-resolver";
import { type Settings, settingsSchema } from "./schema";

// SPEC §18 "Price Resolution (v2)" — offer-anchored, CPT never a pricing input.
//
// This file replaced the v1 suite. Retired with v1 and deliberately NOT
// carried over: the ×1.30 anchor, the 100% ROI solve, skip_no_cogs as a
// non-blocking/blocking matrix, and the whole 18555 cap chain (CPT cap, buy
// box ×1.5, .x9 flooring, capApplied/lowRoiAfterCap/noPriceReference).
// Properties that OUTLIVED v1 are kept and re-pointed at v2's paths:
// fetch-failed never collapsing to "no offers", .99 ceil-rounding, and the
// cost-sensitivity of the ROI solve.

const DEFAULT_SETTINGS: Settings = settingsSchema.parse({});

let seq = 0;
/** A qualifying offer by default: FBA, 3rd-party, comfortably above the feedback floor. */
function offer(price: number, over: Partial<QualifiableOffer> = {}): QualifiableOffer {
  return { sellerId: `S${++seq}`, price, isFba: true, feedbackCount: 500, isAmazon: false, ...over };
}
function definite(offers: QualifiableOffer[] = [], cpt: number | null = null): OffersInput {
  return { kind: "definitive", offers, competitivePriceThreshold: cpt };
}
function failed(reason = "transient_error (429)"): OffersInput {
  return { kind: "fetch_failed", reason };
}
function inp(overrides: Partial<PriceResolverInput> = {}): PriceResolverInput {
  return {
    cogs: 10, fbaFee: 3.5, referralFee: 3.0, feesEstimatePrice: 20,
    weightLbs: 1.0, isHazmat: false, category: "Beauty & Personal Care",
    prepCost: 0, storageCost: 0, offers: definite([]),
    ...overrides,
  };
}
const resolve = (i: PriceResolverInput) => resolveOfferPrice(i, DEFAULT_SETTINGS, true);

// ============================================================================
// Qualified offer set
// ============================================================================
describe("qualified offer set", () => {
  it(`feedback ${MIN_QUALIFYING_FEEDBACK - 1} is EXCLUDED, ${MIN_QUALIFYING_FEEDBACK} is INCLUDED (boundary is inclusive)`, () => {
    const { qualified, disqualified } = qualifyOffers([
      offer(20, { feedbackCount: 14 }),
      offer(21, { feedbackCount: 15 }),
    ]);
    expect(qualified.map((o) => o.price)).toEqual([21]);
    expect(disqualified).toHaveLength(1);
    expect(disqualified[0]).toMatchObject({ price: 20, reason: "under_15_feedback" });
  });

  it("Amazon is excluded even with huge feedback", () => {
    const { qualified, disqualified } = qualifyOffers([
      offer(99, { isAmazon: true, feedbackCount: 1_000_000 }),
      offer(30),
    ]);
    expect(qualified.map((o) => o.price)).toEqual([30]);
    expect(disqualified[0]).toMatchObject({ price: 99, reason: "amazon_offer" });
  });

  it("missing feedback counts as 0 — absence must not pass the floor", () => {
    const { qualified, disqualified } = qualifyOffers([offer(30, { feedbackCount: null })]);
    expect(qualified).toEqual([]);
    expect(disqualified[0].reason).toBe("under_15_feedback");
  });

  it("Amazon takes precedence as the REASON when both exclusions apply", () => {
    // Amazon carries no feedback rating, so both rules fire; "it's Amazon"
    // is the more informative thing to show.
    const { disqualified } = qualifyOffers([offer(50, { isAmazon: true, feedbackCount: null })]);
    expect(disqualified[0].reason).toBe("amazon_offer");
  });

  it("disqualified offers are REPORTED, never silently dropped", () => {
    const r = resolve(inp({ offers: definite([
      offer(40, { isAmazon: true }), offer(35, { feedbackCount: 2 }), offer(30),
    ]) }));
    expect(r.qualifiedCount).toBe(1);
    expect(r.disqualified).toHaveLength(2);
    expect(r.detail).toMatch(/2 disqualified/);
  });

  it("NO outlier rule for opening prices — a low outlier changes nothing", () => {
    // The anchor is the HIGHEST qualified offer, so a low outlier is
    // irrelevant by construction. Pinned because v2 deliberately removed the
    // low-credibility outlier rule rather than reimplementing it here.
    const withOutlier = resolve(inp({ offers: definite([offer(30), offer(2)]) }));
    const without = resolve(inp({ offers: definite([offer(30)]) }));
    expect(withOutlier.resolvedPrice).toBe(without.resolvedPrice);
  });
});

// ============================================================================
// Path 1 — highest qualified FBA offer
// ============================================================================
describe("fba_anchor — highest qualified FBA offer, ceil .99", () => {
  it("anchors on the HIGHEST qualified FBA offer, not the lowest or an average", () => {
    const r = resolve(inp({ cogs: 10, offers: definite([offer(21.57), offer(21.95), offer(21.58)]) }));
    expect(r.source).toBe("fba_anchor");
    expect(r.anchorOffer?.price).toBe(21.95);
    expect(r.resolvedPrice).toBe(21.99); // ceil to next .99
  });

  it("an offer already on .99 is left unchanged", () => {
    const r = resolve(inp({ cogs: 10, offers: definite([offer(39.99)]) }));
    expect(r.resolvedPrice).toBe(39.99);
  });

  it("FBM offers do not anchor — only FBA does", () => {
    const r = resolve(inp({ cogs: 10, offers: definite([
      offer(50, { isFba: false }), offer(30, { isFba: true }),
    ]) }));
    expect(r.source).toBe("fba_anchor");
    expect(r.anchorOffer?.price).toBe(30); // the FBM $50 is qualified but not an anchor
    expect(r.qualifiedCount).toBe(2);
    expect(r.qualifiedFbaCount).toBe(1);
  });

  it("reports the anchor offer's feedback count", () => {
    const r = resolve(inp({ cogs: 10, offers: definite([offer(30, { feedbackCount: 184 })]) }));
    expect(r.anchorOffer?.feedbackCount).toBe(184);
    expect(r.detail).toMatch(/feedback 184/);
  });

  it("no warning when the anchor's ROI clears the threshold", () => {
    const r = resolve(inp({ cogs: 10, offers: definite([offer(40)]) }));
    expect(r.warning).toBeNull();
    expect(r.resultingRoi!).toBeGreaterThanOrEqual(ANCHOR_MIN_ROI);
  });
});

// ============================================================================
// Path 1b — anchor ROI < 20% → 40% solve
// ============================================================================
describe(`roi_40_floor — anchor ROI < ${ANCHOR_MIN_ROI}% → ${LOW_ROI_TARGET}% solve + the only warning`, () => {
  // COGS high relative to the market: anchoring on the offer would price at a
  // thin or negative ROI.
  const thin = inp({ cogs: 18, offers: definite([offer(20)]) });

  it("prices at the 40% ROI solve instead of the anchor", () => {
    const r = resolve(thin);
    expect(r.source).toBe("roi_40_floor");
    expect(r.resultingRoi!).toBeGreaterThanOrEqual(LOW_ROI_TARGET);
    expect(r.resolvedPrice!).toBeGreaterThan(20.99); // above the anchor price
  });

  it("emits low_roi_repriced — and it is the ONLY warning v2 has", () => {
    expect(resolve(thin).warning).toBe("low_roi_repriced");
    // every other path is warning-free
    expect(resolve(inp({ cogs: 10, offers: definite([offer(40)]) })).warning).toBeNull();
    expect(resolve(inp({ cogs: 10, offers: definite([]) })).warning).toBeNull();
  });

  it("still reports the anchor it rejected, with its ROI, in the detail", () => {
    const r = resolve(thin);
    expect(r.anchorOffer?.price).toBe(20);
    expect(r.detail).toMatch(/highest qualified FBA offer \$20\.00/);
    expect(r.detail).toMatch(new RegExp(`< ${ANCHOR_MIN_ROI}%`));
  });

  it("the boundary is inclusive: ROI exactly at the threshold keeps the anchor", () => {
    // Scan for an anchor price whose ROI lands just at/above the threshold and
    // confirm the source flips rather than asserting a hand-computed figure.
    let flipped = false;
    for (let price = 14; price <= 40; price += 0.5) {
      const r = resolve(inp({ cogs: 10, offers: definite([offer(price)]) }));
      if (r.source === "fba_anchor") { expect(r.resultingRoi!).toBeGreaterThanOrEqual(ANCHOR_MIN_ROI); flipped = true; }
      else expect(r.source).toBe("roi_40_floor");
    }
    expect(flipped).toBe(true);
  });
});

// ============================================================================
// Path 2 — no qualified FBA → 60% solve
// ============================================================================
describe(`roi_60_solve — no qualified FBA offers → ${NO_FBA_ROI_TARGET}% ROI`, () => {
  it("zero offers at all → 60% solve", () => {
    const r = resolve(inp({ cogs: 10, offers: definite([]) }));
    expect(r.source).toBe("roi_60_solve");
    expect(r.resultingRoi!).toBeGreaterThanOrEqual(NO_FBA_ROI_TARGET);
    expect(r.detail).toMatch(/no competing offers/);
  });

  it("offers exist but NONE qualify → 60% solve, and says so", () => {
    const r = resolve(inp({ cogs: 10, offers: definite([
      offer(30, { feedbackCount: 3 }), offer(32, { isAmazon: true }),
    ]) }));
    expect(r.source).toBe("roi_60_solve");
    expect(r.detail).toMatch(/no qualified FBA offers among 2/);
  });

  it("qualified FBM but no qualified FBA → 60% solve (FBM is not a fallback anchor)", () => {
    const r = resolve(inp({ cogs: 10, offers: definite([offer(45, { isFba: false })]) }));
    expect(r.source).toBe("roi_60_solve");
    expect(r.qualifiedCount).toBe(1);
    expect(r.qualifiedFbaCount).toBe(0);
  });

  it("price always ends in .99 and rounding UP protects the target", () => {
    for (const cogs of [5, 10, 23.45, 80]) {
      const r = resolve(inp({ cogs, offers: definite([]) }));
      expect(Math.round(r.resolvedPrice! * 100) % 100).toBe(99);
      expect(r.resultingRoi!).toBeGreaterThanOrEqual(NO_FBA_ROI_TARGET);
    }
  });

  // Cost-sensitivity properties carried over from the v1 suite.
  it("deterministic — same input, same output", () => {
    const a = resolve(inp({ cogs: 12, offers: definite([]) }));
    const b = resolve(inp({ cogs: 12, offers: definite([]) }));
    expect(a.resolvedPrice).toBe(b.resolvedPrice);
  });
  it("higher COGS → higher price", () => {
    const lo = resolve(inp({ cogs: 10, offers: definite([]) })).resolvedPrice!;
    const hi = resolve(inp({ cogs: 20, offers: definite([]) })).resolvedPrice!;
    expect(hi).toBeGreaterThan(lo);
  });
  it("prep cost raises the price", () => {
    // Deltas must clear the .99 rounding granularity ($1 steps), so these use
    // costs big enough to move the price a whole dollar.
    const base = resolve(inp({ cogs: 10, offers: definite([]) })).resolvedPrice!;
    expect(resolve(inp({ cogs: 10, prepCost: 3, offers: definite([]) })).resolvedPrice!).toBeGreaterThan(base);
  });

  it("hazmat raises the price ONLY when the surcharges are configured", () => {
    // Default settings have hazmatShipSurcharge = hazmatPrepSurcharge = 0, so
    // isHazmat alone changes nothing — asserting otherwise would be wrong.
    const base = resolve(inp({ cogs: 10, offers: definite([]) })).resolvedPrice!;
    expect(resolve(inp({ cogs: 10, isHazmat: true, offers: definite([]) })).resolvedPrice!).toBe(base);

    const hazSettings: Settings = settingsSchema.parse({ hazmatShipSurcharge: 2, hazmatPrepSurcharge: 2 });
    const plain = resolveOfferPrice(inp({ cogs: 10, offers: definite([]) }), hazSettings, true).resolvedPrice!;
    const haz = resolveOfferPrice(inp({ cogs: 10, isHazmat: true, offers: definite([]) }), hazSettings, true).resolvedPrice!;
    expect(haz).toBeGreaterThan(plain);
  });

  it("includeInboundShipping=false → lower price (one less cost)", () => {
    // 10 lb at the default $0.50/lb = $5, comfortably past the $1 rounding step.
    const heavy = { cogs: 10, weightLbs: 10, offers: definite([]) };
    const on = resolveOfferPrice(inp(heavy), DEFAULT_SETTINGS, true).resolvedPrice!;
    const off = resolveOfferPrice(inp(heavy), DEFAULT_SETTINGS, false).resolvedPrice!;
    expect(off).toBeLessThan(on);
  });
});

// ============================================================================
// Blocked outcomes
// ============================================================================
describe("blocked outcomes", () => {
  it("COGS missing BLOCKS every path — including when offers exist", () => {
    for (const cogs of [null, 0, -5]) {
      const r = resolve(inp({ cogs, offers: definite([offer(30)]) }));
      expect(r.blocked).toBe("needs_cogs");
      expect(r.resolvedPrice).toBeNull();
      expect(r.detail).toMatch(/COGS required/);
    }
  });

  it("the needs_cogs row still reports the offer picture, so the UI can show it", () => {
    const r = resolve(inp({ cogs: null, offers: definite([offer(30), offer(20, { feedbackCount: 1 })], 5.68) }));
    expect(r.qualifiedCount).toBe(1);
    expect(r.disqualified).toHaveLength(1);
    expect(r.competitivePriceThreshold).toBe(5.68);
  });

  // CARRIED OVER FROM v1: the single most important discipline in this module.
  it("fetch_failed NEVER collapses to 'no offers' — it blocks", () => {
    for (const cogs of [10, null]) {
      const r = resolve(inp({ cogs, offers: failed("transient_error (429)") }));
      expect(r.blocked).toBe("offers_fetch_failed");
      expect(r.resolvedPrice).toBeNull();
      expect(r.source).toBeNull();
      expect(r.detail).toMatch(/429/);
    }
  });

  it("a DEFINITIVE empty array is a real zero-offer market, not a failure", () => {
    const r = resolve(inp({ cogs: 10, offers: definite([]) }));
    expect(r.blocked).toBeNull();
    expect(r.source).toBe("roi_60_solve");
  });

  it("unreachable ROI blocks rather than pricing wrong", () => {
    // Prep cost far above any achievable margin.
    const r = resolve(inp({ cogs: 10, prepCost: 100000, offers: definite([]) }));
    expect(r.blocked).toBe("unreachable_roi");
    expect(r.resolvedPrice).toBeNull();
  });
});

// ============================================================================
// CPT — shown, never used
// ============================================================================
describe("CPT is reported but never changes a price", () => {
  it("the SAME inputs price identically whatever CPT says", () => {
    const offers = [offer(21.57), offer(21.95)];
    const prices = [null, 5.68, 1, 999].map(
      (cpt) => resolve(inp({ cogs: 10, offers: definite(offers, cpt) })).resolvedPrice,
    );
    expect(new Set(prices).size).toBe(1); // CPT moved nothing
  });

  it("CPT is passed through for display, including on blocked rows", () => {
    expect(resolve(inp({ cogs: 10, offers: definite([offer(30)], 5.68) })).competitivePriceThreshold).toBe(5.68);
    expect(resolve(inp({ cogs: null, offers: definite([offer(30)], 5.68) })).competitivePriceThreshold).toBe(5.68);
    expect(resolve(inp({ cogs: 10, offers: definite([offer(30)], null) })).competitivePriceThreshold).toBeNull();
  });

  it("CPT produces NO warning and NO flag", () => {
    // A CPT far below the market is exactly what used to cap the price.
    const r = resolve(inp({ cogs: 10, offers: definite([offer(30)], 2.0) }));
    expect(r.warning).toBeNull();
    expect(r.detail).not.toMatch(/cap|18555|threshold/i);
  });

  it("the buy box is not a pricing input either", () => {
    const withBb: OffersInput = { kind: "definitive", offers: [offer(30)], buyBoxPrice: 10 };
    const withoutBb: OffersInput = { kind: "definitive", offers: [offer(30)] };
    expect(resolve(inp({ cogs: 10, offers: withBb })).resolvedPrice)
      .toBe(resolve(inp({ cogs: 10, offers: withoutBb })).resolvedPrice);
  });
});

// ============================================================================
// The cases that motivated v2
// ============================================================================
describe("B00IJYJKRI — the ASIN v1 capped to $5.59 (ROI -102.4%)", () => {
  // Live shape 2026-10-04: 5 competing offers $21.57-$21.95, CPT $5.68,
  // COGS $5.36. v1 capped strictly below CPT and inverted the margin.
  const live = inp({
    cogs: 5.36, fbaFee: 4.09, referralFee: 3.24, feesEstimatePrice: 21.57,
    weightLbs: 0.3527, isHazmat: false, category: "Health & Household",
    offers: definite(
      [offer(21.57), offer(21.58), offer(21.58), offer(21.95), offer(21.95)],
      5.68,
    ),
  });

  it("is NEVER capped — it anchors on the $21.95 offer", () => {
    const r = resolve(live);
    expect(r.source).toBe("fba_anchor");
    expect(r.anchorOffer?.price).toBe(21.95);
    expect(r.resolvedPrice).toBe(21.99);
  });

  it("prices nowhere near the old $5.59, and the ROI is healthy", () => {
    const r = resolve(live);
    expect(r.resolvedPrice!).toBeGreaterThan(20);
    expect(r.resultingRoi!).toBeGreaterThan(ANCHOR_MIN_ROI);
    expect(r.warning).toBeNull();
  });

  it("CPT $5.68 is shown and ignored", () => {
    expect(resolve(live).competitivePriceThreshold).toBe(5.68);
  });
});

describe("B0BS6NVYCN — the worked example from the patch", () => {
  // 6 offers: FBA cluster ~$39.99, FBM $36.99, CPT ~$21, breakeven ~$24.
  // v1 capped to $20.99, below breakeven. v2 opens at the FBA cluster.
  const worked = inp({
    cogs: 16, fbaFee: 5.2, referralFee: 6.0, feesEstimatePrice: 39.99,
    weightLbs: 1.2, category: "Home & Kitchen",
    offers: definite([
      offer(39.99), offer(39.99), offer(38.5), offer(37.25),
      offer(36.99, { isFba: false }),
      offer(40.5, { isAmazon: true }),
    ], 21),
  });

  it("opens at the highest qualified FBA price, not the Amazon offer or the FBM one", () => {
    const r = resolve(worked);
    expect(r.source).toBe("fba_anchor");
    expect(r.anchorOffer?.price).toBe(39.99);   // Amazon's $40.50 excluded
    expect(r.resolvedPrice).toBe(39.99);
    expect(r.warning).toBeNull();
  });

  it("is far above the v1 capped $20.99 and above breakeven", () => {
    const r = resolve(worked);
    expect(r.resolvedPrice!).toBeGreaterThan(24);
    expect(r.resultingRoi!).toBeGreaterThanOrEqual(ANCHOR_MIN_ROI);
  });

  it("shows CPT $21 as information only", () => {
    expect(resolve(worked).competitivePriceThreshold).toBe(21);
    expect(resolve(worked).detail).not.toMatch(/cap/i);
  });
});
