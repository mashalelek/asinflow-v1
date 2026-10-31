import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { costPerUnitPrefill, adjustedProductCost, allocateAsinCosts, COST_FORMULA_VERSION } from "./po-cost";

// The allocation measured against the imported 2026 cost / unit (sheet Col Y).
// v1 (price × total ÷ subtotal × (1 − GC)) reproduced 1,166 of 1,582. v2 is
// Maria's rule for NEW POs (2026-10-31: no tax / shipping in cost, the
// order discount pro rata, rewards added back) — not a reproduction of the
// sheet, whose X formula varies per order (probe doc). The count below is
// the measured v2 figure, kept so a later change is noticed, not a target.
// Regenerate the fixture with `tsx script/export-po-cost-fixture.ts`.
const BASELINE = { version: 2, rows: 1582, matched: 1019 }; // v1 was 1,166 (73.7 %); v2 measures 1,019 (64.4 %) — expected, see above

type Row = { supplier: string; order_id: string; asin: string; qty: number; cost: number; subtotal: number; order_total: number; gc_pct: number | null; tax: number; sh: number; discount: number; cashback_pct: number | null; lines: Array<{ price: number; qty: number }> };
const rows: Row[] = JSON.parse(readFileSync(resolve(__dirname, "__fixtures__/po-cost-2026.json"), "utf8"));

export function measure(): { matched: number; total: number; misses: Row[] } {
  const misses: Row[] = [];
  let matched = 0;
  for (const r of rows) {
    const subtotal = r.subtotal > 0 ? r.subtotal : r.lines.reduce((t, l) => t + l.price * l.qty, 0);
    const got = costPerUnitPrefill({ subtotal, discount: r.discount, gcPct: r.gc_pct }, r.lines, r.qty);
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
  it("§7.1: the order discount is pro rata, the gift-card % is a flat factor, tax and shipping never enter", () => {
    // macys 2026-01-03: subtotal 280, discount 56, GC 11 %, price 40 → X = 40 × 0.8 × 0.89 = 28.48; the row's qty 7 → ASIN qty 4 (yield): COGS 49.84
    expect(adjustedProductCost(40, { subtotal: 280, discount: 56, gcPct: 11 })).toBe(28.48);
    const h = { subtotal: 280, discount: 56, gcPct: 11, tax: 20, shDonations: 9.99 };
    expect(allocateAsinCosts(h, [{ price: 40, qty: 7 }], 4)).toEqual({ sourcing: 56, cogsBeforeAdjustment: 49.84, cogs: 49.84, paid: 49.84 });
    expect(allocateAsinCosts({ subtotal: 234.8, discount: 0, gcPct: null }, [{ price: 11.74, qty: 20 }], 10)!.cogs).toBe(23.48); // 2-pack
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
