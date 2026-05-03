// Client-side aggregation is fine for current scale (~1–2k ASINs).
// Push to SQL if dataset grows past ~10k ASINs.

import type { AsinResult, PriceSource, Settings } from "@shared/schema";
import { getEstimatedProfit, getActualProfit, getMaxCogs } from "./profit";
import { getSelectedPrice } from "@shared/schema";

export interface AnalyticsMetrics {
  // Estimates (point-in-time, 1 unit per ASIN)
  estRoi: number | null;
  estMargin: number | null;
  estProfitPerUnit: number | null;

  // Actuals (date-range scoped, weighted by units)
  actRoi: number | null;
  actMargin: number | null;
  actProfitPerUnit: number | null;

  // Simple averages
  avgCogs: number | null;
  avgMaxCogs: number | null;
  avgSalePrice: number | null;

  // Totals
  asinCount: number;
  totalUnitsSold: number;
  totalRevenue: number;
  totalProfit: number | null;
}

/**
 * Compute portfolio-level analytics metrics for a set of ASIN rows.
 * Works on any subset — full dataset, filtered set, or a single group
 * for Phase 3 category/brand/supplier grouping.
 */
export function computeAnalyticsMetrics(
  rows: AsinResult[],
  priceSource: PriceSource,
  settings: Settings,
  includeInboundShipping: boolean,
): AnalyticsMetrics {
  // ── Estimates ─────────────────────────────────────────────────────
  let estProfitSum = 0;
  let estCogsSum = 0;
  let estSalePriceSum = 0;
  let estCount = 0;

  // ── Simple averages ───────────────────────────────────────────────
  let cogsSum = 0;
  let cogsCount = 0;
  let maxCogsSum = 0;
  let maxCogsCount = 0;
  let salePriceSum = 0;
  let salePriceCount = 0;

  // ── Actuals ───────────────────────────────────────────────────────
  let actTotalProfit = 0;
  let actTotalCogsCost = 0; // SUM(cogs * units_sold)
  let actTotalRevenue = 0;
  let actTotalUnits = 0;
  let actTotalRefundAmount = 0;
  let actTotalUnitsRefunded = 0;

  for (const r of rows) {
    // Estimates
    const est = getEstimatedProfit(r, priceSource, settings, includeInboundShipping);
    if (est) {
      estProfitSum += est.profit;
      estCogsSum += r.estimatedCogs!;
      const { price } = getSelectedPrice(r, priceSource);
      if (price != null) estSalePriceSum += price;
      estCount++;
    }

    // Simple averages (include all rows with valid values, not just "calculated")
    const avgCogsVal = r.actualCogs ?? r.estimatedCogs;
    if (avgCogsVal != null && avgCogsVal > 0) {
      cogsSum += avgCogsVal;
      cogsCount++;
    }
    const mc = getMaxCogs(r, priceSource, settings, includeInboundShipping);
    if (mc != null) {
      maxCogsSum += mc;
      maxCogsCount++;
    }
    const { price } = getSelectedPrice(r, priceSource);
    if (price != null) {
      salePriceSum += price;
      salePriceCount++;
    }

    // Actuals
    const act = getActualProfit(r, settings, includeInboundShipping);
    if (act) {
      actTotalProfit += act.totalProfit;
      actTotalCogsCost += (r.actualCogs ?? 0) * act.unitsSold;
      actTotalRevenue += act.revenue;
      actTotalUnits += act.unitsSold;
    }
    if (r.actuals) {
      actTotalRefundAmount += r.actuals.refund_amount;
      actTotalUnitsRefunded += r.actuals.units_refunded;
    }
  }

  return {
    // Estimates: portfolio-weighted
    estRoi: estCogsSum > 0 ? (estProfitSum / estCogsSum) * 100 : null,
    estMargin: estSalePriceSum > 0 ? (estProfitSum / estSalePriceSum) * 100 : null,
    estProfitPerUnit: estCount > 0 ? estProfitSum / estCount : null,

    // Actuals: weighted by units sold
    actRoi: actTotalCogsCost > 0 ? (actTotalProfit / actTotalCogsCost) * 100 : null,
    actMargin: actTotalRevenue > 0 ? (actTotalProfit / actTotalRevenue) * 100 : null,
    actProfitPerUnit: actTotalUnits > 0 ? actTotalProfit / actTotalUnits : null,

    // Simple averages
    avgCogs: cogsCount > 0 ? cogsSum / cogsCount : null,
    avgMaxCogs: maxCogsCount > 0 ? maxCogsSum / maxCogsCount : null,
    avgSalePrice: salePriceCount > 0 ? salePriceSum / salePriceCount : null,

    // Totals
    asinCount: rows.length,
    totalUnitsSold: actTotalUnits - actTotalUnitsRefunded,
    totalRevenue: actTotalRevenue - actTotalRefundAmount,
    totalProfit: actTotalUnits > 0 ? actTotalProfit : null,
  };
}
