import { describe, it, expect } from "vitest";
import { loadAfAsinCostMap, loadAfPoRows } from "./po-af-source";

// patch docs/claude_spec-patch-po-af-owned.md §2.4 — the AF PO tables replace
// every Orders-sheet reader. These pin the SQL order (newest = order_date,
// then entry_seq) and the sheet-shaped field mapping.

const fake = (rows: any[]) => {
  const calls: Array<{ sql: string; params?: any[] }> = [];
  const query = async (sql: string, params?: any[]) => {
    calls.push({ sql, params });
    return /COUNT\(\*\)::int AS n FROM po_asins/.test(sql) ? { rows: [{ n: 42 }], rowCount: 1 } : { rows, rowCount: rows.length };
  };
  return { calls, query };
};

describe("loadAfAsinCostMap", () => {
  it("newest non-canceled ASIN row per ASIN; blank prep reads 0; ASIN subset upper-cased", async () => {
    const { calls, query } = fake([{ asin: "B076692G4N", cost_per_unit: "4.99", prep_cost: null, supplier: "staples.com" }]);
    const r = await loadAfAsinCostMap(query, ["b076692g4n"]);
    expect(r.data.get("B076692G4N")).toEqual({ cogs: 4.99, prepCost: 0, orderedQty: 0, supplier: "staples.com" });
    expect(r.rowsRead).toBe(42);
    expect(calls[0].sql).toMatch(/DISTINCT ON \(pa\.asin\)/);
    expect(calls[0].sql).toMatch(/ORDER BY pa\.asin, p\.order_date DESC, p\.entry_seq DESC NULLS LAST, p\.created_at DESC/);
    expect(calls[0].sql).toMatch(/bool_and\(\(l\.qty_canceled IS NOT NULL AND l\.qty_canceled >= COALESCE\(l\.qty_ordered, 0\)\)\)/);
    expect(calls[0].params).toEqual([["B076692G4N"]]);
    await loadAfAsinCostMap(query);
    expect(calls[2].params).toEqual([]);
    expect(calls[2].sql).not.toMatch(/ANY\(\$1/);
  });
});

describe("loadAfPoRows", () => {
  const base = { order_id: "9929903576", order_date: "2025-05-01", supplier: "staples.com", closed: false, asin: "B076692G4N", asin_name: "Pens", asin_qty: 6, cost_per_unit: "4.99", prep_cost: "1.00", sold_as: "single", units_per_pack: 1, unique_products: 1, position: 1, product_name: "Pens 12ct", qty_ordered: 6, asin_qty_per_product: "1", canceled: false, line_count: 1 };
  it("one row per line in the sheet's newest-first order, M/D/YYYY dates, status from closed / canceled", async () => {
    const { calls, query } = fake([base, { ...base, closed: true, canceled: true, order_date: new Date(2025, 3, 30) }]);
    const r = await loadAfPoRows(query);
    expect(calls[0].sql).toMatch(/ORDER BY p\.order_date DESC, p\.entry_seq DESC NULLS LAST, p\.created_at DESC, pa\.asin, l\.position/);
    expect(r.rawRowsRead).toBe(2);
    expect(r.rows[0]).toMatchObject({ status: "Ordered", orderDate: "5/1/2025", qty: 6, quantity: "6", cogs: 4.99, prepCost: 1, orderNumber: "9929903576", retailer: "staples.com" });
    expect(r.rows[1]).toMatchObject({ status: "Closed, Canceled", orderDate: "4/30/2025" });
  });
  it("U qty: bundle component = ASIN qty ÷ N (no pack multiply); S=1 multi-line = qty × yield; packs multiply AZ", async () => {
    const { query } = fake([
      { ...base, sold_as: "bundle", unique_products: 2, asin_qty: 10, line_count: 2, units_per_pack: 3 },
      { ...base, sold_as: "pack", asin_qty: 5, line_count: 2, qty_ordered: 4, asin_qty_per_product: "0.5", units_per_pack: 2 },
    ]);
    const r = await loadAfPoRows(query);
    expect(r.rows[0]).toMatchObject({ qty: 5, quantity: "5", uniqueS: "2", unitsPerPack: "3" });
    expect(r.rows[1]).toMatchObject({ qty: 2, quantity: "4", yieldT: "0.5" });
  });
});
