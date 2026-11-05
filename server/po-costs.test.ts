import { describe, it, expect } from "vitest";
import { recomputePoCosts } from "./po-costs";

// po-ai-prefill §7 / §8.4: the recompute follows the current rule (v3, 2026-11-04 — tax and
// shipping in) for POs saved by the form, stamps the version, never touches an imported PO,
// and keeps a hand-typed COGS.
function fake(po: Record<string, any>, promos: any[], asins: any[], lines: Record<string, any[]>, manualIds: string[] = [], payments: any[] = []) {
  const calls: Array<{ sql: string; params: any[] }> = [];
  const q = async (sql: string, params: any[] = []) => {
    calls.push({ sql, params });
    if (/FROM purchase_orders WHERE id/.test(sql)) return { rows: [po], rowCount: 1 };
    if (/FROM po_promos/.test(sql)) return { rows: promos, rowCount: promos.length };
    if (/FROM po_payments/.test(sql)) return { rows: payments, rowCount: payments.length };
    if (/FROM po_asins WHERE po_id/.test(sql)) return { rows: asins, rowCount: asins.length };
    if (/FROM po_edit_log/.test(sql)) return { rows: manualIds.map((id) => ({ entity_id: id })), rowCount: manualIds.length };
    if (/FROM po_line_items WHERE po_asin_id/.test(sql)) return { rows: lines[params[0]] ?? [], rowCount: 0 };
    if (/FROM po_line_items WHERE po_id/.test(sql)) return { rows: Object.values(lines).flat(), rowCount: 0 };
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
  // Maria 2026-11-01, PO 200015336732726: the line price was already the sale price — the recompute must not subtract the discount again.
  it("the double-discount rule: Σ price × qty equal to the post-discount subtotal → the discount / promo count for nothing (COGS = Sourcing = Paid)", async () => {
    const wal = { id: "p1", subtotal: "95.64", discount: "36.12", tax: "0.00", sh_donations: "0.00", order_total: "95.64", weighted_gc_discount_pct: null, cost_formula_version: 2 };
    const rows = [{ id: "a1", asin: "B0756KB8N1", qty: "2.00", cost_per_unit: "29.76", sourcing_cost: "29.76", paid_cost: "29.76", cogs_adjustment: null }];
    const f = fake(wal, [{ amount: "36.12", counts_toward_cogs: true }], rows, { a1: [{ id: "l1", price: "7.97", qty_ordered: "12.00", adjusted_product_cost: "4.96" }] });
    await recomputePoCosts(f.q, "p1", 1);
    const up = f.calls.find((c) => /UPDATE po_asins SET/.test(c.sql) && c.params[0] === "a1")!;
    expect(up.params).toEqual(["a1", "47.82", "47.82", "47.82"]);
    expect(f.calls.find((c) => /UPDATE po_line_items/.test(c.sql))!.params).toEqual(["l1", "7.97"]);
  });
  // Maria 2026-11-05, michaels.com 4300109060826629: saved at 6.37 / 3.11 (the $18 in the paint's price subtracted again, GC 12.80 %).
  it("per promo: only the promo NOT in the line totals is subtracted, at the payments' unrounded GC % (12.795 %) → 7.04 / 3.44", async () => {
    const mich = { id: "p1", subtotal: "188.60", discount: "28.00", tax: "0.00", sh_donations: "0.00", order_total: "160.60", weighted_gc_discount_pct: "12.80", cost_formula_version: 3 };
    const rows = [
      { id: "a1", asin: "B01N3B23JX", qty: "15.00", cost_per_unit: "6.37", sourcing_cost: "7.31", paid_cost: "6.37", cogs_adjustment: null },
      { id: "a2", asin: "B000RDP7XK", qty: "10.00", cost_per_unit: "3.11", sourcing_cost: "3.57", paid_cost: "3.11", cogs_adjustment: null },
    ];
    const ls = { a1: [{ id: "l1", price: "64.350000", qty_ordered: "2.00", line_total: "128.70", adjusted_product_cost: "47.78" }], a2: [{ id: "l2", price: "4.190000", qty_ordered: "10.00", line_total: "41.90", adjusted_product_cost: "3.11" }] };
    const gc = (amount: string, pct: string) => ({ method: "gift_card", amount, gift_card_discount_pct: pct, reward_pct: null });
    const pays = [gc("50.00", "13.00"), gc("50.00", "13.00"), gc("44.15", "13.00"), gc("16.45", "11.00")];
    for (const promo1 of [{ amount: null, counts_toward_cogs: false }, { amount: "18.00", counts_toward_cogs: true }]) {
      const f = fake(mich, [promo1, { amount: "10.00", counts_toward_cogs: true }], rows, ls, [], pays);
      const r = await recomputePoCosts(f.q, "p1", 1, { dryRun: true });
      const cogs = Object.fromEntries(r.plan!.filter((c) => c.field === "cost_per_unit").map((c) => [c.id, c.new]));
      expect(cogs).toEqual({ a1: "7.04", a2: "3.44" });
      expect(f.calls.some((c) => /UPDATE|INSERT/.test(c.sql))).toBe(false);
    }
    // Pre-discount lines (paint at 5.99): both promos are subtracted.
    const pre = fake(mich, [{ amount: "18.00", counts_toward_cogs: true }, { amount: "10.00", counts_toward_cogs: true }], rows, { ...ls, a2: [{ id: "l2", price: "5.990000", qty_ordered: "10.00", line_total: "59.90", adjusted_product_cost: null }] }, [], pays);
    const rp = await recomputePoCosts(pre.q, "p1", 1, { dryRun: true });
    expect(rp.plan!.filter((c) => c.field === "cost_per_unit").map((c) => c.new)).toEqual(["4.45"]); // a1 stays 6.37
  });
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
    expect(logs).toEqual([["a1", "sourcing_cost", "5", "10"], ["a1", "paid_cost", "4.5", "6.75"], ["a1", "cost_per_unit", "4.5", "9"], ["a2", "sourcing_cost", "7.5", "10"], ["p1", "cost_formula_version", 2, "3"]]);
    expect(f.calls.find((c) => /UPDATE purchase_orders SET cost_formula_version/.test(c.sql))!.params).toEqual(["p1", 3]);
  });
  it("v3: tax and shipping are allocated into every cost; a stored line total beats price × qty; a dry run writes nothing", async () => {
    // acmetools 42838131: line total 79.70 (price 2.656667 × 30), already net of the $10 code; shipping 6.49 → 86.19 ÷ 10 ASIN units
    const acme = { id: "p1", subtotal: "89.70", discount: "10.00", tax: "0.00", sh_donations: "6.49", order_total: "86.19", weighted_gc_discount_pct: null, cost_formula_version: 2 };
    const rows = [{ id: "a1", asin: "B07VH2L2QF", qty: "10.00", cost_per_unit: "8.61", sourcing_cost: "8.61", paid_cost: "7.65", cogs_adjustment: null }];
    const ls = { a1: [{ id: "l1", price: "2.656667", line_total: "79.70", qty_ordered: "30.00", adjusted_product_cost: "2.87" }] };
    const dry = fake(acme, [{ amount: "10.00", counts_toward_cogs: false }], rows, ls);
    const plan = await recomputePoCosts(dry.q, "p1", 1, { dryRun: true });
    expect(dry.calls.some((c) => /^\s*(UPDATE|INSERT)/.test(c.sql))).toBe(false);
    expect(plan.plan!.map((p) => [p.field, p.old, p.new])).toEqual([["sourcing_cost", "8.61", "8.62"], ["paid_cost", "7.65", "8.62"], ["cost_per_unit", "8.61", "8.62"], ["adjusted_product_cost", "2.87", "2.87"], ["cost_formula_version", 2, 3]].filter((x) => x[1] !== x[2]));
    // tax 2.00 and shipping 3.00 on a pre-discount $20 order with $5 off, GC 10 %: (20 − 5 + 5) ÷ 20 = 1 per dollar of lines
    const f = fake({ ...po, tax: "2.00", sh_donations: "3.00", order_total: "20.00" }, [], asins, lines, ["a2"]);
    await recomputePoCosts(f.q, "p1", 1);
    expect(f.calls.find((c) => /UPDATE po_asins SET/.test(c.sql) && c.params[0] === "a1")!.params).toEqual(["a1", "10.00", "9.00", "9.00"]);
  });
});
