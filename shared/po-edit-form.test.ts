import { describe, it, expect } from "vitest";
import { poToForm, planPoEdit, editBlockingErrors, storedAsinCosts, canonField, type StoredPo } from "./po-edit-form";
import { groupLines, addAsinRow } from "./po-lines";
import type { PoFormState } from "./po-form";

// Edit PO as a page (Maria 2026-11-04): the stored PO → the New PO form, and the edited form → the editor calls.
const stored = (over: Partial<StoredPo["po"]> = {}): StoredPo => ({
  po: { id: "p1", supplier: "walmart.com", order_id: "200015336732726", order_date: new Date(2026, 9, 28), subtotal: "40.00", tax: "2.40", sh_donations: "0.00", discount: "0.00", refund_amount: "0.00", order_total: "42.40",
    weighted_gc_discount_pct: null, cashback_site: "Rakuten", cashback_pct: "5.0000", purchased_by: "Maria", purchased_by_user_id: 1, notes: null, ships_to: "velocity", email_used: "orders@example.com", cashback_status: null, subscription: false, cost_formula_version: null, ...over },
  asins: [
    { id: "a1", asin: "B0TEST0001", sold_as: "multi-pack", units_per_pack: 2, prep_cost: "1.00", cost_per_unit: "7.77", sourcing_cost: "6.66", paid_cost: "5.55", cogs_adjustment: null, cogs_adjustment_reason: null,
      lines: [{ id: "l1", product_name: "Tea 12ct", supplier_sku: "123", price: "10.00", qty_ordered: "2", retailer_units_per_product: 12, asin_units_per_pack: 2, asin_qty_per_product: "6", notes: null }] },
    { id: "a2", asin: "B0TEST0002", sold_as: "individual", units_per_pack: 1, prep_cost: "1.00", cost_per_unit: "4.10", sourcing_cost: null, paid_cost: null, cogs_adjustment: "0.50", cogs_adjustment_reason: "labels",
      // An unresolved sheet import (NULL integers, migration 080): the stored decimal yield is kept as a typed one.
      lines: [{ id: "l2", product_name: "Soap", supplier_sku: null, price: null, qty_ordered: "3", retailer_units_per_product: null, asin_units_per_pack: null, asin_qty_per_product: "0.33", notes: "dented" }] },
  ],
  payments: [{ id: 11, method: "card", nickname: "Amex Gold", last4: "1005", amount: "42.40", gift_card_discount_pct: null }],
  promos: [{ id: 21, type: "rewards", description: "Walmart cash", amount: "2.00", percent: null, counts_toward_cogs: false }],
});
const clone = (f: PoFormState): PoFormState => JSON.parse(JSON.stringify(f));

describe("a pack not known (2026-11-06)", () => {
  const nullPack = (): StoredPo => { const d = stored(); d.asins[1] = { ...d.asins[1], sold_as: null, units_per_pack: null }; return d; };
  it("NULL sold_as becomes \"\" (never individual), units / pack empty, the stored yield kept on a pack choice", () => {
    const f = poToForm(nullPack());
    expect(f.products[1]).toMatchObject({ sold_as: "", units_per_pack: "", pack_keep_yield: true });
  });
  it("choosing individual is a change: the ASIN row is sent sold_as individual ×1", () => {
    const s = poToForm(nullPack()), n = clone(s);
    n.products[1].sold_as = "individual"; n.products[1].units_per_pack = "1";
    const plan = planPoEdit(s, n, { imported: true });
    expect(plan.asinEdits).toEqual([{ asin: "B0TEST0002", isNew: false, body: { sold_as: "individual", units_per_pack: "1" } }]);
  });
  it("left unknown, nothing is sent", () => {
    const s = poToForm(nullPack());
    expect(planPoEdit(s, clone(s), { imported: true }).asinEdits).toEqual([]);
  });
});

