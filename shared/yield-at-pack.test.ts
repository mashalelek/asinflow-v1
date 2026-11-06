import { describe, it, expect } from "vitest";
import { retailerUnitsAtPack } from "./yield";

// A stored 2-dp yield read at a known pack (Maria 2026-11-06): |y − r ÷ pack| ≤ 0.005.
describe("retailerUnitsAtPack", () => {
  it("0.33 / 0.67 / 0.17 / 0.13 are 1/3, 2/3, 1/6, 1/8; whole yields; anything else is no fit", () => {
    expect([retailerUnitsAtPack("0.33", 3), retailerUnitsAtPack("0.67", 3), retailerUnitsAtPack("0.17", 6), retailerUnitsAtPack("0.13", 8)]).toEqual([1, 2, 1, 1]);
    expect(retailerUnitsAtPack("2", 1)).toBe(2);
    expect(retailerUnitsAtPack("0.50", 2)).toBe(1);
    expect(retailerUnitsAtPack("0.50", 3)).toBeNull();
    expect(retailerUnitsAtPack("0.33", 1)).toBeNull();
    expect(retailerUnitsAtPack(null, 3)).toBeNull();
  });
});
