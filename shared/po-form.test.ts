import { describe, it, expect } from "vitest";
import { checkPoForm, emptyPoForm, emptyProduct, emptyPayment, weightedPaymentPct, weightedPaymentPctExact, canonicalPaymentName, resolvePaymentNickname, ambiguousPaymentHint, promoCountsByDefault, PROMO_REFLECTED_NOTE, type PoFormState } from "./po-form";

// po-af-owned §4 (2026-10-18): the New PO form's validation and derived rows.
const base = (over: Partial<PoFormState> = {}): PoFormState => ({
  ...emptyPoForm("2026-10-18"), supplier: "walmart.com", order_id: "zz-200015000000001",
  products: [{ ...emptyProduct(), product_name: "Pens 12ct", price: "5.44", qty_ordered: "5", asin: "B0TEST0001", sold_as: "individual", units_per_pack: "1" }],
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
  it("costs (formula v3, §7.1): the order discount pro rata, tax and shipping in, the GC % as a factor; the override wins", () => {
    // tetley 2026: 20 × 25.61 = 512.20, discount 149.71, tax 30, S&H 9.99 → (512.20 − 149.71 + 39.99) ÷ 20 = 20.124 → 20.12
    const tetley = base({ subtotal: "512.20", discount: "149.71", tax: "30", sh_donations: "9.99", products: [{ ...emptyProduct(), price: "25.61", qty_ordered: "20", asin: "B001AXZ7Q8" }] });
    expect(checkPoForm(tetley).asins[0]).toMatchObject({ cost_per_unit: "20.12", sourcing_cost: "20.12", paid_cost: "20.12", cogs_adjustment: null });
    // target 2026: gc 2.15 %, price 25.49 → COGS 24.94, Sourcing (before the GC discount) 25.49
    expect(checkPoForm(base({ weighted_gc_discount_pct: "2.15", products: [{ ...emptyProduct(), price: "25.49", qty_ordered: "5", asin: "B0TEST0002" }] })).asins[0]).toMatchObject({ cost_per_unit: "24.94", sourcing_cost: "25.49" });
    const ov = checkPoForm({ ...tetley, cost_overrides: { B001AXZ7Q8: "17.50" } });
    expect(ov.asins[0]).toMatchObject({ cost_per_unit: "17.50", computed_cost_per_unit: "20.12" });
  });
  it("promos (§7.2): a rewards promo is added back onto COGS / Sourcing, Paid keeps it; one without an amount only warns; the adjustment needs a reason", () => {
    const item = { ...emptyProduct(), price: "10", qty_ordered: "1", asin: "B0TEST0009" };
    const rewards = base({ discount: "5", products: [item], promos: [{ type: "rewards", description: "Michaels rewards", amount: "5", percent: "", counts_toward_cogs: false }] });
    const c = checkPoForm(rewards);
    expect(c.ok).toBe(true);
    expect(c.nonCountingPromoAmount).toBe(5);
    expect(c.asins[0]).toMatchObject({ cost_per_unit: "10.00", sourcing_cost: "10.00", paid_cost: "5.00" });
    // The only promo without an amount takes the discount − the others (2026-11-05): added back, no warning.
    const implied = checkPoForm({ ...rewards, promos: [{ type: "rewards", description: "Michaels rewards", amount: "", percent: "", counts_toward_cogs: false }] });
    expect(implied.asins[0].cost_per_unit).toBe("10.00");
    expect(implied.warnings.join()).not.toMatch(/cannot be added back/);
    // Two without an amount: neither can be added back — they count, with the warning.
    const noAmount = checkPoForm({ ...rewards, promos: [{ type: "rewards", description: "Michaels rewards", amount: "", percent: "", counts_toward_cogs: false }, { type: "coupon", description: "SAVE", amount: "", percent: "", counts_toward_cogs: true }] });
    expect(noAmount.asins[0].cost_per_unit).toBe("5.00");
    expect(noAmount.warnings.join()).toMatch(/cannot be added back/);
    expect(checkPoForm({ ...rewards, promos: [{ type: "" as any, description: "", amount: "", percent: "", counts_toward_cogs: true }] }).errors).toContain("Promo 1: type must be sale, coupon or rewards");
    const adj = checkPoForm(base({ products: [item], cogs_adjustments: { B0TEST0009: { amount: "3", reason: "prep materials" } } }));
    expect(adj.asins[0]).toMatchObject({ cost_per_unit: "13.00", computed_cost_per_unit: "13.00", sourcing_cost: "10.00", cogs_adjustment: "3.00", cogs_adjustment_reason: "prep materials" });
    expect(checkPoForm(base({ products: [item], cogs_adjustments: { B0TEST0009: { amount: "3", reason: "" } } })).errors).toContain("B0TEST0009: a COGS adjustment needs a reason");
  });
  // Maria 2026-11-01, PO 200015336732726: the line price 7.97 was already the sale price; "sale $36.12, counts" subtracted it again (29.76 instead of 47.82).
  // Maria 2026-11-05, michaels.com 4300109060826629: the paint was already $4.19 after MEGA30DEAL −$18.00; the combined $28 was
  // subtracted from line totals that carried the $18 → 6.37 / 3.11. Correct (docs/claude_cogs-rule.md): 7.04 / 3.44.
  const michaels = (over: Partial<PoFormState> = {}): PoFormState => base({
    supplier: "michaels.com", subtotal: "188.60", discount: "28.00", tax: "0", sh_donations: "0", order_total: "160.60",
    products: [
      { ...emptyProduct(), product_name: "15 Pack: Caron Simply Soft Solid Yarn", price: "64.35", qty_ordered: "2", retailer_units_per_pack: "15", asin: "B01N3B23JX", sold_as: "multi-pack", units_per_pack: "2", asin_qty_per_product: "7.5" },
      { ...emptyProduct(), product_name: "Liquitex BASICS 4oz. Acrylic Paint", price: "4.19", qty_ordered: "10", asin: "B000RDP7XK" },
    ],
    promos: [
      { type: "sale", description: "30% on regular priced items (code MEGA30DEAL)", amount: "18.00", percent: "30", counts_toward_cogs: true },
      { type: "rewards", description: "$10 voucher 3921", amount: "10.00", percent: "", counts_toward_cogs: true },
    ],
    payments: [
      { ...emptyPayment(), method: "gift_card", last4: "1004", amount: "50.00", gift_card_discount_pct: "13" },
      { ...emptyPayment(), method: "gift_card", last4: "1020", amount: "50.00", gift_card_discount_pct: "13" },
      { ...emptyPayment(), method: "gift_card", last4: "1038", amount: "44.15", gift_card_discount_pct: "13" },
      { ...emptyPayment(), method: "gift_card", last4: "0895", amount: "16.45", gift_card_discount_pct: "11" },
    ],
    ...over,
  });
  it("per-promo rule (Michaels 4300109060826629): the promo already in the line totals is not subtracted again; the voucher counts by line total; the exact GC % → 7.04 / 3.44", () => {
    const c = checkPoForm(michaels());
    expect(c.ok).toBe(true);
    expect(c.computedSubtotal).toBe(170.6);
    expect(c.discountReflected).toBe(false);
    expect(c.promoReflected).toEqual([true, false]);
    expect(c.weightedGcPct).toBe(12.8); // displayed / stored at 2 dp
    expect(c.asins.map((a) => [a.asin, a.qty, a.cost_per_unit])).toEqual([["B01N3B23JX", 15, "7.04"], ["B000RDP7XK", 10, "3.44"]]);
    expect(c.warnings.join()).not.toMatch(/cannot be added back|match neither/);
    // Promo 1's toggle is moot once it is in the prices (the addendum: it must not depend on unticking COGS).
    const off = michaels({ promos: [{ ...michaels().promos![0], counts_toward_cogs: false }, michaels().promos![1]] });
    expect(checkPoForm(off).asins.map((a) => a.cost_per_unit)).toEqual(["7.04", "3.44"]);
    // As captured (2026-11-05): promo 1 with only its 30 % — the amount is implied from the discount, same result, no warning.
    const pctOnly = checkPoForm(michaels({ promos: [{ ...michaels().promos![0], amount: "", counts_toward_cogs: false }, michaels().promos![1]] }));
    expect(pctOnly.asins.map((a) => a.cost_per_unit)).toEqual(["7.04", "3.44"]);
    expect(pctOnly.warnings.join()).not.toMatch(/cannot be added back/);
    // The voucher toggled off (rewards' default): added back — COGS before the voucher, only the GC %.
    const voucherOff = michaels({ promos: [michaels().promos![0], { ...michaels().promos![1], counts_toward_cogs: false }] });
    expect(checkPoForm(voucherOff).asins.map((a) => a.cost_per_unit)).toEqual(["7.48", "3.65"]);
  });
  it("per-promo rule: a discount NOT in the line prices is still subtracted; two subsets that fit → \"which promos are already in the prices?\"", () => {
    // Pre-discount lines: paint at its regular $5.99 → Σ lines = subtotal 188.60, both promos subtracted.
    const pre = michaels({ products: [michaels().products[0], { ...michaels().products[1], price: "5.99" }] });
    const c = checkPoForm(pre);
    expect(c.promoReflected).toEqual([false, false]);
    // ratio (188.60 − 28) ÷ 188.60 × (1 − 12.795 %): yarn 128.70 ÷ 15 → 6.37 · paint 59.90 ÷ 10 → 4.45
    expect(c.asins.map((a) => a.cost_per_unit)).toEqual(["6.37", "4.45"]);
    // Two $9 promos and a $9 gap (Maria 2026-11-06): neither is subtracted (COGS errs high: 91.00, not 82.00) and the PO does
    // not save until she answers "In prices?" on each; her answers then decide.
    const ambForm = base({ subtotal: "100", discount: "18", order_total: "82", products: [{ ...emptyProduct(), price: "91", qty_ordered: "1", asin: "B0TEST0005" }], promos: [
      { type: "sale", description: "A", amount: "9", percent: "", counts_toward_cogs: true }, { type: "coupon", description: "B", amount: "9", percent: "", counts_toward_cogs: true }] });
    const amb = checkPoForm(ambForm);
    expect(amb.promoReflected).toEqual([true, true]);
    expect(amb.promoNeedsAnswer).toEqual([0, 1]);
    expect(amb.asins[0].cost_per_unit).toBe("91.00");
    expect(amb.ok).toBe(false);
    expect(amb.errors.join()).toMatch(/^Which promos are already in the prices\? .*promo 1 or promo 2 each fit — answer "In prices\?" on promo 1, promo 2/);
    const half = checkPoForm({ ...ambForm, promos: [{ ...ambForm.promos![0], in_line_prices: true }, ambForm.promos![1]] });
    expect(half.ok).toBe(false);
    expect(half.promoNeedsAnswer).toEqual([1]);
    const answered = checkPoForm({ ...ambForm, promos: [{ ...ambForm.promos![0], in_line_prices: true }, { ...ambForm.promos![1], in_line_prices: false }] });
    expect(answered.ok).toBe(true);
    expect(answered.asins[0].cost_per_unit).toBe("82.00"); // 91 − the $9 not in the prices
  });
  it("the weighted GC % goes into the math unrounded (12.795 %), shown at 2 dp", () => {
    const pays = michaels().payments!;
    expect(weightedPaymentPct(pays, 160.6)).toBe(12.8);
    expect(weightedPaymentPctExact(pays, 160.6)!).toBeCloseTo(12.79514, 5);
  });
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
    expect(pc.asins[0].cost_per_unit).toBe("4.49"); // 5.99 × (77.82 − 23.35 + 3.81 tax) ÷ 77.82
    // A non-counting promo larger than the header discount never raises the cost above the price paid.
    expect(checkPoForm(base({ discount: "0", products: [{ ...emptyProduct(), price: "10", qty_ordered: "1", asin: "B0TEST0009" }], promos: [{ type: "rewards", description: "r", amount: "5", percent: "", counts_toward_cogs: false }] })).asins[0].cost_per_unit).toBe("10.00");
  });
  // Maria 2026-11-04, acmetools.com 42838131: 30 Lenox blades for $79.70 after code DHDNYC −$10 (79.70 ÷ 30 is not whole cents), shipping 6.49.
  it("line totals: the captured total carries the cost; already net → Sourcing = COGS = Paid = 86.19 ÷ 10, nothing added back; the price takes 6 decimals", () => {
    const line = { ...emptyProduct(), product_name: "Lenox 20350GOLD5C", price: "2.66", line_total: "79.70", qty_ordered: "30", asin: "B07VH2L2QF", sold_as: "multi-pack" as const, units_per_pack: "3", asin_qty_per_product: "0.3333" };
    const po = base({ subtotal: "89.70", discount: "10.00", tax: "0", sh_donations: "6.49", order_total: "86.19", products: [line], promos: [{ type: "coupon", description: "Code DHDNYC", amount: "10.00", percent: "", counts_toward_cogs: false }] });
    const c = checkPoForm(po);
    expect(c.ok).toBe(true);
    expect(c.computedSubtotal).toBe(79.7);
    expect(c.discountReflected).toBe(true);
    expect(c.nonCountingPromoAmount).toBe(0);
    expect(c.warnings).toEqual([]);
    expect(c.asins[0]).toMatchObject({ qty: 10, cost_per_unit: "8.62", sourcing_cost: "8.62", paid_cost: "8.62" });
    expect(c.asins[0].lines[0]).toMatchObject({ price: "2.656667", line_total: "79.70" });
    // A line total that no longer fits the price (the price was retyped) is ignored with a warning: price × qty.
    const off = checkPoForm({ ...po, products: [{ ...line, price: "2.99" }] });
    expect(off.computedSubtotal).toBe(89.7);
    expect(off.warnings.join()).toMatch(/line total 79.70 does not match price × qty/);
    // A price typed past the cent is accepted and kept; 7 decimals is not.
    const typed = checkPoForm({ ...po, products: [{ ...line, price: "2.656667", line_total: "" }] });
    expect(typed.asins[0].lines[0]).toMatchObject({ price: "2.656667", line_total: null });
    expect(checkPoForm({ ...po, products: [{ ...line, price: "2.6566667", line_total: "" }] }).productErrors[0]).toEqual(["price must be an amount ≥ 0 (at most 6 decimals)"]);
    // Lines that match neither the subtotal nor the subtotal after discount: the one totals warning.
    const neither = checkPoForm({ ...po, products: [{ ...line, price: "2.80", line_total: "" }] });
    expect(neither.warnings).toEqual(["Line totals 84.00 match neither the subtotal 89.70 nor the subtotal after discount 79.70"]);
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
  // Maria 2026-11-02: two Amex cards end in 1005 — Amex Gold and Amex Plus.
  it("resolvePaymentNickname: nickname first (alias or canonical), last 4 second (the one method with it), never a shared last 4 alone — blank + the candidates; a narrowing nickname still resolves", () => {
    const lists = { methods: ["Gift cards", "Amex (1001)", "Amex Gold", "Amex Plus", "Chase (7927)", "Chase Ink (7927)", "Walmart card"], aliases: { "OnePay Cash": "Walmart card", "Amex (1005) - Gold": "Amex Gold", "Amex Gold (1005)": "Amex Gold", "Amex Plus (1005)": "Amex Plus" }, last4: { "Amex (1001)": "1001", "Amex Gold": "1005", "Amex Plus": "1005", "Chase (7927)": "7927", "Chase Ink (7927)": "7927" } };
    expect(resolvePaymentNickname("Amex Plus", "1005", lists)).toEqual({ nickname: "Amex Plus", ambiguous: [] });
    expect(resolvePaymentNickname("amex gold (1005)", "1005", lists)).toEqual({ nickname: "Amex Gold", ambiguous: [] });
    expect(resolvePaymentNickname("Amex (1005) - Gold", "", lists)).toEqual({ nickname: "Amex Gold", ambiguous: [] });
    expect(resolvePaymentNickname("Gold", "1005", lists)).toEqual({ nickname: "Amex Gold", ambiguous: [] });
    expect(resolvePaymentNickname("Amex", "1001", lists)).toEqual({ nickname: "Amex (1001)", ambiguous: [] });
    expect(resolvePaymentNickname("Visa", "1001", lists)).toEqual({ nickname: "Amex (1001)", ambiguous: [] }); // the brand is not the nickname; the last 4 is unique
    expect(resolvePaymentNickname("Amex", "1005", lists)).toEqual({ nickname: "", ambiguous: ["Amex Gold", "Amex Plus"] });
    expect(resolvePaymentNickname("Amex (1005)", "1005", lists)).toEqual({ nickname: "", ambiguous: ["Amex Gold", "Amex Plus"] });
    expect(resolvePaymentNickname("", "1005", lists)).toEqual({ nickname: "", ambiguous: ["Amex Gold", "Amex Plus"] });
    expect(resolvePaymentNickname("Chase", "7927", lists)).toEqual({ nickname: "", ambiguous: ["Chase (7927)", "Chase Ink (7927)"] });
    expect(resolvePaymentNickname("OnePay Cash", "", lists)).toEqual({ nickname: "Walmart card", ambiguous: [] });
    expect(resolvePaymentNickname(" Discover ", "4242", lists)).toEqual({ nickname: "Discover", ambiguous: [] }); // unknown: passes through trimmed
    expect(resolvePaymentNickname("Amex", "", { methods: [], aliases: null, last4: null })).toEqual({ nickname: "Amex", ambiguous: [] });
    expect(ambiguousPaymentHint("1005", ["Amex Gold", "Amex Plus"])).toBe("Two cards end in 1005 — pick Amex Gold or Amex Plus");
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
    expect(w.warnings).toEqual(["Subtotal 30.00 differs from the line totals 27.20"]);
  });
  it("header validation: real date, money, percentages", () => {
    expect(checkPoForm(base({ order_date: "2026-02-30" })).errors).toContain("Order date must be a real date (YYYY-MM-DD)");
    expect(checkPoForm(base({ tax: "1.234" })).errors).toContain("Tax must be an amount with at most 2 decimals");
    expect(checkPoForm(base({ cashback_pct: "150" })).errors).toContain("Cashback % must be a percentage between 0 and 100");
  });
});
