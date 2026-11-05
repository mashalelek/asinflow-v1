import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { loadGrid, loadSeries, loadCoverage, poSpendCtes } from "./dashboard";

// Dashboard SQL (SPEC §28) on the REAL local schema, every test inside a
// transaction that is ROLLED BACK — nothing it creates survives. Fixtures
// live in 2031 so no real row shares a range with them; "today" is injected
// (2031-06-18, a Wednesday; 15:00Z = the same day in both zones). Skipped
// only when no local Postgres with sales_orders (migration 082) answers.
const url = process.env.DATABASE_URL || "postgresql://localhost:5432/asinflow";
let client: pg.Client | null = null;
beforeAll(async () => {
  const c = new pg.Client({ connectionString: url });
  try { await c.connect(); await c.query("SELECT 1 FROM sales_orders LIMIT 0"); client = c; } catch { await c.end().catch(() => {}); }
});
afterAll(async () => { await client?.end(); });

type Q = (sql: string, params?: any[]) => Promise<any>;
const NOW = new Date("2031-06-18T15:00:00Z");
const ASIN = "B0ZZDASH01";

/**
 * A: today, $100, 10 units × pack 2.                 B: yesterday, $50, FULLY canceled, a due refund $20 (→ Spend $0, due $20).
 * C: Monday (this week), $200, 10 units, NO pack size, line 1 of 2 partially canceled (2 of 6) with a due refund $30 (→ $170, 8 ASIN units).
 * D: 06-01 (MTD), $80, a received manual refund $10 (→ $70).   E: 05-20 (the 30-day edge), sheet-imported header already NET of its $10 refund + a 'sheet' row $10 (→ $60, not $50).
 * F: 05-19 (last month, outside 30 days), $40.          G: 04-30, $999 (custom only).
 */
