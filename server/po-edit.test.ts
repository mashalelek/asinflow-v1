import { describe, it, expect } from "vitest";
import {
  parseEdits, changedFields, asLogText, asinQtyFromLines, shipmentBlockMessage, HEADER_FIELDS, LINE_FIELDS, ASIN_FIELDS,
  editPoHeader, removeLine, editAsinRow, EditError, ORDER_ID_WARNING, setUnknownAsinPack, linesAtPack, fillAsinPackGaps,
} from "./po-edit";

// patch docs/claude_spec-patch-po-af-owned.md §3 — AF-owned PO editing.

describe("field parsers", () => {
  it("header: money, dates, required text, percentages; unknown fields refused", () => {
    expect(parseEdits(HEADER_FIELDS, { subtotal: "$1,234.50", order_date: "2026-10-18", supplier: " walmart.com " })).toEqual({ ok: true, edits: { subtotal: "1234.50", order_date: "2026-10-18", supplier: "walmart.com" } });
    expect(parseEdits(HEADER_FIELDS, { order_date: "2026-02-30" })).toMatchObject({ ok: false, error: "order_date is not a real date" });
    expect(parseEdits(HEADER_FIELDS, { supplier: "" })).toMatchObject({ ok: false, error: "supplier is required" });
    expect(parseEdits(HEADER_FIELDS, { tax: "1.234" })).toMatchObject({ ok: false });
    expect(parseEdits(HEADER_FIELDS, { cashback_pct: "101" })).toMatchObject({ ok: false });
    expect(parseEdits(HEADER_FIELDS, { cashback_pct: "" })).toEqual({ ok: true, edits: { cashback_pct: null } });
    expect(parseEdits(HEADER_FIELDS, { status: "Closed" })).toMatchObject({ ok: false, error: expect.stringMatching(/^status is not an editable field/) });
    expect(parseEdits(HEADER_FIELDS, {})).toMatchObject({ ok: false, error: "nothing to update" });
  });
  it("lines and ASIN rows: quantities to 2 decimals, yield > 0, ASIN shape, sold-as enum; derived values are not editable", () => {
    // Exact yield (migration 080): the two integers are editable, the derived asin_qty_per_product is not (never a decimal from a route).
    expect(parseEdits(LINE_FIELDS, { qty_ordered: "12", retailer_units_per_product: "1", asin_units_per_pack: "2", asin: "b0test0001" })).toEqual({ ok: true, edits: { qty_ordered: 12, retailer_units_per_product: 1, asin_units_per_pack: 2, asin: "B0TEST0001" } });
    expect(parseEdits(LINE_FIELDS, { asin_qty_per_product: "0.5" })).toMatchObject({ ok: false });
    expect(parseEdits(LINE_FIELDS, { retailer_units_per_product: "0.5" })).toMatchObject({ ok: false });
    expect(parseEdits(LINE_FIELDS, { asin_units_per_pack: "0" })).toMatchObject({ ok: false });
    // The bundle rule (migration 100): a component's units per bundle — whole, ≥ 1, or null (not known → proposed).
    expect(parseEdits(LINE_FIELDS, { units_per_bundle: "2" })).toEqual({ ok: true, edits: { units_per_bundle: 2 } });
    expect(parseEdits(LINE_FIELDS, { units_per_bundle: null })).toEqual({ ok: true, edits: { units_per_bundle: null } });
    expect(parseEdits(LINE_FIELDS, { units_per_bundle: "0" })).toMatchObject({ ok: false });
    expect(parseEdits(LINE_FIELDS, { units_per_bundle: "1.5" })).toMatchObject({ ok: false });
    expect(parseEdits(LINE_FIELDS, { qty_ordered: "2.5" })).toEqual({ ok: true, edits: { qty_ordered: 2.5 } }); // decimals since migration 062
    expect(parseEdits(LINE_FIELDS, { qty_canceled: "1" })).toMatchObject({ ok: false }); // a claim since migration 101 (D14)
    expect(parseEdits(LINE_FIELDS, { qty_ordered: "2.555" })).toMatchObject({ ok: false });
    expect(parseEdits(LINE_FIELDS, { qty_ordered: "0" })).toMatchObject({ ok: false });
    expect(parseEdits(LINE_FIELDS, { asin: "B0SHORT" })).toMatchObject({ ok: false });
    expect(parseEdits(ASIN_FIELDS, { sold_as: "pack" })).toMatchObject({ ok: false });
    expect(parseEdits(ASIN_FIELDS, { units_per_pack: "0" })).toMatchObject({ ok: false });
    for (const derived of ["qty", "qty_shipped_fba", "qty_received_amazon", "qty_at_prep", "qty_canceled_asin"]) {
      expect(parseEdits(ASIN_FIELDS, { [derived]: "1" })).toMatchObject({ ok: false });
    }
  });
});

