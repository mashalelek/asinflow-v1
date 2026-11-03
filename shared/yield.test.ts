import { describe, it, expect } from "vitest";
import { asinUnitsFromLines, effectiveYield, fracToNumber, lineRatio, lineUnitsExact, ratioForUnits, ratioFromStoredYield, ratioYield, reduceRatio } from "./yield";
import { trueYield } from "./po-form";

// Exact line yield (migration 080, Maria 2026-11-02): two integers per line, Ordered summed exactly and rounded once.
describe("shared/yield", () => {
  it("lineRatio reads the two integers (≥ 1), else null; ratioYield is the derived 4-dp yield", () => {
    expect(lineRatio({ retailer_units_per_product: 1, asin_units_per_pack: 15 })).toEqual({ retailer: 1, asinUnits: 15 });
    expect(lineRatio({ retailer_units_per_product: "9", asin_units_per_pack: "1" })).toEqual({ retailer: 9, asinUnits: 1 });
    expect(lineRatio({ retailer_units_per_product: null, asin_units_per_pack: 2 })).toBeNull();
    expect(lineRatio({ retailer_units_per_product: 0, asin_units_per_pack: 2 })).toBeNull();
    expect(lineRatio({})).toBeNull();
    expect(ratioYield({ retailer: 1, asinUnits: 15 })).toBe("0.0667");
    expect(ratioYield({ retailer: 1, asinUnits: 2 })).toBe("0.5");
    expect(ratioYield({ retailer: 12, asinUnits: 1 })).toBe("12");
    expect(reduceRatio(1600, 4800)).toEqual({ retailer: 1, asinUnits: 3 });
  });
  it("walmart 200014971489745 B071G486Q7: 30 × 1/15 = 2 exactly (the stored 0.07 made 2.1); the legacy 2-dp path still reads trueYield", () => {
    expect(asinUnitsFromLines([{ qty_ordered: 30, retailer_units_per_product: 1, asin_units_per_pack: 15 }], "individual")).toEqual({ qty: 2, uniqueProducts: null });
    expect(asinUnitsFromLines([{ qty_ordered: 30, asin_qty_per_product: "0.07" }], "individual", trueYield).qty).toBe(2.1); // the stored 2-dp yield (trueYield snaps denominators ≤ 12 only) — the reason for the ratio
    expect(asinUnitsFromLines([{ qty_ordered: 48, asin_qty_per_product: "0.33" }], "individual", trueYield).qty).toBe(16);
    expect(effectiveYield({ retailer_units_per_product: 1, asin_units_per_pack: 15, asin_qty_per_product: "0.07" })).toBeCloseTo(1 / 15, 12);
    expect(effectiveYield({ asin_qty_per_product: "0.33" }, trueYield)).toBeCloseTo(1 / 3, 12);
  });
  it("sums exactly and rounds once: three lines of 1/3 → 1.00, 10 × 1/3 → 3.33, a mix of ratio and legacy lines adds up; a bundle takes the scarcest component", () => {
    const third = { retailer_units_per_product: 1, asin_units_per_pack: 3 };
    expect(asinUnitsFromLines([{ qty_ordered: 1, ...third }, { qty_ordered: 1, ...third }, { qty_ordered: 1, ...third }], "multi-pack").qty).toBe(1);
    expect(asinUnitsFromLines([{ qty_ordered: 10, ...third }], "multi-pack").qty).toBe(3.33);
    expect(asinUnitsFromLines([{ qty_ordered: 10, retailer_units_per_product: 1, asin_units_per_pack: 2 }, { qty_ordered: 4, asin_qty_per_product: "1" }], "multi-pack", trueYield).qty).toBe(9);
    expect(asinUnitsFromLines([{ qty_ordered: 14, retailer_units_per_product: 1, asin_units_per_pack: 1 }, { qty_ordered: 12, retailer_units_per_product: 1, asin_units_per_pack: 1 }], "bundle")).toEqual({ qty: 12, uniqueProducts: 2 });
    expect(asinUnitsFromLines([{ qty_ordered: 1, retailer_units_per_product: 18, asin_units_per_pack: 1 }, { qty_ordered: 1, retailer_units_per_product: 18, asin_units_per_pack: 1 }], "bundle").qty).toBe(18);
    expect(asinUnitsFromLines([], "bundle")).toEqual({ qty: 0, uniqueProducts: 1 });
    expect(asinUnitsFromLines([{ qty_ordered: "2.50", retailer_units_per_product: 2, asin_units_per_pack: 1 }], "individual").qty).toBe(5);
    expect(fracToNumber(lineUnitsExact(1, { retailer: 2, asinUnits: 3 }))).toBe(0.67);
    expect(fracToNumber({ num: BigInt(5), den: BigInt(1000) }, 2)).toBe(0.01); // half-up
  });
  it("ratioForUnits: a typed unit count keeps the pack size when units × pack ÷ qty is whole, else the reduced fraction units ÷ qty", () => {
    expect(ratioForUnits(50, 100, 2)).toEqual({ retailer: 1, asinUnits: 2 });   // 100 singles → 50 two-packs
    expect(ratioForUnits(2, 30, 15)).toEqual({ retailer: 1, asinUnits: 15 });
    expect(ratioForUnits(2, 12, 1)).toEqual({ retailer: 1, asinUnits: 6 });     // 12 × 1/6 = 2, individual ASIN
    expect(ratioForUnits(7, 3, 1)).toEqual({ retailer: 7, asinUnits: 3 });
    expect(ratioForUnits(16, 48, 1)).toEqual({ retailer: 1, asinUnits: 3 });
    expect(ratioForUnits(2.5, 5, 2)).toEqual({ retailer: 1, asinUnits: 2 });
    expect(ratioForUnits(0, 5, 1)).toBeNull();
    expect(ratioForUnits(5, 0, 1)).toBeNull();
  });
  it("the backfill rule: stored yield × the row's units / pack within 0.02 of a whole number ≥ 1 → that ratio; no pack size, yield 0 or a bad fit → null (a gap)", () => {
    expect(ratioFromStoredYield("0.07", 15)).toEqual({ retailer: 1, asinUnits: 15, fit: "2dp" }); // 1.05: 0.05 off, within the 2-dp bound 0.075
    expect(ratioFromStoredYield("0.33", 3)).toEqual({ retailer: 1, asinUnits: 3, fit: "0.02" });
    expect(ratioFromStoredYield("1.00", 1)).toEqual({ retailer: 1, asinUnits: 1, fit: "0.02" });
    expect(ratioFromStoredYield("0.5", 2)).toEqual({ retailer: 1, asinUnits: 2, fit: "0.02" });
    expect(ratioFromStoredYield("12", 1)).toEqual({ retailer: 12, asinUnits: 1, fit: "0.02" });
    expect(ratioFromStoredYield("0.08", 15)).toBeNull();     // 1.2: 0.2 off, beyond both bounds
    expect(ratioFromStoredYield("0.07", null)).toBeNull();   // the walmart row: no units_per_pack on the ASIN row
    expect(ratioFromStoredYield("0.07", 1)).toBeNull();      // 0.07 is not within 0.02 of a whole number
    expect(ratioFromStoredYield("0", 2)).toBeNull();
    expect(ratioFromStoredYield(null, 2)).toBeNull();
    expect(ratioFromStoredYield("0.17", 6)).toEqual({ retailer: 1, asinUnits: 6, fit: "0.02" }); // 1.02 → 1
    expect(ratioFromStoredYield("0.16", 6)).toBeNull();      // 0.96 → 0.04 off, beyond 0.02 and beyond 0.005 × 6 = 0.03
  });
});
