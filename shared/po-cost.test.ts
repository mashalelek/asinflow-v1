import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { costPerUnitPrefill, adjustedProductCost, COST_FORMULA_VERSION } from "./po-cost";

// The cost / unit prefill measured against the imported 2026 cost / unit
// (sheet Col Y). Each refinement of po-cost.ts must not lower the match
// count; raise BASELINE when it goes up. Regenerate the fixture with
// `tsx script/export-po-cost-fixture.ts`.
const BASELINE = { version: 1, rows: 1582, matched: 1166 };

type Row = { supplier: string; order_id: string; asin: string; qty: number; cost: number; subtotal: number; order_total: number; gc_pct: number | null; tax: number; sh: number; discount: number; cashback_pct: number | null; lines: Array<{ price: number; qty: number }> };
const rows: Row[] = JSON.parse(readFileSync(resolve(__dirname, "__fixtures__/po-cost-2026.json"), "utf8"));

export function measure(): { matched: number; total: number; misses: Row[] } {
  const misses: Row[] = [];
  let matched = 0;
  for (const r of rows) {
    const subtotal = r.subtotal > 0 ? r.subtotal : r.lines.reduce((t, l) => t + l.price * l.qty, 0);
    const got = costPerUnitPrefill({ subtotal, orderTotal: r.order_total, gcPct: r.gc_pct, tax: r.tax, shDonations: r.sh, discount: r.discount, cashbackPct: r.cashback_pct }, r.lines, r.qty);
    if (got != null && Math.abs(got - r.cost) <= 0.01 + 1e-9) matched++; else misses.push(r);
  }
  return { matched, total: rows.length, misses };
}

describe("cost / unit prefill vs the imported 2026 cost / unit", () => {
  it(`formula v${COST_FORMULA_VERSION} matches at least the baseline (within one cent)`, () => {
    const m = measure();
    // eslint-disable-next-line no-console
    console.log(`[po-cost] v${COST_FORMULA_VERSION}: ${m.matched} / ${m.total} (${((100 * m.matched) / m.total).toFixed(1)}%) match the imported cost / unit`);
    expect(m.total).toBe(BASELINE.rows);
    expect(m.matched).toBeGreaterThanOrEqual(BASELINE.matched);
  });
  it("known cases: tetley (discounted order) and target (weighted gift card) match; a hand-keyed cost does not", () => {
    expect(adjustedProductCost(25.61, { subtotal: 512.2, orderTotal: 362.49, gcPct: null })).toBe(18.12);
    expect(adjustedProductCost(25.49, { subtotal: 127.45, orderTotal: 127.45, gcPct: 2.15 })).toBe(24.94);
    expect(costPerUnitPrefill({ subtotal: 234.8, orderTotal: 234.8, gcPct: null }, [{ price: 11.74, qty: 20 }], 10)).toBe(23.48); // 2-pack
    expect(costPerUnitPrefill({ subtotal: 1, orderTotal: 1, gcPct: null }, [{ price: null, qty: 1 }], 1)).toBeNull();
    expect(costPerUnitPrefill({ subtotal: 1, orderTotal: 1, gcPct: null }, [{ price: 1, qty: 1 }], 0)).toBeNull();
  });
});
