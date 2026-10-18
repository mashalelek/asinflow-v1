import { describe, it, expect } from "vitest";
import { loadPoGuards, deletePo, cancelPo, reassignShipment, velocityOrderNumberFor } from "./po-guards";

// patch docs/claude_spec-patch-po-af-owned.md §5 — delete / cancel guards, Reassign shipment.
function fakeQuery(script: Array<[RegExp, any[] | ((p: any[]) => any[])]>) {
  const calls: Array<{ sql: string; params: any[] }> = [];
  const q = async (sql: string, params: any[] = []) => {
    calls.push({ sql, params });
    for (const [re, rows] of script) if (re.test(sql)) { const r = typeof rows === "function" ? rows(params) : rows; return { rows: r, rowCount: r.length }; }
    return { rows: [], rowCount: 0 };
  };
  return { q, calls };
}
const poRow = { id: "po1", supplier: "walmart.com", order_id: "200015415094735", lines: 3, asins: 2, at_prep: "2.00" };
const close: Array<[RegExp, any[]]> = [[/SELECT p\.closed_at, p\.closed_by, ARRAY/, [{ closed_at: null, closed_by: null, action_items: [] }]]];
const shipped = [{ qty_shipped: "9.00", fba_shipment_ids: ["FBA19A2B3C"] }, { qty_shipped: "1.00", fba_shipment_ids: ["FBA19A2B3D", "FBA19A2B3C"] }];

describe("guards (§5.1)", () => {
  it("names units and FBA ids; units still at Velocity are reported", async () => {
    const f = fakeQuery([[/FROM purchase_orders p WHERE p\.id = \$1/, [poRow]], [/SELECT s\.qty_shipped, s\.fba_shipment_ids/, shipped]]);
    const g = await loadPoGuards(f.q, "po1");
    expect(g).toMatchObject({ lineCount: 3, asinCount: 2, atPrepUnits: 2, fba: { units: 10, fbaIds: ["FBA19A2B3C", "FBA19A2B3D"], rows: 2 } });
    expect(g.blocked).toBe("10 units shipped to FBA in FBA19A2B3C, FBA19A2B3D. Reassign the shipment to another PO first.");
  });
  it("delete and cancel are refused while an FBA shipment exists — nothing written", async () => {
    for (const run of [deletePo, cancelPo]) {
      const f = fakeQuery([[/FROM purchase_orders p WHERE p\.id = \$1/, [poRow]], [/SELECT s\.qty_shipped, s\.fba_shipment_ids/, shipped]]);
      await expect(run(f.q, "po1", 7)).rejects.toMatchObject({ status: 409 });
      expect(f.calls.some((c) => /^(INSERT|UPDATE|DELETE)/.test(c.sql))).toBe(false);
    }
  });
});

describe("delete (§5.3)", () => {
  it("tombstones (supplier, order #), logs with the units still at Velocity, deletes lines then the PO", async () => {
    const f = fakeQuery([[/FROM purchase_orders p WHERE p\.id = \$1/, [poRow]]]);
    const r = await deletePo(f.q, "po1", 7);
    expect(r).toMatchObject({ deleted: true, lines: 3, asins: 2, atPrepUnits: 2 });
    const w = f.calls.filter((c) => /^(INSERT|DELETE)/.test(c.sql));
    expect(w[0].sql).toMatch(/^INSERT INTO deleted_pos \(supplier, order_id, deleted_by\)/);
    expect(w[0].params).toEqual(["walmart.com", "200015415094735", 7]);
    expect(w[1].params).toEqual(["po1", 7, "po", "po1", "PO deleted", "walmart.com 200015415094735 — 2 ASIN(s), 3 product(s), 2 still at Velocity", null]);
    expect(w[2].sql).toMatch(/^DELETE FROM po_line_items WHERE po_id = \$1/);
    expect(w[3].sql).toMatch(/^DELETE FROM purchase_orders WHERE id = \$1/);
  });
});

describe("cancel PO (§5.4)", () => {
  it("every line qty_canceled = qty_ordered, each logged, auto-close re-run", async () => {
    const f = fakeQuery([[/FROM purchase_orders p WHERE p\.id = \$1/, [poRow]], [/^UPDATE po_line_items SET qty_canceled = qty_ordered WHERE po_id/, [{ id: "l1", qty_ordered: 5 }, { id: "l2", qty_ordered: 2 }]], ...close]);
    const r = await cancelPo(f.q, "po1", 7);
    expect(r.linesCanceled).toBe(2);
    expect(f.calls.filter((c) => /INSERT INTO po_edit_log/.test(c.sql)).map((c) => [c.params[3], c.params[4], c.params[6]])).toEqual([["l1", "qty_canceled", "5"], ["l2", "qty_canceled", "2"], ["po1", "PO canceled", "2 product(s)"]]);
  });
});

