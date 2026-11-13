// Actual COGS on PO save (Orders-sheet retirement commit 1, 2026-11-13) on the REAL local schema, every test in a
// transaction that is ROLLED BACK: the rule reads the views of migration 107 and writes asin_estimates, so a mocked
// query would prove nothing. Skipped when no local Postgres answers.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { syncAsinCostsFromPos, syncAsinCostsAfterPoWrite, poAsinList, AF_PO_COGS_SOURCE } from "./asin-po-costs";

const url = process.env.DATABASE_URL || "postgresql://localhost:5432/asinflow";
let client: pg.Client | null = null;
beforeAll(async () => {
  const c = new pg.Client({ connectionString: url });
  try { await c.connect(); await c.query("SELECT 1 FROM po_asin_expected LIMIT 0"); client = c; } catch { await c.end().catch(() => {}); }
});
afterAll(async () => { await client?.end(); });

type Q = (sql: string, params?: any[]) => Promise<any>;
const ASIN = "ZZPOCOST01";
const noLog = () => {};

/** One PO for the ASIN: one 2-pack row, one line (Individual units), cost per unit and prep as given. */
async function seedPo(q: Q, orderId: string, orderDate: string, cost: number, prep: number | null, individualUnits = 12) {
  const po = (await q(`INSERT INTO purchase_orders (order_id, order_date, supplier, order_total, cost_formula_version, ships_to, source)
    VALUES ($1, $2, 'zz-test.com', 10, 3, 'velocity', 'extension') RETURNING id`, [orderId, orderDate])).rows[0].id as string;
  const row = (await q(`INSERT INTO po_asins (po_id, asin, qty, qty_basis, cost_per_unit, prep_cost, sold_as, units_per_pack)
    VALUES ($1, $2, $3, 'individual', $4, $5, 'multi-pack', 2) RETURNING id`, [po, ASIN, individualUnits, cost, prep])).rows[0].id as string;
  const line = (await q(`INSERT INTO po_line_items (po_id, po_asin_id, position, product_name, price, qty_ordered, qty_basis, retailer_units_per_product, asin_units_per_pack)
    VALUES ($1, $2, 0, 'zz tea', 5, $3, 'individual', 4, 2) RETURNING id`, [po, row, individualUnits])).rows[0].id as string;
  return { po, row, line };
}
const est = async (q: Q) => {
  const r = (await q(`SELECT cogs, cogs_source, actual_cogs, estimated_cogs, estimated_cogs_source, prep_override FROM asin_estimates WHERE asin = $1`, [ASIN])).rows[0];
  return r && { cogs: Number(r.cogs), source: r.cogs_source, actual: r.actual_cogs == null ? null : Number(r.actual_cogs), est: r.estimated_cogs == null ? null : Number(r.estimated_cogs), estSource: r.estimated_cogs_source, prep: r.prep_override == null ? null : Number(r.prep_override) };
};
async function inTx(fn: (q: Q) => Promise<void>) {
  const q: Q = (sql, params) => client!.query(sql, params);
  await q("BEGIN");
  try {
    await q(`INSERT INTO asins (asin, title) VALUES ($1, 'zz cost test')`, [ASIN]);
    await q(`INSERT INTO asin_estimates (asin) VALUES ($1)`, [ASIN]);
    await fn(q);
  } finally { await q("ROLLBACK"); }
  expect((await client!.query(`SELECT count(*)::int AS n FROM asins WHERE asin = $1`, [ASIN])).rows[0].n).toBe(0);
}

