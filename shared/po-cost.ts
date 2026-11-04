// Cost allocation for a PO's ASIN rows — the ONE place the formula lives
// (New PO form via shared/po-form.ts, the PO editor's recompute via
// server/po-costs.ts). Patch docs/claude_spec-patch-po-ai-prefill.md §7.1 as
// corrected by Maria 2026-11-04 (formula v3; "my 10/31 instruction was
// wrong"). Applies to NEW and EDITED POs only: historical rows keep the
// sheet's values verbatim and are never recomputed
// (purchase_orders.cost_formula_version IS NULL).
//
// COGS INCLUDES the supplier's tax and shipping / handling, MINUS coupons,
// sales and the gift-card discount %. Rewards are Maria's call per PO (the
// promo's COGS toggle, default off — a non-counting promo is ADDED BACK).
// Cashback never counts. Everything is allocated pro rata over the LINE
// TOTALS (a line's total as captured; price × qty when none was stored), so
// a line whose total ÷ qty is not whole cents (79.70 ÷ 30) costs exactly.
//
//   L                = Σ line totals of the PO (the allocation base)
//   countingDiscount = discount − Σ amount(promos that do not count)
//   base_counting    = L − countingDiscount + tax + shipping
//   base_paid        = L − discount + tax + shipping                (every discount)
//   Sourcing cost (col AR) = Σ(line total_i) × base_counting ÷ L ÷ ASIN qty  → Update COGS in SC
//   COGS (col Y)           = Sourcing × (1 − gift-card %) + adjustment       → actual_cogs, Aura, repricing
//   Paid cost              = Σ(line total_i) × base_paid ÷ L ÷ ASIN qty × (1 − gift-card %)
//   Adjusted product cost (col X) = unit price × base_counting ÷ L × (1 − gift-card %)  (stored per line)
// Rounded to the cent once at the end of each figure. When the line totals
// already carry the discount (discountReflectedInLines), the discount and
// promos count for nothing — not subtracted again, nothing added back.
//
// v1 (2026-10-18) was price × (order total ÷ subtotal) × (1 − GC %); v2
// (2026-10-31) left tax and shipping out — wrong, per Maria 2026-11-04.
// Neither is a reproduction of the sheet (the probe doc records why no single
// rule can be: the sheet's X formula varies per order).

export const COST_FORMULA_VERSION = 3;

