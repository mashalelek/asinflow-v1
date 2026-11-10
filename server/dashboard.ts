// Dashboard (SPEC §28, patch docs/claude_spec-patch-analytics-dashboard.md):
// the Spend · Sales · Profit grid and the three chart series. Read-only; all
// aggregation in SQL. The range resolver is server/dashboard-range.ts.
//
// SPEND — purchase_orders / po_asins / po_line_items / po_line_refunds by
// purchase_orders.order_date (Eastern "today"):
//   Spend(PO) = order_total − the refund rows that are not already inside
//   order_total. A fully-canceled PO (every line qty_canceled ≥ qty_ordered)
//   is forced to $0 whatever its rows say (D5). Probe P1 (2026-11-03): on a
//   sheet-imported PO order_total is col AG verbatim, which D3 expects to be
//   NET of the refund already, and the col-AF backfill rows (source 'sheet')
//   would then be subtracted a second time — so a 'sheet' row on a PO whose
//   stored header already nets its refund (|order_total − (subtotal + tax +
//   sh_donations − discount − refund_amount)| ≤ $0.01) is NOT subtracted;
//   every other row (manual, email, a due row, a 'sheet' row on a gross-AG
//   PO) is. Gift-card % is never applied; cashback never counts.
//   A split PO's repeated header (2026-11-04, the two Pyramyd POs
//   "115449859" and "115449859 / 115450009", $255.84 each for one $255.84
//   order): when two sheet-imported POs of one supplier share the order
//   date, the order total and an order number, the sheet copied the order's
//   header onto both rows — the later one (by id) adds $0 of order_total,
//   its own refund rows still count. Stored values unchanged.
//   Refunds due = Σ rows with status 'due' (any PO, canceled or not) + each open
//   supplier defect's $ no refund row carries yet (SPEC §22 "Supplier defects"):
//   a defect linked to its due row adds nothing more.
//   ASIN units = Σ po_asins.qty − Σ canceled line qty × yield (bundles ÷
//   unique products, the §22 derivation with per-line COALESCE); fully-
//   canceled POs 0. Individual units = ASIN units × units_per_pack; a row
//   with NULL units_per_pack contributes its ASIN units and is COUNTED as
//   missing — never ×1 silently (2026-11-01 rule).
// SALES — sales_daily (+ sales_orders) by the Pacific sale_date.
// PROFIT — placeholders until the Finances API patch (null, pending).
import express, { type Router, type Request, type Response } from "express";
import { query as defaultQuery } from "./db";
import type { QueryLike } from "./scheduler/types";
import { LINE_YIELD_SQL } from "./po-queries";
import { REFUNDS_DUE_PO_SQL } from "./supplier-claim-sql";
import { resolveColumns, parseSet, parseCustom, parseYmd, last12MonthsRange, todayIn, EASTERN, PACIFIC, mondayOf, firstOfMonth, addDays, type RangeSet } from "./dashboard-range";
import { DASHBOARD_ROWS, SERIES_KINDS, type DashboardCell, type DashboardColumn, type DashboardCoverage, type DashboardGrid, type DashboardRowKey, type DashboardSeries, type SeriesKind, type SeriesPoint, type Ymd } from "@shared/dashboard";

// ── SQL ──────────────────────────────────────────────────────────────────────

/** A sheet-imported header whose order_total already nets its refund (probe P1). `p` = purchase_orders alias. */
export const HEADER_NETS_REFUND_SQL = `(p.refund_amount IS NOT NULL AND p.refund_amount > 0 AND p.subtotal IS NOT NULL AND p.order_total IS NOT NULL
  AND ABS(p.order_total - (COALESCE(p.subtotal, 0) + COALESCE(p.tax, 0) + COALESCE(p.sh_donations, 0) - COALESCE(p.discount, 0) - p.refund_amount)) <= 0.01)`;

