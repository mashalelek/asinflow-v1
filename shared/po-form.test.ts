import { describe, it, expect } from "vitest";
import { checkPoForm, emptyPoForm, emptyProduct, type PoFormState } from "./po-form";

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
  it("cost / unit follows price × (order total ÷ subtotal) × (1 − weighted GC %) and can be overridden", () => {
    // tetley 2026: price 25.61, subtotal 512.20, total 362.49 → 18.12 (the imported cost / unit)
    const tetley = base({ subtotal: "512.20", order_total: "362.49", products: [{ ...emptyProduct(), price: "25.61", qty_ordered: "20", asin: "B001AXZ7Q8" }] });
    expect(checkPoForm(tetley).asins[0].cost_per_unit).toBe("18.12");
    // target 2026: gc 2.15 %, price 25.49 → 24.94
    expect(checkPoForm(base({ weighted_gc_discount_pct: "2.15", products: [{ ...emptyProduct(), price: "25.49", qty_ordered: "5", asin: "B0TEST0002" }] })).asins[0].cost_per_unit).toBe("24.94");
    const ov = checkPoForm({ ...tetley, cost_overrides: { B001AXZ7Q8: "17.50" } });
    expect(ov.asins[0]).toMatchObject({ cost_per_unit: "17.50", computed_cost_per_unit: "18.12" });
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