describe("reassign shipment (§5.2)", () => {
  const src = { id: "s1", po_asin_id: "paA", velocity_shipment_id: "73917fcd-bc7b-4790-9513-b44dd5fe16f7", velocity_order_number: null, qty_shipped: "9.00", qty_received: "6.00", fba_shipment_ids: ["FBA19A2B3C"], sc_match: "matched", shipped_at: "2026-10-15", source: "velocity", asin: "0349125937", po_id: "poA", order_id: "102003840691113", supplier: "target.com" };
  const tgt = { id: "paB", asin: "0349125937", po_id: "poB", order_id: "102003843107733", supplier: "target.com" };
  const raw = { detail: { orders: [{ order_number: "102003840691113", asin: "0349125937", quantity_shipped: 9 }, { order_number: "SHOP533384", asin: "B004WZ4CLW" }] } };
  const base = (extra: Array<[RegExp, any[]]> = []) => fakeQuery([
    [/FROM po_asin_shipments s JOIN po_asins pa ON pa\.id = s\.po_asin_id JOIN purchase_orders p/, [src]],
    [/FROM po_asins pa JOIN purchase_orders p ON p\.id = pa\.po_id WHERE pa\.id = \$1/, [tgt]],
    [/SELECT raw FROM velocity_shipments/, [{ raw }]],
    ...extra, ...close,
  ]);
  it("part of a shipment: a new manual row on the target (received split pro rata), the source reduced and pinned, both POs logged", async () => {
    const f = base();
    const r = await reassignShipment(f.q, "s1", "paB", "3", 7);
    expect(r).toMatchObject({ moved: 3, from: { poId: "poA" }, to: { poId: "poB" } });
    const ins = f.calls.find((c) => /^INSERT INTO po_asin_shipments/.test(c.sql))!;
    expect(ins.sql).toMatch(/'manual', \$9\)/);
    expect(ins.params).toEqual(["paB", src.velocity_shipment_id, ["FBA19A2B3C"], "matched", 3, 2, "2026-10-15", "velocity", "102003840691113"]);
    const upd = f.calls.find((c) => /^UPDATE po_asin_shipments SET qty_shipped = qty_shipped - \$2/.test(c.sql))!;
    expect(upd.sql).toMatch(/assigned_by = 'manual'/);
    expect(upd.params).toEqual(["s1", 3, 2, "102003840691113"]);
    const logs = f.calls.filter((c) => /INSERT INTO po_edit_log/.test(c.sql)).map((c) => [c.params[0], c.params[4]]);
    expect(logs).toEqual([["poA", "shipment reassigned out"], ["poB", "shipment reassigned in"]]);
  });
  it("all of it: the row moves in place, pinned to the Velocity line", async () => {
    const f = base();
    await reassignShipment(f.q, "s1", "paB", undefined, 7);
    const mv = f.calls.find((c) => /^UPDATE po_asin_shipments SET po_asin_id = \$2, assigned_by = 'manual'/.test(c.sql))!;
    expect(mv.params).toEqual(["s1", "paB", "102003840691113"]);
    expect(f.calls.some((c) => /^(INSERT INTO po_asin_shipments|DELETE)/.test(c.sql))).toBe(false);
  });
  it("refuses another ASIN, the same row, and more units than shipped", async () => {
    await expect(reassignShipment(fakeQuery([[/JOIN purchase_orders p ON p\.id = pa\.po_id WHERE s\.id/, [src]], [/WHERE pa\.id = \$1/, [{ ...tgt, asin: "B004WZ4CLW" }]]]).q, "s1", "paB", "1", 7)).rejects.toMatchObject({ status: 400 });
    await expect(reassignShipment(base().q, "s1", "paB", "9.5", 7)).rejects.toMatchObject({ status: 400 });
    await expect(reassignShipment(fakeQuery([[/JOIN purchase_orders p ON p\.id = pa\.po_id WHERE s\.id/, [src]], [/WHERE pa\.id = \$1/, [{ ...tgt, id: "paA" }]]]).q, "s1", "paA", "1", 7)).rejects.toMatchObject({ status: 400 });
  });
  it("the Velocity order # comes from the stored shipment detail; two lines with the ASIN and none matching the PO → refused", async () => {
    const two = { detail: { orders: [{ order_number: "A1", asin: "0349125937" }, { order_number: "B2", asin: "0349125937" }] } };
    const f = fakeQuery([[/SELECT raw FROM velocity_shipments/, [{ raw: two }]]]);
    await expect(velocityOrderNumberFor(f.q, { velocity_shipment_id: "x", velocity_order_number: null, asin: "0349125937", order_id: "B2" })).resolves.toBe("B2");
    await expect(velocityOrderNumberFor(f.q, { velocity_shipment_id: "x", velocity_order_number: null, asin: "0349125937", order_id: "Z" })).rejects.toMatchObject({ status: 409 });
    await expect(velocityOrderNumberFor(f.q, { velocity_shipment_id: "x", velocity_order_number: "KEEP", asin: "0349125937", order_id: "Z" })).resolves.toBe("KEEP");
  });
});