export interface CostHeader {
  /** Σ line totals the costs are allocated over (the typed subtotal when the lines are pre-discount and it is known). */
  subtotal: number;
  discount: number;          // the order-level discount as shown at checkout (0 when none)
  gcPct: number | null;      // weighted gift-card discount, percent (2.15 = 2.15 %)
  /** Σ amount of the promos that do NOT count toward COGS (rewards) — added back. */
  nonCountingPromoAmount?: number;
  /** The supplier's tax — in COGS since v3. */
  tax?: number;
  /** The supplier's shipping / handling (purchase_orders.sh_donations) — in COGS since v3. */
  shDonations?: number;
  /** Kept for callers that still pass them; never used. */
  orderTotal?: number;
  cashbackPct?: number | null;
}
/** One product line: its unit price (full precision) and qty; lineTotal = the line's money as captured (else price × qty). */
export interface CostLine { price: number | null; qty: number; lineTotal?: number | null }
export interface AsinCosts {
  /** Col AR: before the gift-card discount, counting promos applied. */
  sourcing: number;
  /** Col Y: sourcing × (1 − GC %) + adjustment. */
  cogs: number;
  /** Every discount counted, × (1 − GC %). */
  paid: number;
  /** cogs without the adjustment. */
  cogsBeforeAdjustment: number;
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const fin = (x: number | undefined | null) => (x != null && Number.isFinite(x) ? x : 0);
const gcFactor = (h: CostHeader) => 1 - (h.gcPct != null && Number.isFinite(h.gcPct) ? h.gcPct / 100 : 0);
/** base ÷ L: what one dollar of line money costs once discounts, tax and shipping are allocated. */
const ratio = (h: CostHeader, discount: number) => (h.subtotal > 0 ? (h.subtotal - discount + fin(h.tax) + fin(h.shDonations)) / h.subtotal : 1);
// Never below 0: a non-counting promo larger than the header discount cannot raise the cost above the price paid.
const countingDiscount = (h: CostHeader) => Math.max(0, (h.discount || 0) - (h.nonCountingPromoAmount || 0));

/** A line's money: its stored / captured total, else price × qty; null when neither is known. */
export function lineMoney(l: CostLine): number | null {
  if (l.lineTotal != null && Number.isFinite(l.lineTotal)) return l.lineTotal;
  if (l.price == null || !Number.isFinite(l.price)) return null;
  return l.price * l.qty;
}

/** Tolerance of the reflected check: 1¢ (Maria 2026-11-04 — line totals vs the pre- / post-discount subtotal). */
export const REFLECTED_TOLERANCE = 0.01;

/**
 * Maria 2026-11-01 (the first real PO, Walmart): the line price $7.97 was already the sale price and the
 * "sale $36.12" promo was subtracted again → COGS 29.76 instead of 47.82. A discount / promo reduces a cost
 * ONLY when the line totals are pre-discount. When Σ line totals equals the post-discount subtotal (order
 * total − tax − shipping) within 1¢, the discount and the promos are informational: nothing reduces COGS or
 * Paid, the COGS toggle defaults off, nothing is "added back". Pure.
 */
export function discountReflectedInLines(a: { linesSum: number; discount: number; promoAmounts?: number; postDiscountSubtotal: number | null }): boolean {
  const d = (a.discount || 0) + (a.promoAmounts || 0);
  if (!(d > 0) || !(a.linesSum > 0) || a.postDiscountSubtotal == null || !Number.isFinite(a.postDiscountSubtotal)) return false;
  // The typed subtotal is not consulted: a retailer that shows the subtotal after a sale (Walmart) has lines = subtotal = post-discount.
  return Math.abs(a.linesSum - a.postDiscountSubtotal) <= REFLECTED_TOLERANCE + 1e-9;
}
/** The cost header with the reflected rule applied: a reflected discount / promo set counts for nothing. */
export function effectiveCostHeader(h: CostHeader, reflected: boolean): CostHeader {
  return reflected ? { ...h, discount: 0, nonCountingPromoAmount: 0 } : h;
}

/** One product's adjusted cost (the sheet's Col X role): unit price × base_counting ÷ L × (1 − GC %), rounded to the cent. */
export function adjustedProductCost(price: number | null, h: CostHeader): number | null {
  if (price == null || !Number.isFinite(price)) return null;
  return r2(price * ratio(h, countingDiscount(h)) * gcFactor(h));
}

/** The three costs of an ASIN row. Null when any product lacks money or the ASIN qty is 0. */
export function allocateAsinCosts(h: CostHeader, lines: readonly CostLine[], asinQty: number, adjustment = 0): AsinCosts | null {
  if (!(asinQty > 0)) return null;
  let money = 0;
  for (const l of lines) { const m = lineMoney(l); if (m == null) return null; money += m; }
  const counting = money * ratio(h, countingDiscount(h)), all = money * ratio(h, h.discount || 0);
  const sourcing = r2(counting / asinQty);
  const cogsBeforeAdjustment = r2((counting / asinQty) * gcFactor(h));
  const adj = Number.isFinite(adjustment) ? adjustment : 0;
  return { sourcing, cogsBeforeAdjustment, cogs: r2(cogsBeforeAdjustment + adj), paid: r2((all / asinQty) * gcFactor(h)) };
}

/** COGS per ASIN unit before any adjustment (the sheet's Col Y role). Kept for the fixture measurement and older callers. */
export function costPerUnitPrefill(h: CostHeader, lines: readonly CostLine[], asinQty: number): number | null {
  return allocateAsinCosts(h, lines, asinQty)?.cogsBeforeAdjustment ?? null;
}