async function seed(q: Q) {
  const po = async (oid: string, date: string, total: number, extra: Record<string, any> = {}) => {
    const cols = ["order_id", "order_date", "supplier", "order_total", ...Object.keys(extra)];
    const vals = [oid, date, "zz-dash.test", total, ...Object.values(extra)];
    return (await q(`INSERT INTO purchase_orders (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`, vals)).rows[0].id as string;
  };
  const asinRow = async (poId: string, qty: number, upp: number | null, soldAs = "individual") =>
    (await q(`INSERT INTO po_asins (po_id, asin, qty, units_per_pack, sold_as) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [poId, ASIN, qty, upp, soldAs])).rows[0].id as string;
  const line = async (poId: string, paId: string, pos: number, ordered: number, canceled: number | null, price = 10) =>
    (await q(`INSERT INTO po_line_items (po_id, po_asin_id, position, product_name, qty_ordered, qty_canceled, price, asin_qty_per_product) VALUES ($1, $2, $3, 'zz', $4, $5, $6, 1) RETURNING id`, [poId, paId, pos, ordered, canceled, price])).rows[0].id as string;
  const refund = (poId: string, lineId: string | null, amount: number, status: "due" | "received", source = "manual") =>
    q(`INSERT INTO po_line_refunds (po_id, po_line_item_id, amount, status, source) VALUES ($1, $2, $3, $4, $5)`, [poId, lineId, amount, status, source]);

  const A = await po("zz-A", "2031-06-18", 100); const a = await asinRow(A, 10, 2); await line(A, a, 0, 10, null);
  const B = await po("zz-B", "2031-06-17", 50); const b = await asinRow(B, 5, 1); const b1 = await line(B, b, 0, 5, 5); await refund(B, b1, 20, "due");
  const C = await po("zz-C", "2031-06-16", 200); const c = await asinRow(C, 10, null); const c1 = await line(C, c, 0, 6, 2); await line(C, c, 1, 4, null); await refund(C, c1, 30, "due");
  const D = await po("zz-D", "2031-06-01", 80); const d = await asinRow(D, 4, 1); const d1 = await line(D, d, 0, 4, null); await refund(D, d1, 10, "received");
  const E = await po("zz-E", "2031-05-20", 60, { subtotal: 70, tax: 0, sh_donations: 0, discount: 0, refund_amount: 10, source: "sheet_import" }); const e = await asinRow(E, 1, 3); const e1 = await line(E, e, 0, 1, null); await refund(E, e1, 10, "received", "sheet");
  const F = await po("zz-F", "2031-05-19", 40); const f = await asinRow(F, 2, 1); await line(F, f, 0, 2, null);
  const G = await po("zz-G", "2031-04-30", 999); const g = await asinRow(G, 1, 1); await line(G, g, 0, 1, null);

  const asinId = (await q(`INSERT INTO asins (asin) VALUES ($1) RETURNING id`, [ASIN])).rows[0].id as string;
  const sale = (date: string, units: number, revenue: number) => q(`INSERT INTO sales_daily (asin_id, sale_date, units_sold, revenue) VALUES ($1, $2, $3, $4)`, [asinId, date, units, revenue]);
  const order = (id: string, date: string, units: number) => q(`INSERT INTO sales_orders (amazon_order_id, asin_id, sale_date, units) VALUES ($1, $2, $3, $4)`, [id, asinId, date, units]);
  await sale("2031-06-18", 2, 30); await order("zz-o1", "2031-06-18", 2);
  await sale("2031-06-17", 1, 10); await order("zz-o2", "2031-06-17", 1);
  await sale("2031-06-10", 5, 50); await order("zz-o3", "2031-06-10", 3); await order("zz-o4", "2031-06-10", 2);
  await sale("2031-05-25", 1, 7); await order("zz-o5", "2031-05-25", 1);
  return { A, B, C, D, E, F, G };
}

async function inTx(fn: (q: Q) => Promise<void>) {
  const q: Q = (sql, params) => client!.query(sql, params);
  await q("BEGIN");
  try { await fn(q); } finally { await q("ROLLBACK"); }
  expect((await client!.query(`SELECT count(*)::int AS n FROM purchase_orders WHERE supplier = 'zz-dash.test'`)).rows[0].n).toBe(0);
  expect((await client!.query(`SELECT count(*)::int AS n FROM asins WHERE asin = $1`, [ASIN])).rows[0].n).toBe(0);
}
const v = (col: any, key: string) => col.cells[key].value;

describe("Dashboard grid on the real schema (rolled back)", () => {
  it("set 1 — Today · This week · MTD · 30 days: every Spend and Sales cell", async (ctx) => {
    if (!client) return ctx.skip();
    await inTx(async (q) => {
      await seed(q);
      const g = await loadGrid(q, 1, undefined, NOW);
      const [today, week, mtd, d30] = g.columns;
      expect(g.columns.map((c) => c.key)).toEqual(["today", "this_week", "mtd", "d30"]);
      expect(today.eastern).toEqual({ from: "2031-06-18", to: "2031-06-18" });
      expect(today.pacific).toEqual({ from: "2031-06-18", to: "2031-06-18" });
      // Today: PO A only
      expect(today.cells).toMatchObject({ spend: { value: 100 }, refunds_due: { value: 0 }, asin_units: { value: 10 }, individual_units: { value: 20, missingPackSize: 0 }, avg_po_value: { value: 100, poCount: 1 }, sales: { value: 30 }, orders_units: { value: 1, secondary: 2 } });
      // This week (Mon 06-16 → 06-18): A + B (forced $0, due 20) + C ($170 after the due 30, 8 ASIN units, no pack size)
      expect(week.eastern.from).toBe("2031-06-16");
      expect(v(week, "spend")).toBe(270);
      expect(v(week, "refunds_due")).toBe(50);
      expect(v(week, "asin_units")).toBe(18);
      expect(week.cells.individual_units).toEqual({ value: 28, missingPackSize: 1 });
      expect(week.cells.avg_po_value).toEqual({ value: 135, poCount: 2 }); // B not counted
      expect(v(week, "sales")).toBe(40); expect(week.cells.orders_units).toMatchObject({ value: 2, secondary: 3 });
      // MTD: + D ($70 after the received refund)
      expect(v(mtd, "spend")).toBe(340); expect(mtd.cells.avg_po_value).toEqual({ value: 113.33, poCount: 3 });
      expect(v(mtd, "asin_units")).toBe(22); expect(v(mtd, "individual_units")).toBe(32);
      expect(v(mtd, "sales")).toBe(90); expect(mtd.cells.orders_units).toMatchObject({ value: 4, secondary: 8 });
      // 30 days (05-20 → 06-18, the edge day included): + E — the sheet row on a header that already nets its refund is NOT subtracted again
      expect(d30.eastern.from).toBe("2031-05-20");
      expect(v(d30, "spend")).toBe(400); expect(d30.cells.avg_po_value).toEqual({ value: 100, poCount: 4 });
      expect(v(d30, "asin_units")).toBe(23); expect(v(d30, "individual_units")).toBe(35);
      expect(v(d30, "sales")).toBe(97); expect(d30.cells.orders_units).toMatchObject({ value: 5, secondary: 9 });
      // placeholders
      for (const k of ["refunds", "gross_profit", "net_profit", "est_payout"]) expect(today.cells[k as "refunds"]).toMatchObject({ value: null, pending: true });
      expect(g.coverage.earliestSaleDate).not.toBeNull();
      expect(today.cells.sales.dataFrom).toBeNull(); // 2031 is inside coverage
    });
  });
  it("set 2 (Yesterday = a fully-canceled PO: $0 Spend, $20 due, no PO counted; Last month = E + F), set 3 (7 / 14 days), set 4 (custom)", async (ctx) => {
    if (!client) return ctx.skip();
    await inTx(async (q) => {
      await seed(q);
      const s2 = await loadGrid(q, 2, undefined, NOW);
      const [, yesterday, , lastMonth] = s2.columns;
      expect(yesterday.cells).toMatchObject({ spend: { value: 0 }, refunds_due: { value: 20 }, asin_units: { value: 0 }, individual_units: { value: 0, missingPackSize: 0 }, avg_po_value: { value: null, poCount: 0 }, sales: { value: 10 }, orders_units: { value: 1, secondary: 1 } });
      expect(lastMonth.eastern).toEqual({ from: "2031-05-01", to: "2031-05-31" });
      expect(lastMonth.cells).toMatchObject({ spend: { value: 100 }, avg_po_value: { value: 50, poCount: 2 }, sales: { value: 7 }, orders_units: { value: 1, secondary: 1 } });
      const s3 = await loadGrid(q, 3, undefined, NOW);
      const [, , d7, d14, d30] = s3.columns;
      expect(d7.eastern.from).toBe("2031-06-12"); expect(v(d7, "spend")).toBe(270); expect(v(d7, "sales")).toBe(40);
      expect(d14.eastern.from).toBe("2031-06-05"); expect(v(d14, "spend")).toBe(270); expect(v(d14, "sales")).toBe(90);
      expect(v(d30, "spend")).toBe(400);
      const s4 = await loadGrid(q, 4, { from: "2031-04-01", to: "2031-04-30" }, NOW);
      expect(s4.columns).toHaveLength(1);
      expect(s4.columns[0]).toMatchObject({ key: "custom", eastern: { from: "2031-04-01", to: "2031-04-30" } });
      expect(s4.columns[0].cells).toMatchObject({ spend: { value: 999 }, sales: { value: 0 }, orders_units: { value: 0, secondary: 0 } });
    });
  });
  it("a sheet row on a GROSS header (AG not netting the refund — the D3 data error) IS subtracted; a manual due row on a net header too", async (ctx) => {
    if (!client) return ctx.skip();
    await inTx(async (q) => {
      const ins = async (oid: string, header: Record<string, any>) => (await q(`INSERT INTO purchase_orders (order_id, order_date, supplier, source, subtotal, tax, sh_donations, discount, refund_amount, order_total) VALUES ($1, '2031-09-10', 'zz-dash.test', 'sheet_import', $2, $3, $4, $5, $6, $7) RETURNING id`, [oid, header.subtotal, header.tax, header.sh, header.discount, header.refund, header.total])).rows[0].id;
      const gross = await ins("zz-gross", { subtotal: 100, tax: 5, sh: 0, discount: 0, refund: 30, total: 105 }); // AG = AB + AC (refund not netted)
      await q(`INSERT INTO po_line_refunds (po_id, amount, status, source) VALUES ($1, 30, 'received', 'sheet')`, [gross]);
      const net = await ins("zz-net", { subtotal: 100, tax: 5, sh: 0, discount: 0, refund: 30, total: 75 }); // AG nets it
      await q(`INSERT INTO po_line_refunds (po_id, amount, status, source) VALUES ($1, 30, 'received', 'sheet')`, [net]);
      await q(`INSERT INTO po_line_refunds (po_id, amount, status, source) VALUES ($1, 5, 'due', 'manual')`, [net]); // a later due row still counts
      const g = await loadGrid(q, 4, { from: "2031-09-10", to: "2031-09-10" }, NOW);
      expect(g.columns[0].cells.spend.value).toBe(75 + 70); // gross: 105 − 30; net: 75 − 5 (not − 30 again)
      expect(g.columns[0].cells.refunds_due.value).toBe(5);
    });
  });
});

describe("Dashboard series on the real schema (rolled back)", () => {
  it("monthly: empty months are 0, the current month is partial; weekly starts Monday; running30 sums [d−29, d] in SQL", async (ctx) => {
    if (!client) return ctx.skip();
    await inTx(async (q) => {
      await seed(q);
      const m = await loadSeries(q, "monthly", { from: "2031-03-01", to: "2031-06-18" }, NOW);
      expect(m.points.map((p) => [p.period, p.spend, p.sales, p.poCount, p.units, p.orders, p.partial])).toEqual([
        ["2031-03-01", 0, 0, 0, 0, 0, false],
        ["2031-04-01", 999, 0, 1, 0, 0, false],
        ["2031-05-01", 100, 7, 2, 1, 1, false],
        ["2031-06-01", 340, 90, 3, 8, 4, true],
      ]);
      expect(m.salesFrom).toBeNull();
      const w = await loadSeries(q, "weekly", { from: "2031-06-02", to: "2031-06-18" }, NOW);
      expect(w.points.map((p) => [p.period, p.spend, p.sales, p.partial])).toEqual([
        ["2031-06-02", 0, 0, false], ["2031-06-09", 0, 50, false], ["2031-06-16", 270, 40, true],
      ]);
      const r = await loadSeries(q, "running30", { from: "2031-06-17", to: "2031-06-18" }, NOW);
      expect(r.points).toEqual([
        { period: "2031-06-17", spend: 340, sales: 67, poCount: 4, units: 7, orders: 4, partial: false }, // [05-19, 06-17]: B(0)+C+D+E+F; sales 10+50+7
        { period: "2031-06-18", spend: 400, sales: 97, poCount: 4, units: 9, orders: 5, partial: true },  // [05-20, 06-18]: F drops out, A comes in
      ]);
    });
  });
  it("a range starting before sales coverage: salesFrom is the coverage start and earlier periods carry null sales", async (ctx) => {
    if (!client) return ctx.skip();
    await inTx(async (q) => {
      const cov = await loadCoverage(q);
      if (!cov.earliestSaleDate) return; // nothing ingested locally — nothing to assert
      const first = cov.earliestSaleDate;
      const from = `${Number(first.slice(0, 4)) - 1}-01-01`;
      const m = await loadSeries(q, "monthly", { from, to: first }, NOW);
      expect(m.salesFrom).toBe(first);
      expect(m.points[0].sales).toBeNull();
      expect(m.points[m.points.length - 1].sales).not.toBeNull();
      const g = await loadGrid(q, 4, { from, to: first }, NOW);
      expect(g.columns[0].cells.sales.dataFrom).toBe(first);
      // Pending only while sales_orders is empty: rows before the re-backfill's start day stay on the old basis by design.
      expect(cov.rebackfillPending).toBe(cov.ordersFrom == null);
    });
  });
});

// 2026-11-04 (Maria): the two Pyramyd POs "115449859" and "115449859 / 115450009" carry the one order's $255.84 header each (the sheet
// copied it onto the split row). Spend counts a shared header once; stored values are untouched.
describe("Dashboard Spend: a split PO's repeated header counts once (rolled back)", () => {
  it("two sheet-imported POs, same supplier / date / total / order # → $255.84 and 1 PO; a repeat order (other date or other #) and a form-saved PO still count", async (ctx) => {
    if (!client) return ctx.skip();
    await inTx(async (q) => {
      const po = async (oid: string, date: string, total: number, version: number | null = null) =>
        (await q(`INSERT INTO purchase_orders (order_id, order_date, supplier, order_total, cost_formula_version) VALUES ($1, $2, 'zz-dash.test', $3, $4) RETURNING id`, [oid, date, total, version])).rows[0].id;
      await po("115449859", "2032-01-10", 255.84);
      await po("115449859 / 115450009", "2032-01-10", 255.84);
      const spend = async (from: string, to: string) => (await q(`WITH ${poSpendCtes("$1::date", "$2::date")} SELECT SUM(spend)::float8 AS spend, COUNT(*) FILTER (WHERE NOT fully_canceled AND NOT shared_dup)::int AS n FROM po_spend`, [from, to])).rows[0];
      expect(await spend("2032-01-10", "2032-01-10")).toEqual({ spend: 255.84, n: 1 });
      await po("50SBFK7R1T46", "2032-01-11", 104.44); await po("50SBFK7R1T46+1", "2032-03-11", 104.44); // a repeat subscription order: another date
      await po("200013530050140", "2032-01-12", 51.55); await po("200013228060326", "2032-01-12", 51.55); // two orders, same day and total, no shared #
      await po("4242001", "2032-01-13", 80); await po("4242001 / 4242002", "2032-01-13", 80, 3); // a form-saved PO is never a sheet copy
      expect(await spend("2032-01-10", "2032-03-31")).toEqual({ spend: 255.84 + 2 * 104.44 + 2 * 51.55 + 160, n: 7 });
      expect((await q(`SELECT SUM(order_total)::float8 AS t FROM purchase_orders WHERE supplier = 'zz-dash.test'`)).rows[0].t).toBeCloseTo(2 * 255.84 + 2 * 104.44 + 2 * 51.55 + 160, 2); // stored values unchanged
    });
  });
});