/** Order-number tokens of an order_id: runs of 5+ letters/digits with a digit ("115449859", "50SBFK7R1T46", "CLK-160691" → "160691"). */
const ORDER_TOKENS = (col: string) => `ARRAY(SELECT m[1] FROM regexp_matches(upper(${col}), '([0-9][0-9A-Z]{4,}|[A-Z]+[0-9][0-9A-Z]{3,})', 'g') m)`;
/** A sheet-imported PO (`p`) whose header repeats an earlier sibling split PO's: same supplier, order date and order total, a shared order number, both sheet-imported. */
export const SHARED_HEADER_DUP_SQL = `(p.cost_formula_version IS NULL AND p.order_total IS NOT NULL AND p.order_total > 0 AND EXISTS (
  SELECT 1 FROM purchase_orders s
   WHERE s.id < p.id AND s.cost_formula_version IS NULL AND s.supplier = p.supplier
     AND s.order_date = p.order_date AND s.order_total = p.order_total
     AND ${ORDER_TOKENS("s.order_id")} && ${ORDER_TOKENS("p.order_id")}))`;

/**
 * The per-PO CTEs over an order_date range: `po` (id, order_date, stored_total,
 * shared_dup, header_nets, fully_canceled), `ref` (counted / due refunds per PO) and
 * `po_spend` (id, order_date, fully_canceled, shared_dup, spend, due) — a
 * shared_dup PO adds no order_total and is not a PO of its own in the counts. `startExpr` /
 * `endExpr` are SQL date expressions (parameter placeholders).
 */
export function poSpendCtes(startExpr: string, endExpr: string): string {
  return `po AS (
      SELECT p.id, p.order_date, p.order_total AS stored_total, ${SHARED_HEADER_DUP_SQL} AS shared_dup, ${HEADER_NETS_REFUND_SQL} AS header_nets,
             (l.n > 0 AND l.canceled = l.n) AS fully_canceled
        FROM purchase_orders p
        LEFT JOIN LATERAL (
          SELECT COUNT(*) AS n,
                 COUNT(*) FILTER (WHERE li.fully_canceled) AS canceled
            FROM po_line_expected li WHERE li.po_id = p.id) l ON true
       WHERE p.order_date >= ${startExpr} AND p.order_date <= ${endExpr}
    ), ref AS (
      SELECT r.po_id,
             COALESCE(SUM(r.amount) FILTER (WHERE NOT (r.source = 'sheet' AND po.header_nets)), 0) AS counted
        FROM po_line_refunds r JOIN po ON po.id = r.po_id
       GROUP BY r.po_id
    ), po_spend AS (
      SELECT po.id, po.order_date, po.fully_canceled, po.shared_dup,
             -- §3.7: Spend subtracts the refunds received plus what is still owed on open claims (the due rows before migration 101)
             CASE WHEN po.fully_canceled THEN 0 ELSE (CASE WHEN po.shared_dup THEN 0 ELSE COALESCE(po.stored_total, 0) END) - COALESCE(ref.counted, 0) - ${REFUNDS_DUE_PO_SQL("po")} END AS spend,
             ${REFUNDS_DUE_PO_SQL("po")} AS due
        FROM po LEFT JOIN ref ON ref.po_id = po.id
    )`;
}

// Units rows (SPEC §28): ASIN units ordered less the units canceled by claims (po_asin_expected, migration 101 — a bundle by the
// bundle rule); Individual = × the pack, unknown while a row has no pack size (counted in missing_pack_size).
const SPEND_GRID_SQL = `WITH ${poSpendCtes("$1::date", "$2::date")}, units AS (
      SELECT e.id,
             CASE WHEN po.fully_canceled THEN 0 ELSE GREATEST(COALESCE(e.ordered_asin, 0) - COALESCE(e.canceled_asin, 0), 0) END AS asin_units,
             -- the stored Individual units (NULL on a legacy row = pack not known)
             CASE WHEN po.fully_canceled THEN 0 WHEN e.ordered_individual IS NULL THEN NULL ELSE GREATEST(e.ordered_individual - COALESCE(e.canceled_individual, 0), 0) END AS individual_units
        FROM po_asin_expected e JOIN po ON po.id = e.po_id
    )
    SELECT (SELECT COALESCE(SUM(spend), 0) FROM po_spend)::float8 AS spend,
           (SELECT COALESCE(SUM(due), 0) FROM po_spend)::float8 AS refunds_due,
           (SELECT COUNT(*) FILTER (WHERE NOT fully_canceled AND NOT shared_dup) FROM po_spend)::int AS po_count,
           (SELECT COALESCE(SUM(asin_units), 0) FROM units)::float8 AS asin_units,
           (SELECT COALESCE(SUM(COALESCE(individual_units, asin_units)), 0) FROM units)::float8 AS individual_units,
           (SELECT COUNT(*) FILTER (WHERE individual_units IS NULL AND asin_units > 0) FROM units)::int AS missing_pack_size`;