describe("change detection and log text", () => {
  it("only fields whose value changes; numbers compared without trailing zeros; dates as YYYY-MM-DD", () => {
    const cur = { subtotal: "12.50", order_date: new Date(2026, 9, 18), notes: null, supplier: "walmart.com" };
    expect(changedFields(cur, { subtotal: "12.5", order_date: "2026-10-18", notes: null, supplier: "target.com" })).toEqual([{ field: "supplier", old: "walmart.com", new: "target.com" }]);
    expect(asLogText(["SHIP", "See Comments"])).toBe("SHIP, See Comments");
    expect(asLogText("0349125937")).toBe("0349125937"); // ISBN-style ASIN keeps its leading zero
    expect(asLogText("0.50")).toBe("0.5");
  });
});

describe("Ordered (po_asins.qty) recomputed from the lines, as the importer derives it", () => {
  it("Σ qty × yield; 2-dp yields restored (48 × 0.33 = 16); a bundle is built as often as its scarcest component", () => {
    expect(asinQtyFromLines([{ qty_ordered: 48, asin_qty_per_product: "0.33" }], "individual")).toEqual({ qty: 16, uniqueProducts: null });
    expect(asinQtyFromLines([{ qty_ordered: 10, asin_qty_per_product: "0.5" }, { qty_ordered: 4, asin_qty_per_product: "1" }], "multi-pack").qty).toBe(9);
    expect(asinQtyFromLines([{ qty_ordered: 12, asin_qty_per_product: "1" }, { qty_ordered: 12, asin_qty_per_product: "1" }], "bundle")).toEqual({ qty: 12, uniqueProducts: 2 });
    expect(asinQtyFromLines([{ qty_ordered: 1, asin_qty_per_product: "18" }, { qty_ordered: 1, asin_qty_per_product: "18" }, { qty_ordered: 1, asin_qty_per_product: "18" }], "bundle")).toEqual({ qty: 18, uniqueProducts: 3 }); // B019YPFEKM
    expect(asinQtyFromLines([{ qty_ordered: 14, asin_qty_per_product: "1" }, { qty_ordered: 12, asin_qty_per_product: "1" }], "bundle").qty).toBe(12);
  });
  it("the bundle rule (Maria 2026-11-09): walmart 200015415094735 — 12 balms (×1) + 2 six-packs (×6) at ×2, 1 + 1 → 12 bundles; a 2:1 bundle; a leftover; the old encoding read as the real pack would double", () => {
    const walmart = [{ qty_ordered: "12.00", retailer_units_per_product: 1, asin_units_per_pack: 2, units_per_bundle: 1 }, { qty_ordered: "2.00", retailer_units_per_product: 6, asin_units_per_pack: 2, units_per_bundle: 1 }];
    expect(asinQtyFromLines(walmart, "bundle", 2)).toEqual({ qty: 12, uniqueProducts: 2 });
    // Without the per-bundle counts the even split is proposed (1 + 1) — same answer.
    expect(asinQtyFromLines(walmart.map(({ units_per_bundle: _u, ...l }) => l), "bundle", 2).qty).toBe(12);
    // 2 of A + 1 of B (×3): 20 A + 10 B → 10 bundles.
    expect(asinQtyFromLines([{ qty_ordered: 20, retailer_units_per_product: 1, units_per_bundle: 2 }, { qty_ordered: 10, retailer_units_per_product: 1, units_per_bundle: 1 }], "bundle", 3).qty).toBe(10);
    // Leftover: 12 balms + 3 six-packs → 12 bundles (6 oils left over, shown by the UI).
    expect(asinQtyFromLines([{ qty_ordered: 12, retailer_units_per_product: 1 }, { qty_ordered: 3, retailer_units_per_product: 6 }], "bundle", 2).qty).toBe(12);
    // The migration-080 model's reading of the same PO: every component ÷ N → 6 (the bug); the rule never divides a component by N.
    expect(asinQtyFromLines(walmart, "bundle", 2).qty).not.toBe(6);
  });
});

