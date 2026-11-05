import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { PO_ACTION_ITEMS_SQL, PO_CLOSE_ACTION_ITEMS_SQL } from "./po-action-items";
import { REPLACEMENT_TRACKING_ITEM } from "./po-status-map";
import { replacementCheckedIn, REPLACEMENT_TRACKING_PAIRS } from "./tracking-replacement-pair";

// The replacement pair's item resolving once the to-PO is fully checked in at Velocity (2026-11-05, SPEC §26),
// on the real local schema, rolled back.
const url = process.env.DATABASE_URL || "postgresql://localhost:5432/asinflow";
let client: pg.Client | null = null;
beforeAll(async () => {
  const c = new pg.Client({ connectionString: url });
  try { await c.connect(); await c.query("SELECT 1 FROM po_asins LIMIT 0"); client = c; } catch { await c.end().catch(() => {}); }
});
afterAll(async () => { await client?.end(); });

type Q = (sql: string, params?: any[]) => Promise<any>;
async function inTx(fn: (q: Q) => Promise<void>) {
  const q: Q = (sql, params) => client!.query(sql, params);
  await q("BEGIN");
  try { await fn(q); } finally { await q("ROLLBACK"); }
  expect((await client!.query(`SELECT count(*)::int AS n FROM purchase_orders WHERE supplier = 'zz-derived-test.com'`)).rows[0].n).toBe(0);
}
const po = async (q: Q, o: { order_id: string; days_ago: number }) =>
  (await q(`INSERT INTO purchase_orders (order_id, order_date, supplier, source) VALUES ($1, (NOW() AT TIME ZONE 'America/New_York')::date - $2::int, 'zz-derived-test.com', 'extension') RETURNING id`,
    [o.order_id, o.days_ago])).rows[0].id as string;
const items = async (q: Q, sql: string, id: string) => (await q(`SELECT ${sql} AS items FROM purchase_orders p WHERE p.id = $1`, [id])).rows[0].items as string[];

describe("the replacement pair's item resolves once 200015557295492 is fully checked in at Velocity", () => {
  it("shown at 11 of 12 singles (5.5 of 6 two-packs), gone at 6 of 6; the push then sends nothing to it", async (ctx) => {
    if (!client) return ctx.skip();
    const pair = REPLACEMENT_TRACKING_PAIRS[0];
    await inTx(async (q) => {
      // Any local copies of the pair step aside inside the transaction.
      await q(`UPDATE purchase_orders SET order_id = order_id || '-zz-aside' WHERE order_id IN ($1, $2)`, [pair.fromOrderId, pair.toOrderId]);
      const from = await po(q, { order_id: pair.fromOrderId, days_ago: 0 });
      const to = await po(q, { order_id: pair.toOrderId, days_ago: 7 });
      const row = (await q(`INSERT INTO po_asins (po_id, asin, qty, units_per_pack, sold_as, received_velocity) VALUES ($1, 'B006T0U4R4', 6, 2, 'multi-pack', 5.5) RETURNING id`, [to])).rows[0].id;
      expect(await items(q, PO_ACTION_ITEMS_SQL, from)).toContain(REPLACEMENT_TRACKING_ITEM);
      expect(await replacementCheckedIn(q, pair)).toBe(false);
      await q(`UPDATE po_asins SET received_velocity = 6 WHERE id = $1`, [row]);
      expect(await items(q, PO_ACTION_ITEMS_SQL, from)).not.toContain(REPLACEMENT_TRACKING_ITEM);
      expect(await items(q, PO_CLOSE_ACTION_ITEMS_SQL, from)).not.toContain(REPLACEMENT_TRACKING_ITEM);
      expect(await replacementCheckedIn(q, pair)).toBe(true);
    });
  });
});
