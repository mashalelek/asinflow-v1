import { describe, it, expect } from "vitest";
import { recomputePoCosts } from "./po-costs";

// po-ai-prefill §7 / §8.4: the recompute follows the v2 rule for POs saved
// under it, never touches an imported PO, and keeps a hand-typed COGS.
function fake(po: Record<string, any>, promos: any[], asins: any[], lines: Record<string, any[]>, manualIds: string[] = []) {
  const calls: Array<{ sql: string; params: any[] }> = [];
  const q = async (sql: string, params: any[] = []) => {
    calls.push({ sql, params });
    if (/FROM purchase_orders WHERE id/.test(sql)) return { rows: [po], rowCount: 1 };
    if (/FROM po_promos/.test(sql)) return { rows: promos, rowCount: promos.length };
    if (/FROM po_asins WHERE po_id/.test(sql)) return { rows: asins, rowCount: asins.length };
    if (/FROM po_edit_log/.test(sql)) return { rows: manualIds.map((id) => ({ entity_id: id })), rowCount: manualIds.length };
    if (/FROM po_line_items WHERE po_asin_id/.test(sql)) return { rows: lines[params[0]] ?? [], rowCount: 0 };
    return { rows: [], rowCount: 1 };
  };
  return { q, calls };
}
const po = { id: "p1", subtotal: "20.00", discount: "5.00", weighted_gc_discount_pct: "10", cost_formula_version: 2 };
const asins = [
  { id: "a1", asin: "B0A", qty: "1", cost_per_unit: "4.50", sourcing_cost: "5.00", paid_cost: "4.50", cogs_adjustment: null },
  { id: "a2", asin: "B0B", qty: "1", cost_per_unit: "9.99", sourcing_cost: "7.50", paid_cost: "6.75", cogs_adjustment: null },
];
const lines = { a1: [{ id: "l1", price: "10.00", qty_ordered: "1", adjusted_product_cost: "6.75" }], a2: [{ id: "l2", price: "10.00", qty_ordered: "1", adjusted_product_cost: "6.75" }] };

describe("recomputePoCosts", () => {
  it("a sheet-imported PO (cost_formula_version NULL) is never recomputed", async () => {
    const f = fake({ ...po, cost_formula_version: null }, [], asins, lines);
    expect(await recomputePoCosts(f.q, "p1", 1)).toEqual({ poId: "p1", skipped: "imported", asinRows: 0, changed: 0 });
    expect(f.calls.some((c) => /UPDATE/.test(c.sql))).toBe(false);
  });
  it("a rewards promo flipped to not-counting adds its amount back; a hand-typed COGS keeps its value while Sourcing / Paid follow", async () => {
    // $5 rewards no longer counts: AQ = 10 × (20 − 0) ÷ 20 = 10 → Sourcing 10, COGS 9 (GC 10 %), Paid = 10 × 0.75 × 0.9 = 6.75
    const f = fake(po, [{ amount: "5.00", counts_toward_cogs: false }], asins, lines, ["a2"]);
    const r = await recomputePoCosts(f.q, "p1", 1);
    expect(r).toMatchObject({ skipped: null, asinRows: 2 });
    const upA1 = f.calls.find((c) => /UPDATE po_asins SET/.test(c.sql) && c.params[0] === "a1")!;
    expect(upA1.params).toEqual(["a1", "10.00", "6.75", "9.00"]); // sourcing_cost, paid_cost, cost_per_unit
    const upA2 = f.calls.find((c) => /UPDATE po_asins SET/.test(c.sql) && c.params[0] === "a2")!;
    expect(upA2.sql).not.toMatch(/cost_per_unit/); // typed by hand: kept
    expect(upA2.params).toEqual(["a2", "10.00"]); // paid_cost already 6.75
    const lineUp = f.calls.filter((c) => /UPDATE po_line_items SET adjusted_product_cost/.test(c.sql));
    expect(lineUp.map((c) => c.params)).toEqual([["l1", "9.00"], ["l2", "9.00"]]);
    const logs = f.calls.filter((c) => /INSERT INTO po_edit_log/.test(c.sql)).map((c) => [c.params[3], c.params[4], c.params[5], c.params[6]]);
    expect(logs).toEqual([["a1", "sourcing_cost", "5", "10"], ["a1", "paid_cost", "4.5", "6.75"], ["a1", "cost_per_unit", "4.5", "9"], ["a2", "sourcing_cost", "7.5", "10"]]);
  });
});
