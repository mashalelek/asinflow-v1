import { describe, it, expect } from "vitest";
import { createPoFromForm } from "./po-create";
import { emptyPoForm, emptyProduct } from "@shared/po-form";

// po-af-owned §4: a form-created PO is laid out as the importer would, source
// 'manual', entry_seq = creation time, one creation log row.
function fake(dupe = false) {
  const calls: Array<{ sql: string; params: any[] }> = [];
  let n = 0;
  const q = async (sql: string, params: any[] = []) => {
    calls.push({ sql, params });
    if (/SELECT id FROM purchase_orders WHERE supplier/.test(sql)) return { rows: dupe ? [{ id: "x" }] : [], rowCount: dupe ? 1 : 0 };
    if (/SELECT title, primary_sku FROM asins/.test(sql)) return { rows: [{ title: "Catalog title", primary_sku: "SKU-1" }], rowCount: 1 };
    if (/RETURNING id/.test(sql)) return { rows: [{ id: `id${++n}` }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  };
  return { q, calls };
}
const form = () => ({
  ...emptyPoForm("2026-10-18"), supplier: "walmart.com", order_id: "zz-200015000000001",
  products: [
    { ...emptyProduct(), product_name: "Epsom Salt Soak", price: "3.00", qty_ordered: "7", asin: "B0GNHTYGPF", sold_as: "bundle" as const, units_per_pack: "2" },
    { ...emptyProduct(), product_name: "Body Wash", price: "4.00", qty_ordered: "7", asin: "B0GNHTYGPF", sold_as: "bundle" as const, units_per_pack: "2" },
    { ...emptyProduct(), product_name: "Pens", price: "5.44", qty_ordered: "5", asin: "b0test0001" },
  ],
});

describe("createPoFromForm", () => {
  it("inserts the PO (manual, Open, entry_seq = now), one ASIN row per ASIN with its lines, and logs the creation", async () => {
    const { q, calls } = fake();
    const now = new Date(2026, 9, 18, 12, 0, 0);
    const r = await createPoFromForm(q, form(), 7, now);
    expect(r).toEqual({ poId: "id1", asins: 2, lines: 3 });
    const po = calls.find((c) => /^INSERT INTO purchase_orders/.test(c.sql))!;
    expect(po.sql).toMatch(/'manual', \$16\)/);
    expect(po.params.slice(0, 4)).toEqual(["zz-200015000000001", "2026-10-18", "walmart.com", "76.20"]);
    expect(po.params[15]).toBe(now.getTime());
    const pas = calls.filter((c) => /^INSERT INTO po_asins/.test(c.sql)).map((c) => c.params);
    expect(pas).toEqual([
      ["id1", "B0GNHTYGPF", "Catalog title", "SKU-1", 7, "7.00", "1.00", "bundle", 2, 2],
      ["id1", "B0TEST0001", "Catalog title", "SKU-1", 5, "5.44", "1.00", "individual", 1, null],
    ]);
    const lines = calls.filter((c) => /^INSERT INTO po_line_items/.test(c.sql)).map((c) => [c.params[1], c.params[2], c.params[3], c.params[6]]);
    expect(lines).toEqual([["id2", 0, "Epsom Salt Soak", 7], ["id2", 1, "Body Wash", 7], ["id3", 0, "Pens", 5]]);
    const log = calls.find((c) => /INSERT INTO po_edit_log/.test(c.sql))!;
    expect(log.params).toEqual(["id1", 7, "po", "id1", "PO created", null, "walmart.com zz-200015000000001 — 2 ASIN(s), 3 product(s)"]);
  });
  it("refuses an invalid form (400) and an existing (supplier, order #) (409) before writing anything", async () => {
    const bad = fake();
    await expect(createPoFromForm(bad.q, { ...form(), order_id: "" }, 7)).rejects.toMatchObject({ status: 400 });
    expect(bad.calls).toHaveLength(0);
    const dup = fake(true);
    await expect(createPoFromForm(dup.q, form(), 7)).rejects.toMatchObject({ status: 409, message: "a PO walmart.com zz-200015000000001 already exists" });
    expect(dup.calls.some((c) => /^INSERT/.test(c.sql))).toBe(false);
  });
});