describe("§5.1 block message", () => {
  it("names the units and FBA ids", () => {
    expect(shipmentBlockMessage({ units: 9, fbaIds: ["FBA19A2B3C", "FBA19A2B3D"] })).toBe("9 Individual units shipped to FBA in FBA19A2B3C, FBA19A2B3D. Reassign the shipment to another PO first.");
    expect(shipmentBlockMessage({ units: 1, fbaIds: [] })).toBe("1 Individual unit shipped to FBA in a shipment with no FBA id yet. Reassign the shipment to another PO first.");
  });
});

// A scripted query: returns canned rows by SQL pattern, records every call.
function fakeQuery(script: Array<[RegExp, any[] | ((p: any[]) => any[])]>) {
  const calls: Array<{ sql: string; params: any[] }> = [];
  const q = async (sql: string, params: any[] = []) => {
    calls.push({ sql, params });
    for (const [re, rows] of script) if (re.test(sql)) { const r = typeof rows === "function" ? rows(params) : rows; return { rows: r, rowCount: r.length }; }
    return { rows: [], rowCount: 0 };
  };
  return { q, calls };
}
const autoCloseRows: Array<[RegExp, any[]]> = [
  [/SELECT p\.closed_at, p\.closed_by, ARRAY/, [{ closed_at: null, closed_by: null, action_items: [] }]],
];

describe("editPoHeader", () => {
  it("writes and logs only changed fields, refuses a duplicate (supplier, order #), warns on an order # change", async () => {
    const po = { id: "po1", supplier: "walmart.com", order_id: "111", subtotal: "10.00", notes: null };
    const ok = fakeQuery([[/SELECT \* FROM purchase_orders WHERE id/, [po]], [/SELECT id FROM purchase_orders WHERE supplier = \$1 AND order_id = \$2 AND id <> \$3/, []], ...autoCloseRows]);
    const r = await editPoHeader(ok.q, "po1", { subtotal: "10", notes: "box dented", order_id: "111_1" }, 7);
    expect(r.changes.map((c) => c.field)).toEqual(["notes", "order_id"]);
    expect(r.warning).toBe(ORDER_ID_WARNING);
    const upd = ok.calls.find((c) => /^UPDATE purchase_orders SET notes = \$2, order_id = \$3/.test(c.sql))!;
    expect(upd.params).toEqual(["po1", "box dented", "111_1"]);
    const logs = ok.calls.filter((c) => /INSERT INTO po_edit_log/.test(c.sql)).map((c) => c.params);
    expect(logs).toEqual([["po1", 7, "po", "po1", "notes", null, "box dented"], ["po1", 7, "po", "po1", "order_id", "111", "111_1"]]);

    const dup = fakeQuery([[/SELECT \* FROM purchase_orders WHERE id/, [po]], [/SELECT id FROM purchase_orders WHERE supplier = \$1 AND order_id = \$2 AND id <> \$3/, [{ id: "po2" }]]]);
    await expect(editPoHeader(dup.q, "po1", { order_id: "222" }, 7)).rejects.toMatchObject({ status: 409 });
    expect(dup.calls.some((c) => /^UPDATE/.test(c.sql))).toBe(false);

    const none = fakeQuery([[/SELECT \* FROM purchase_orders WHERE id/, [po]], ...autoCloseRows]);
    const r2 = await editPoHeader(none.q, "po1", { subtotal: "10.00" }, 7);
    expect(r2.changes).toEqual([]);
    expect(none.calls.some((c) => /^UPDATE|INSERT INTO po_edit_log/.test(c.sql))).toBe(false);
  });
});