const SALES_GRID_SQL = `SELECT COALESCE(SUM(revenue), 0)::float8 AS sales, COALESCE(SUM(units_sold), 0)::int AS units
    FROM sales_daily WHERE sale_date >= $1::date AND sale_date <= $2::date`;
const ORDERS_GRID_SQL = `SELECT COUNT(DISTINCT amazon_order_id)::int AS orders FROM sales_orders WHERE sale_date >= $1::date AND sale_date <= $2::date`;

const COVERAGE_SQL = `SELECT (SELECT MIN(sale_date)::text FROM sales_daily) AS earliest,
           (SELECT MAX(sale_date)::text FROM sales_daily) AS newest,
           (SELECT MIN(sale_date)::text FROM sales_orders) AS orders_from,
           (SELECT MAX(finished_at) FROM refresh_runs WHERE stage IN ('19_sales', 'sales')) AS last_sync`;

// ── Grid ─────────────────────────────────────────────────────────────────────

const round2 = (v: number) => Math.round(v * 100) / 100;
const num = (v: unknown) => (v == null ? 0 : Number(v));

export async function loadCoverage(query: QueryLike): Promise<DashboardCoverage> {
  const r = (await query(COVERAGE_SQL)).rows[0] ?? {};
  const earliest = r.earliest ?? null, ordersFrom = r.orders_from ?? null;
  return {
    earliestSaleDate: earliest,
    newestSaleDate: r.newest ?? null,
    lastSalesSyncAt: r.last_sync ? new Date(r.last_sync).toISOString() : null,
    ordersFrom,
    // Pending only while sales_orders is EMPTY. Rows before the re-backfill's
    // start day (the first day Amazon's report still returned — 2024-10-31 on
    // 2026-11-03) are left on the old basis on purpose, so an orders start
    // later than the sales start is the expected end state, not a pending
    // backfill; the header then says "orders from <date>" and the per-cell
    // dataFrom markers cover the columns that reach before it.
    rebackfillPending: earliest != null && ordersFrom == null,
  };
}

/** The grid for one range set (set 4 needs `custom`). `now` is injectable for tests. */
export async function loadGrid(query: QueryLike, set: RangeSet, custom: Ymd | undefined, now: Date = new Date()): Promise<DashboardGrid> {
  const columns = resolveColumns(set, now, custom);
  const coverage = await loadCoverage(query);
  const out: DashboardColumn[] = [];
  for (const c of columns) {
    const sp = (await query(SPEND_GRID_SQL, [c.eastern.from, c.eastern.to])).rows[0] ?? {};
    const sa = (await query(SALES_GRID_SQL, [c.pacific.from, c.pacific.to])).rows[0] ?? {};
    const so = (await query(ORDERS_GRID_SQL, [c.pacific.from, c.pacific.to])).rows[0] ?? {};
    const poCount = num(sp.po_count);
    const spend = round2(num(sp.spend));
    const dataFrom = coverage.earliestSaleDate && c.pacific.from < coverage.earliestSaleDate ? coverage.earliestSaleDate : null;
    const ordersFrom = coverage.ordersFrom && c.pacific.from < coverage.ordersFrom ? coverage.ordersFrom : coverage.ordersFrom == null ? null : dataFrom;
    const pending: DashboardCell = { value: null, pending: true };
    const cells: Record<DashboardRowKey, DashboardCell> = {
      spend: { value: spend },
      refunds_due: { value: round2(num(sp.refunds_due)) },
      asin_units: { value: round2(num(sp.asin_units)) },
      individual_units: { value: round2(num(sp.individual_units)), missingPackSize: num(sp.missing_pack_size) },
      avg_po_value: { value: poCount > 0 ? round2(spend / poCount) : null, poCount },
      sales: { value: round2(num(sa.sales)), dataFrom },
      orders_units: { value: coverage.ordersFrom == null ? null : num(so.orders), secondary: num(sa.units), dataFrom: ordersFrom },
      refunds: { ...pending, secondary: null },
      gross_profit: pending,
      net_profit: pending,
      est_payout: pending,
    };
    out.push({ key: c.key, label: c.label, eastern: c.eastern, pacific: c.pacific, cells });
  }
  return { set, columns: out, coverage, generatedAt: now.toISOString() };
}

