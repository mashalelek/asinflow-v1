// Pure price resolver for offer-add — SPEC §18 "Price Resolution (v2)".
//
// v2 (2026-10-07) is OFFER-ANCHORED. The anchor is the highest offer in a
// QUALIFIED set of current competing offers; CPT is shown but never used;
// every path resolves to a price with no manual entry.
//
//   qualified FBA offers exist  -> highest qualified FBA landed price, ceil .99
//                                  ROI at that price < 20% -> 40% ROI solve
//                                  (warning low_roi_repriced)
//   no qualified FBA / no offers -> 60% ROI solve, ceil .99
//   60% unreachable              -> blocked
//   COGS missing                 -> blocked, UI prompts inline
//
// Qualified set (SHARED with §23's repricer min/max — one definition):
//   - Amazon always excluded (we never compete with Amazon)
//   - feedback count < 15 excluded (no track record); missing feedback = 0
//   - NO outlier rule here: the anchor is the HIGHEST qualified offer, so
//     excluding low outliers could never move it. Low-outlier handling is
//     the repricer's lowest-offer rule only.
//
// RETIRED from v1: the 18555 cap chain (CPT / buy box x1.5 / .x9 flooring),
// "capped", lowRoiAfterCap, noPriceReference, the x1.30 anchor, the 100% ROI
// solve, manual price entry, skip_no_cogs-as-skip. SPEC §18 keeps the 18555
// history and the v1 calibration; none of the mechanism is live. Why: CPT
// lags the market badly enough to price below breakeven — B0BS6NVYCN opened
// at $20.99 against a ~$24 breakeven, and B00IJYJKRI was capped to $5.59
// (ROI -102.4%) against a $21.57-21.95 market.
//
// Fee infrastructure mirrors the Estimated profit columns: the same
// calculateProfit() from shared/schema.ts, so a resolved price's ROI matches
// what the table shows for that price.

import { calculateProfit, type Settings } from "./schema";

// ─── Thresholds (SPEC §18 v2) ────────────────────────────────────────────────
/** Feedback floor for the qualified set. 10 (2026-09-03) -> 20 (2026-09-15) -> 15. */
export const MIN_QUALIFYING_FEEDBACK = 15;
/** ROI at the FBA anchor below this triggers the 40% solve. */
export const ANCHOR_MIN_ROI = 20;
/** Target when the anchor ROI is too low. */
export const LOW_ROI_TARGET = 40;
/** Target when there is no qualified FBA offer at all. */
export const NO_FBA_ROI_TARGET = 60;

export type PriceSource =
  | "fba_anchor"    // highest qualified FBA offer
  | "roi_40_floor"  // anchor existed but its ROI was < 20%
  | "roi_60_solve"; // no qualified FBA offer / no offers

export type PriceBlockedReason =
  | "needs_cogs"           // COGS null or <= 0 — UI prompts inline, row can't submit
  | "unreachable_roi"      // target ROI not achievable in the search range
  | "offers_fetch_failed"; // 429/5xx/404/network — UNKNOWN, never treated as "no offers"

export type DisqualifyReason = "amazon_offer" | "under_15_feedback";

/** One offer as Amazon reported it, before qualification. */
export interface QualifiableOffer {
  sellerId: string;
  price: number;              // landed (listing + shipping)
  isFba: boolean;
  feedbackCount: number | null; // null = Amazon omitted it -> treated as 0
  isAmazon: boolean;
}

// Discriminated union: forces callers to distinguish "definitively zero
// offers" from "we couldn't find out". Collapsing them produces wrong prices —
// a 429 would otherwise look like an empty market and trigger the ROI solve
// on an ASIN that actually has competitors. Same unknown != definite-value
// discipline as catalog-deleted's tri-state.
export type OffersInput =
  | {
      kind: "definitive";
      offers: QualifiableOffer[];          // empty array = real zero offers
      // Parsed from payload.Summary of the SAME response (free). SHOWN on the
      // preview row, NEVER an input to any price (§18 v2).
      competitivePriceThreshold?: number | null;
      buyBoxPrice?: number | null;
    }
  | { kind: "fetch_failed"; reason: string };

export interface PriceResolverInput {
  cogs: number | null;
  fbaFee: number | null;
  referralFee: number | null;
  feesEstimatePrice: number | null;
  weightLbs: number | null;
  isHazmat: boolean;
  category: string | null;
  prepCost: number;
  storageCost: number;
  // Caller filters OUR seller out before building this.
  offers: OffersInput;
}

export interface DisqualifiedOffer {
  sellerId: string;
  price: number;
  isFba: boolean;
  feedbackCount: number | null;
  reason: DisqualifyReason;
}

