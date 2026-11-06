import { describe, expect, it } from "vitest";
import { yieldMismatchNote } from "./yield-mismatch";

const line = (y: number | null, r: number | null = null, p: number | null = null) => ({ asin_qty_per_product: y, retailer_units_per_product: r, asin_units_per_pack: p });

describe("yieldMismatchNote", () => {
  it("flags a stored yield that fits no whole number of retailer units at the pack", () => {
    expect(yieldMismatchNote(line(0.5), "individual", null)).toBe("stored 0.50, ×1 gives 1.00");
    expect(yieldMismatchNote(line(0.25), "multi-pack", 2)).toBe("stored 0.25, ×2 gives 0.50");
    expect(yieldMismatchNote(line(1.4), "multi-pack", 2)).toBe("stored 1.40, ×2 gives 1.50");
  });
  it("leaves a sheet rounding of an exact ratio alone (0.33 at ×3, 0.17 at ×6, 2 at ×1)", () => {
    expect(yieldMismatchNote(line(0.33), "multi-pack", 3)).toBeNull();
    expect(yieldMismatchNote(line(0.17), "multi-pack", 6)).toBeNull();
    expect(yieldMismatchNote(line(2), "individual", null)).toBeNull();
  });
  it("a multi-pack with no pack size says so", () => {
    expect(yieldMismatchNote(line(0.25), "multi-pack", null)).toBe("stored 0.25, multi-pack has no pack size");
  });
  it("skips lines with pack integers, bundles, unknown packs and no stored yield", () => {
    expect(yieldMismatchNote(line(0.5, 1, 2), "individual", null)).toBeNull();
    expect(yieldMismatchNote(line(0.5), "bundle", 2)).toBeNull();
    expect(yieldMismatchNote(line(0.5), null, null)).toBeNull();
    expect(yieldMismatchNote(line(null), "individual", null)).toBeNull();
  });
});