describe("removeLine", () => {
  it("removing a product of an ASIN row with an FBA shipment is blocked (§5.1) — nothing deleted", async () => {
    const f = fakeQuery([
      [/FROM po_line_items l LEFT JOIN po_asins pa/, [{ id: "l1", po_id: "po1", po_asin_id: "pa1", asin: "B0TEST0001", product_name: "Thing", qty_ordered: 9 }]],
      [/SELECT s\.qty_shipped, s\.fba_shipment_ids FROM po_asin_shipments/, [{ qty_shipped: "9.00", fba_shipment_ids: ["FBA19A2B3C"] }]],
    ]);
    const err = await removeLine(f.q, "l1", 7).catch((e) => e);
    expect(err).toBeInstanceOf(EditError);
    expect(err.status).toBe(409);
    expect(err.message).toBe("B0TEST0001: 9 Individual units shipped to FBA in FBA19A2B3C. Reassign the shipment to another PO first.");
    expect(f.calls.some((c) => /^DELETE/.test(c.sql))).toBe(false);
  });
});

describe("editAsinRow", () => {
  it("an individual ASIN keeps 1 unit/pack; switching to individual resets it", async () => {
    const cur = { id: "pa1", po_id: "po1", sold_as: "individual", units_per_pack: 1, cost_per_unit: "4.00" };
    const f = fakeQuery([[/SELECT \* FROM po_asins WHERE id/, [cur]], ...autoCloseRows]);
    await expect(editAsinRow(f.q, "pa1", { units_per_pack: "2" }, 7)).rejects.toMatchObject({ status: 400 });
    const g = fakeQuery([[/SELECT \* FROM po_asins WHERE id/, [{ ...cur, sold_as: "multi-pack", units_per_pack: 2 }]], [/SELECT id, po_id, qty, sold_as/, []], ...autoCloseRows]);
    const r = await editAsinRow(g.q, "pa1", { sold_as: "individual", cost_per_unit: "4.25" }, 7);
    expect(r.changes.map((c) => `${c.field}:${c.old}->${c.new}`)).toEqual(["sold_as:multi-pack->individual", "cost_per_unit:4->4.25", "units_per_pack:2->1"]);
  });
});

