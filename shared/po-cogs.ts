/**
 * Purchase Order COGS engine.
 *
 * Implements the spec's calculateAsinCosts: derives a line item's
 * adjusted_product_cost, per-ASIN-unit COGS, and per-ASIN-unit sourcing cost
 * by allocating order-level discounts/shipping/tax/gift-card discounts to the
 * line item in proportion to its share of order_subtotal, then dividing across
 * ASIN units.
 *
 * Pure: no DB or network deps. Lives in shared/ so it can be unit-tested and
 * (later) shared with client-side preview if needed. Server callers (POST/PUT
 * /api/pos endpoints) feed in PO row + line item row + gift cards array +
 * prep_cost_per_unit from the asins table.
 *
 * Definitions (per spec, mirrors the calc):
 *   adjusted_product_cost      = product-level cost after all discounts +
 *                                allocated tax + allocated shipping - GC discount
 *   cogs_per_asin_unit         = adjusted_product_cost / asin_qty_per_product + prep
 *   sourcing_cost_per_asin_unit= (adjusted_product_cost + weighted GC discount)
 *                                / asin_qty_per_product   (no prep, GC added back)
 *
 * Divide-by-zero guards: order_subtotal=0, asin_qty_per_product=0 throw
 * (they make no domain sense). order_total=0 with no gift cards is allowed
 * (GC discount short-circuits to 0); order_total=0 WITH gift cards throws.
 */

export type DiscountType = "percentage" | "dollar" | null | undefined;

export interface PoForCogs {
  order_subtotal: number;
  order_total: number;
  shipping_cost: number;
  tax: number;
  order_discount: number;
  order_discount_type: DiscountType;
}

export interface LineItemForCogs {
  product_price: number;
  product_discount: number;
  product_discount_type: DiscountType;
  asin_qty_per_product: number;
  tax_exempt: boolean;
}

export interface GiftCardForCogs {
  amount_used: number;
  /** Effective per-dollar discount the GC represents (e.g. 5 for a 5% GC) */
  discount_percentage: number;
}

export interface AsinCostsResult {
  adjusted_product_cost: number;
  cogs_per_asin_unit: number;
  sourcing_cost_per_asin_unit: number;
}

function discountAmount(price: number, value: number, type: DiscountType): number {
  if (!value) return 0;
  return type === "percentage" ? (price * value) / 100 : value;
}

export function calculateAsinCosts(
  po: PoForCogs,
  lineItem: LineItemForCogs,
  giftCards: GiftCardForCogs[],
  prepCostPerUnit: number,
): AsinCostsResult {
  if (!(po.order_subtotal > 0)) {
    throw new Error(`calculateAsinCosts: order_subtotal must be > 0 (got ${po.order_subtotal})`);
  }
  if (!(lineItem.asin_qty_per_product > 0)) {
    throw new Error(`calculateAsinCosts: asin_qty_per_product must be > 0 (got ${lineItem.asin_qty_per_product})`);
  }

  // 1. Weighted order-level discount allocated to this line item's product price.
  const orderDiscountAmount = discountAmount(po.order_subtotal, po.order_discount, po.order_discount_type);
  const weightedOrderDiscount = (orderDiscountAmount / po.order_subtotal) * lineItem.product_price;

  // 2. Product-level discount.
  const productDiscountAmount = discountAmount(lineItem.product_price, lineItem.product_discount, lineItem.product_discount_type);
  const discountedProductPrice = lineItem.product_price - productDiscountAmount - weightedOrderDiscount;

  // 3. Weighted gift-card discount %.
  //    Example: $100 order, $20 @ 5% GC + $30 @ 10% GC = (20*0.05+30*0.10)/100 = 5%.
  let weightedGcDiscount = 0;
  if (giftCards.length > 0) {
    let totalGcDiscountValue = 0;
    for (const gc of giftCards) totalGcDiscountValue += gc.amount_used * (gc.discount_percentage / 100);
    if (!(po.order_total > 0)) {
      throw new Error("calculateAsinCosts: order_total must be > 0 when gift cards are present");
    }
    const weightedGcDiscountPct = totalGcDiscountValue / po.order_total;
    weightedGcDiscount = discountedProductPrice * weightedGcDiscountPct;
  }

  // 4. Tax allocated proportionally to discounted product price (skipped if line item is tax-exempt).
  const taxPerProduct = lineItem.tax_exempt ? 0 : (po.tax / po.order_subtotal) * discountedProductPrice;

  // 5. Shipping allocated proportionally to original product price.
  const weightedShipping = (po.shipping_cost / po.order_subtotal) * lineItem.product_price;

  // 6. Final product-level cost.
  const adjusted_product_cost = discountedProductPrice + taxPerProduct + weightedShipping - weightedGcDiscount;

  // 7. Sourcing cost = adjusted cost with GC discount added back (Amazon submission).
  const productSourcingCost = adjusted_product_cost + weightedGcDiscount;

  // 8. Per-ASIN-unit values.
  const cogs_per_asin_unit = adjusted_product_cost / lineItem.asin_qty_per_product + prepCostPerUnit;
  const sourcing_cost_per_asin_unit = productSourcingCost / lineItem.asin_qty_per_product;

  return { adjusted_product_cost, cogs_per_asin_unit, sourcing_cost_per_asin_unit };
}
