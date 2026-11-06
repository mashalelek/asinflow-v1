import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { costPerUnitPrefill, adjustedProductCost, allocateAsinCosts, discountReflectedInLines, lineMoney, COST_FORMULA_VERSION, reflectedPromos, promoCostHeader } from "./po-cost";

// The allocation measured against the imported 2026 cost / unit (sheet Col Y).
// v1 (price × total ÷ subtotal × (1 − GC)) reproduced 1,166 of 1,582; v2
// (2026-10-31, no tax / shipping) 1,019. v3 is Maria's corrected rule for
// NEW and EDITED POs (2026-11-04: tax and shipping in, the order discount pro
// rata, rewards added back) — not a reproduction of the sheet, whose X
// formula varies per order (probe doc). The count below is the measured v3
// figure, kept so a later change is noticed, not a target.
// Regenerate the fixture with `tsx script/export-po-cost-fixture.ts`.
const BASELINE = { version: 3, rows: 1582, matched: 1198 }; // v3 1,198 (75.7 %); v1 1,166 (73.7 %), v2 1,019 (64.4 %) — see above

type Row = { supplier: string; order_id: string; asin: string; qty: number; cost: number; subtotal: number; order_total: number; gc_pct: number | null; tax: number; sh: number; discount: number; cashback_pct: number | null; lines: Array<{ price: number; qty: number }> };
const rows: Row[] = JSON.parse(readFileSync(resolve(__dirname, "__fixtures__/po-cost-2026.json"), "utf8"));

export function measure(): { matched: number; total: number; misses: Row[] } {
  const misses: Row[] = [];
  let matched = 0;
  for (const r of rows) {
    const subtotal = r.subtotal > 0 ? r.subtotal : r.lines.reduce((t, l) => t + l.price * l.qty, 0);
    const got = costPerUnitPrefill({ subtotal, discount: r.discount, gcPct: r.gc_pct, tax: r.tax, shDonations: r.sh }, r.lines, r.qty);
    if (got != null && Math.abs(got - r.cost) <= 0.01 + 1e-9) matched++; else misses.push(r);
  }
  return { matched, total: rows.length, misses };
}

describe("cost allocation vs the imported 2026 cost / unit", () => {
  it(`formula v${COST_FORMULA_VERSION} matches the recorded count (within one cent)`, () => {
    const m = measure();
    // eslint-disable-next-line no-console
    console.log(`[po-cost] v${COST_FORMULA_VERSION}: ${m.matched} / ${m.total} (${((100 * m.matched) / m.total).toFixed(1)}%) match the imported cost / unit`);
    expect(m.total).toBe(BASELINE.rows);
    expect(m.matched).toBeGreaterThanOrEqual(BASELINE.matched);
  });
  it("§7.1 v3: tax and shipping are in, the order discount is pro rata, the gift-card % is a flat factor", () => {
    // subtotal 280, discount 56, tax 20, shipping 9.99, GC 11 %: base = 280 − 56 + 29.99 = 253.99; X = 40 × 253.99 ÷ 280 × 0.89
    expect(adjustedProductCost(40, { subtotal: 280, discount: 56, gcPct: 11, tax: 20, shDonations: 9.99 })).toBe(32.29);
    const h = { subtotal: 280, discount: 56, gcPct: 11, tax: 20, shDonations: 9.99 };
    // the row's qty 7 → ASIN qty 4 (yield): 280 × 253.99 ÷ 280 ÷ 4 = 63.4975 → Sourcing 63.50, COGS × 0.89 = 56.51
    expect(allocateAsinCosts(h, [{ price: 40, qty: 7 }], 4)).toEqual({ sourcing: 63.5, cogsBeforeAdjustment: 56.51, cogs: 56.51, paid: 56.51 });
    expect(allocateAsinCosts({ subtotal: 234.8, discount: 0, gcPct: null }, [{ price: 11.74, qty: 20 }], 10)!.cogs).toBe(23.48); // 2-pack
  });
  it("acmetools.com 42838131: the line total 79.70 already nets the $10 code → Sourcing = COGS = Paid = 86.19 ÷ 10 (8.62)", () => {
    // Lenox 20350GOLD5C, 30 × (79.70 ÷ 30 — not whole cents), shipping 6.49, tax 0, 3-pack → 10 ASIN units
    const reflected = discountReflectedInLines({ linesSum: 79.7, discount: 10, postDiscountSubtotal: 86.19 - 0 - 6.49 });
    expect(reflected).toBe(true);
    const h = { subtotal: 79.7, discount: 0, gcPct: null, tax: 0, shDonations: 6.49 };
    expect(allocateAsinCosts(h, [{ price: 79.7 / 30, qty: 30, lineTotal: 79.7 }], 10)).toEqual({ sourcing: 8.62, cogsBeforeAdjustment: 8.62, cogs: 8.62, paid: 8.62 });
    // the 2-dp price × qty would be 79.80 — the line total, not the rounded price, carries the cost
    expect(lineMoney({ price: 2.66, qty: 30, lineTotal: 79.7 })).toBe(79.7);
    expect(lineMoney({ price: 2.5, qty: 4 })).toBe(10);
  });
  it("the reflected check: within 1¢ of the post-discount subtotal", () => {
    expect(discountReflectedInLines({ linesSum: 79.71, discount: 10, postDiscountSubtotal: 79.7 })).toBe(true);
    expect(discountReflectedInLines({ linesSum: 79.72, discount: 10, postDiscountSubtotal: 79.7 })).toBe(false);
    expect(discountReflectedInLines({ linesSum: 89.7, discount: 10, postDiscountSubtotal: 79.7 })).toBe(false);
    expect(discountReflectedInLines({ linesSum: 79.7, discount: 0, postDiscountSubtotal: 79.7 })).toBe(false);
  });
  it("a rewards promo (not counting) is added back onto COGS and Sourcing, but Paid cost keeps every discount", () => {
    // $10 item, $5 Michaels rewards applied as the order discount: COGS stays $10, Paid is $5 (the §1 trigger case)
    const c = allocateAsinCosts({ subtotal: 10, discount: 5, gcPct: null, nonCountingPromoAmount: 5 }, [{ price: 10, qty: 1 }], 1)!;
    expect(c).toEqual({ sourcing: 10, cogsBeforeAdjustment: 10, cogs: 10, paid: 5 });
    // a coupon ($2, counts) beside the rewards ($5): only the coupon reduces COGS
    const d = allocateAsinCosts({ subtotal: 10, discount: 7, gcPct: 10, nonCountingPromoAmount: 5 }, [{ price: 10, qty: 1 }], 1)!;
    expect(d).toEqual({ sourcing: 8, cogsBeforeAdjustment: 7.2, cogs: 7.2, paid: 2.7 });
  });
  it("the adjustment is added onto COGS only; unknown price or zero qty → null", () => {
    expect(allocateAsinCosts({ subtotal: 10, discount: 0, gcPct: null }, [{ price: 10, qty: 1 }], 1, 3)).toEqual({ sourcing: 10, cogsBeforeAdjustment: 10, cogs: 13, paid: 10 });
    expect(costPerUnitPrefill({ subtotal: 1, discount: 0, gcPct: null }, [{ price: null, qty: 1 }], 1)).toBeNull();
    expect(costPerUnitPrefill({ subtotal: 1, discount: 0, gcPct: null }, [{ price: 1, qty: 1 }], 0)).toBeNull();
  });
});

