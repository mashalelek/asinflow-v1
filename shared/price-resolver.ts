// STEP 3 / DA-4 substep 1: Pure price resolver for offer-add.
//
// Two rules (per Maria's spec):
//   Rule 1 — ≥1 competing offer (excluding ours): highest competing × 1.30
//   Rule 2 — 0 competing offers: bisect calculateProfit() for 100% ROI
//
// "Competing offers" is the list of offer prices from OTHER sellers — the
// caller is responsible for filtering OUR seller out (see server/listings-
// offers-fetch.ts which uses our SP_API_SELLER_ID to drop our own offer).
//
// Fee infrastructure intentionally mirrors the Estimated profit columns:
// uses the same calculateProfit() in shared/schema.ts, so the resolved
// price's resulting ROI matches what the table shows for that price.

import { calculateProfit, type Settings } from "./schema";

export type PriceRule =
  | "highest_plus_30"      // Rule 1: ≥1 competing offer
  | "roi_100"              // Rule 2: 0 competing offers, ROI-100 solved
  | "skip_no_cogs"         // Rule 2 but cogs missing/zero — cannot solve
  | "skip_unreachable"     // Rule 2 but 100% ROI not achievable (extreme edge)
  | "offers_fetch_failed"; // Offers fetch returned 429/5xx/network — UNKNOWN, blocked

// Discriminated union: forces callers to distinguish "definitive empty"
// (real zero offers → Rule 2 path) from "fetch failed" (unknown → blocked).
// This is the same unknown≠definite-value lesson as catalog-deleted's
// tri-state — collapsing the two states produces wrong prices (e.g., a
// 429 transient would silently trigger 100% ROI pricing on an ASIN that
// actually has competitors).
export type OffersInput =
  | {
      kind: "definitive";
      competing: number[];                        // empty array = real zero offers
      // 18555-cap reference data — parsed from the SAME getItemOffers response
      // (payload.Summary), zero extra API calls. Both are frequently absent:
      // CPT observed on ~1/3 of probes (and can exist WITHOUT a buy box);
      // buy box absent when no offer holds it. null/undefined = not present.
      competitivePriceThreshold?: number | null;
      buyBoxPrice?: number | null;                // New-condition landed price
    }
  | { kind: "fetch_failed"; reason: string };     // 429/5xx/404/network — UNKNOWN

export interface PriceResolverInput {
  // Cost inputs
  cogs: number | null;
  // Fee inputs (from asin_estimates / analyze path)
  fbaFee: number | null;
  referralFee: number | null;
  feesEstimatePrice: number | null;
  // Catalog inputs
  weightLbs: number | null;
  isHazmat: boolean;
  category: string | null;
  // Cost overrides (from asin_estimates if set, else settings defaults)
  prepCost: number;
  storageCost: number;
  // Market signal — see OffersInput. Caller filters our seller out before
  // building this; the "competing" list only contains OTHER sellers' prices.
  // For "we couldn't reach the offers API", use kind: "fetch_failed".
  // When the user supplies a cogs override at the needs_cogs prompt, the UI
  // persists it via PUT /api/asins/:asin/cogs (estimated_cogs + source='manual')
  // BEFORE re-calling the resolver — this resolver stays pure.
  offers: OffersInput;
}

export interface PriceResolverResult {
  rule: PriceRule;
  resolvedPrice: number | null;
  competingOfferCount: number;
  highestCompetingOffer: number | null;
  detail: string;
  // Actual ROI at the resolved price (when computable). null when no price
  // was resolved OR when cogs is missing (can't compute ROI without cost).
  resultingRoi: number | null;
  // True when input.cogs is null or <= 0. Surfaces the "ROI unknown" indicator
  // to the preview UI as a NON-BLOCKING flag. UI matrix:
  //   Rule 1 (offers exist) + cogsMissing=true → SHOW indicator, allow submit
  //   Rule 2 (no offers)    + cogsMissing=true → rule='skip_no_cogs', BLOCK
  //   Either rule + cogs present                → no indicator, ROI shown
  // The blocking/non-blocking distinction is encoded by which rule fires;
  // cogsMissing is the UI-side flag for the non-blocking case.
  cogsMissing: boolean;
  // ─── 18555 suppression cap (SPEC §18 "Suppression cap") ───
  // The cap can only LOWER a rule price, never raise it.
  capApplied: boolean;                            // rule price exceeded the cap
  capReference: "cpt" | "buy_box_x1_5" | null;    // which reference bound (when capApplied)
  uncappedPrice: number | null;                   // the rule price before capping (when capApplied)
  // No CPT and no buy box → nothing to cap against. Rule price stands
  // UNCAPPED; preview surfaces "no market reference — 18555 risk".
  noPriceReference: boolean;
  // Cap bound AND resulting ROI fell below settings.minRoiThreshold.
  // Flagged for review, never blocked.
  lowRoiAfterCap: boolean;
}

