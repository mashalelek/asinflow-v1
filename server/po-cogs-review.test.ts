import { describe, it, expect } from "vitest";
import { sheetCogsForAsin, differs, isAnswered, type SheetProductRow } from "./po-cogs-review";

const row = (p: Partial<SheetProductRow>): SheetProductRow => ({ productName: "x", status: "Ordered", price: null, qtyOrdered: 1, asinQty: 1, uniqueProducts: null, yieldPerProduct: 1, adjProductCost: null, adjCogs: null, soldAs: "", unitsPerPack: "", ...p });

describe("sheetCogsForAsin — the sheet's PO-level COGS the way AF computes it (Maria 2026-11-01)", () => {
  it("single row: Σ(X × L) ÷ N; sheet Y verbatim", () => {
    expect(sheetCogsForAsin([row({ qtyOrdered: 4, asinQty: 8, adjProductCost: 5, adjCogs: 2.5 })])).toEqual({ mode: "single", asinQty: 8, computed: 2.5, sheetY: 2.5, productSum: 20 });
  });
  it("S=1 merge: N summed, product costs summed, sheet Y N-weighted when rows differ", () => {
    const r = sheetCogsForAsin([row({ qtyOrdered: 2, asinQty: 2, adjProductCost: 10, adjCogs: 10 }), row({ qtyOrdered: 1, asinQty: 1, adjProductCost: 7, adjCogs: 7 })]);
    expect(r).toEqual({ mode: "s1-merge", asinQty: 3, computed: 9, sheetY: 9, productSum: 27 });
  });
  it("bundle (S ≥ 2 on every row): the component rows sum over the bundle's N", () => {
    const r = sheetCogsForAsin([row({ uniqueProducts: 2, qtyOrdered: 3, asinQty: 3, adjProductCost: 4, adjCogs: 9 }), row({ uniqueProducts: 2, qtyOrdered: 3, asinQty: 3, adjProductCost: 5, adjCogs: 9 })]);
    expect(r).toEqual({ mode: "bundle", asinQty: 3, computed: 9, sheetY: 9, productSum: 27 });
  });
  it("mixed S values cannot be computed; a missing X leaves computed null", () => {
    expect(sheetCogsForAsin([row({ uniqueProducts: 2 }), row({ uniqueProducts: 1 })]).mode).toBe("mixed");
    expect(sheetCogsForAsin([row({ adjProductCost: null, adjCogs: 3 })]).computed).toBeNull();
  });
  it("differs is null-safe with a 2¢ tolerance; answered rows match by order # or ASIN", () => {
    expect(differs(5, 5.02)).toBe(false); expect(differs(5, 5.03)).toBe(true); expect(differs(null, 5)).toBe(true);
    expect(isAnswered("71160468", "B000000000")).toBe(true); expect(isAnswered("X-1", "b07k889yz7")).toBe(true); expect(isAnswered("2000155-50741831", "B0")).toBe(true); expect(isAnswered("1", "B0")).toBe(false);
  });
});
