import { describe, it, expect } from "vitest";
import {
  parseEdits, changedFields, asLogText, asinQtyFromLines, shipmentBlockMessage, HEADER_FIELDS, LINE_FIELDS, ASIN_FIELDS,
  editPoHeader, removeLine, editAsinRow, EditError, ORDER_ID_WARNING,
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
    expect(parseEdits(LINE_FIELDS, { qty_ordered: "12", asin_qty_per_product: "0.5", asin: "b0test0001" })).toEqual({ ok: true, edits: { qty_ordered: 12, asin_qty_per_product: "0.5", asin: "B0TEST0001" } });
    expect(parseEdits(LINE_FIELDS, { qty_ordered: "2.5", qty_canceled: "0.25" })).toEqual({ ok: true, edits: { qty_ordered: 2.5, qty_canceled: 0.25 } }); // decimals since migration 062
    expect(parseEdits(LINE_FIELDS, { qty_ordered: "2.555" })).toMatchObject({ ok: false });
    expect(parseEdits(LINE_FIELDS, { qty_ordered: "0" })).toMatchObject({ ok: false });
    expect(parseEdits(LINE_FIELDS, { asin_qty_per_product: "0" })).toMatchObject({ ok: false });
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
});

describe("§5.1 block message", () => {
  it("names the units and FBA ids", () => {
    expect(shipmentBlockMessage({ units: 9, fbaIds: ["FBA19A2B3C", "FBA19A2B3D"] })).toBe("9 units shipped to FBA in FBA19A2B3C, FBA19A2B3D. Reassign the shipment to another PO first.");
    expect(shipmentBlockMessage({ units: 1, fbaIds: [] })).toBe("1 unit shipped to FBA in a shipment with no FBA id yet. Reassign the shipment to another PO first.");
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
    expect(err.message).toBe("B0TEST0001: 9 units shipped to FBA in FBA19A2B3C. Reassign the shipment to another PO first.");
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

describe("editLine cancel guard (§5.1)", () => {
  it("raising qty canceled on a product whose ASIN row has an FBA shipment is refused; nothing written", async () => {
    const f = fakeQuery([
      [/FROM po_line_items l LEFT JOIN po_asins pa/, [{ id: "l1", po_id: "po1", po_asin_id: "pa1", asin: "B0TEST0001", qty_ordered: 9, qty_canceled: null }]],
      [/SELECT s\.qty_shipped, s\.fba_shipment_ids FROM po_asin_shipments/, [{ qty_shipped: "4", fba_shipment_ids: ["FBA19A2B3C"] }]],
    ]);
    const { editLine } = await import("./po-edit");
    await expect(editLine(f.q, "l1", { qty_canceled: "9" }, 7)).rejects.toMatchObject({ status: 409, message: "B0TEST0001: 4 units shipped to FBA in FBA19A2B3C. Reassign the shipment to another PO first." });
    expect(f.calls.some((c) => /^UPDATE|INSERT INTO po_edit_log/.test(c.sql))).toBe(false);
  });
});