// ─── 18555 cap helpers ────────────────────────────────────────────────────────
const CAP_BB_MULTIPLIER = 1.5;

// Largest price ending in 9 CENTS (10-cent steps: .09, .19, … .99) that is
// <= v. NOT .99-dollar steps: $18.97 → $18.89.
function floorToX9(v: number): number {
  const cents = Math.floor(v * 100 + 1e-6);
  const r = cents % 10;
  return (r === 9 ? cents : cents - r - 1) / 100;
}

// Largest .x9 price STRICTLY below v — for the CPT cap ("never price AT the
// threshold"). If v itself sits on .x9, step down one dime ($119.99 → $119.89).
function floorToX9StrictlyBelow(v: number): number {
  const f = floorToX9(v);
  return Math.abs(f - v) < 0.005 ? Math.round((f - 0.10) * 100) / 100 : f;
}

interface CapInfo { value: number; reference: "cpt" | "buy_box_x1_5" }

// Cap chain: CPT (strictly below, .x9) → buy box × 1.5 (.x9) → null.
function resolveCap(offers: OffersInput): CapInfo | null {
  if (offers.kind !== "definitive") return null;
  const cpt = offers.competitivePriceThreshold;
  if (cpt != null && cpt > 0) {
    const value = floorToX9StrictlyBelow(cpt);
    if (value >= 0.09) return { value, reference: "cpt" };
  }
  const bb = offers.buyBoxPrice;
  if (bb != null && bb > 0) {
    const value = floorToX9(bb * CAP_BB_MULTIPLIER);
    if (value >= 0.09) return { value, reference: "buy_box_x1_5" };
  }
  return null;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

// .99-cent rounding (Amazon convention). Returns the smallest value of form
// N.99 that is >= the input price. This is the "round to nearest .99 but
// never below the computed value" rule simplified: when nearest-below would
// drop the price, ceil up instead.
//
// For Rule 2 specifically this protects the ROI floor — rounded price is
// always >= bisection-solved price, so resulting ROI is always >= target.
//
// Cents arithmetic to dodge floating-point edge cases (e.g., $35.99 stored
// as 35.989999…).
function ceilToNext99(price: number): number {
  const cents = Math.ceil(price * 100);
  const remainder = cents % 100;
  if (remainder === 99) return cents / 100;
  return (cents - remainder + 99) / 100;
}

export function resolveOfferPrice(
  input: PriceResolverInput,
  settings: Settings,
  includeInboundShipping: boolean,
): PriceResolverResult {
  const cogsMissing = input.cogs == null || input.cogs <= 0;

  // ─── Blocked outcome: offers fetch failed ────────────────────────────────
  // CRITICAL: never fall through to "zero offers" → Rule 2 when we don't
  // actually know whether competing offers exist. Same unknown≠definite-value
  // discipline as catalog-deleted's tri-state. UI surfaces this as
  // "couldn't check competition — retry" and blocks submission until retry succeeds.
  if (input.offers.kind === "fetch_failed") {
    return {
      rule: "offers_fetch_failed",
      resolvedPrice: null,
      competingOfferCount: 0,
      highestCompetingOffer: null,
      detail: `Couldn't check competition: ${input.offers.reason}. Not submittable until retry succeeds.`,
      resultingRoi: null,
      cogsMissing,
      ...NO_CAP_FIELDS,
    };
  }

  // From here, TypeScript has narrowed input.offers to { kind: "definitive" }
  const competing = input.offers.competing;
  const n = competing.length;
  const highest = n > 0 ? Math.max(...competing) : null;

  // ─── Rule 1: ≥1 competing offer → highest × 1.30, ceil to .99 ────────────
  if (n >= 1) {
    const raw = highest! * 1.30;
    const rulePrice = ceilToNext99(raw);
    const baseDetail = `${n} competing offer${n === 1 ? "" : "s"}; highest $${highest!.toFixed(2)} × 1.30 = $${raw.toFixed(2)} → $${rulePrice.toFixed(2)} (.99)${cogsMissing ? " — ROI unknown (no COGS)" : ""}`;
    return finalizePriced(
      "highest_plus_30", rulePrice, n, highest, baseDetail, cogsMissing,
      input, settings, includeInboundShipping,
    );
  }

  // ─── Rule 2: 0 competing offers → bisect for 100% ROI ────────────────────
  if (cogsMissing) {
    return {
      rule: "skip_no_cogs",
      resolvedPrice: null,
      competingOfferCount: 0,
      highestCompetingOffer: null,
      detail: "0 competing offers; cannot solve 100% ROI without COGS (cogs is null or 0)",
      resultingRoi: null,
      cogsMissing: true,
      ...NO_CAP_FIELDS,
    };
  }

  const TARGET_ROI = 100;
  // Narrowing: cogsMissing=false (checked above) guarantees input.cogs > 0,
  // but TS can't track that through the boolean intermediate.
  const cogs = input.cogs!;

  // Bisect over [lo, hi] where lo evaluates < TARGET, hi evaluates >= TARGET.
  // At price = cogs, profit is necessarily ≤ 0 → ROI ≤ 0 (well below 100).
  let lo = cogs;
  let hi = cogs * 10; // start; expand if needed

  // Expand hi if 100% ROI not reachable yet (fee structure with huge prep
  // or hazmat surcharges can push the price high). Cap expansion to avoid
  // runaway loops.
  let expansionAttempts = 0;
  while (roiAt(hi, input, settings, includeInboundShipping) < TARGET_ROI && expansionAttempts < 6) {
    hi *= 2;
    expansionAttempts++;
  }
  if (roiAt(hi, input, settings, includeInboundShipping) < TARGET_ROI) {
    return {
      rule: "skip_unreachable",
      resolvedPrice: null,
      competingOfferCount: 0,
      highestCompetingOffer: null,
      detail: `100% ROI not reachable: at price $${round2(hi).toFixed(2)} (cogs × ${Math.round(hi / cogs)}), ROI = ${roiAt(hi, input, settings, includeInboundShipping).toFixed(1)}%`,
      resultingRoi: null,
      cogsMissing: false, // we have cogs here (passed the earlier check)
      ...NO_CAP_FIELDS,
    };
  }

  // Bisection until convergence within 1 cent on the price axis.
  let iterations = 0;
  while (hi - lo > 0.01 && iterations < 60) {
    const mid = (lo + hi) / 2;
    if (roiAt(mid, input, settings, includeInboundShipping) < TARGET_ROI) {
      lo = mid;
    } else {
      hi = mid;
    }
    iterations++;
  }

  // Ceil to next .99 — always rounds UP to protect the ROI floor.
  // Re-evaluating ROI at the rounded price yields ROI slightly > 100%
  // (rounding up nudges margin up). Acceptable per spec: "erring high is safe".
  const rawSolved = hi;
  const rulePrice = ceilToNext99(rawSolved);
  const ruleRoi = roiAt(rulePrice, input, settings, includeInboundShipping);
  const baseDetail = `0 competing offers; bisected to $${rawSolved.toFixed(2)} for ~100% ROI; rounded UP to $${rulePrice.toFixed(2)} (.99). Actual ROI ${ruleRoi.toFixed(1)}% (cogs $${cogs.toFixed(2)})`;
  return finalizePriced(
    "roi_100", rulePrice, 0, null, baseDetail, false,
    input, settings, includeInboundShipping,
  );
}

// Default cap fields for null-price outcomes (skips / fetch-failed) — no price
// was produced, so nothing was capped and no risk flag applies.
const NO_CAP_FIELDS = {
  capApplied: false,
  capReference: null,
  uncappedPrice: null,
  noPriceReference: false,
  lowRoiAfterCap: false,
} as const;

// Applies the 18555 cap to a rule-produced price and assembles the final
// result. ROI is computed at the FINAL (possibly capped) price so preview ROI
// matches what will actually be submitted.
function finalizePriced(
  rule: PriceRule,
  rulePrice: number,
  competingOfferCount: number,
  highestCompetingOffer: number | null,
  baseDetail: string,
  cogsMissing: boolean,
  input: PriceResolverInput,
  settings: Settings,
  includeInboundShipping: boolean,
): PriceResolverResult {
  const cap = resolveCap(input.offers);
  const capApplied = cap != null && rulePrice > cap.value;
  const price = capApplied ? cap!.value : rulePrice;
  const resultingRoi = !cogsMissing ? roiAt(price, input, settings, includeInboundShipping) : null;
  const lowRoiAfterCap = capApplied && resultingRoi != null && resultingRoi < settings.minRoiThreshold;

  let detail = baseDetail;
  if (capApplied) {
    const refLabel = cap!.reference === "cpt" ? "strictly below CPT" : "buy box × 1.5";
    detail += ` — CAPPED $${rulePrice.toFixed(2)} → $${price.toFixed(2)} (${refLabel}, 18555 prevention)`;
    if (lowRoiAfterCap) detail += `; ROI ${resultingRoi!.toFixed(1)}% is below min ${settings.minRoiThreshold}%`;
  } else if (cap == null) {
    detail += " — no market reference (CPT/buy box absent): uncapped, 18555 risk";
  }

  return {
    rule,
    resolvedPrice: price,
    competingOfferCount,
    highestCompetingOffer,
    detail,
    resultingRoi,
    cogsMissing,
    capApplied,
    capReference: capApplied ? cap!.reference : null,
    uncappedPrice: capApplied ? rulePrice : null,
    noPriceReference: cap == null,
    lowRoiAfterCap,
  };
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
