import { describe, it, expect } from "vitest";
import { bundleFromLines, evenSplit, bundleSplitMessage } from "./bundle";

describe("bundle rule (Maria 2026-11-09): ×N = Individual units in one bundle; per-component counts; min over components; leftovers shown", () => {
  it("walmart 200015415094735 B0GWG5S64Q: 12 balms (singles) + 2 six-packs of oil, ×2 → 12 bundles / 24 individual, cost 5.87 + 31.70 ÷ 6 = 11.15, no leftovers", () => {
    const r = bundleFromLines([
      { qty_ordered: 12, retailer_units_per_product: 1, units_per_bundle: 1, unit_money: 5.87 },
      { qty_ordered: 2, retailer_units_per_product: 6, units_per_bundle: 1, unit_money: 31.7 },
    ], 2);
    expect(r.asinUnits).toBe(12);
    expect(r.individual).toBe(24);
    expect(r.costPreShare).toBe(11.15);
    expect(r.components.map((c) => c.leftover)).toEqual([0, 0]);
    expect(r.sumMatches).toBe(true);
    expect(r.splitKnown).toBe(true);
    expect(r.hasLeftover).toBe(false);
  });
  it("the old model's reading of the same PO (every component ÷ N) gave 6, the sum of component prices 37.57 — the rule gives 12 and 11.15", () => {
    // Documented contrast only: the old model is shared/yield.ts asinUnitsFromLines(..., "bundle").
    const r = bundleFromLines([
      { qty_ordered: 12, retailer_units_per_product: 1, unit_money: 5.87 },
      { qty_ordered: 2, retailer_units_per_product: 6, unit_money: 31.7 },
    ], 2);
    expect(r.asinUnits).toBe(12);
    expect(r.costPreShare).toBe(11.15);
    expect(r.splitKnown).toBe(false);          // the counts were proposed (1 + 1)
    expect(r.components.every((c) => c.proposed)).toBe(true);
  });
  it("a 2:1 bundle (2 of A + 1 of B, ×3): 20 A singles + 10 B singles → 10 bundles / 30 individual; cost = 2 × A + B", () => {
    const r = bundleFromLines([
      { qty_ordered: 20, retailer_units_per_product: 1, units_per_bundle: 2, unit_money: 4 },
      { qty_ordered: 10, retailer_units_per_product: 1, units_per_bundle: 1, unit_money: 7 },
    ], 3);
    expect(r.asinUnits).toBe(10);
    expect(r.individual).toBe(30);
    expect(r.costPreShare).toBe(15);
    expect(r.sumMatches).toBe(true);
    expect(r.hasLeftover).toBe(false);
  });
  it("leftovers: 12 balms + 3 six-packs of oil (18) at 1 + 1 → 12 bundles, 6 oils left over — shown, and the bundle's cost does not carry them", () => {
    const r = bundleFromLines([
      { qty_ordered: 12, retailer_units_per_product: 1, units_per_bundle: 1, unit_money: 5.87 },
      { qty_ordered: 3, retailer_units_per_product: 6, units_per_bundle: 1, unit_money: 31.7 },
    ], 2);
    expect(r.asinUnits).toBe(12);
    expect(r.components[1].individual).toBe(18);
    expect(r.components[1].leftover).toBe(6);
    expect(r.hasLeftover).toBe(true);
    expect(r.costPreShare).toBe(11.15);
  });
  it("a 2:1 bundle with no stored counts cannot take an even split (×3 over 2 components) — proposable false, the counts default to 1 and the sum is flagged", () => {
    const r = bundleFromLines([{ qty_ordered: 20, retailer_units_per_product: 1 }, { qty_ordered: 10, retailer_units_per_product: 1 }], 3);
    expect(evenSplit(3, 2)).toBeNull();
    expect(r.splitProposable).toBe(false);
    expect(r.sumMatches).toBe(false);
    expect(bundleSplitMessage(r, 3)).toBe("the components' units per bundle add up to 2, not ×3");
  });
  it("counts that do not add up to N are flagged; NULL retailer pack reads as 1; NULL N gives individual = ASIN units", () => {
    const r = bundleFromLines([{ qty_ordered: 12, units_per_bundle: 2 }, { qty_ordered: 12, units_per_bundle: 1 }], 2);
    expect(r.sumPerBundle).toBe(3);
    expect(r.sumMatches).toBe(false);
    expect(r.asinUnits).toBe(6);
    expect(bundleFromLines([{ qty_ordered: 5 }, { qty_ordered: 5 }], null).individual).toBe(5);
    expect(bundleFromLines([], 2)).toMatchObject({ asinUnits: 0, costPreShare: null, sumMatches: false });
  });
});
