import { describe, it, expect } from "vitest";
import { emptyProduct, checkPoForm, emptyPoForm, type PoFormProduct } from "./po-form";
import { groupLines, ensureLineIds, lineQty, slotUnits, setSlotUnits, resetSlotYield, addAsinRow, addProductToBundle, removeAsinRow, removeLine, isFractional, FRACTIONAL_UNITS_NOTE } from "./po-lines";

// Maria's whiteboard (2026-11-01): three shapes — one product → two ASINs, two products → one ASIN (bundle), one product → one ASIN.
const row = (over: Partial<PoFormProduct>): PoFormProduct => ({ ...emptyProduct(), product_name: "Pens 12ct", supplier_sku: "123", price: "5.44", qty_ordered: "12", asin: "B0TEST0001", line_id: "a", ...over });

describe("line layout", () => {
  it("ensureLineIds gives every row a line_id without touching the ones it has", () => {
    const out = ensureLineIds([row({ line_id: undefined }), row({ line_id: "keep" }), row({ line_id: undefined })]);
    expect(out.map((p) => p.line_id)).toEqual(["l0", "keep", "l2"]);
    expect(ensureLineIds(out)).toBe(out);
  });
  it("groups a plain line, a split (one product → two ASINs) and a bundle (two products → one ASIN)", () => {
    const products = [
      row({ line_id: "a" }),
      row({ line_id: "b", asin: "B0TEST0002", qty_ordered: "8" }), row({ line_id: "b", asin: "B0TEST0003", qty_ordered: "4" }),
      row({ line_id: "c", bundle_id: "c", product_name: "Cups", sold_as: "bundle", units_per_pack: "2", asin_qty_per_product: "0.5", asin: "B0BUNDLE01" }), row({ line_id: "d", bundle_id: "c", product_name: "Lids", sold_as: "bundle", units_per_pack: "2", asin_qty_per_product: "0.5", asin: "B0BUNDLE01" }),
    ];
    const boxes = groupLines(products);
    expect(boxes.map((b) => [b.key, b.bundle, b.lines.length, b.slots])).toEqual([
      ["a", false, 1, [[0]]],
      ["b", false, 1, [[1], [2]]],
      ["c", true, 2, [[3, 4]]],
    ]);
    expect(lineQty(products, boxes[1].lines[0].copies)).toBe(12);
    expect(slotUnits(products, boxes[1].slots[0], false)).toBe(8);
    expect(slotUnits(products, boxes[2].slots[0], true)).toBe(6); // 12 × 0.5 per member → 6 sets
    expect(checkPoForm({ ...emptyPoForm("2026-11-01"), supplier: "walmart.com", order_id: "zz-1", products }).asins.map((a) => [a.asin, a.qty])).toEqual([["B0TEST0001", 12], ["B0TEST0002", 8], ["B0TEST0003", 4], ["B0BUNDLE01", 6]]);
  });
  it("typing the ASIN qty: one ASIN row pins the yield; a split sets that row's share; reset returns to the pack math", () => {
    const single = [row({ retailer_units_per_pack: "12", asin_qty_per_product: "12" })];
    const b1 = groupLines(single);
    const pinned = setSlotUnits(single, b1[0], 0, "72");
    expect(pinned[0]).toMatchObject({ qty_ordered: "12", asin_qty_per_product: "6", yield_manual: true });
    expect(resetSlotYield(pinned, b1[0].slots[0])[0]).toMatchObject({ asin_qty_per_product: "12", yield_manual: false });
    const split = [row({ line_id: "b", asin: "B0TEST0002", qty_ordered: "8" }), row({ line_id: "b", asin: "B0TEST0003", qty_ordered: "4" })];
    const b2 = groupLines(split);
    expect(setSlotUnits(split, b2[0], 1, "6")[1]).toMatchObject({ qty_ordered: "6", asin_qty_per_product: "1" });
    expect(setSlotUnits(split, b2[0], 1, "")[1].qty_ordered).toBe("");
  });
  it("+ Add ASIN adds a blank row beneath the line (its share and ASIN empty); removing it brings the line back", () => {
    const products = [row({ line_id: "a" }), row({ line_id: "z", product_name: "Other" })];
    const after = addAsinRow(products, groupLines(products)[0]);
    expect(after).toHaveLength(3);
    expect(after[1]).toMatchObject({ line_id: "a", product_name: "Pens 12ct", asin: "", qty_ordered: "", sold_as: "individual" });
    expect(after[2].line_id).toBe("z");
    expect(removeAsinRow(after, groupLines(after)[0], 1)).toEqual(products);
  });
  it("+ Add product to bundle turns a line into a bundle box with a new member; removing a member of a two-member bundle leaves a plain line", () => {
    const products = [row({ line_id: "a", units_per_pack: "1" })];
    const bundled = addProductToBundle(products, groupLines(products)[0]);
    expect(bundled).toHaveLength(2);
    expect(bundled[0]).toMatchObject({ line_id: "a", bundle_id: "a", sold_as: "bundle", units_per_pack: "2", asin: "B0TEST0001" });
    expect(bundled[1]).toMatchObject({ bundle_id: "a", sold_as: "bundle", units_per_pack: "2", asin: "B0TEST0001", product_name: "", qty_ordered: "" });
    const boxes = groupLines(bundled);
    expect(boxes).toHaveLength(1);
    expect(boxes[0]).toMatchObject({ bundle: true, slots: [[0, 1]] });
    const back = removeLine(bundled, boxes[0], bundled[1].line_id!);
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({ line_id: "a", sold_as: "individual", units_per_pack: "1" });
    expect(back[0].bundle_id).toBeUndefined();
  });
  it("a fractional ASIN qty is flagged (red + the note), never silently", () => {
    expect(isFractional(7.5)).toBe(true);
    expect(isFractional(8)).toBe(false);
    expect(isFractional(0)).toBe(false);
    expect(FRACTIONAL_UNITS_NOTE).toBe("check qty or pack size");
  });
});
