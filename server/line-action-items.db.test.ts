import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { writeLineItems, reconcileReviewVelocity, insertLineItems } from "./line-action-items";
import { openLineItemsSql, PO_ACTION_ITEMS_SQL } from "./po-action-items";
import { evaluateAutoClose } from "./po-close";
import { loadPoAsinRows } from "./po-queries";

// PO table v2 (migration 074) on the REAL local schema, each test inside a
// transaction that is ROLLED BACK — nothing it creates survives. Skipped only
// when no local Postgres with po_line_action_items answers.
const url = process.env.DATABASE_URL || "postgresql://localhost:5432/asinflow";
let client: pg.Client | null = null;
beforeAll(async () => {
  const c = new pg.Client({ connectionString: url });
  try { await c.connect(); await c.query("SELECT 1 FROM po_line_action_items LIMIT 0"); client = c; } catch { await c.end().catch(() => {}); }
});
afterAll(async () => { await client?.end(); });

type Q = (sql: string, params?: any[]) => Promise<any>;
/** One PO: ASIN A with two product lines (a bundle), ASIN B with one; every row fully shipped. */
async function seed(q: Q) {
  const po = (await q(`INSERT INTO purchase_orders (order_id, order_date, supplier) VALUES ('zz-v2-test', '2026-08-17', 'zz-test.com') RETURNING id`)).rows[0].id;
  const a = (await q(`INSERT INTO po_asins (po_id, asin, qty, units_per_pack, sold_as, qty_shipped_fba) VALUES ($1, 'B0ZZV2000A', 5, 1, 'bundle', 5) RETURNING id`, [po])).rows[0].id;
  const b = (await q(`INSERT INTO po_asins (po_id, asin, qty, units_per_pack, sold_as, qty_shipped_fba) VALUES ($1, 'B0ZZV2000B', 3, 1, 'individual', 3) RETURNING id`, [po])).rows[0].id;
  const line = async (pa: string, pos: number) => (await q(`INSERT INTO po_line_items (po_id, po_asin_id, position, product_name, qty_ordered) VALUES ($1, $2, $3, 'zz', 5) RETURNING id`, [po, pa, pos])).rows[0].id as string;
  const a1 = await line(a, 0), a2 = await line(a, 1), b1 = await line(b, 2);
  return { po, a, b, a1, a2, b1 };
}
const open = async (q: Q, lineId: string) => (await q(`SELECT item, source, reason FROM po_line_action_items WHERE po_line_item_id = $1 AND cleared_at IS NULL ORDER BY item`, [lineId])).rows;
async function inTx(fn: (q: Q) => Promise<void>) {
  const q: Q = (sql, params) => client!.query(sql, params);
  await q("BEGIN");
  try { await fn(q); } finally { await q("ROLLBACK"); }
  expect((await client!.query(`SELECT count(*)::int AS n FROM purchase_orders WHERE order_id = 'zz-v2-test'`)).rows[0].n).toBe(0);
}

