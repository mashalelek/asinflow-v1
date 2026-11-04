import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { loadPoForm, savePoForm } from "./po-edit-form";
import { EditError } from "./po-edit";
import type { PoFormState } from "@shared/po-form";

// Edit PO as a page (Maria 2026-11-04) on the REAL local schema, each test
// inside a transaction that is ROLLED BACK — nothing it creates survives.
// Skipped only when no local Postgres answers.
const url = process.env.DATABASE_URL || "postgresql://localhost:5432/asinflow";
let client: pg.Client | null = null;
beforeAll(async () => {
  const c = new pg.Client({ connectionString: url });
  try { await c.connect(); await c.query("SELECT 1 FROM po_payments LIMIT 0"); client = c; } catch { await c.end().catch(() => {}); }
});
afterAll(async () => { await client?.end(); });

type Q = (sql: string, params?: any[]) => Promise<any>;
/** One PO: ASIN A (multi-pack × 2, one 12-count line), ASIN B (individual, one line with NULL integers); a payment and a promo. */
async function seed(q: Q, costFormulaVersion: number | null) {
  const po = (await q(`INSERT INTO purchase_orders (order_id, order_date, supplier, subtotal, tax, sh_donations, discount, refund_amount, order_total, cost_formula_version, ships_to, notes)
    VALUES ('zz-edit-form', '2026-10-28', 'zz-test.com', 29.00, 0, 0, 0, 0, 29.00, $1, 'velocity', NULL) RETURNING id`, [costFormulaVersion])).rows[0].id as string;
  const a = (await q(`INSERT INTO po_asins (po_id, asin, qty, cost_per_unit, sourcing_cost, paid_cost, prep_cost, sold_as, units_per_pack) VALUES ($1, 'B0ZZEDIT0A', 12, 7.77, 6.66, 5.55, 1.00, 'multi-pack', 2) RETURNING id`, [po])).rows[0].id as string;
  const b = (await q(`INSERT INTO po_asins (po_id, asin, qty, cost_per_unit, prep_cost, sold_as, units_per_pack) VALUES ($1, 'B0ZZEDIT0B', 3, 3.00, 1.00, 'individual', 1) RETURNING id`, [po])).rows[0].id as string;
  const l1 = (await q(`INSERT INTO po_line_items (po_id, po_asin_id, position, product_name, price, qty_ordered, asin_qty_per_product, retailer_units_per_product, asin_units_per_pack) VALUES ($1, $2, 0, 'zz tea 12ct', 10.00, 2, 6, 12, 2) RETURNING id`, [po, a])).rows[0].id as string;
  const l2 = (await q(`INSERT INTO po_line_items (po_id, po_asin_id, position, product_name, price, qty_ordered, asin_qty_per_product) VALUES ($1, $2, 1, 'zz soap', 3.00, 3, 1) RETURNING id`, [po, b])).rows[0].id as string;
  const pay = (await q(`INSERT INTO po_payments (po_id, position, method, nickname, amount) VALUES ($1, 0, 'card', 'zz card', 29.00) RETURNING id`, [po])).rows[0].id as number;
  await q(`INSERT INTO po_promos (po_id, position, type, description, amount, counts_toward_cogs, source) VALUES ($1, 0, 'rewards', 'zz cash', 1.00, false, 'manual')`, [po]);
  return { po, a, b, l1, l2, pay: Number(pay) };
}
const log = async (q: Q, po: string) => (await q(`SELECT entity, field, old_value, new_value FROM po_edit_log WHERE po_id = $1 ORDER BY id`, [po])).rows;
const clone = (f: PoFormState): PoFormState => JSON.parse(JSON.stringify(f));
async function inTx(fn: (q: Q) => Promise<void>) {
  const q: Q = (sql, params) => client!.query(sql, params);
  await q("BEGIN");
  try { await fn(q); } finally { await q("ROLLBACK"); }
  expect((await client!.query(`SELECT count(*)::int AS n FROM purchase_orders WHERE order_id = 'zz-edit-form'`)).rows[0].n).toBe(0);
}