// ── Series ───────────────────────────────────────────────────────────────────

const MONTHLY_SQL = (trunc: "month" | "week") => `WITH periods AS (
      SELECT generate_series(date_trunc('${trunc}', $1::date), date_trunc('${trunc}', $2::date), '1 ${trunc}')::date AS period
    ), ${poSpendCtes("$1::date", "$2::date")}, sp AS (
      SELECT date_trunc('${trunc}', order_date)::date AS period, SUM(spend) AS spend, COUNT(*) FILTER (WHERE NOT fully_canceled AND NOT shared_dup) AS po_count FROM po_spend GROUP BY 1
    ), sa AS (
      SELECT date_trunc('${trunc}', sale_date)::date AS period, SUM(revenue) AS sales, SUM(units_sold) AS units FROM sales_daily WHERE sale_date >= $1::date AND sale_date <= $2::date GROUP BY 1
    ), so AS (
      SELECT date_trunc('${trunc}', sale_date)::date AS period, COUNT(DISTINCT amazon_order_id) AS orders FROM sales_orders WHERE sale_date >= $1::date AND sale_date <= $2::date GROUP BY 1
    )
    SELECT pr.period::text AS period, COALESCE(sa.sales, 0)::float8 AS sales, COALESCE(sp.spend, 0)::float8 AS spend,
           COALESCE(sp.po_count, 0)::int AS po_count, COALESCE(sa.units, 0)::int AS units, COALESCE(so.orders, 0)::int AS orders
      FROM periods pr LEFT JOIN sp ON sp.period = pr.period LEFT JOIN sa ON sa.period = pr.period LEFT JOIN so ON so.period = pr.period
     ORDER BY pr.period`;

/** 30-day running sums per day: generate_series + a 29-PRECEDING window over 0-filled days; the series starts 29 days early so the first day's window is complete. */
const RUNNING30_SQL = `WITH days AS (
      SELECT generate_series($1::date - 29, $2::date, '1 day')::date AS d
    ), ${poSpendCtes("$1::date - 29", "$2::date")}, spd AS (
      SELECT order_date AS d, SUM(spend) AS spend, COUNT(*) FILTER (WHERE NOT fully_canceled AND NOT shared_dup) AS n FROM po_spend GROUP BY 1
    ), sad AS (
      SELECT sale_date AS d, SUM(revenue) AS sales, SUM(units_sold) AS units FROM sales_daily WHERE sale_date >= $1::date - 29 AND sale_date <= $2::date GROUP BY 1
    ), base AS (
      SELECT days.d, COALESCE(sad.sales, 0) AS sales, COALESCE(sad.units, 0) AS units, COALESCE(spd.spend, 0) AS spend, COALESCE(spd.n, 0) AS n
        FROM days LEFT JOIN sad ON sad.d = days.d LEFT JOIN spd ON spd.d = days.d
    ), win AS (
      SELECT d, SUM(sales) OVER w AS sales, SUM(units) OVER w AS units, SUM(spend) OVER w AS spend, SUM(n) OVER w AS po_count
        FROM base WINDOW w AS (ORDER BY d ROWS BETWEEN 29 PRECEDING AND CURRENT ROW)
    )
    SELECT w.d::text AS period, w.sales::float8 AS sales, w.spend::float8 AS spend, w.po_count::int AS po_count, w.units::int AS units,
           (SELECT COUNT(DISTINCT so.amazon_order_id) FROM sales_orders so WHERE so.sale_date >= w.d - 29 AND so.sale_date <= w.d)::int AS orders
      FROM win w WHERE w.d >= $1::date ORDER BY w.d`;