describe("editAsinRow — a pack not known (2026-11-06)", () => {
  const unknown = { id: "pa1", po_id: "po1", sold_as: null, units_per_pack: null, cost_per_unit: "4.00" };
  it("choosing individual writes sold_as and ×1 with History; the line's yield and integers stay (1/1 stays 1/1)", async () => {
    const f = fakeQuery([[/SELECT \* FROM po_asins WHERE id/, [unknown]], [/SELECT id, retailer_units_per_product, asin_units_per_pack, asin_qty_per_product FROM po_line_items/, [{ id: "l1", retailer_units_per_product: 1, asin_units_per_pack: 1 }]], [/SELECT id, po_id, qty, sold_as/, []], ...autoCloseRows]);
    const r = await editAsinRow(f.q, "pa1", { sold_as: "individual" }, 7);
    expect(r.changes.map((c) => `${c.field}:${c.old}->${c.new}`)).toEqual(["sold_as:null->individual", "units_per_pack:null->1"]);
    expect(f.calls.some((c) => /^UPDATE po_line_items SET retailer_units_per_product/.test(c.sql))).toBe(false);
  });
  it("choosing multi-pack ×2 keeps the stored yield: a 2/1 line becomes 4/2, logged on the line", async () => {
    const f = fakeQuery([[/SELECT \* FROM po_asins WHERE id/, [unknown]], [/SELECT id, retailer_units_per_product, asin_units_per_pack, asin_qty_per_product FROM po_line_items/, [{ id: "l1", retailer_units_per_product: 2, asin_units_per_pack: 1 }]], [/SELECT id, po_id, qty, sold_as/, []], ...autoCloseRows]);
    await editAsinRow(f.q, "pa1", { sold_as: "multi-pack", units_per_pack: "2" }, 7);
    const upd = f.calls.find((c) => /^UPDATE po_line_items SET retailer_units_per_product/.test(c.sql));
    expect(upd?.params).toEqual(["l1", 4, 2]);
  });
  it("a line with no integers whose stored 0.33 is a rounding of 1 ÷ 3 takes 1/3 exactly when ×3 is set — also on a row whose pack was known (Michaels 9800109062072825)", async () => {
    const f = fakeQuery([[/SELECT \* FROM po_asins WHERE id/, [{ ...unknown, sold_as: "multi-pack", units_per_pack: 2 }]], [/SELECT id, retailer_units_per_product, asin_units_per_pack, asin_qty_per_product FROM po_line_items/, [{ id: "l1", retailer_units_per_product: null, asin_units_per_pack: null, asin_qty_per_product: "0.33" }]], [/SELECT id, po_id, qty, sold_as/, []], ...autoCloseRows]);
    await editAsinRow(f.q, "pa1", { units_per_pack: "3" }, 7);
    expect(f.calls.find((c) => /^UPDATE po_line_items SET retailer_units_per_product/.test(c.sql))?.params).toEqual(["l1", 1, 3]);
  });
  it("multi-pack without units (or ×1) is refused; nothing written", async () => {
    const f = fakeQuery([[/SELECT \* FROM po_asins WHERE id/, [unknown]], ...autoCloseRows]);
    await expect(editAsinRow(f.q, "pa1", { sold_as: "multi-pack" }, 7)).rejects.toMatchObject({ status: 400, message: "a multi-pack needs Individual units per ASIN unit (2 or more)" });
    expect(f.calls.some((c) => /^UPDATE/.test(c.sql))).toBe(false);
  });
});

