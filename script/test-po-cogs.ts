/**
 * Unit tests for shared/po-cogs.ts (Phase 1 deliverable).
 *
 * The project has no test framework; this is the same executable-assertion
 * style used by other one-off verifications. Run: npx tsx script/test-po-cogs.ts
 * Exits non-zero on any failure.
 */
import { calculateAsinCosts, type PoForCogs, type LineItemForCogs, type GiftCardForCogs } from "../shared/po-cogs";

let passed = 0, failed = 0;
const EPS = 0.001;

function approx(label: string, actual: number, expected: number, eps = EPS) {
  const ok = Math.abs(actual - expected) <= eps;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}: got ${actual.toFixed(6)}  expected ${expected.toFixed(6)}`);
  ok ? passed++ : failed++;
}

function expectThrow(label: string, fn: () => unknown) {
  try {
    fn();
    console.log(`  FAIL  ${label}: expected throw, but returned`);
    failed++;
  } catch (e: any) {
    console.log(`  PASS  ${label}: threw "${e.message}"`);
    passed++;
  }
}

function po(over: Partial<PoForCogs> = {}): PoForCogs {
  return {
    order_subtotal: 100, order_total: 100, shipping_cost: 0, tax: 0,
    order_discount: 0, order_discount_type: null, ...over,
  };
}
function li(over: Partial<LineItemForCogs> = {}): LineItemForCogs {
  return {
    product_price: 100, product_discount: 0, product_discount_type: null,
    asin_qty_per_product: 1, tax_exempt: false, ...over,
  };
}

// ─── 1. minimal (no modifiers) ────────────────────────────────────────────────
console.log("\nTest 1: minimal $100 / 1 ASIN / prep $1");
{
  const r = calculateAsinCosts(po(), li(), [], 1);
  approx("adjusted", r.adjusted_product_cost, 100);
  approx("cogs", r.cogs_per_asin_unit, 101);
  approx("sourcing", r.sourcing_cost_per_asin_unit, 100);
}

// ─── 2. order discount dollar ─────────────────────────────────────────────────
console.log("\nTest 2: $10 order discount (dollar) on $100 PO");
{
  const r = calculateAsinCosts(
    po({ order_discount: 10, order_discount_type: "dollar" }),
    li(), [], 1,
  );
  approx("adjusted", r.adjusted_product_cost, 90);
  approx("cogs", r.cogs_per_asin_unit, 91);
}

// ─── 3. order discount percentage, split across 2 line items ──────────────────
console.log("\nTest 3: 10% order discount on $200 PO, 2 LIs ($120 + $80)");
{
  const o = po({ order_subtotal: 200, order_total: 200, order_discount: 10, order_discount_type: "percentage" });
  const a = calculateAsinCosts(o, li({ product_price: 120 }), [], 1);
  const b = calculateAsinCosts(o, li({ product_price: 80 }), [], 1);
  approx("L1 adjusted", a.adjusted_product_cost, 108);
  approx("L2 adjusted", b.adjusted_product_cost, 72);
  // Sum of weighted discounts must equal full order discount ($20)
  approx("discounts sum", (120 - a.adjusted_product_cost) + (80 - b.adjusted_product_cost), 20);
}

// ─── 4 & 5. product discount equivalence dollar vs percentage ────────────────
console.log("\nTest 4: $15 product discount (dollar) on $100 LI");
{
  const r = calculateAsinCosts(po(), li({ product_discount: 15, product_discount_type: "dollar" }), [], 1);
  approx("adjusted", r.adjusted_product_cost, 85);
}
console.log("\nTest 5: 15% product discount on $100 LI (should equal Test 4)");
{
  const r = calculateAsinCosts(po(), li({ product_discount: 15, product_discount_type: "percentage" }), [], 1);
  approx("adjusted", r.adjusted_product_cost, 85);
}

// ─── 6. single gift card ──────────────────────────────────────────────────────
console.log("\nTest 6: $50 GC @ 10% on $100 PO/$100 LI");
{
  const r = calculateAsinCosts(po(), li(), [{ amount_used: 50, discount_percentage: 10 }], 1);
  // gcVal=5, weightedPct=0.05, weightedGcDisc=$5
  approx("adjusted", r.adjusted_product_cost, 95);  // 100-5
  approx("cogs", r.cogs_per_asin_unit, 96);
  approx("sourcing (GC added back)", r.sourcing_cost_per_asin_unit, 100);
}

// ─── 7. multiple gift cards (spec example) ────────────────────────────────────
console.log("\nTest 7: $20@5% + $30@10% GC on $100 PO/$100 LI");
{
  const r = calculateAsinCosts(po(), li(), [
    { amount_used: 20, discount_percentage: 5 },
    { amount_used: 30, discount_percentage: 10 },
  ], 1);
  // 20*0.05+30*0.10 = 1+3 = 4 → 4/100 = 4% → weightedGcDisc = $4
  approx("adjusted", r.adjusted_product_cost, 96);
  approx("sourcing", r.sourcing_cost_per_asin_unit, 100);
}

// ─── 8. tax proportional allocation ───────────────────────────────────────────
console.log("\nTest 8: $20 tax on $200 PO split across 2 LIs ($120/$80)");
{
  const o = po({ order_subtotal: 200, order_total: 200, tax: 20 });
  const a = calculateAsinCosts(o, li({ product_price: 120 }), [], 1);
  const b = calculateAsinCosts(o, li({ product_price: 80 }), [], 1);
  // weighted tax: $12 / $8 (proportional to discountedPrice which == price here)
  approx("L1 adjusted (incl $12 tax)", a.adjusted_product_cost, 132);
  approx("L2 adjusted (incl $8 tax)", b.adjusted_product_cost, 88);
}

// ─── 9. tax_exempt ────────────────────────────────────────────────────────────
console.log("\nTest 9: $10 tax, LI is tax_exempt");
{
  const r = calculateAsinCosts(po({ tax: 10 }), li({ tax_exempt: true }), [], 1);
  approx("adjusted (no tax allocated)", r.adjusted_product_cost, 100);
}

// ─── 10. shipping allocation ─────────────────────────────────────────────────
console.log("\nTest 10: $20 shipping on $200 PO across 2 LIs ($120/$80)");
{
  const o = po({ order_subtotal: 200, order_total: 200, shipping_cost: 20 });
  const a = calculateAsinCosts(o, li({ product_price: 120 }), [], 1);
  const b = calculateAsinCosts(o, li({ product_price: 80 }), [], 1);
  approx("L1 adjusted (+$12 ship)", a.adjusted_product_cost, 132);
  approx("L2 adjusted (+$8 ship)", b.adjusted_product_cost, 88);
}

// ─── 11. asin_qty_per_product > 1 ─────────────────────────────────────────────
console.log("\nTest 11: $100 LI with 4 ASIN units per product, prep $1");
{
  const r = calculateAsinCosts(po(), li({ asin_qty_per_product: 4 }), [], 1);
  approx("cogs per ASIN unit (25 + 1 prep)", r.cogs_per_asin_unit, 26);
  approx("sourcing per ASIN unit (25, no prep)", r.sourcing_cost_per_asin_unit, 25);
}

// ─── 12. full kitchen sink ────────────────────────────────────────────────────
console.log("\nTest 12: kitchen sink — 10% ord disc, $10 ship, $15 tax, 5% prod disc on L1, tax_exempt on L2, $50 GC@5%");
{
  const o = po({
    order_subtotal: 200, order_total: 205,
    shipping_cost: 10, tax: 15,
    order_discount: 10, order_discount_type: "percentage",
  });
  const gcs: GiftCardForCogs[] = [{ amount_used: 50, discount_percentage: 5 }];
  const L1 = calculateAsinCosts(o,
    li({ product_price: 120, product_discount: 5, product_discount_type: "percentage", asin_qty_per_product: 1 }),
    gcs, 1);
  const L2 = calculateAsinCosts(o,
    li({ product_price: 80, asin_qty_per_product: 2, tax_exempt: true }),
    gcs, 1);

  // L1 hand-calc:
  // orderDiscWeighted = (200*0.10/200)*120 = $12
  // prodDisc = 120*0.05 = $6
  // discountedPrice = 120-6-12 = $102
  // gcVal = 50*0.05 = $2.5; weightedPct = 2.5/205 ≈ 0.0121951
  // weightedGcDisc = 102 * 0.0121951 = 1.243902
  // tax = (15/200)*102 = $7.65
  // shipping = (10/200)*120 = $6
  // adjusted = 102 + 7.65 + 6 - 1.243902 = 114.406098
  // cogs = 114.406098/1 + 1 = 115.406098
  // sourcing = (114.406098 + 1.243902)/1 = 115.65
  approx("L1 adjusted", L1.adjusted_product_cost, 114.406098, 0.01);
  approx("L1 cogs", L1.cogs_per_asin_unit, 115.406098, 0.01);
  approx("L1 sourcing", L1.sourcing_cost_per_asin_unit, 115.65, 0.01);

  // L2 hand-calc:
  // orderDiscWeighted = (20/200)*80 = $8
  // discountedPrice = 80-0-8 = $72
  // weightedGcDisc = 72 * 0.0121951 = 0.878049
  // tax = 0 (exempt)
  // shipping = (10/200)*80 = $4
  // adjusted = 72 + 0 + 4 - 0.878049 = 75.121951
  // cogs = 75.121951/2 + 1 = 38.560976
  // sourcing = (75.121951 + 0.878049)/2 = 76/2 = 38
  approx("L2 adjusted", L2.adjusted_product_cost, 75.121951, 0.01);
  approx("L2 cogs (÷2 + prep)", L2.cogs_per_asin_unit, 38.560976, 0.01);
  approx("L2 sourcing (÷2, no prep, GC added back)", L2.sourcing_cost_per_asin_unit, 38, 0.01);
}

// ─── 13-15. guards ────────────────────────────────────────────────────────────
console.log("\nTest 13: order_subtotal=0 throws");
expectThrow("subtotal=0", () => calculateAsinCosts(po({ order_subtotal: 0 }), li(), [], 1));

console.log("\nTest 14: asin_qty_per_product=0 throws");
expectThrow("asin_qty=0", () => calculateAsinCosts(po(), li({ asin_qty_per_product: 0 }), [], 1));

console.log("\nTest 15: order_total=0 with GC throws; without GC OK");
expectThrow("ord_total=0 + GC", () =>
  calculateAsinCosts(po({ order_total: 0 }), li(), [{ amount_used: 10, discount_percentage: 5 }], 1));
{
  // No GC: should compute fine even with order_total=0.
  const r = calculateAsinCosts(po({ order_total: 0 }), li(), [], 1);
  approx("no-GC ord_total=0 adjusted", r.adjusted_product_cost, 100);
}

console.log(`\n==== ${passed} passed, ${failed} failed ====`);
process.exit(failed > 0 ? 1 : 0);
