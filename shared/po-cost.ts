// Cost allocation for a PO's ASIN rows — the ONE place the formula lives
// (New PO form via shared/po-form.ts, the PO editor's recompute via
// server/po-costs.ts). Patch docs/claude_spec-patch-po-ai-prefill.md §7 as
// corrected by Maria 2026-10-31 (formula v2). Applies to NEW POs only:
// historical rows keep the sheet's values verbatim and are never recomputed
// (purchase_orders.cost_formula_version IS NULL).
//
// Per product line, the paid price AQ = the unit price actually paid (an
// item-level sale or coupon is already in it). The order-level discount
// (header Discount) is allocated pro rata over the subtotal; a promo whose
// counts_toward_cogs is false (rewards, by default) is ADDED BACK — its
// amount is taken out of the discount before allocating. Tax and shipping
// are never allocated into cost. Cashback never counts.
//
//   countingDiscount = discount − Σ amount(promos that do not count)
//   AQ_i      = price_i × (subtotal − countingDiscount) ÷ subtotal
//   AQ_paid_i = price_i × (subtotal − discount) ÷ subtotal        (every discount)
//   Sourcing cost (col AR) = Σ(AQ_i × qty_i) ÷ ASIN qty            → Update COGS in SC
//   COGS (col Y)           = Sourcing × (1 − gift-card %) + adjustment → actual_cogs, Aura, repricing
//   Paid cost              = Σ(AQ_paid_i × qty_i) ÷ ASIN qty × (1 − gift-card %)
//   Adjusted product cost (col X) = AQ_i × (1 − gift-card %)       (stored per line)
// Rounded to the cent once at the end of each figure.
//
// v1 (2026-10-18) was price × (order total ÷ subtotal) × (1 − GC %) — it
// folded tax and shipping in and matched 73.7 % of the imported 2026 rows;
// v2 is the agreed rule, not a reproduction of the sheet (the probe doc
// records why no single rule can be: the sheet's X formula varies per order).

export const COST_FORMULA_VERSION = 2;

export interface CostHeader {
  subtotal: number;          // the typed subtotal, else Σ price × qty
  discount: number;          // the order-level discount as shown at checkout (0 when none)
  gcPct: number | null;      // weighted gift-card discount, percent (2.15 = 2.15 %)
  /** Σ amount of the promos that do NOT count toward COGS (rewards) — added back. */
  nonCountingPromoAmount?: number;
  /** Kept for callers that still pass them; never used by v2. */
  orderTotal?: number;
  tax?: number;
  shDonations?: number;
  cashbackPct?: number | null;
}
export interface CostLine { price: number | null; qty: number }
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
const gcFactor = (h: CostHeader) => 1 - (h.gcPct != null && Number.isFinite(h.gcPct) ? h.gcPct / 100 : 0);
const ratio = (h: CostHeader, discount: number) => (h.subtotal > 0 ? (h.subtotal - discount) / h.subtotal : 1);
const countingDiscount = (h: CostHeader) => (h.discount || 0) - (h.nonCountingPromoAmount || 0);

/** Unrounded paid price of one product after the counting discounts (AQ); null when the price is unknown. */
function paidExact(price: number | null, h: CostHeader, allDiscounts: boolean): number | null {
  if (price == null || !Number.isFinite(price)) return null;
  return price * ratio(h, allDiscounts ? h.discount || 0 : countingDiscount(h));
}

/** One product's adjusted cost (the sheet's Col X role): AQ × (1 − GC %), rounded to the cent for storage / display. */
export function adjustedProductCost(price: number | null, h: CostHeader): number | null {
  const a = paidExact(price, h, false);
  return a == null ? null : r2(a * gcFactor(h));
}

/** The three costs of an ASIN row. Null when any product lacks a price or the ASIN qty is 0. */
export function allocateAsinCosts(h: CostHeader, lines: readonly CostLine[], asinQty: number, adjustment = 0): AsinCosts | null {
  if (!(asinQty > 0)) return null;
  let counting = 0, all = 0;
  for (const l of lines) {
    const a = paidExact(l.price, h, false), b = paidExact(l.price, h, true);
    if (a == null || b == null) return null;
    counting += a * l.qty; all += b * l.qty;
  }
  const sourcing = r2(counting / asinQty);
  const cogsBeforeAdjustment = r2((counting / asinQty) * gcFactor(h));
  const adj = Number.isFinite(adjustment) ? adjustment : 0;
  return { sourcing, cogsBeforeAdjustment, cogs: r2(cogsBeforeAdjustment + adj), paid: r2((all / asinQty) * gcFactor(h)) };
}

/** COGS per ASIN unit before any adjustment (the sheet's Col Y role). Kept for the fixture measurement and older callers. */
export function costPerUnitPrefill(h: CostHeader, lines: readonly CostLine[], asinQty: number): number | null {
  return allocateAsinCosts(h, lines, asinQty)?.cogsBeforeAdjustment ?? null;
}