/** The last day of a period (for the coverage cut). */
function periodEnd(kind: SeriesKind, period: string): string {
  if (kind === "running30") return period;
  if (kind === "weekly") return addDays(period, 6);
  const d = new Date(`${period}T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() + 1);
  return addDays(d.toISOString().slice(0, 10), -1);
}

export async function loadSeries(query: QueryLike, kind: SeriesKind, range: Ymd | undefined, now: Date = new Date()): Promise<DashboardSeries> {
  const r = range ?? last12MonthsRange(now);
  const coverage = await loadCoverage(query);
  const sql = kind === "running30" ? RUNNING30_SQL : MONTHLY_SQL(kind === "monthly" ? "month" : "week");
  const rows = (await query(sql, [r.from, r.to])).rows as any[];
  const earliest = coverage.earliestSaleDate;
  const todayEt = todayIn(EASTERN, now), todayPt = todayIn(PACIFIC, now);
  const todayPeriod = kind === "running30" ? todayEt : kind === "weekly" ? mondayOf(todayEt) : firstOfMonth(todayEt);
  const points: SeriesPoint[] = rows.map((x) => {
    const period = String(x.period);
    const covered = earliest != null && periodEnd(kind, period) >= earliest;
    return {
      period,
      sales: covered ? round2(num(x.sales)) : null,
      spend: round2(num(x.spend)),
      poCount: num(x.po_count),
      units: covered ? num(x.units) : null,
      orders: covered && coverage.ordersFrom != null ? num(x.orders) : null,
      partial: period === todayPeriod || (kind === "running30" && period === todayPt),
    };
  });
  return { kind, from: r.from, to: r.to, salesFrom: earliest && r.from < earliest ? earliest : null, points };
}

// ── Router ───────────────────────────────────────────────────────────────────

export function parseGridQuery(q: Record<string, unknown>): { set: RangeSet; custom?: Ymd } | { error: string } {
  const set = parseSet(q.set ?? 1);
  if (!set) return { error: "set must be 1, 2, 3 or 4" };
  if (set !== 4) return { set };
  const custom = parseCustom(q.from, q.to);
  return "error" in custom ? custom : { set, custom };
}

export function parseSeriesQuery(q: Record<string, unknown>): { kind: SeriesKind; range?: Ymd } | { error: string } {
  const kind = String(q.kind ?? "running30") as SeriesKind;
  if (!SERIES_KINDS.includes(kind)) return { error: "kind must be running30, monthly or weekly" };
  if (q.from == null && q.to == null) return { kind };
  const custom = parseCustom(q.from, q.to);
  return "error" in custom ? custom : { kind, range: custom };
}

export function createDashboardRouter(deps: { query?: QueryLike } = {}): Router {
  const query = deps.query ?? (defaultQuery as any as QueryLike);
  const router = express.Router();
  router.get("/api/dashboard/grid", async (req: Request, res: Response) => {
    const p = parseGridQuery(req.query as Record<string, unknown>);
    if ("error" in p) { res.status(400).json({ error: "invalid_range", message: p.error }); return; }
    try { res.json(await loadGrid(query, p.set, p.custom)); }
    catch (err: any) { res.status(500).json({ error: "dashboard_failed", message: err?.message ?? String(err) }); }
  });
  router.get("/api/dashboard/series", async (req: Request, res: Response) => {
    const p = parseSeriesQuery(req.query as Record<string, unknown>);
    if ("error" in p) { res.status(400).json({ error: "invalid_range", message: p.error }); return; }
    try { res.json(await loadSeries(query, p.kind, p.range)); }
    catch (err: any) { res.status(500).json({ error: "dashboard_failed", message: err?.message ?? String(err) }); }
  });
  return router;
}

export { DASHBOARD_ROWS, parseYmd };
