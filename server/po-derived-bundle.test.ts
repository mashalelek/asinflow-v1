import { describe, it, expect } from "vitest";
import { derivedFromLines, poAsinRowsSql } from "./po-queries";
import { PIPELINE_ROWS_SQL } from "./asin-po-pipeline";

// Row-level Status patch, P2 decision (Maria 2026-10-17): keep stored yields;
// for sold_as = 'bundle' ASINs the derived Canceled / Returned is
// Σ(line qty × yield) ÷ N, N = Col S (po_asins.unique_products). This file
// evaluates the SQL expression's arithmetic with a tiny interpreter of the
// same rule and pins the SQL text, so the two cannot drift.
function derive(lines: Array<{ qty: number | null; yield: number | null }>, soldAs: string, uniqueProducts: number | null): number | null {
  if (lines.length === 0 || lines.some((l) => l.qty == null)) return null;
  const sum = lines.reduce((a, l) => a + (l.qty as number) * (l.yield ?? 1), 0);
  return sum / (soldAs === "bundle" && (uniqueProducts ?? 0) > 1 ? (uniqueProducts as number) : 1);
}

describe("derived Canceled / Returned", () => {
  it("fully canceled Kinder's B0G6R55GNQ (2 products × 12, yield 1.00) derives 12, not 24", () => {
    expect(derive([{ qty: 12, yield: 1 }, { qty: 12, yield: 1 }], "bundle", 2)).toBe(12);
  });
  it("1 unit of 1 product canceled in a 3-product bundle derives 1/3", () => {
    expect(derive([{ qty: 1, yield: 1 }, { qty: 0, yield: 1 }, { qty: 0, yield: 1 }], "bundle", 3)).toBeCloseTo(1 / 3, 10);
  });
  it("a bundle with a multi-pack component keeps its stored yield before ÷ N (Yves Rocher 5 × 1 + 1 × 5 → 5)", () => {
    expect(derive([{ qty: 5, yield: 1 }, { qty: 1, yield: 5 }], "bundle", 2)).toBe(5);
  });
  it("multi-packs and non-bundle multi-listing groups keep the plain sum; any NULL line → NULL", () => {
    expect(derive([{ qty: 10, yield: 0.5 }], "multi-pack", null)).toBe(5);
    expect(derive([{ qty: 5, yield: 1 }, { qty: 4, yield: 1 }], "individual", 3)).toBe(9);
    expect(derive([{ qty: 5, yield: 1 }, { qty: null, yield: 1 }], "bundle", 2)).toBeNull();
  });
  it("the SQL divides by unique_products for bundles only, and the POs page uses the one definition and the ASINs pipeline the same rule", () => {
    const sql = derivedFromLines("qty_canceled");
    expect(sql).toMatch(/SUM\(l\.qty_canceled \* COALESCE\(l\.asin_qty_per_product, 1\)\)\s+\/ \(CASE WHEN pa\.sold_as = 'bundle' AND COALESCE\(pa\.unique_products, 0\) > 1 THEN pa\.unique_products ELSE 1 END\)/);
    expect(poAsinRowsSql("TRUE")).toContain(derivedFromLines("qty_returned"));
    // The ASINs-page pipeline aggregates the lines once (performance, 2026-10-18) with the same rule:
    // Σ(qty × yield) ÷ unique products for a bundle, NULL when any line is untracked.
    expect(PIPELINE_ROWS_SQL).toContain("SUM(l.qty_canceled * COALESCE(l.asin_qty_per_product, 1))");
    expect(PIPELINE_ROWS_SQL).toContain("(CASE WHEN pa.sold_as = 'bundle' AND COALESCE(pa.unique_products, 0) > 1 THEN pa.unique_products ELSE 1 END)");
  });
});
