import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { linkUnmatchedLine } from "./shipment-link";
import { clearExtraUnits } from "./extra-units";
import { extraUnits } from "./po-action-items";

// "Link to PO ASIN" against the REAL schema (2026-10-29): the route selected
// v.fba_shipment_ids, which velocity_shipments never had, and every link
// failed in production — the mock-DB tests could not see it. This runs the
// whole action (select, insert, resolve stamp, auto-close, row reload) on
// the local database inside one transaction that is ROLLED BACK: nothing it
// creates survives. Skipped only when no local Postgres answers.
const url = process.env.DATABASE_URL || "postgresql://localhost:5432/asinflow";
let client: pg.Client | null = null;

beforeAll(async () => {
  const c = new pg.Client({ connectionString: url });
  try { await c.connect(); await c.query("SELECT 1 FROM shipment_unmatched LIMIT 0"); client = c; } catch { await c.end().catch(() => {}); }
});
afterAll(async () => { await client?.end(); });

describe("linkUnmatchedLine on the real schema (rolled back)", () => {
  it("links a matched-SC line: shipment row with the shipment's FBA ids, line resolved as picker, PO re-evaluated", async (ctx) => {
    if (!client) return ctx.skip();
    const q = (sql: string, params?: any[]) => client!.query(sql, params);
    await q("BEGIN");
    try {
      const po = (await q(`INSERT INTO purchase_orders (order_id, order_date, supplier) VALUES ('zz-link-test', '2026-08-16', 'zz-test.com') RETURNING id`)).rows[0].id;
      const pa = (await q(`INSERT INTO po_asins (po_id, asin, qty, units_per_pack, sold_as) VALUES ($1, 'B0ZZTEST01', 5, 1, 'individual') RETURNING id`, [po])).rows[0].id;
      await q(`INSERT INTO velocity_shipments (id, status, raw, shipped_at, sc_shipment_ids, sc_match) VALUES ('zz-vship', 'shipped', '{}'::jsonb, '2026-09-21', ARRAY['FBA19ZZTEST1'], 'matched')`);
      const u = (await q(
        `INSERT INTO shipment_unmatched (velocity_shipment_id, velocity_order_id, line, reason) VALUES ('zz-vship', 'zz-vorder', $1::jsonb, 'no_order') RETURNING id`,
        [JSON.stringify({ asin: "B0ZZTEST01", retailer: "Carters", quantity_shipped: 5 })],
      )).rows[0].id;

      const out = await linkUnmatchedLine(q as any, u, pa);
      expect(out.status).toBe(200);
      if (out.status !== 200) return;
      expect(out.body.qty).toBe(5);
      const row = (await q(`SELECT qty_shipped::float AS qty, fba_shipment_ids, sc_match, shipped_at::text AS shipped_at, source FROM po_asin_shipments WHERE po_asin_id = $1`, [pa])).rows[0];
      expect(row).toEqual({ qty: 5, fba_shipment_ids: ["FBA19ZZTEST1"], sc_match: "matched", shipped_at: "2026-09-21", source: "velocity" });
      const stamp = (await q(`SELECT resolved_at IS NOT NULL AS resolved, resolved_po_asin_id, match_reason FROM shipment_unmatched WHERE id = $1`, [u])).rows[0];
      expect(stamp).toEqual({ resolved: true, resolved_po_asin_id: pa, match_reason: "picker" });
      expect(String(out.body.row?.id)).toBe(String(pa));
      // a second link of the same line is refused
      expect((await linkUnmatchedLine(q as any, u, pa)).status).toBe(409);
    } finally {
      await q("ROLLBACK");
    }
    expect((await client.query(`SELECT count(*)::int AS n FROM purchase_orders WHERE order_id = 'zz-link-test'`)).rows[0].n).toBe(0);
  });
  it("refuses a bad or unknown ASIN row and an unknown line", async (ctx) => {
    if (!client) return ctx.skip();
    const q = (sql: string, params?: any[]) => client!.query(sql, params);
    expect((await linkUnmatchedLine(q as any, "00000000-0000-0000-0000-000000000000", "nope")).status).toBe(400);
    expect((await linkUnmatchedLine(q as any, "00000000-0000-0000-0000-000000000000", "00000000-0000-0000-0000-000000000000")).status).toBe(404);
  });
});