describe("poToForm — the stored PO as the form", () => {
  it("header, lines with their ids, the yield from the two integers, a NULL-integer line as a typed yield; promos / payments keep their ids", () => {
    const f = poToForm(stored());
    expect(f).toMatchObject({ supplier: "walmart.com", order_id: "200015336732726", order_date: "2026-10-28", subtotal: "40.00", order_total: "42.40", cashback_pct: "5", purchased_by_user_id: "1", ships_to: "velocity" });
    expect(f.products.map((p) => [p.line_item_id, p.asin, p.retailer_units_per_pack, p.asin_qty_per_product, !!p.yield_manual])).toEqual([["l1", "B0TEST0001", "12", "6", false], ["l2", "B0TEST0002", "1", "0.33", true]]);
    expect(f.products[1]).toMatchObject({ price: "", notes: "dented", sold_as: "individual", units_per_pack: "1" });
    expect(f.promos).toEqual([{ id: 21, type: "rewards", description: "Walmart cash", amount: "2.00", percent: "", counts_toward_cogs: false, in_line_prices: null }]);
    expect(f.payments).toEqual([{ id: 11, method: "card", nickname: "Amex Gold", last4: "1005", amount: "42.40", gift_card_discount_pct: "", reward_pct: "" }]);
    expect(f.cogs_adjustments).toEqual({ B0TEST0002: { amount: "0.50", reason: "labels" } });
  });
  it("an imported PO shows its stored COGS as the field's value; a v2 PO only where it differs from the formula (a typed one)", () => {
    expect(poToForm(stored()).cost_overrides).toEqual({ B0TEST0001: "7.77", B0TEST0002: "4.10" });
    const v2 = stored({ cost_formula_version: 2 });
    const formula = poToForm({ ...v2, asins: v2.asins.map((a) => ({ ...a, cost_per_unit: null })) });
    expect(formula.cost_overrides).toEqual({});
    expect(storedAsinCosts(stored()).B0TEST0001).toEqual({ sourcing_cost: "6.66", cost_per_unit: "7.77", paid_cost: "5.55" });
  });
  it("a bundle's lines share one box; a line whose integers the row's pack cannot reproduce keeps its yield as typed", () => {
    const d = stored();
    d.asins = [{ id: "b1", asin: "B0BUNDLE01", sold_as: "bundle", units_per_pack: 2, prep_cost: "1.00", cost_per_unit: null, lines: [
      { id: "m1", product_name: "A", price: "1.00", qty_ordered: "4", retailer_units_per_product: 1, asin_units_per_pack: 1 },
      { id: "m2", product_name: "B", price: "1.00", qty_ordered: "4", retailer_units_per_product: 1, asin_units_per_pack: 3 },
    ] }];
    const f = poToForm(d);
    const boxes = groupLines(f.products);
    expect(boxes).toHaveLength(1);
    expect(boxes[0]).toMatchObject({ bundle: true, slots: [[0, 1]] });
    expect(f.products.map((p) => [p.retailer_units_per_pack, p.asin_qty_per_product, !!p.yield_manual])).toEqual([["2", "1", false], ["1", "0.3333", true]]);
  });
});

describe("planPoEdit — the edited form → the editor calls", () => {
  it("an untouched PO plans nothing (open and Save writes no History row)", () => {
    const f = poToForm(stored());
    expect(planPoEdit(f, clone(f), { imported: true })).toMatchObject({ empty: true, errors: [] });
    const v2 = poToForm(stored({ cost_formula_version: 2 }));
    expect(planPoEdit(v2, clone(v2), { imported: false }).empty).toBe(true);
  });
  it("only the changed fields are sent: header, a line's price, a removed payment, a new promo; costs untouched", () => {
    const s = poToForm(stored()), n = clone(s);
    n.notes = "dented box"; n.cashback_pct = "5.00"; n.products[0].price = "9.50"; n.payments = []; n.promos!.push({ type: "coupon", description: "SAVE5", amount: "5", percent: "", counts_toward_cogs: true });
    const plan = planPoEdit(s, n, { imported: true });
    expect(plan.header).toEqual({ notes: "dented box" }); // 5 and 5.00 are the same percentage
    expect(plan.lineEdits).toEqual([{ id: "l1", body: { price: "9.50" } }]);
    expect(plan.asinEdits).toEqual([]);
    expect(plan.paymentRemoves).toEqual([11]);
    expect(plan.promoAdds).toEqual([{ type: "coupon", description: "SAVE5", amount: "5", percent: "", counts_toward_cogs: true, in_line_prices: "" }]);
    expect(plan.promoEdits).toEqual([]);
  });
  it("a pack change re-sends each of the ASIN's lines' two integers and the row's units / pack; Update ASIN in AF is planned", () => {
    const s = poToForm(stored()), n = clone(s);
    n.products[0].units_per_pack = "3"; n.products[0].asin_qty_per_product = "4"; n.pack_updates = { B0TEST0001: true };
    const plan = planPoEdit(s, n, { imported: true });
    expect(plan.lineEdits).toEqual([{ id: "l1", body: { retailer_units_per_product: 12, asin_units_per_pack: 3 } }]);
    expect(plan.asinEdits).toEqual([{ asin: "B0TEST0001", body: { units_per_pack: "3" }, isNew: false }]);
    expect(plan.packUpdates).toEqual([{ asin: "B0TEST0001", sold_as: "multi-pack", units_per_pack: 3 }]);
  });
  it("lines: a new row is an add, a gone row a removal, a re-mapped ASIN an edit; a split's new row never reuses the stored line's id", () => {
    const s = poToForm(stored()), n = clone(s);
    const box = groupLines(n.products)[0];
    n.products = addAsinRow(n.products, box);
    expect(n.products[1].line_item_id).toBeUndefined();
    n.products[1] = { ...n.products[1], asin: "B0TEST0003", qty_ordered: "1", price: "10.00" };
    n.products = n.products.filter((p) => p.line_item_id !== "l2");
    const plan = planPoEdit(s, n, { imported: true });
    expect(plan.lineAdds).toEqual([expect.objectContaining({ asin: "B0TEST0003", qty_ordered: "1" })]);
    expect(plan.lineRemoves).toEqual(["l2"]);
    expect(plan.asinEdits.map((e) => [e.asin, e.isNew])).toEqual([["B0TEST0003", true]]);
    const remap = clone(s); remap.products[1].asin = "B0TEST0009";
    expect(planPoEdit(s, remap, { imported: true }).lineEdits).toEqual([{ id: "l2", body: { asin: "B0TEST0009" } }]);
  });
  it("COGS: written only when its field changed; cleared on an imported PO = blank (never the formula), on a v2 PO = the formula's", () => {
    const s = poToForm(stored()), n = clone(s);
    n.cost_overrides.B0TEST0001 = "8.00"; delete n.cost_overrides.B0TEST0002;
    expect(planPoEdit(s, n, { imported: true }).asinEdits).toEqual([
      { asin: "B0TEST0001", body: { cost_per_unit: "8.00" }, isNew: false },
      { asin: "B0TEST0002", body: { cost_per_unit: "" }, isNew: false },
    ]);
    const v = poToForm(stored({ cost_formula_version: 2 })), vn = clone(v);
    delete vn.cost_overrides.B0TEST0001;
    const e = planPoEdit(v, vn, { imported: false }).asinEdits[0];
    expect(e.asin).toBe("B0TEST0001");
    expect(e.body.cost_per_unit).toMatch(/^\d+\.\d{2}$/);
  });
});

