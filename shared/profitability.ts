/**
 * Row-level profitability gates. Single source of truth for "is this ASIN
 * Profitable / a Replens candidate", used by the scorecard tile counts, the
 * tile-click row filters, and the row tint in the results table.
 *
 * Symmetric exclusion: any ASIN that can't be evaluated (error, no usable
 * price, no estimatedCogs) returns `false` from BOTH helpers. This guarantees
 * the tile count matches the row count after a tile click — fixes the
 * pre-B2 asymmetry where the Unprofitable click filter swept in all
 * uncalculated rows that the tile face never counted.
 *
 * NEVER hardcode `true` for includeInboundShipping at a caller — pass the
 * page's current toggle value so the count and the click-filter row count
 * stay in sync when the user toggles it off.
 */
import {
  type AsinResult,
  type PriceSource,
  type Settings,
  calculateProfit,
  getEffectivePrep,
  getEffectiveStorage,
  getSelectedPrice,
} from "./schema";

/**
 * Compute the profit object for a row using the current price source / settings.
 * Returns `null` when the row can't be evaluated — same gates the tile face uses.
 * Internal helper; the public helpers below wrap it.
 */
function evaluate(
  result: AsinResult,
  priceSource: PriceSource,
  settings: Settings,
  includeInboundShipping: boolean,
): ReturnType<typeof calculateProfit> | null {
  if (result.error) return null;
  const { price } = getSelectedPrice(result, priceSource);
  if (price == null || result.estimatedCogs == null) return null;

  const prep = getEffectivePrep(result, settings);
  const storage = getEffectiveStorage(result, settings);

  return calculateProfit(
    price,
    result.estimatedCogs,
    result.feesData.fbaFulfillmentFee ?? 0,
    result.feesData.referralFee ?? 0,
    result.feesData.feesEstimatePrice,
    result.catalogData.weightLbs,
    prep.value,
    storage.value,
    settings,
    includeInboundShipping,
    result.isHazmat ?? false,
    result.category ?? null,
  );
}

/**
 * Row-level Profitable gate. Uses three user-tunable thresholds from Settings:
 *   ROI ≥ minRoiThreshold       AND
 *   Margin ≥ minMarginThreshold AND
 *   Profit/Unit ≥ minProfitUnitThreshold
 *
 * Returns false for rows that can't be evaluated.
 */
export function isProfitable(
  result: AsinResult,
  priceSource: PriceSource,
  settings: Settings,
  includeInboundShipping: boolean,
): boolean {
  const calc = evaluate(result, priceSource, settings, includeInboundShipping);
  if (!calc) return false;
  return (
    calc.roi >= settings.minRoiThreshold &&
    calc.margin >= settings.minMarginThreshold &&
    calc.profit >= settings.minProfitUnitThreshold
  );
}

/**
 * Row-level Replenishment candidate gate. Opinionated business rule (the
 * tiered ROI/margin numbers are NOT user-tunable — they encode the
 * "what's worth restocking?" judgement and stay hardcoded by design).
 *
 *   Tiered profitability:
 *     (ROI > 25% AND Margin > 10%) OR
 *     (ROI > 20% AND Margin > 12%) OR
 *     (ROI > 15% AND Margin > 14%)
 *   AND  Profit/Unit ≥ settings.minProfitUnitThreshold   (user-tunable)
 *   AND  actuals.units_sold > 0
 *
 * The units_sold gate assumes the caller has already fetched results with the
 * desired date range (the API returns actuals scoped to ?startDate/?endDate).
 * Callers MUST NOT pass stale or cross-range results here.
 *
 * Returns false for rows that can't be evaluated.
 */
export function isReplens(
  result: AsinResult,
  priceSource: PriceSource,
  settings: Settings,
  includeInboundShipping: boolean,
): boolean {
  const calc = evaluate(result, priceSource, settings, includeInboundShipping);
  if (!calc) return false;
  const tieredOK =
    (calc.roi > 25 && calc.margin > 10) ||
    (calc.roi > 20 && calc.margin > 12) ||
    (calc.roi > 15 && calc.margin > 14);
  if (!tieredOK) return false;
  if (calc.profit < settings.minProfitUnitThreshold) return false;
  if ((result.actuals?.units_sold ?? 0) <= 0) return false;
  return true;
}