describe("Actual COGS follows the newest non-canceled PO (real schema, rolled back)", () => {
  it("create: the PO's cost per unit and prep land on the ASIN with source af_po; nothing written before a PO exists", async (ctx) => {
    if (!client) return ctx.skip();
    await inTx(async (q) => {
      expect((await syncAsinCostsFromPos(q, new Set([ASIN]), noLog)).updated).toBe(0);
      expect((await est(q)).actual).toBeNull();
      const s = await seedPo(q, "zz-po-1", "2026-11-01", 5.5, 1);
      expect(await poAsinList(q, s.po)).toEqual([ASIN]);
      const r = await syncAsinCostsFromPos(q, new Set([ASIN]), noLog);
      expect([r.updated, r.errors]).toEqual([1, []]);
      expect(await est(q)).toEqual({ cogs: 5.5, source: AF_PO_COGS_SOURCE, actual: 5.5, est: 5.5, estSource: AF_PO_COGS_SOURCE, prep: 1 });
      expect(AF_PO_COGS_SOURCE).toBe("af_po");
    });
  });

  it("edit cost: the changed cost per unit replaces the ASIN's value; a manual Est. COGS is left alone", async (ctx) => {
    if (!client) return ctx.skip();
    await inTx(async (q) => {
      const s = await seedPo(q, "zz-po-1", "2026-11-01", 5.5, 1);
      await syncAsinCostsFromPos(q, new Set([ASIN]), noLog);
      await q(`UPDATE po_asins SET cost_per_unit = 6.25, prep_cost = 1.5 WHERE id = $1`, [s.row]);
      await syncAsinCostsFromPos(q, new Set([ASIN]), noLog);
      expect(await est(q)).toMatchObject({ actual: 6.25, est: 6.25, prep: 1.5 });
      await q(`UPDATE asin_estimates SET estimated_cogs = 4, estimated_cogs_source = 'manual' WHERE asin = $1`, [ASIN]);
      await q(`UPDATE po_asins SET cost_per_unit = 7 WHERE id = $1`, [s.row]);
      await syncAsinCostsFromPos(q, new Set([ASIN]), noLog);
      expect(await est(q)).toMatchObject({ actual: 7, est: 4, estSource: "manual" });
    });
  });

  it("cancel the latest PO: its canceled claim drops it and the ASIN falls back to the previous PO's cost", async (ctx) => {
    if (!client) return ctx.skip();
    await inTx(async (q) => {
      await seedPo(q, "zz-po-1", "2026-11-01", 5.5, 1);
      const newer = await seedPo(q, "zz-po-2", "2026-11-10", 7.75, 2);
      await syncAsinCostsFromPos(q, new Set([ASIN]), noLog);
      expect(await est(q)).toMatchObject({ actual: 7.75, prep: 2 });
      // Cancel PO / a line's cancel: one canceled claim covering the line's ordered Individual units (D14).
      await q(`INSERT INTO supplier_claims (po_id, po_line_item_id, kind, qty, status, found_by, found_at, supplier_confirmed_at)
               VALUES ($1, $2, 'canceled', 12, 'open', 'maria', CURRENT_DATE, now())`, [newer.po, newer.line]);
      expect((await q(`SELECT fully_canceled FROM po_asin_expected WHERE id = $1`, [newer.row])).rows[0].fully_canceled).toBe(true);
      await syncAsinCostsFromPos(q, new Set([ASIN]), noLog);
      expect(await est(q)).toMatchObject({ actual: 5.5, prep: 1 });
    });
  });

  it("a backdated PO entered later does not win: newest is by order date, then entry sequence", async (ctx) => {
    if (!client) return ctx.skip();
    await inTx(async (q) => {
      await seedPo(q, "zz-po-1", "2026-11-01", 5.5, 1);
      await syncAsinCostsFromPos(q, new Set([ASIN]), noLog);
      await seedPo(q, "zz-po-0", "2026-10-01", 9.99, 3); // created now, dated earlier
      await syncAsinCostsFromPos(q, new Set([ASIN]), noLog);
      expect(await est(q)).toMatchObject({ actual: 5.5, prep: 1 });
      await seedPo(q, "zz-po-3", "2026-11-20", 8.25, 1);
      await syncAsinCostsFromPos(q, new Set([ASIN]), noLog);
      expect(await est(q)).toMatchObject({ actual: 8.25 });
    });
  });

  it("the after-write sync never throws: a failing query is logged and answers null", async () => {
    const logged: string[] = [];
    const boom: Q = async () => { throw new Error("connection lost"); };
    expect(await syncAsinCostsAfterPoWrite(boom, [ASIN], "create PO", (m) => logged.push(m))).toBeNull();
    expect(logged).toEqual(["PO costs after create PO failed (the hourly pass catches up): connection lost"]);
    expect(await syncAsinCostsAfterPoWrite(boom, [], "nothing", (m) => logged.push(m))).toBeNull();
    expect(logged).toHaveLength(1); // no ASINs: no call, no log
  });
});