describe("Edit PO — load and save on the real schema (rolled back)", () => {
  it("open and Save on an untouched PO writes nothing; the form carries the stored rows and the Last edited line", async (ctx) => {
    if (!client) return ctx.skip();
    await inTx(async (q) => {
      const s = await seed(q, null);
      const load = (await loadPoForm(q as any, s.po))!;
      expect(load.imported).toBe(true);
      expect(load.form.products.map((p) => [p.line_item_id, p.asin, p.asin_qty_per_product])).toEqual([[s.l1, "B0ZZEDIT0A", "6"], [s.l2, "B0ZZEDIT0B", "1"]]);
      expect(load.form.cost_overrides).toEqual({ B0ZZEDIT0A: "7.77", B0ZZEDIT0B: "3.00" });
      expect(load.last_edit).toBeNull();
      const r = await savePoForm(q as any, s.po, clone(load.form), 7);
      expect(r.changes).toBe(0);
      expect(await log(q, s.po)).toEqual([]);
      expect(await loadPoForm(q as any, "not-a-uuid")).toBeNull();
    });
  });
  it("an imported PO: one History row per changed field; its stored Sourcing / COGS / Paid stay as stored", async (ctx) => {
    if (!client) return ctx.skip();
    await inTx(async (q) => {
      const s = await seed(q, null);
      const f = clone((await loadPoForm(q as any, s.po))!.form);
      f.notes = "zz dented"; f.products[0].price = "9.50"; f.payments = [];
      f.promos!.push({ type: "coupon", description: "zz SAVE1", amount: "1", percent: "", counts_toward_cogs: true });
      const r = await savePoForm(q as any, s.po, f, null);
      const rows = await log(q, s.po);
      expect(rows).toEqual(expect.arrayContaining([
        { entity: "po", field: "notes", old_value: null, new_value: "zz dented" },
        { entity: "line", field: "price", old_value: "10", new_value: "9.5" },
        expect.objectContaining({ entity: "po", field: "payment removed" }),
        expect.objectContaining({ entity: "po", field: "promo added" }),
      ]));
      expect(r.changes).toBe(rows.length);
      const a = (await q(`SELECT cost_per_unit, sourcing_cost, paid_cost FROM po_asins WHERE id = $1`, [s.a])).rows[0];
      expect([a.cost_per_unit, a.sourcing_cost, a.paid_cost].map(Number)).toEqual([7.77, 6.66, 5.55]);
      expect((await loadPoForm(q as any, s.po))!.last_edit).not.toBeNull();
    });
  });
  it("a v2 PO: a qty change recomputes its costs; a removed line goes, its ASIN row with it", async (ctx) => {
    if (!client) return ctx.skip();
    await inTx(async (q) => {
      const s = await seed(q, 2);
      const f = clone((await loadPoForm(q as any, s.po))!.form);
      f.products[0].qty_ordered = "1"; f.subtotal = "13.00"; f.order_total = "13.00";
      f.products = f.products.filter((p) => p.line_item_id !== s.l2);
      await savePoForm(q as any, s.po, f, null);
      const a = (await q(`SELECT qty, cost_per_unit, sourcing_cost FROM po_asins WHERE id = $1`, [s.a])).rows[0];
      expect(Number(a.qty)).toBe(6);
      expect(Number(a.sourcing_cost)).toBeCloseTo(10 / 6, 2);
      expect((await q(`SELECT count(*)::int AS n FROM po_asins WHERE id = $1`, [s.b])).rows[0].n).toBe(0);
    });
  });
  it("a refused step throws (the route's transaction rolls the whole save back): removing a line whose ASIN row shipped to FBA", async (ctx) => {
    if (!client) return ctx.skip();
    await inTx(async (q) => {
      const s = await seed(q, null);
      await q(`INSERT INTO po_asin_shipments (po_asin_id, velocity_shipment_id, qty_shipped, source, fba_shipment_ids) VALUES ($1, 'zz-ship-1', 3, 'manual', ARRAY['FBA-ZZ-1'])`, [s.b]);
      const f = clone((await loadPoForm(q as any, s.po))!.form);
      f.products = f.products.filter((p) => p.line_item_id !== s.l2);
      await expect(savePoForm(q as any, s.po, f, null)).rejects.toBeInstanceOf(EditError);
    });
  });
});