describe("po_line_action_items on the real schema (rolled back)", () => {
  it("rollup: a line's item shows on its ASIN row and the PO; the ASIN write-through sets every line of that ASIN only", async (ctx) => {
    if (!client) return ctx.skip();
    await inTx(async (q) => {
      const s = await seed(q);
      await writeLineItems(q, s.po, [s.a1, s.a2], ["See comments"], null);
      expect(await open(q, s.a1)).toEqual([{ item: "See comments", source: "manual", reason: null }]);
      expect(await open(q, s.a2)).toEqual([{ item: "See comments", source: "manual", reason: null }]);
      expect(await open(q, s.b1)).toEqual([]);
      await writeLineItems(q, s.po, [s.b1], ["SHIP"], null);
      const rows = await loadPoAsinRows(q as any, [s.po]);
      const byAsin = Object.fromEntries(rows.map((r: any) => [r.asin, r.action_items]));
      expect(byAsin).toEqual({ B0ZZV2000A: ["See comments"], B0ZZV2000B: ["SHIP"] });
      expect(rows.find((r: any) => r.asin === "B0ZZV2000A").lines.map((l: any) => l.action_items)).toEqual([["See comments"], ["See comments"]]);
      const po = (await q(`SELECT ${PO_ACTION_ITEMS_SQL} AS items FROM purchase_orders p WHERE p.id = $1`, [s.po])).rows[0].items;
      expect([...po].sort()).toEqual(["SHIP", "See comments"]);
      // removing on the ASIN clears every line of it (cleared_by manual), History has one row per line changed
      await writeLineItems(q, s.po, [s.a1, s.a2], [], null);
      expect(await open(q, s.a1)).toEqual([]);
      expect((await q(`SELECT count(*)::int AS n FROM po_line_action_items WHERE po_line_item_id = ANY($1::uuid[]) AND cleared_by = 'manual'`, [[s.a1, s.a2]])).rows[0].n).toBe(2);
      expect((await q(`SELECT count(*)::int AS n FROM po_edit_log WHERE po_id = $1 AND field = 'action_items'`, [s.po])).rows[0].n).toBe(5);
    });
  });
  it("the any-line filter matches the PO when one line of one ASIN carries the item", async (ctx) => {
    if (!client) return ctx.skip();
    await inTx(async (q) => {
      const s = await seed(q);
      const hits = async (items: string[]) => (await q(`SELECT p.id FROM purchase_orders p WHERE p.id = $1 AND EXISTS (${openLineItemsSql("l.po_id = p.id AND ai.item = ANY($2::text[])")})`, [s.po, items])).rows.length;
      expect(await hits(["Need to return"])).toBe(0);
      await insertLineItems(q, s.a2, ["Need to return"], "manual");
      expect(await hits(["Need to return"])).toBe(1);
      expect(await hits(["SHIP", "Need to return"])).toBe(1);
    });
  });
  it("auto-close: closes when nothing is open; one open line keeps it open; an auto-closed PO reopens when a line gets an item", async (ctx) => {
    if (!client) return ctx.skip();
    await inTx(async (q) => {
      const s = await seed(q);
      await insertLineItems(q, s.b1, ["ATTN: Velocity"], "manual");
      expect((await evaluateAutoClose(s.po, q as any)).closed).toBe(false);
      await writeLineItems(q, s.po, [s.b1], [], null);
      expect(await evaluateAutoClose(s.po, q as any)).toMatchObject({ closed: true, changed: "closed" });
      await insertLineItems(q, s.a2, ["Missing / damaged from supplier"], "manual");
      expect(await evaluateAutoClose(s.po, q as any)).toMatchObject({ closed: false, changed: "reopened" });
    });
  });
  it("Review Velocity: set on every line with the reason, re-reasoned when it changes, cleared auto / manual", async (ctx) => {
    if (!client) return ctx.skip();
    await inTx(async (q) => {
      const s = await seed(q);
      const t = (await q(`INSERT INTO po_tracking (po_id, carrier, tracking_number, gmail_message_id, status, review_reason, source) VALUES ($1, 'UPS', 'ZZV2TRACK1', 'zz-v2-msg', 'matched', 'not in Velocity', 'manual') RETURNING id`, [s.po])).rows[0].id;
      expect(await reconcileReviewVelocity(q as any, [s.po])).toEqual({ set: 3, cleared: 0 });
      for (const l of [s.a1, s.a2, s.b1]) expect(await open(q, l)).toEqual([{ item: "Review Velocity", source: "auto", reason: "not in Velocity" }]);
      // idempotent
      expect(await reconcileReviewVelocity(q as any, [s.po])).toEqual({ set: 0, cleared: 0 });
      await q(`UPDATE po_tracking SET review_reason = 'address mismatch' WHERE id = $1`, [t]);
      await reconcileReviewVelocity(q as any, [s.po]);
      expect((await open(q, s.b1))[0].reason).toBe("address mismatch");
      // hand clear (suppressed_at) → cleared as manual on every line
      await q(`UPDATE po_tracking SET suppressed_at = now() WHERE id = $1`, [t]);
      expect((await reconcileReviewVelocity(q as any, [s.po])).cleared).toBe(3);
      expect((await q(`SELECT DISTINCT cleared_by FROM po_line_action_items ai JOIN po_line_items l ON l.id = ai.po_line_item_id WHERE l.po_id = $1 AND ai.reason = 'address mismatch'`, [s.po])).rows).toEqual([{ cleared_by: "manual" }]);
      // and an editor can never set or clear it
      await writeLineItems(q, s.po, [s.b1], ["Review Velocity", "SHIP"], null);
      expect((await open(q, s.b1)).map((r: any) => r.item)).toEqual(["SHIP"]);
    });
  });
});
