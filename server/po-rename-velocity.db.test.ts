// The shared-old-number guard on the REAL local schema, rolled back (Maria 2026-11-13): two identical POs under the
// same placeholder order #, one renamed through editPoHeader → no Velocity write, the warning shown. Skipped when no
// local Postgres answers.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { editPoHeader } from "./po-edit";
import { syncVelocityAfterOrderIdRename, posSharingOrderId } from "./po-rename-velocity";

const url = process.env.DATABASE_URL || "postgresql://localhost:5432/asinflow";
let client: pg.Client | null = null;
beforeAll(async () => {
  const c = new pg.Client({ connectionString: url });
  try { await c.connect(); await c.query("SELECT 1 FROM velocity_order_links LIMIT 0"); client = c; } catch { await c.end().catch(() => {}); }
});
afterAll(async () => { await client?.end(); });
type Q = (sql: string, params?: any[]) => Promise<any>;
const ASIN = "ZZRENAME01";

async function seedPo(q: Q, orderId: string, supplier = "zz-rename.com") {
  const po = (await q(`INSERT INTO purchase_orders (order_id, order_date, supplier, order_total, cost_formula_version, ships_to, source)
    VALUES ($1, '2026-11-13', $2, 10, 3, 'velocity', 'extension') RETURNING id`, [orderId, supplier])).rows[0].id as string;
  await q(`INSERT INTO po_asins (po_id, asin, qty, qty_basis, cost_per_unit, prep_cost, sold_as, units_per_pack) VALUES ($1, $2, 4, 'individual', 5, 1, 'individual', 1)`, [po, ASIN]);
  return po;
}

describe("order # rename guard (real schema, rolled back)", () => {
  it("two identical POs under the same placeholder, one renamed → AF saves the rename, Velocity is not written, the warning says shared", async (ctx) => {
    if (!client) return ctx.skip();
    const q: Q = (sql, params) => client!.query(sql, params);
    await q("BEGIN");
    try {
      await q(`INSERT INTO asins (asin, title) VALUES ($1, 'zz rename test')`, [ASIN]);
      const a = await seedPo(q, "no_poid_at_checkout");
      const b = await seedPo(q, "no_poid_at_checkout", "zz-rename-2.com");
      // The rename itself (the route's transaction) succeeds.
      const r = await editPoHeader(q, a, { order_id: "1372131" }, null);
      expect(r.changes.map((c) => [c.field, c.old, c.new])).toEqual([["order_id", "no_poid_at_checkout", "1372131"]]);
      // (a local copy of production may hold real POs under the placeholder too — the other seeded PO is among them)
      expect((await posSharingOrderId(q, a, "no_poid_at_checkout")).map((p) => p.id)).toContain(b);
      // After the commit: the Velocity step sees the shared old number and writes nothing.
      let puts = 0;
      const v = await syncVelocityAfterOrderIdRename(q, { poId: a, oldOrderId: "no_poid_at_checkout", newOrderId: "1372131" }, null, {
        fetchKnown: async () => [{ order_id: "v-1", order_number: "no_poid_at_checkout", asin: ASIN, status: "inbound", lifecycleSource: "inbound", date: "11/13/2026", sold_as: "individual" } as any],
        update: async () => { puts++; }, log: () => {},
      });
      expect([v.outcome, puts]).toEqual(["shared", 0]);
      expect(v.warning).toMatch(/^Velocity not updated: old order # is shared by \d+ orders, link by hand$/);
      expect((await q(`SELECT count(*)::int AS n FROM velocity_order_links l JOIN po_asins pa ON pa.id = l.po_asin_id WHERE pa.po_id = $1`, [a])).rows[0].n).toBe(0);
      expect((await q(`SELECT order_id, alt_order_ids FROM purchase_orders WHERE id = $1`, [a])).rows[0]).toEqual({ order_id: "1372131", alt_order_ids: null });
      // An alternate on another PO counts as shared too.
      await q(`UPDATE purchase_orders SET order_id = 'OTHER-9', alt_order_ids = 'no_poid_at_checkout' WHERE id = $1`, [b]);
      expect((await posSharingOrderId(q, a, "no_poid_at_checkout")).map((p) => p.id)).toContain(b);
    } finally { await q("ROLLBACK"); }
    expect((await client!.query(`SELECT count(*)::int AS n FROM asins WHERE asin = $1`, [ASIN])).rows[0].n).toBe(0);
  });
});
