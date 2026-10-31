import { describe, it, expect } from "vitest";
import { applyAsinPackUpdate, parsePack } from "./asin-pack";

// po-ai-prefill §6.5: "Update ASIN in AF" writes the ASIN's pack fields with
// a History row and brings open POs' rows (and their lines' yields) to the
// new size; "This PO only" simply never calls this. Closed POs untouched.
function fake(opts: { asin?: any; openRows?: any[]; lines?: Record<string, any[]>; version?: number | null }) {
  const calls: Array<{ sql: string; params: any[] }> = [];
  const q = async (sql: string, params: any[] = []) => {
    calls.push({ sql, params });
    if (/SELECT asin, sold_as, units_per_pack FROM asins/.test(sql)) return { rows: opts.asin === null ? [] : [opts.asin ?? { asin: "B0A", sold_as: "multi-pack", units_per_pack: 6 }], rowCount: 1 };
    if (/FROM po_asins pa JOIN purchase_orders p ON p.id = pa.po_id WHERE pa.asin/.test(sql)) return { rows: opts.openRows ?? [], rowCount: 0 };
    if (/SELECT id, asin_qty_per_product FROM po_line_items WHERE po_asin_id/.test(sql)) return { rows: opts.lines?.[params[0]] ?? [], rowCount: 0 };
    if (/SELECT id, po_id, qty, sold_as, unique_products FROM po_asins WHERE id/.test(sql)) return { rows: [{ id: params[0], po_id: "p1", qty: "3", sold_as: "multi-pack", unique_products: null }], rowCount: 1 };
    if (/SELECT qty_ordered, asin_qty_per_product FROM po_line_items WHERE po_asin_id/.test(sql)) return { rows: (opts.lines?.[params[0]] ?? []).map((l) => ({ qty_ordered: 6, asin_qty_per_product: 0.0833 })), rowCount: 1 };
    if (/FROM purchase_orders WHERE id/.test(sql)) return { rows: [{ id: "p1", subtotal: "60", discount: "0", weighted_gc_discount_pct: null, cost_formula_version: opts.version ?? null }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  };
  return { q, calls };
}

describe("applyAsinPackUpdate", () => {
  it("parses the pack value", () => {
    expect(parsePack({ sold_as: "individual", units_per_pack: 9 })).toEqual({ sold_as: "individual", units_per_pack: 1 });
    expect(parsePack({ sold_as: "multi-pack", units_per_pack: "12" })).toEqual({ sold_as: "multi-pack", units_per_pack: 12 });
    expect(() => parsePack({ sold_as: "multi-pack", units_per_pack: 1 })).toThrow(/≥ 2/);
    expect(() => parsePack({ sold_as: "box" })).toThrow(/sold_as/);
  });
  it("no change → nothing written; unknown ASIN → 404", async () => {
    const f = fake({});
    expect((await applyAsinPackUpdate(f.q, "B0A", { sold_as: "multi-pack", units_per_pack: 6 }, 1)).changed).toBe(false);
    expect(f.calls.some((c) => /UPDATE|INSERT/.test(c.sql))).toBe(false);
    await expect(applyAsinPackUpdate(fake({ asin: null }).q, "B0X", { sold_as: "individual", units_per_pack: 1 }, 1)).rejects.toMatchObject({ status: 404 });
  });
  it("writes asins + asin_field_log, moves the open PO row to the new size with its lines' yields scaled (units kept), recomputes Ordered and a v2 PO's costs", async () => {
    const f = fake({ openRows: [{ id: "pa1", po_id: "p1", sold_as: "multi-pack", units_per_pack: 6 }], lines: { pa1: [{ id: "l1", asin_qty_per_product: "0.5" }] }, version: 2 });
    const r = await applyAsinPackUpdate(f.q, "b0a", { sold_as: "multi-pack", units_per_pack: 12 }, 7, "po_form");
    expect(r).toEqual({ asin: "B0A", changed: true, openRows: 1, rowsUpdated: 1, posRecosted: 1 });
    expect(f.calls.find((c) => /UPDATE asins SET/.test(c.sql))!.params).toEqual(["B0A", "multi-pack", 12]);
    expect(f.calls.filter((c) => /INSERT INTO asin_field_log/.test(c.sql)).map((c) => c.params)).toEqual([["B0A", 7, "units_per_pack", "6", "12", "po_form"]]);
    expect(f.calls.find((c) => /UPDATE po_asins SET sold_as/.test(c.sql))!.params).toEqual(["pa1", "multi-pack", 12]);
    // 6 retail units per product: yield 0.5 of a 6-pack → 0.25 of a 12-pack
    expect(f.calls.find((c) => /UPDATE po_line_items SET asin_qty_per_product/.test(c.sql))!.params).toEqual(["l1", "0.25"]);
    expect(f.calls.some((c) => /INSERT INTO po_edit_log/.test(c.sql) && c.params[4] === "units_per_pack (ASIN pack update)")).toBe(true);
    expect(f.calls.some((c) => /UPDATE po_asins SET qty/.test(c.sql))).toBe(true); // Ordered recomputed
  });
});