describe("setUnknownAsinPack — an ASIN with no pack on record (Maria 2026-11-06)", () => {
  it("linesAtPack: a line's own ratio is kept, a 2-dp stored yield within 0.005 of r ÷ pack gives r, else null", () => {
    expect(linesAtPack([{ qty_ordered: "60", retailer_units_per_product: null, asin_units_per_pack: null, asin_qty_per_product: "0.33" }], 3)).toMatchObject({ units: 20, lines: [{ retailer: 1 }] });
    expect(linesAtPack([{ qty_ordered: "10", retailer_units_per_product: 2, asin_units_per_pack: 1, asin_qty_per_product: "2" }], 2)).toMatchObject({ units: 20, lines: [{ retailer: 4 }] });
    expect(linesAtPack([{ qty_ordered: "10", retailer_units_per_product: null, asin_units_per_pack: null, asin_qty_per_product: "0.40" }], 3)).toBeNull();
  });
  it("sets the record (asin_field_log), fills the open row and the closed row that reproduces its Ordered; a closed row that doesn't stays; no quantity or cost written", async () => {
    const lines: Record<string, any[]> = {
      open1: [{ id: "lo", qty_ordered: "60", retailer_units_per_product: null, asin_units_per_pack: null, asin_qty_per_product: "0.33" }],
      closedOk: [{ id: "lc", qty_ordered: "30", retailer_units_per_product: null, asin_units_per_pack: null, asin_qty_per_product: "0.33" }],
      closedBad: [{ id: "lb", qty_ordered: "30", retailer_units_per_product: null, asin_units_per_pack: null, asin_qty_per_product: "0.50" }],
    };
    const f = fakeQuery([
      [/SELECT sold_as, units_per_pack FROM asins/, [{ sold_as: null, units_per_pack: null }]],
      [/FROM po_asins pa JOIN purchase_orders p/, [{ id: "open1", po_id: "p1", qty: "20.00", closed: false }, { id: "closedOk", po_id: "p2", qty: "10.00", closed: true }, { id: "closedBad", po_id: "p3", qty: "15.00", closed: true }]],
      [/FROM po_line_items WHERE po_asin_id/, (p) => lines[p[0]]],
    ]);
    const r = await setUnknownAsinPack(f.q, "b07n6v47hc", "multi-pack", 3, 7, "src");
    expect(r).toEqual({ asin: "B07N6V47HC", sold_as: "multi-pack", units_per_pack: 3, openRows: 1, closedRows: 1, closedSkipped: 1, lines: 2, openSkipped: 0,
      skipped: [{ po_asin_id: "closedBad", po_id: "p3", closed: true, qty: 15, at_pack: null }] });
    expect(f.calls.filter((c) => /^INSERT INTO asin_field_log/.test(c.sql)).map((c) => [c.params[2], c.params[4], c.params[5]])).toEqual([["sold_as", "multi-pack", "po_form"], ["units_per_pack", "3", "po_form"]]);
    expect(f.calls.filter((c) => /^UPDATE po_asins SET sold_as/.test(c.sql)).map((c) => c.params[0])).toEqual(["open1", "closedOk"]);
    expect(f.calls.filter((c) => /^UPDATE po_line_items/.test(c.sql)).map((c) => c.params)).toEqual([["lo", 1, 3], ["lc", 1, 3]]);
    expect(f.calls.some((c) => /SET qty|cost_per_unit|sourcing_cost|paid_cost/.test(c.sql) && /^UPDATE/.test(c.sql))).toBe(false);
    expect(f.calls.find((c) => /FROM po_asins pa JOIN purchase_orders p/.test(c.sql))?.params).toEqual(["B07N6V47HC", "src"]);
  });
  it("strict: an open row the pack does not reproduce is listed, not written (the open-PO review, 2026-11-06)", async () => {
    const lines: Record<string, any[]> = {
      openOk: [{ id: "l1", qty_ordered: "10", qty_basis: "product_legacy", retailer_units_per_product: null, asin_units_per_pack: null, asin_qty_per_product: "1.00" }],
      // stored Individual units (migration 101): 10 Product units × the pack 2 = 20
      openBad: [{ id: "l2", qty_ordered: "20", qty_basis: "individual", retailer_units_per_product: 2, asin_units_per_pack: 1, asin_qty_per_product: "2.00" }],
    };
    const f = fakeQuery([
      [/FROM po_asins pa JOIN purchase_orders p/, [{ id: "openOk", po_id: "p1", qty: "10.00", closed: false }, { id: "openBad", po_id: "p2", qty: "10.00", closed: false }]],
      [/FROM po_line_items WHERE po_asin_id/, (p) => lines[p[0]]],
    ]);
    const r = await fillAsinPackGaps(f.q, "B0TEST0001", "individual", 1, 7, undefined, { strict: true });
    expect(r).toMatchObject({ openRows: 1, openSkipped: 1, skipped: [{ po_asin_id: "openBad", closed: false, qty: 10, at_pack: 20 }] });
    expect(f.calls.filter((c) => /^UPDATE po_asins SET sold_as/.test(c.sql)).map((c) => c.params[0])).toEqual(["openOk"]);
  });
  it("a record that already has a pack is left alone (the form asks when it differs)", async () => {
    const f = fakeQuery([[/SELECT sold_as, units_per_pack FROM asins/, [{ sold_as: "multi-pack", units_per_pack: 2 }]]]);
    expect(await setUnknownAsinPack(f.q, "B07MZSBYM3", "multi-pack", 3, 7)).toBeNull();
    expect(f.calls.some((c) => /^UPDATE|^INSERT/.test(c.sql))).toBe(false);
  });
});