export interface PriceResolverResult {
  source: PriceSource | null;
  resolvedPrice: number | null;
  /** Non-null means the row cannot submit. */
  blocked: PriceBlockedReason | null;
  /** The qualified FBA offer the price was anchored on (fba_anchor only). */
  anchorOffer: { price: number; feedbackCount: number | null; sellerId: string } | null;
  resultingRoi: number | null;
  /** Shown per row as a value; "—" when null. NEVER used in pricing. */
  competitivePriceThreshold: number | null;
  qualifiedCount: number;
  qualifiedFbaCount: number;
  disqualified: DisqualifiedOffer[];
  /** The ONLY warning v2 emits. */
  warning: "low_roi_repriced" | null;
  detail: string;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

// Smallest value of the form N.99 that is >= price. Always rounds UP, which
// is what protects an ROI target: the rounded price's ROI is always >= the
// solved target. Cents arithmetic dodges float edges ($35.99 as 35.9899…).
function ceilToNext99(price: number): number {
  const cents = Math.ceil(price * 100);
  const remainder = cents % 100;
  if (remainder === 99) return cents / 100;
  return (cents - remainder + 99) / 100;
}

/**
 * Split offers into qualified and disqualified per §18 v2.
 * Exported so §23's repricer min/max can consume the SAME definition when
 * that phase lands, rather than growing a second copy.
 */
export function qualifyOffers(offers: QualifiableOffer[]): {
  qualified: QualifiableOffer[];
  disqualified: DisqualifiedOffer[];
} {
  const qualified: QualifiableOffer[] = [];
  const disqualified: DisqualifiedOffer[] = [];
  for (const o of offers) {
    // Amazon first: when both apply, "it's Amazon" is the more informative
    // reason to show.
    if (o.isAmazon) {
      disqualified.push({ ...o, reason: "amazon_offer" });
      continue;
    }
    // Missing feedback counts as 0 — "no track record" is the case the
    // threshold exists for, so absence must not pass.
    if ((o.feedbackCount ?? 0) < MIN_QUALIFYING_FEEDBACK) {
      disqualified.push({ ...o, reason: "under_15_feedback" });
      continue;
    }
    qualified.push(o);
  }
  return { qualified, disqualified };
}

export function resolveOfferPrice(
  input: PriceResolverInput,
  settings: Settings,
  includeInboundShipping: boolean,
): PriceResolverResult {
  const cpt = input.offers.kind === "definitive"
    ? (input.offers.competitivePriceThreshold ?? null)
    : null;

  const base = {
    source: null,
    resolvedPrice: null,
    anchorOffer: null,
    resultingRoi: null,
    competitivePriceThreshold: cpt,
    qualifiedCount: 0,
    qualifiedFbaCount: 0,
    disqualified: [] as DisqualifiedOffer[],
    warning: null,
  };

  // ─── Blocked: offers fetch failed ────────────────────────────────────────
  // Never fall through to "zero offers" when we don't know.
  if (input.offers.kind === "fetch_failed") {
    return {
      ...base,
      blocked: "offers_fetch_failed",
      detail: `Couldn't check competition: ${input.offers.reason}. Not submittable until retry succeeds.`,
    };
  }

  const { qualified, disqualified } = qualifyOffers(input.offers.offers);
  const qualifiedFba = qualified.filter((o) => o.isFba);
  const counts = {
    qualifiedCount: qualified.length,
    qualifiedFbaCount: qualifiedFba.length,
    disqualified,
  };
  const disqSuffix = disqualified.length > 0
    ? ` (${disqualified.length} disqualified: ${summariseReasons(disqualified)})`
    : "";

  // ─── Blocked: COGS required by every path ────────────────────────────────
  // UI expands the row for an inline COGS entry, saves it as estimated COGS
  // through the product row's Est. COGS write path, then re-resolves.
  if (input.cogs == null || input.cogs <= 0) {
    return {
      ...base, ...counts,
      blocked: "needs_cogs",
      detail: `COGS required to price this row — enter it to resolve. ${qualified.length} qualified offer${qualified.length === 1 ? "" : "s"}${disqSuffix}.`,
    };
  }
  const cogs = input.cogs;

  // ─── Path 1: qualified FBA offers exist → highest, ceil .99 ──────────────
  if (qualifiedFba.length > 0) {
    const anchor = qualifiedFba.reduce((hi, o) => (o.price > hi.price ? o : hi), qualifiedFba[0]);
    const anchorPrice = ceilToNext99(anchor.price);
    const anchorRoi = roiAt(anchorPrice, input, settings, includeInboundShipping);
    const anchorDesc = `highest qualified FBA offer $${anchor.price.toFixed(2)} (feedback ${anchor.feedbackCount ?? 0}) → $${anchorPrice.toFixed(2)} (.99)`;

    if (anchorRoi >= ANCHOR_MIN_ROI) {
      return {
        ...base, ...counts,
        source: "fba_anchor",
        resolvedPrice: anchorPrice,
        blocked: null,
        anchorOffer: { price: anchor.price, feedbackCount: anchor.feedbackCount, sellerId: anchor.sellerId },
        resultingRoi: anchorRoi,
        detail: `${qualified.length} qualified offer${qualified.length === 1 ? "" : "s"}; ${anchorDesc}; ROI ${anchorRoi.toFixed(1)}%${disqSuffix}.`,
      };
    }

    // ROI at the anchor is too thin → price at 40% ROI instead. A starting
    // price above the market beats live-at-a-loss; the repricer walks down.
    const solved = solveForRoi(LOW_ROI_TARGET, cogs, input, settings, includeInboundShipping);
    if (solved == null) {
      return {
        ...base, ...counts,
        blocked: "unreachable_roi",
        anchorOffer: { price: anchor.price, feedbackCount: anchor.feedbackCount, sellerId: anchor.sellerId },
        detail: `${anchorDesc} gives ROI ${anchorRoi.toFixed(1)}% (< ${ANCHOR_MIN_ROI}%), and ${LOW_ROI_TARGET}% ROI is not reachable in the search range.`,
      };
    }
    const roi = roiAt(solved, input, settings, includeInboundShipping);
    return {
      ...base, ...counts,
      source: "roi_40_floor",
      resolvedPrice: solved,
      blocked: null,
      anchorOffer: { price: anchor.price, feedbackCount: anchor.feedbackCount, sellerId: anchor.sellerId },
      resultingRoi: roi,
      warning: "low_roi_repriced",
      detail: `${anchorDesc} gives ROI ${anchorRoi.toFixed(1)}% (< ${ANCHOR_MIN_ROI}%) — priced at ${LOW_ROI_TARGET}% ROI instead: $${solved.toFixed(2)} (.99), ROI ${roi.toFixed(1)}%${disqSuffix}.`,
    };
  }

  // ─── Path 2: no qualified FBA (or no offers) → 60% ROI solve ─────────────
  const solved = solveForRoi(NO_FBA_ROI_TARGET, cogs, input, settings, includeInboundShipping);
  const why = input.offers.offers.length === 0
    ? "no competing offers"
    : `no qualified FBA offers among ${input.offers.offers.length}`;
  if (solved == null) {
    return {
      ...base, ...counts,
      blocked: "unreachable_roi",
      detail: `${why}; ${NO_FBA_ROI_TARGET}% ROI is not reachable in the search range (cogs $${cogs.toFixed(2)}).`,
    };
  }
  const roi = roiAt(solved, input, settings, includeInboundShipping);
  return {
    ...base, ...counts,
    source: "roi_60_solve",
    resolvedPrice: solved,
    blocked: null,
    resultingRoi: roi,
    detail: `${why}; priced at ${NO_FBA_ROI_TARGET}% ROI: $${solved.toFixed(2)} (.99), ROI ${roi.toFixed(1)}% (cogs $${cogs.toFixed(2)})${disqSuffix}.`,
  };
}

function summariseReasons(d: DisqualifiedOffer[]): string {
  const byReason = new Map<DisqualifyReason, number>();
  for (const o of d) byReason.set(o.reason, (byReason.get(o.reason) ?? 0) + 1);
  return Array.from(byReason).map(([r, n]) => `${n} ${r}`).join(", ");
}

/**
 * Bisect calculateProfit for a target ROI, then ceil to .99 so the resulting
 * ROI is always >= target. Returns null when the target is unreachable within
 * the search range (extreme fee/prep structures).
 */
function solveForRoi(
  target: number,
  cogs: number,
  input: PriceResolverInput,
  settings: Settings,
  includeInboundShipping: boolean,
): number | null {
  let lo = cogs;                 // at price = cogs, profit <= 0 → ROI <= 0
  let hi = cogs * 10;
  let expansions = 0;
  while (roiAt(hi, input, settings, includeInboundShipping) < target && expansions < 6) {
    hi *= 2;
    expansions++;
  }
  if (roiAt(hi, input, settings, includeInboundShipping) < target) return null;

  let iterations = 0;
  while (hi - lo > 0.01 && iterations < 60) {
    const mid = (lo + hi) / 2;
    if (roiAt(mid, input, settings, includeInboundShipping) < target) lo = mid;
    else hi = mid;
    iterations++;
  }
  return ceilToNext99(hi);
}
// ============================================================================
// Helper: evaluate ROI at a given price using calculateProfit (same fee
// infrastructure as the Estimated profit columns).
// ============================================================================
function roiAt(
  price: number,
  input: PriceResolverInput,
  settings: Settings,
  includeInboundShipping: boolean,
): number {
  const calc = calculateProfit(
    price,
    input.cogs ?? 0,
    input.fbaFee ?? 0,
    input.referralFee ?? 0,
    input.feesEstimatePrice,
    input.weightLbs,
    input.prepCost,
    input.storageCost,
    settings,
    includeInboundShipping,
    input.isHazmat,
    input.category,
  );
  return calc.roi;
}
