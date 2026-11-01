import { describe, it, expect } from "vitest";
import { checkPoForm, emptyPoForm, emptyProduct, canonicalPaymentName, promoCountsByDefault, PROMO_REFLECTED_NOTE, type PoFormState } from "./po-form";

// po-af-owned §4 (2026-10-18): the New PO form's validation and derived rows.
const base = (over: Partial<PoFormState> = {}): PoFormState => ({
  ...emptyPoForm("2026-10-18"), supplier: "walmart.com", order_id: "zz-200015000000001",
  products: [{ ...emptyProduct(), product_name: "Pens 12ct", price: "5.44", qty_ordered: "5", asin: "B0TEST0001" }],
  ...over,
});

describe("checkPoForm", () => {
  it("the empty form is a plain JSON shape and round-trips through JSON unchanged", () => {
    const f = emptyPoForm("2026-10-18");
    expect(JSON.parse(JSON.stringify(f))).toEqual(f);
    const c = checkPoForm(f);
    expect(c.ok).toBe(false);
    expect(c.errors).toEqual(expect.arrayContaining(["Supplier is required", "Order # is required"]));
    expect(c.productErrors[0]).toEqual(expect.arrayContaining(["qty must be more than 0 (at most 2 decimals)", "map it to an ASIN (10 characters)"]));
  });
  it("a valid single-product PO: one ASIN row, Ordered = qty × yield, live totals, cost / unit from price", () => {
    const c = checkPoForm(base());
    expect(c.ok).toBe(true);
    expect(c.computedSubtotal).toBe(27.2);
    expect(c.effectiveOrderTotal).toBe(27.2);
    expect(c.asins).toHaveLength(1);
    expect(c.asins[0]).toMatchObject({ asin: "B0TEST0001", qty: 5, sold_as: "individual", units_per_pack: 1, cost_per_unit: "5.44", prep_cost: "1.00", unique_products: null });
  });
  it("costs (formula v2, §7.1): the order discount pro rata and the GC % as a factor; tax / shipping never; the override wins", () => {
    // tetley 2026: price 25.61, subtotal 512.20, discount 149.71 → X = 25.61 × (1 − 149.71 ÷ 512.20) = 18.12; tax and S&H change nothing
    const tetley = base({ subtotal: "512.20", discount: "149.71", tax: "30", sh_donations: "9.99", products: [{ ...emptyProduct(), price: "25.61", qty_ordered: "20", asin: "B001AXZ7Q8" }] });
    expect(checkPoForm(tetley).asins[0]).toMatchObject({ cost_per_unit: "18.12", sourcing_cost: "18.12", paid_cost: "18.12", cogs_adjustment: null });
    // target 2026: gc 2.15 %, price 25.49 → COGS 24.94, Sourcing (before the GC discount) 25.49
    expect(checkPoForm(base({ weighted_gc_discount_pct: "2.15", products: [{ ...emptyProduct(), price: "25.49", qty_ordered: "5", asin: "B0TEST0002" }] })).asins[0]).toMatchObject({ cost_per_unit: "24.94", sourcing_cost: "25.49" });
    const ov = checkPoForm({ ...tetley, cost_overrides: { B001AXZ7Q8: "17.50" } });
    expect(ov.asins[0]).toMatchObject({ cost_per_unit: "17.50", computed_cost_per_unit: "18.12" });
  });
  it("promos (§7.2): a rewards promo is added back onto COGS / Sourcing, Paid keeps it; one without an amount only warns; the adjustment needs a reason", () => {
    const item = { ...emptyProduct(), price: "10", qty_ordered: "1", asin: "B0TEST0009" };
    const rewards = base({ discount: "5", products: [item], promos: [{ type: "rewards", description: "Michaels rewards", amount: "5", percent: "", counts_toward_cogs: false }] });
    const c = checkPoForm(rewards);
    expect(c.ok).toBe(true);
    expect(c.nonCountingPromoAmount).toBe(5);
    expect(c.asins[0]).toMatchObject({ cost_per_unit: "10.00", sourcing_cost: "10.00", paid_cost: "5.00" });
    const noAmount = checkPoForm({ ...rewards, promos: [{ type: "rewards", description: "Michaels rewards", amount: "", percent: "", counts_toward_cogs: false }] });
    expect(noAmount.asins[0].cost_per_unit).toBe("5.00");
    expect(noAmount.warnings.join()).toMatch(/cannot be added back/);
    expect(checkPoForm({ ...rewards, promos: [{ type: "" as any, description: "", amount: "", percent: "", counts_toward_cogs: true }] }).errors).toContain("Promo 1: type must be sale, coupon or rewards");
    const adj = checkPoForm(base({ products: [item], cogs_adjustments: { B0TEST0009: { amount: "3", reason: "prep materials" } } }));
    expect(adj.asins[0]).toMatchObject({ cost_per_unit: "13.00", computed_cost_per_unit: "13.00", sourcing_cost: "10.00", cogs_adjustment: "3.00", cogs_adjustment_reason: "prep materials" });
    expect(checkPoForm(base({ products: [item], cogs_adjustments: { B0TEST0009: { amount: "3", reason: "" } } })).errors).toContain("B0TEST0009: a COGS adjustment needs a reason");
  });
  // Maria 2026-11-01, PO 200015336732726: the line price 7.97 was already the sale price; "sale $36.12, counts" subtracted it again (29.76 instead of 47.82).
  it("double-discount rule: when Σ price × qty already equals the post-discount subtotal, the discount / promo is informational — COGS = Sourcing = Paid, nothing added back", () => {
    const line = { ...emptyProduct(), product_name: "Keystone All Natural Chicken, 28 oz Can", price: "7.97", qty_ordered: "12", asin: "B0756KB8N1", sold_as: "multi-pack" as const, units_per_pack: "6", asin_qty_per_product: "0.1667" };
    const po = base({ subtotal: "95.64", discount: "36.12", tax: "0", sh_donations: "0", order_total: "95.64", products: [line], promos: [{ type: "sale", description: "Now $7.97, was $10.98", amount: "36.12", percent: "", counts_toward_cogs: true }] });
    const c = checkPoForm(po);
    expect(c.discountReflected).toBe(true);
    expect(c.nonCountingPromoAmount).toBe(0);
    expect(c.asins[0]).toMatchObject({ qty: 2, cost_per_unit: "47.82", sourcing_cost: "47.82", paid_cost: "47.82" });
    // The same with the promo off (its default when reflected) and with no header discount at all: still 47.82.
    expect(checkPoForm({ ...po, promos: [{ ...po.promos![0], counts_toward_cogs: false }] }).asins[0].cost_per_unit).toBe("47.82");
    expect(checkPoForm({ ...po, discount: "", promos: [] }).asins[0].cost_per_unit).toBe("47.82");
    expect(promoCountsByDefault("sale", true)).toBe(false);
    expect(promoCountsByDefault("sale")).toBe(true);
    expect(PROMO_REFLECTED_NOTE).toBe("already reflected in line prices");
    // Pre-discount lines (Michaels: subtotal 77.82 before a 23.35 discount, total 58.28 with tax 3.81) still allocate the discount.
    const pre = base({ subtotal: "77.82", discount: "23.35", tax: "3.81", order_total: "58.28", products: [{ ...emptyProduct(), price: "5.99", qty_ordered: "6", asin: "B0TEST0003" }, { ...emptyProduct(), price: "3.49", qty_ordered: "12", asin: "B0TEST0004" }] });
    const pc = checkPoForm(pre);
    expect(pc.discountReflected).toBe(false);
    expect(pc.asins[0].cost_per_unit).toBe("4.19"); // 5.99 × (1 − 23.35 ÷ 77.82)
    // A non-counting promo larger than the header discount never raises the cost above the price paid.
    expect(checkPoForm(base({ discount: "0", products: [{ ...emptyProduct(), price: "10", qty_ordered: "1", asin: "B0TEST0009" }], promos: [{ type: "rewards", description: "r", amount: "5", percent: "", counts_toward_cogs: false }] })).asins[0].cost_per_unit).toBe("10.00");
  });
  it("weighted GC % is computed live from the gift-card payments (Σ amount × GC % ÷ order total), beats the typed field, and feeds COGS", () => {
    const item = { ...emptyProduct(), price: "100", qty_ordered: "1", asin: "B0TEST0010" };
    const c = checkPoForm(base({ order_total: "100", weighted_gc_discount_pct: "9", products: [item], payments: [{ method: "gift_card", nickname: "", last4: "", amount: "50", gift_card_discount_pct: "10" }, { method: "card", nickname: "Amex", last4: "1001", amount: "50", gift_card_discount_pct: "" }] }));
    expect(c.weightedGcPct).toBe(5);
    expect(c.asins[0]).toMatchObject({ cost_per_unit: "95.00", sourcing_cost: "100.00" });
    expect(checkPoForm(base({ products: [item], payments: [{ method: "card", nickname: "Amex", last4: "1001", amount: "100", gift_card_discount_pct: "" }] })).weightedGcPct).toBeNull();
  });
  it("payment-method aliases: OnePay Cash is the Walmart card; other names pass through trimmed", () => {
    const aliases = { "OnePay Cash": "Walmart card" };
    expect(canonicalPaymentName("OnePay Cash", aliases)).toBe("Walmart card");
    expect(canonicalPaymentName("onepay cashrewards", aliases)).toBe("Walmart card");
    expect(canonicalPaymentName(" Amex ", aliases)).toBe("Amex");
    expect(canonicalPaymentName("Chase (7927)", null)).toBe("Chase (7927)");
  });
  it("pack math: 5 units of a 2-pack (2.5 ASIN units) is allowed with the whole-packs warning, not blocked", () => {
    const p = { ...emptyProduct(), price: "6.56", qty_ordered: "5", asin: "B007K83C46", asin_qty_per_product: "0.5", sold_as: "multi-pack" as const, units_per_pack: "2" };
    const half = checkPoForm(base({ products: [p] }));
    expect(half.ok).toBe(true);
    expect(half.asins[0]).toMatchObject({ qty: 2.5, units_per_pack: 2 });
    expect(half.warnings).toContain("B007K83C46: 2.5 ASIN units — Upload to Velocity will skip this line — Velocity only accepts whole packs");
    const whole = checkPoForm(base({ products: [{ ...p, qty_ordered: "6" }] }));
    expect(whole.ok).toBe(true);
    expect(whole.asins[0]).toMatchObject({ qty: 3 });
    expect(whole.warnings.join()).not.toMatch(/whole packs/);
    expect(checkPoForm(base({ products: [{ ...p, units_per_pack: "1" }] })).productErrors[0]).toContain("units per pack must be a whole number ≥ 2 for a multi-pack");
  });
  it("2-dp yields are read as the fraction they stand for (48 × 0.33 = 16)", () => {
    expect(checkPoForm(base({ products: [{ ...emptyProduct(), price: "1", qty_ordered: "48", asin: "B0TEST0003", asin_qty_per_product: "0.33" }] })).asins[0].qty).toBe(16);
  });
  it("a bundle needs ≥ 2 products giving the same number of sets; S = its products", () => {
    const comp = (q: string) => ({ ...emptyProduct(), price: "3", qty_ordered: q, asin: "B0GNHTYGPF", sold_as: "bundle" as const, units_per_pack: "2" });
    const ok = checkPoForm(base({ products: [comp("7"), comp("7")] }));
    expect(ok.ok).toBe(true);
    expect(ok.asins[0]).toMatchObject({ qty: 7, unique_products: 2, sold_as: "bundle" });
    expect(checkPoForm(base({ products: [comp("7"), comp("8")] })).errors.join()).toMatch(/every bundle component must give the same number of sets/);
    expect(checkPoForm(base({ products: [comp("7")] })).errors.join()).toMatch(/a bundle needs at least two products/);
  });
  it("products of one ASIN must agree on sold as / units per pack / prep; a typed subtotal that differs is only a warning", () => {
    const a = { ...emptyProduct(), price: "2", qty_ordered: "2", asin: "B0TEST0004" };
    expect(checkPoForm(base({ products: [a, { ...a, prep_cost: "0" }] })).errors.join()).toMatch(/B0TEST0004: its products disagree/);
    const w = checkPoForm(base({ subtotal: "30.00" }));
    expect(w.ok).toBe(true);
    expect(w.warnings).toEqual(["Subtotal 30.00 differs from Σ price × qty = 27.20"]);
  });
  it("header validation: real date, money, percentages", () => {
    expect(checkPoForm(base({ order_date: "2026-02-30" })).errors).toContain("Order date must be a real date (YYYY-MM-DD)");
    expect(checkPoForm(base({ tax: "1.234" })).errors).toContain("Tax must be an amount with at most 2 decimals");
    expect(checkPoForm(base({ cashback_pct: "150" })).errors).toContain("Cashback % must be a percentage between 0 and 100");
  });
});