describe("Extra units shipped on the real schema (rolled back, 2026-10-29)", () => {
  // CAR118805142_1 shape: the row already has 5 of 5 shipped; linking 5 more overshoots.
  async function seed(q: (sql: string, params?: any[]) => Promise<any>) {
    const po = (await q(`INSERT INTO purchase_orders (order_id, order_date, supplier) VALUES ('zz-extra-test', '2026-08-17', 'zz-test.com') RETURNING id`)).rows[0].id;
    const pa = (await q(`INSERT INTO po_asins (po_id, asin, qty, units_per_pack, sold_as) VALUES ($1, 'B0ZZTEST02', 5, 1, 'individual') RETURNING id`, [po])).rows[0].id;
    await q(`INSERT INTO velocity_shipments (id, status, raw, shipped_at, sc_match) VALUES ('zz-vship-a', 'shipped', '{}'::jsonb, '2026-08-26', 'none'), ('zz-vship-b', 'shipped', '{}'::jsonb, '2026-09-02', 'none')`);
    await q(`INSERT INTO po_asin_shipments (po_asin_id, velocity_shipment_id, qty_shipped, source) VALUES ($1, 'zz-vship-a', 5, 'velocity')`, [pa]);
    const u = (await q(`INSERT INTO shipment_unmatched (velocity_shipment_id, velocity_order_id, line, reason) VALUES ('zz-vship-b', 'zz-vorder', $1::jsonb, 'po_not_found') RETURNING id`,
      [JSON.stringify({ asin: "B0ZZTEST02", order_number: "ZZ1_1", quantity_shipped: 5 })])).rows[0].id;
    return { po, pa, u };
  }
  it("the link guard: overshoot refused with nothing written; confirm needs a note; confirmed → 10 of 5, note on the row and in History, item raised", async (ctx) => {
    if (!client) return ctx.skip();
    const q = (sql: string, params?: any[]) => client!.query(sql, params);
    await q("BEGIN");
    try {
      const { po, pa, u } = await seed(q);
      const refused = await linkUnmatchedLine(q as any, u, pa);
      expect(refused).toMatchObject({ status: 409, body: { code: "overshoot", ordered: 5, shipped_before: 5, shipped_after: 10 } });
      expect((await q(`SELECT resolved_at FROM shipment_unmatched WHERE id = $1`, [u])).rows[0].resolved_at).toBeNull();
      expect((await linkUnmatchedLine(q as any, u, pa, { confirmOvershoot: true, note: "  " })).status).toBe(400);
      const ok = await linkUnmatchedLine(q as any, u, pa, { confirmOvershoot: true, note: "removal order 9/16 for 4" });
      expect(ok.status).toBe(200);
      if (ok.status !== 200) return;
      expect(Number(ok.body.row.qty_shipped_fba)).toBe(10);
      expect(ok.body.row.action_items).toContain("Extra units shipped");
      expect(ok.body.row.extra_units_note).toBe("removal order 9/16 for 4");
      const log = (await q(`SELECT field, new_value FROM po_edit_log WHERE po_id = $1`, [po])).rows;
      expect(log).toEqual([{ field: "extra_units_shipped", new_value: "10 of 5 ordered (linked ZZ1_1): removal order 9/16 for 4" }]);
      // the PO-level union carries it and it blocks auto-close
      expect(ok.body.close.closed).toBe(false);
    } finally { await q("ROLLBACK"); }
  });
  it("clear by hand needs a note; it hides the item until more units ship past the cleared value; reconciling clears it", async (ctx) => {
    if (!client) return ctx.skip();
    const q = (sql: string, params?: any[]) => client!.query(sql, params);
    await q("BEGIN");
    try {
      const { po, pa } = await seed(q);
      await q(`UPDATE po_asin_shipments SET qty_shipped = 7 WHERE po_asin_id = $1`, [pa]);
      expect((await clearExtraUnits(q as any, pa, "", null)).status).toBe(400);
      const ok = await clearExtraUnits(q as any, pa, "supplier sent 2 free", null);
      expect(ok.status).toBe(200);
      if (ok.status !== 200) return;
      expect(ok.body.row.action_items).not.toContain("Extra units shipped");
      expect(ok.body.row.extra_units_note).toBe("supplier sent 2 free");
      expect((await q(`SELECT field, old_value, new_value FROM po_edit_log WHERE po_id = $1`, [po])).rows).toEqual([{ field: "extra_units_cleared", old_value: "7 of 5 ordered", new_value: "supplier sent 2 free" }]);
      const items = async () => (await q(`SELECT 1 FROM po_asins pa WHERE pa.id = $1 AND ${extraUnits("pa")}`, [pa])).rows.length > 0;
      await q(`UPDATE po_asin_shipments SET qty_shipped = 8 WHERE po_asin_id = $1`, [pa]);
      expect(await items()).toBe(true);
      await q(`UPDATE po_asin_shipments SET qty_shipped = 5 WHERE po_asin_id = $1`, [pa]);
      expect(await items()).toBe(false);
      expect((await clearExtraUnits(q as any, pa, "x", null)).status).toBe(409);
    } finally { await q("ROLLBACK"); }
    expect((await client.query(`SELECT count(*)::int AS n FROM purchase_orders WHERE order_id = 'zz-extra-test'`)).rows[0].n).toBe(0);
  });
});