describe("editBlockingErrors — only a problem the stored PO does not already have blocks Save", () => {
  it("an imported line with no price saves a change elsewhere; a new line with no price blocks", () => {
    const s = poToForm(stored()), n = clone(s);
    n.notes = "x";
    expect(editBlockingErrors(s, n).errors).toEqual([]);
    n.products[0].price = "";
    expect(editBlockingErrors(s, n).errors).toEqual([expect.stringMatching(/^B0TEST0001: price must be an amount ≥ 0/)]);
    n.order_id = "";
    expect(editBlockingErrors(s, n).errors[0]).toBe("Order # is required");
  });
  it("\"Which promos are already in the prices?\" blocks Save even when the stored PO already had it; the answers are saved per promo (Maria 2026-11-06)", () => {
    // Lines 20.00 vs subtotal 40.00: two $20 promos, either could be the one in the prices.
    const amb = stored({ discount: "40.00", order_total: "2.40" });
    amb.promos = [{ id: 21, type: "sale", description: "A", amount: "20.00", percent: null, counts_toward_cogs: true, in_line_prices: null }, { id: 22, type: "coupon", description: "B", amount: "20.00", percent: null, counts_toward_cogs: true, in_line_prices: null }];
    const s = poToForm(amb), n = clone(s);
    expect(s.promos!.map((p) => p.in_line_prices)).toEqual([null, null]);
    n.notes = "x";
    expect(editBlockingErrors(s, n).errors).toEqual([expect.stringMatching(/^Which promos are already in the prices\?/)]);
    n.promos![0].in_line_prices = true; n.promos![1].in_line_prices = false;
    expect(editBlockingErrors(s, n).errors).toEqual([]);
    expect(planPoEdit(s, n, { imported: false }).promoEdits).toEqual([{ id: 21, body: { in_line_prices: true } }, { id: 22, body: { in_line_prices: false } }]);
    const back = clone(n); back.promos![0].in_line_prices = null;
    expect(planPoEdit(n, back, { imported: false }).promoEdits).toEqual([{ id: 21, body: { in_line_prices: "" } }]);
  });
  it("canonField: money and percentages compare as numbers, text as trimmed text", () => {
    expect(canonField("subtotal", "$1,234.50")).toBe("1234.5");
    expect(canonField("cashback_pct", "5.0000")).toBe("5");
    expect(canonField("notes", " a ")).toBe("a");
  });
});
