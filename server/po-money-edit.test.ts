import { describe, it, expect } from "vitest";
import { addMoneyRow, editMoneyRow, removeMoneyRow } from "./po-money-edit";

// po-ai-prefill §8 (commit 8): payments / promos / refunds CRUD with History rows; a promo change recomputes a v2 PO's costs, never an imported PO's.
function fake(opts: { version?: number | null; row?: any; line?: any } = {}) {
  const calls: Array<{ sql: string; params: any[] }> = [];
  const q = async (sql: string, params: any[] = []) => {
    calls.push({ sql, params });
    if (/SELECT id FROM purchase_orders WHERE id/.test(sql)) return { rows: [{ id: params[0] }], rowCount: 1 };
    if (/SELECT id, subtotal, discount, tax, sh_donations, order_total, weighted_gc_discount_pct, cost_formula_version FROM purchase_orders/.test(sql)) return { rows: [{ id: "p1", subtotal: "10", discount: "0", tax: "0", sh_donations: "0", order_total: "10", weighted_gc_discount_pct: null, cost_formula_version: opts.version ?? null }], rowCount: 1 };
    if (/SELECT \* FROM po_(payments|promos|line_refunds) WHERE id/.test(sql)) return { rows: opts.row ? [opts.row] : [], rowCount: opts.row ? 1 : 0 };
    if (/SELECT qty_ordered FROM po_line_items WHERE id/.test(sql)) return { rows: opts.line ? [opts.line] : [], rowCount: opts.line ? 1 : 0 };
    if (/RETURNING \*/.test(sql)) { const cols = /\(po_id(.*?)\) VALUES/.exec(sql)![1].split(",").map((s) => s.trim()).filter(Boolean); const row: any = { id: 11, po_id: params[0] }; let i = 1; for (const c of cols) { if (c === "position" || c === "source") continue; row[c] = params[i++]; } return { rows: [row], rowCount: 1 }; }
    if (/FROM po_promos WHERE po_id/.test(sql)) return { rows: [], rowCount: 0 };
    if (/FROM po_asins WHERE po_id/.test(sql)) return { rows: [], rowCount: 0 };
    return { rows: [], rowCount: 1 };
  };
  return { q, calls };
}

describe("payments / promos / refunds", () => {
  it("adds a payment with validation and a History row", async () => {
    const f = fake();
    const r = await addMoneyRow(f.q, "po_payments", "p1", { method: "card", nickname: "Amex", last4: "1001", amount: "12.50" }, 7);
    expect(r).toEqual({ poId: "p1", id: 11 });
    const ins = f.calls.find((c) => /INSERT INTO po_payments/.test(c.sql))!;
    expect(ins.sql).toMatch(/\(po_id, position, method, nickname, last4, amount\)/);
    expect(ins.params).toEqual(["p1", "card", "Amex", "1001", "12.50"]);
    expect(f.calls.find((c) => /INSERT INTO po_edit_log/.test(c.sql))!.params.slice(4)).toEqual(["payment added", null, "card Amex (1001) $12.50"]);
    await expect(addMoneyRow(f.q, "po_payments", "p1", { method: "cash" }, 7)).rejects.toMatchObject({ status: 400 });
    await expect(addMoneyRow(f.q, "po_payments", "p1", { method: "card", last4: "12" }, 7)).rejects.toMatchObject({ status: 400 });
  });
  it("a promo gets the §7.2 default for counts_toward_cogs; flipping it on a v2 PO recomputes, on an imported PO it does not", async () => {
    const v2 = fake({ version: 2, row: { id: 3, po_id: "p1", type: "rewards", description: "Rewards", amount: "5.00", percent: null, counts_toward_cogs: false } });
    const added = await addMoneyRow(v2.q, "po_promos", "p1", { type: "rewards", description: "Rewards", amount: "5" }, 7);
    expect(v2.calls.find((c) => /INSERT INTO po_promos/.test(c.sql))!.params).toEqual(["p1", "rewards", "Rewards", "5", false]);
    expect(added.recomputed).toEqual({ changed: 0, skipped: null });
    const flipped = await editMoneyRow(v2.q, "po_promos", 3, { counts_toward_cogs: true }, 7);
    expect(v2.calls.find((c) => /UPDATE po_promos SET counts_toward_cogs/.test(c.sql))!.params).toEqual([3, true]);
    expect(v2.calls.some((c) => /INSERT INTO po_edit_log/.test(c.sql) && c.params[4] === "promo counts_toward_cogs" && c.params[5] === "false" && c.params[6] === "true")).toBe(true);
    expect(flipped.recomputed).toEqual({ changed: 0, skipped: null });
    const imported = fake({ version: null, row: { id: 3, po_id: "p1", type: "rewards", description: "Rewards", amount: "5.00", percent: null, counts_toward_cogs: false } });
    expect((await editMoneyRow(imported.q, "po_promos", 3, { counts_toward_cogs: true }, 7)).recomputed).toEqual({ changed: 0, skipped: "imported" });
    expect((await editMoneyRow(imported.q, "po_promos", 3, { counts_toward_cogs: false }, 7)).recomputed).toBeUndefined(); // no change
  });
  it("a refund on a line must name a line of the PO and stay within its qty; a removal logs the summary", async () => {
    const f = fake({ line: { qty_ordered: "2" }, row: { id: 5, po_id: "p1", po_line_item_id: "l1", qty: "1", amount: "4.00", needs_split: false } });
    await expect(addMoneyRow(f.q, "po_line_refunds", "p1", { po_line_item_id: "l1", qty: "3", amount: "4" }, 7)).rejects.toMatchObject({ status: 400, message: /cannot exceed/ });
    const r = await addMoneyRow(f.q, "po_line_refunds", "p1", { po_line_item_id: "l1", qty: "1", amount: "4", refunded_at: "2026-10-31" }, 7);
    expect(r).toEqual({ poId: "p1", id: 11 });
    expect(f.calls.find((c) => /INSERT INTO po_line_refunds/.test(c.sql))!.sql).toMatch(/'manual'/);
    const none = fake({ line: null });
    await expect(addMoneyRow(none.q, "po_line_refunds", "p1", { po_line_item_id: "zz", amount: "4" }, 7)).rejects.toMatchObject({ status: 400, message: /product line of this PO/ });
    const rm = await removeMoneyRow(f.q, "po_line_refunds", 5, 7);
    expect(rm).toEqual({ poId: "p1", id: 5 });
    expect(f.calls.find((c) => /DELETE FROM po_line_refunds/.test(c.sql))!.params).toEqual([5]);
    expect(f.calls.filter((c) => /INSERT INTO po_edit_log/.test(c.sql)).pop()!.params.slice(4)).toEqual(["refund removed", "1 × $4.00", null]);
  });
});
