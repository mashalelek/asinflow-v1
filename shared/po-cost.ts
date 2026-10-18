// Cost / unit prefill for a new PO's ASIN rows — the ONE place the formula
// lives (New PO form, shared/po-form.ts; patch po-af-owned §4, 2026-10-18).
//
// The importer never computed cost: it copied the Orders sheet's Col Y,
// which the VA keyed per row. This formula is the starting point toward
// reproducing it; Maria refines it over time. Every refinement is measured
// against the imported 2026 cost / unit in shared/__fixtures__/po-cost-2026.json
// by shared/po-cost.test.ts (a match = within one cent). Baseline, formula
// v1: 1,166 of 1,582 non-bundle 2026 ASIN rows (73.7%).
//
// v1: adjusted product cost = price × (order total ÷ subtotal) × (1 − weighted
// gift-card %); cost / unit = Σ(adjusted cost × qty ordered) ÷ the ASIN
// row's Ordered, rounded to the cent once at the end (the per-product value
// shown / stored as adjusted_product_cost is rounded on its own).

export const COST_FORMULA_VERSION = 1;

export interface CostHeader {
  subtotal: number;          // the typed subtotal, else Σ price × qty
  orderTotal: number;        // the typed order total, else subtotal + tax + S&H − discount
  gcPct: number | null;      // weighted gift-card discount, percent (2.15 = 2.15 %)
  tax?: number;
  shDonations?: number;
  discount?: number;
  cashbackPct?: number | null;
}
export interface CostLine { price: number | null; qty: number }

const r2 = (x: number) => Math.round(x * 100) / 100;

/** Unrounded adjusted cost of one product; null when the price is unknown. */
function adjustedExact(price: number | null, h: CostHeader): number | null {
  if (price == null || !Number.isFinite(price)) return null;
  const ratio = h.subtotal > 0 ? h.orderTotal / h.subtotal : 1;
  const gc = h.gcPct != null && Number.isFinite(h.gcPct) ? h.gcPct / 100 : 0;
  return price * ratio * (1 - gc);
}

/** One product's adjusted cost (the sheet's Col X role), rounded to the cent for storage / display. */
export function adjustedProductCost(price: number | null, h: CostHeader): number | null {
  const a = adjustedExact(price, h);
  return a == null ? null : r2(a);
}

/** Cost / unit for an ASIN row (the sheet's Col Y role), rounded once at the end. Null when any product lacks a price or Ordered is 0. */
export function costPerUnitPrefill(h: CostHeader, lines: readonly CostLine[], asinQty: number): number | null {
  if (!(asinQty > 0)) return null;
  let total = 0;
  for (const l of lines) {
    const adj = adjustedExact(l.price, h);
    if (adj == null) return null;
    total += adj * l.qty;
  }
  return r2(total / asinQty);
}
