import {
  type AsinResult,
  type PriceSource,
  type Settings,
  getSelectedPrice,
  calculateProfit,
  getEffectivePrep,
  getEffectiveStorage,
  calculateMaxCogs,
  appliesDgHazmatSurcharge,
} from "@shared/schema";

/**
 * Compute the estimated per-unit profit for an ASIN using the currently
 * selected price source. Returns null if the ASIN has an error or no
 * available price.
 */
export function getEstimatedProfit(
  result: AsinResult,
  priceSource: PriceSource,
  settings: Settings,
  includeInboundShipping = true,
): ReturnType<typeof calculateProfit> | null {
  if (result.error) return null;
  const { price } = getSelectedPrice(result, priceSource);
  if (price == null) return null;
  const cogs = result.estimatedCogs;
  if (cogs == null) return null;
  const prep = getEffectivePrep(result, settings);
  const storage = getEffectiveStorage(result, settings);
  return calculateProfit(
    price,
    cogs,
    result.feesData.fbaFulfillmentFee ?? 0,
    result.feesData.referralFee ?? 0,
    result.feesData.feesEstimatePrice,
    result.catalogData.weightLbs,
    prep.value,
    storage.value,
    settings,
    includeInboundShipping,
    appliesDgHazmatSurcharge(result),
    result.category ?? null,
  );
}

/**
 * Compute actual profit for an ASIN over the selected date range.
 *
 * Returns { totalProfit, profitPerUnit, margin, roi } or null if no
 * sales data exists.
 *
 * Since the Finances API patch the stored facts (`actuals.fin`) are the
 * value; the estimated-fee math below only serves a range the Finances
 * backfill has not covered yet.
 */
export function getActualProfit(
  result: AsinResult,
  settings: Settings,
  includeInboundShipping = true,
): {
  totalProfit: number;
  profitPerUnit: number;
  margin: number;
  roi: number;
  unitsSold: number;
  revenue: number;
} | null {
  if (!result.actuals || result.actuals.units_sold === 0) return null;
  // Finances API patch (commit 8, SPEC §6): the stored facts win — Net profit for the range from the same accessor as the
  // breakdown panel (fees Amazon charged, COGS by cost period, Prep by the Settings rule). The estimate below is the
  // fallback for a range the backfill has not covered.
  const fin = result.actuals.fin;
  if (fin && fin.units > 0) {
    return {
      totalProfit: fin.net_profit,
      profitPerUnit: fin.net_profit / fin.units,
      margin: fin.sales ? (fin.net_profit / fin.sales) * 100 : 0,
      roi: fin.cost_of_goods ? (fin.net_profit / Math.abs(fin.cost_of_goods)) * 100 : 0,
      unitsSold: fin.units,
      revenue: fin.sales,
    };
  }
  const cogs = result.actualCogs;
  if (cogs == null) return null;
  const au = result.actuals.units_sold;
  const ar = result.actuals.revenue;
  const prep = getEffectivePrep(result, settings);
  const storage = getEffectiveStorage(result, settings);
  const calc = calculateProfit(
    ar / au,
    cogs,
    result.feesData.fbaFulfillmentFee ?? 0,
    result.feesData.referralFee ?? 0,
    result.feesData.feesEstimatePrice,
    result.catalogData.weightLbs,
    prep.value,
    storage.value,
    settings,
    includeInboundShipping,
    appliesDgHazmatSurcharge(result),
    result.category ?? null,
  );
  return {
    totalProfit: calc.profit * au,
    profitPerUnit: calc.profit,
    margin: calc.margin,
    roi: calc.roi,
    unitsSold: au,
    revenue: ar,
  };
}

/**
 * Get the Max COGS value for an ASIN. Convenience wrapper around
 * calculateMaxCogs using the standard input resolution pattern.
 */
export function getMaxCogs(
  result: AsinResult,
  priceSource: PriceSource,
  settings: Settings,
  includeInboundShipping = true,
): number | null {
  const { price } = getSelectedPrice(result, priceSource);
  const prep = getEffectivePrep(result, settings);
  const storage = getEffectiveStorage(result, settings);
  return calculateMaxCogs(
    price,
    result.feesData.fbaFulfillmentFee,
    result.feesData.referralFee,
    result.feesData.feesEstimatePrice,
    result.catalogData.weightLbs,
    prep.value,
    storage.value,
    settings,
    includeInboundShipping,
    appliesDgHazmatSurcharge(result),
    result.category ?? null,
  );
}