// Maria 2026-11-05 (Michaels 4300109060826629): which promos are already in the line totals, per promo.
describe("reflectedPromos", () => {
  const mich = { linesSum: 170.6, subtotal: 188.6, discount: 28, postDiscountSubtotal: 160.6 };
  it("the one subset closing subtotal − Σ lines within 1¢; an amount-less promo takes discount − the others", () => {
    expect(reflectedPromos({ ...mich, promoAmounts: [18, 10] })).toMatchObject({ all: false, reflected: [true, false], reflectedAmount: 18, ambiguous: false });
    expect(reflectedPromos({ ...mich, promoAmounts: [null, 10] })).toMatchObject({ reflected: [true, false], amounts: [18, 10] });
    expect(reflectedPromos({ ...mich, linesSum: 188.6, promoAmounts: [18, 10] })).toMatchObject({ reflected: [false, false], reflectedAmount: 0 });
    expect(reflectedPromos({ ...mich, linesSum: 160.6, promoAmounts: [18, 10] })).toMatchObject({ all: true, reflectedAmount: 28 });
    // Ambiguous (2026-11-06): no candidate is subtracted (COGS errs high) and each needs Maria's answer; her answer wins.
    const amb = { linesSum: 91, subtotal: 100, discount: 18, postDiscountSubtotal: 82, promoAmounts: [9, 9] };
    expect(reflectedPromos(amb)).toMatchObject({ ambiguous: true, reflected: [true, true], reflectedAmount: 18, fits: [[0], [1]], needsAnswer: [0, 1] });
    expect(reflectedPromos({ ...amb, answers: [true, null] })).toMatchObject({ reflected: [true, true], needsAnswer: [1] });
    expect(reflectedPromos({ ...amb, answers: [true, false] })).toMatchObject({ reflected: [true, false], reflectedAmount: 9, needsAnswer: [] });
    // An answer also overrides an unambiguous result.
    expect(reflectedPromos({ ...mich, promoAmounts: [18, 10], answers: [false, null] })).toMatchObject({ reflected: [false, false], reflectedAmount: 0 });
  });
  it("promoCostHeader: reflected promos leave the discount and are never added back; the base is Σ line totals", () => {
    const h = { subtotal: 188.6, discount: 28, gcPct: 12.795 };
    const r = reflectedPromos({ ...mich, promoAmounts: [18, 10] });
    expect(promoCostHeader(h, 170.6, [{ counts: false }, { counts: true }], r)).toMatchObject({ subtotal: 170.6, discount: 10, nonCountingPromoAmount: 0 });
    expect(promoCostHeader(h, 170.6, [{ counts: false }, { counts: false }], r)).toMatchObject({ subtotal: 170.6, discount: 10, nonCountingPromoAmount: 10 });
  });
});
