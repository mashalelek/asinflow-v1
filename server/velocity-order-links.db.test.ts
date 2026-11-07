import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { linkVelocityOrder, unlinkVelocityOrder, loadOrderLinks } from "./velocity-order-links";
import { reconcileReviewVelocity } from "./line-action-items";
import { REVIEW_VELOCITY_REASONS_SQL, HOME_PO_REVIEW_REASON } from "./po-action-items";

// velocity_order_links and the Home-PO Review Velocity (migration 099) on the
// REAL local schema, each test inside a transaction that is ROLLED BACK —
// nothing it creates survives. Skipped when no local Postgres with migration
// 099 answers.
const url = process.env.DATABASE_URL || "postgresql://localhost:5432/asinflow";
let client: pg.Client | null = null;
beforeAll(async () => {
  const c = new pg.Client({ connectionString: url });
  try { await c.connect(); await c.query("SELECT 1 FROM velocity_order_links LIMIT 0"); client = c; } catch { await c.end().catch(() => {}); }
});
afterAll(async () => { await client?.end(); });

type Q = (sql: string, params?: any[]) => Promise<any>;
async function seed(q: Q, shipsTo: "home" | "velocity" = "velocity") {
  const po = (await q(`INSERT INTO purchase_orders (order_id, order_date, supplier, ships_to) VALUES ('zz-vol-test', '2026-10-23', 'zz-test.com', $1) RETURNING id`, [shipsTo])).rows[0].id as string;
  const pa = (await q(`INSERT INTO po_asins (po_id, asin, qty, units_per_pack, sold_as) VALUES ($1, 'B0ZZVOL001', 3, 1, 'individual') RETURNING id`, [po])).rows[0].id as string;
  const line = (await q(`INSERT INTO po_line_items (po_id, po_asin_id, position, product_name, qty_ordered) VALUES ($1, $2, 0, 'zz', 3) RETURNING id`, [po, pa])).rows[0].id as string;
  return { po, pa, line };
}
async function inTx(fn: (q: Q) => Promise<void>) {
  const q: Q = (sql, params) => client!.query(sql, params);
  await q("BEGIN");
  try { await fn(q); } finally { await q("ROLLBACK"); }
  expect((await client!.query(`SELECT count(*)::int AS n FROM purchase_orders WHERE order_id = 'zz-vol-test'`)).rows[0].n).toBe(0);
}
const history = async (q: Q, po: string) => (await q(`SELECT field, old_value, new_value FROM po_edit_log WHERE po_id = $1 ORDER BY id`, [po])).rows;
const LINE = { id: 8785, order_number: "", retailer: "zz-test.com", asin: "B0ZZVOL001", quantity: 3 };

describe("velocity_order_links on the real schema (rolled back)", () => {
  it("link → History row, the order leaves the no-PO list; linking again changes nothing; unlink → History row, link gone", async (ctx) => {
    if (!client) return ctx.skip();
    await inTx(async (q) => {
      const { po, pa } = await seed(q);
      await q(`INSERT INTO velocity_orders_unplaced (velocity_order_id, line, reason) VALUES ('zz-vo-1', $1::jsonb, 'no_order')`, [JSON.stringify(LINE)]);
      expect(await linkVelocityOrder(q, { velocityOrderId: "zz-vo-1", poAsinId: pa, line: LINE, source: "manual" }, null)).toEqual({ status: 200, body: { linked: true, previous: null } });
      expect((await q(`SELECT count(*)::int AS n FROM velocity_orders_unplaced WHERE velocity_order_id = 'zz-vo-1'`)).rows[0].n).toBe(0);
      expect((await loadOrderLinks(q)).filter((l) => l.velocity_order_id === "zz-vo-1")).toEqual([{ velocity_order_id: "zz-vo-1", po_asin_id: pa, po_id: po, order_id: "zz-vol-test", supplier: "zz-test.com", asin: "B0ZZVOL001" }]);
      expect((await linkVelocityOrder(q, { velocityOrderId: "zz-vo-1", poAsinId: pa, line: LINE, source: "manual" }, null)).body).toEqual({ linked: false, previous: null });
      expect((await unlinkVelocityOrder(q, "zz-vo-1", null)).status).toBe(200);
      expect((await unlinkVelocityOrder(q, "zz-vo-1", null)).status).toBe(404);
      expect(await history(q, po)).toEqual([
        { field: "velocity_order_link", old_value: null, new_value: "Velocity #8785 (no Order #) · zz-test.com · B0ZZVOL001 · 3u" },
        { field: "velocity_order_link", old_value: "Velocity #8785 (no Order #) · zz-test.com · B0ZZVOL001 · 3u", new_value: null },
      ]);
    });
  });
  it("a different ASIN is refused, nothing written", async (ctx) => {
    if (!client) return ctx.skip();
    await inTx(async (q) => {
      const { po, pa } = await seed(q);
      const r = await linkVelocityOrder(q, { velocityOrderId: "zz-vo-2", poAsinId: pa, line: { ...LINE, asin: "B0OTHER001" }, source: "manual" }, null);
      expect(r.status).toBe(400);
      expect(await history(q, po)).toEqual([]);
    });
  });
});

describe("Review Velocity — a Velocity order on a Home PO (rolled back)", () => {
  it("open with the reason while ships_to is home; a hand clear closes it 'manual'; corrected ships_to closes it", async (ctx) => {
    if (!client) return ctx.skip();
    await inTx(async (q) => {
      const { po, line } = await seed(q, "home");
      const item = async () => (await q(`SELECT reason, source, cleared_by FROM po_line_action_items WHERE po_line_item_id = $1 AND item = 'Review Velocity' ORDER BY id DESC LIMIT 1`, [line])).rows[0];
      const reasons = async () => (await q(`SELECT ${REVIEW_VELOCITY_REASONS_SQL} AS r FROM purchase_orders p WHERE p.id = $1`, [po])).rows[0].r;
      await q(`UPDATE purchase_orders SET velocity_home_orders = '#8785' WHERE id = $1`, [po]);
      expect(await reconcileReviewVelocity(q, [po])).toEqual({ set: 1, cleared: 0 });
      expect(await item()).toEqual({ reason: HOME_PO_REVIEW_REASON, source: "auto", cleared_by: null });
      expect(await reasons()).toEqual([HOME_PO_REVIEW_REASON]);
      // cleared by hand (the Clear button on the tracking tab)
      await q(`UPDATE purchase_orders SET velocity_home_cleared_at = now() WHERE id = $1`, [po]);
      expect(await reconcileReviewVelocity(q, [po])).toEqual({ set: 0, cleared: 1 });
      expect((await item()).cleared_by).toBe("manual");
      // a new finding reopens it; ships_to corrected → cleared 'auto'
      await q(`UPDATE purchase_orders SET velocity_home_cleared_at = NULL WHERE id = $1`, [po]);
      expect(await reconcileReviewVelocity(q, [po])).toEqual({ set: 1, cleared: 0 });
      await q(`UPDATE purchase_orders SET ships_to = 'velocity' WHERE id = $1`, [po]);
      expect(await reconcileReviewVelocity(q, [po])).toEqual({ set: 0, cleared: 1 });
      expect((await item()).cleared_by).toBe("auto");
      expect(await reasons()).toEqual([]);
    });
  });
});
