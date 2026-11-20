// finances_daily — the per-day / per-ASIN / per-line aggregate every Actual
// figure reads (patch commits 5–8; SPEC §1, §2, §3, §4, §5, §8).
//
// rebuildFinancesDaily(from, to) recomputes the days in [from, to] from the
// stored facts (finances_order_lines + the live Finances rows, the report
// rows, the PO tables) in ONE transaction. Cost period (§5): the newest
// non-canceled, non-components-only po_asins row with order_date ≤ the day;
// a sale before the ASIN's first PO uses the first PO; no PO at all → COGS 0
// and the `cogs_missing` units. Prep is never stored as money: the aggregate
// keeps the units that take the Settings prep (Velocity PO in force) in
// prep_units / prep_hazmat_units and readBreakdown applies the current
// Settings values (§5 "Computed when viewed").
import pool, { query as defaultQuery } from "./db";
import { log } from "./log";
import { LIVE_QTY_CTE_SQL, LIVE_REFUND_TX_SQL, LIVE_SHIPMENT_TX_SQL } from "./finances-sql";
import { ensureShipmentsKnown } from "./finances-reports";
import { settingsFromRows } from "@shared/settings-keys";
import { FOUND_REASONS, GROUP_ORDER, LOST_REASONS, groupOf, labelOf, type FinancesBreakdown, type FinancesBreakdownLine } from "@shared/finances";
import type { Settings } from "@shared/schema";

type QueryFn = (sql: string, params?: any[]) => Promise<any>;
export const aggregateDeps = {
  async transaction<T>(fn: (q: QueryFn) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try { await client.query("BEGIN"); const out = await fn((sql, params) => client.query(sql, params)); await client.query("COMMIT"); return out; }
    catch (err) { await client.query("ROLLBACK").catch(() => {}); throw err; }
    finally { client.release(); }
  },
  ensureShipmentsKnown,
};

/** Cost periods (§5): per ASIN, each non-canceled PO row's cost from its order_date to the day before the next one; the first row also covers every day before it. */
export const COST_PERIODS_SQL = `
  SELECT asin, cost_per_unit, ships_to,
         CASE WHEN row_number() OVER w = 1 THEN DATE '1900-01-01' ELSE order_date END AS from_day,
         COALESCE(LEAD(order_date) OVER w - 1, DATE '9999-12-31') AS to_day
    FROM (
      SELECT pa.asin, pa.cost_per_unit, p.ships_to, p.order_date, p.entry_seq, p.created_at
        FROM po_asins pa JOIN purchase_orders p ON p.id = pa.po_id
       WHERE pa.cost_per_unit IS NOT NULL AND NOT pa.components_only AND pa.asin ~ '^(B0[A-Z0-9]{8}|[0-9]{9}[0-9X])$'
         AND NOT (SELECT e.fully_canceled FROM po_asin_expected e WHERE e.id = pa.id)
    ) r
  WINDOW w AS (PARTITION BY asin ORDER BY order_date, entry_seq NULLS FIRST, created_at)`;

const ASIN_SQL = `^(B0[A-Z0-9]{8}|[0-9]{9}[0-9X])$`;

/**
 * Recompute finances_daily for the Pacific days [from, to] (inclusive, YYYY-MM-DD).
 * Returns the row count written. `live = false` skips the live shipment read
 * (tests, dry runs).
 */
export async function rebuildFinancesDaily(from: string, to: string, opts: { live?: boolean; log?: (m: string) => void; q?: QueryFn } = {}): Promise<{ rows: number }> {
  const L = opts.log ?? ((m: string) => log(m, "finances"));
  if (opts.live !== false) {
    // Shipments named by inbound fee rows in the range that sc_inbound_shipments lacks are read live first (§4).
    const q0 = opts.q ?? (defaultQuery as any);
    const ids = (await q0(`SELECT DISTINCT order_id FROM finances_lines WHERE transaction_type = 'ServiceFee' AND line IN ('svc:FBAPostInboundTransportation', 'svc:FBAInboundTransportation', 'svc:FBAInboundConvenience') AND posted_day BETWEEN $1::date AND $2::date AND order_id IS NOT NULL`, [from, to])).rows.map((r: any) => String(r.order_id));
    await aggregateDeps.ensureShipmentsKnown(ids, { log: L, q: q0 }).catch((err: any) => L(`shipment read skipped: ${err?.message ?? err}`));
  }
  const run = async (q: QueryFn) => {
    await q(`DROP TABLE IF EXISTS fin_periods; DROP TABLE IF EXISTS fin_hazmat; DROP TABLE IF EXISTS fin_out`);
    await q(`CREATE TEMP TABLE fin_periods ON COMMIT DROP AS ${COST_PERIODS_SQL}`);
    await q(`CREATE INDEX fin_periods_idx ON fin_periods (asin, from_day, to_day)`);
    await q(`CREATE TEMP TABLE fin_hazmat ON COMMIT DROP AS SELECT asin, (COALESCE(is_hazmat, false) OR COALESCE(is_dangerous_good, false)) AS hazmat FROM asins`);
    await q(`CREATE TEMP TABLE fin_out (day date, asin text, line text, amount numeric(14,4), quantity numeric(14,4), est_amount numeric(14,4), est_units numeric(14,4), prep_units numeric(14,4), prep_hazmat_units numeric(14,4)) ON COMMIT DROP`);
    const P = [from, to];

    // A. Order lines by purchase day: Sales, Units, Orders, the fee lines, COGS, Prep (§2, §3, §5).
    await q(`
      WITH live AS (${LIVE_SHIPMENT_TX_SQL}),
      ${LIVE_QTY_CTE_SQL},
      fin AS (
        SELECT l.order_id, l.sku,
               COALESCE(SUM(l.amount) FILTER (WHERE l.line = 'sales'), 0)        AS principal,
               COALESCE(SUM(l.amount) FILTER (WHERE l.line = 'promo'), 0)        AS promo,
               COALESCE(SUM(l.amount) FILTER (WHERE l.line = 'fba_fee'), 0)      AS fba_fee,
               COALESCE(SUM(l.amount) FILTER (WHERE l.line = 'referral_fee'), 0) AS referral_fee,
               COALESCE(SUM(l.amount) FILTER (WHERE l.line = 'vcf'), 0)          AS vcf,
               COALESCE(SUM(l.amount) FILTER (WHERE l.line LIKE 'fee:%'), 0)     AS other_fee,
               COALESCE(MAX(lq.qty), 0)                                           AS quantity,
               bool_or(live.transaction_status = 'DEFERRED')                      AS any_deferred
          FROM live
          JOIN finances_lines l ON l.transaction_id = live.transaction_id AND l.sku IS NOT DISTINCT FROM live.sku
          LEFT JOIN live_qty lq ON lq.order_id = live.order_id AND lq.sku IS NOT DISTINCT FROM live.sku
         WHERE live.order_id IN (SELECT order_id FROM finances_order_lines WHERE purchase_day BETWEEN $1::date AND $2::date)
         GROUP BY l.order_id, l.sku),
      -- the same ASIN's most recent POSTED per-unit figures (§3 source 3)
      last_posted AS (
        SELECT DISTINCT ON (l.asin) l.asin,
               SUM(l.amount) FILTER (WHERE l.line = 'sales') OVER (PARTITION BY l.transaction_id, l.sku) / NULLIF(l.quantity, 0) AS unit_price,
               SUM(l.amount) FILTER (WHERE l.line = 'fba_fee') OVER (PARTITION BY l.transaction_id, l.sku) / NULLIF(l.quantity, 0) AS unit_fba,
               SUM(l.amount) FILTER (WHERE l.line = 'referral_fee') OVER (PARTITION BY l.transaction_id, l.sku) / NULLIF(SUM(l.amount) FILTER (WHERE l.line = 'sales') OVER (PARTITION BY l.transaction_id, l.sku), 0) AS comm_rate
          FROM finances_lines l JOIN finances_transactions t ON t.transaction_id = l.transaction_id
         WHERE t.transaction_type = 'Shipment' AND t.transaction_status = 'RELEASED' AND t.superseded_at IS NULL AND l.quantity > 0 AND l.line IN ('sales', 'fba_fee', 'referral_fee')
           AND l.asin IN (SELECT DISTINCT asin FROM finances_order_lines WHERE purchase_day BETWEEN $1::date AND $2::date)
         ORDER BY l.asin, l.posted_at DESC),
      -- a live shipment transaction with NO money at all (a $0 replacement shipment Amazon posts with empty items): the order has
      -- its row, it is just worth nothing — never priced or fee-estimated as "no row yet"
      zero_tx AS (
        SELECT DISTINCT t.order_id FROM finances_transactions t
         WHERE t.transaction_type = 'Shipment' AND t.superseded_at IS NULL AND t.total_amount = 0
           AND t.order_id IN (SELECT order_id FROM finances_order_lines WHERE purchase_day BETWEEN $1::date AND $2::date)
           AND NOT EXISTS (SELECT 1 FROM finances_lines l WHERE l.transaction_id = t.transaction_id)),
      lines AS (
        SELECT ol.purchase_day AS day, ol.asin, ol.order_id,
               -- units ordered, or the units Amazon shipped when more (a free replacement shipment under the same order id)
               GREATEST(ol.units, COALESCE(f.quantity, 0)) AS units,
               (f.order_id IS NOT NULL OR z.order_id IS NOT NULL) AS has_row, COALESCE(f.any_deferred, false) AS any_deferred,
               CASE WHEN f.order_id IS NULL AND z.order_id IS NOT NULL THEN ol.units ELSE COALESCE(f.quantity, 0) END AS fin_qty,
               CASE WHEN f.order_id IS NULL AND z.order_id IS NOT NULL THEN 0 ELSE GREATEST(ol.units - COALESCE(f.quantity, 0), 0) END AS rest_units,
               COALESCE(NULLIF(ol.item_price, 0) / NULLIF(ol.units, 0), lp.unit_price, e.lowest_fba_price, 0) AS unit_price,
               COALESCE(f.principal, 0) + COALESCE(f.promo, 0) AS fin_sales,
               COALESCE(f.fba_fee, 0) AS fin_fba, COALESCE(f.referral_fee, 0) AS fin_ref, COALESCE(f.vcf, 0) AS fin_vcf, COALESCE(f.other_fee, 0) AS fin_other,
               -- the per-unit estimate for units without a row: last posted, else AF's estimate scaled to the price
               COALESCE(lp.unit_fba, -ABS(e.fba_fee), 0) AS est_unit_fba,
               COALESCE(lp.comm_rate, -ABS(e.referral_fee) / NULLIF(e.fees_estimate_price, 0), 0) AS est_comm_rate,
               CASE WHEN f.order_id IS NULL AND ol.item_price IS NULL THEN 0 ELSE 1 END AS priced,
               cp.cost_per_unit, cp.ships_to, COALESCE(h.hazmat, false) AS hazmat
          FROM finances_order_lines ol
          LEFT JOIN fin f ON f.order_id = ol.order_id AND f.sku = ol.sku
          LEFT JOIN zero_tx z ON z.order_id = ol.order_id
          LEFT JOIN last_posted lp ON lp.asin = ol.asin
          LEFT JOIN asin_estimates e ON e.asin = ol.asin
          LEFT JOIN fin_periods cp ON cp.asin = ol.asin AND ol.purchase_day BETWEEN cp.from_day AND cp.to_day
          LEFT JOIN fin_hazmat h ON h.asin = ol.asin
         -- S01- orders (Amazon's own replacement / MCF orders) are not sales (SB leaves them out; fixture diff 2026-11-19)
         WHERE ol.purchase_day BETWEEN $1::date AND $2::date AND ol.order_status <> 'Cancelled' AND ol.order_id NOT LIKE 'S01-%' AND ol.asin ~ '${ASIN_SQL}'),
      per_line AS (
        SELECT day, asin, order_id, units,
               CASE WHEN has_row THEN fin_sales + rest_units * unit_price ELSE units * unit_price END AS sales,
               fin_fba + rest_units * est_unit_fba AS fba, fin_ref + rest_units * est_comm_rate * unit_price AS referral, fin_vcf AS vcf, fin_other AS other,
               (CASE WHEN any_deferred THEN fin_fba ELSE 0 END) + rest_units * est_unit_fba AS fba_est,
               (CASE WHEN any_deferred THEN fin_ref ELSE 0 END) + rest_units * est_comm_rate * unit_price AS ref_est,
               (CASE WHEN any_deferred THEN fin_qty ELSE 0 END) + rest_units AS est_units,
               cost_per_unit, ships_to, hazmat
          FROM lines)
      INSERT INTO fin_out (day, asin, line, amount, quantity, est_amount, est_units, prep_units, prep_hazmat_units)
      SELECT day, asin, 'sales', SUM(sales), SUM(units), 0, 0, 0, 0 FROM per_line GROUP BY day, asin
      UNION ALL SELECT day, asin, 'units', 0, SUM(units), 0, 0, 0, 0 FROM per_line GROUP BY day, asin
      UNION ALL SELECT day, '', 'orders', 0, COUNT(DISTINCT order_id), 0, 0, 0, 0 FROM per_line GROUP BY day
      UNION ALL SELECT day, asin, 'fba_fee', SUM(fba), SUM(units), SUM(fba_est), SUM(est_units), 0, 0 FROM per_line GROUP BY day, asin
      UNION ALL SELECT day, asin, 'referral_fee', SUM(referral), SUM(units), SUM(ref_est), SUM(est_units), 0, 0 FROM per_line GROUP BY day, asin
      UNION ALL SELECT day, asin, 'vcf', SUM(vcf), 0, 0, 0, 0, 0 FROM per_line WHERE vcf <> 0 GROUP BY day, asin
      UNION ALL SELECT day, asin, 'fee:other', SUM(other), 0, 0, 0, 0, 0 FROM per_line WHERE other <> 0 GROUP BY day, asin
      UNION ALL SELECT day, asin, 'cogs', -SUM(units * COALESCE(cost_per_unit, 0)), SUM(units) FILTER (WHERE cost_per_unit IS NOT NULL), 0, 0, 0, 0 FROM per_line GROUP BY day, asin
      UNION ALL SELECT day, asin, 'cogs_missing', 0, SUM(units), 0, 0, 0, 0 FROM per_line WHERE cost_per_unit IS NULL GROUP BY day, asin
      UNION ALL SELECT day, asin, 'prep', 0, SUM(units), 0, 0,
                       SUM(units) FILTER (WHERE ships_to = 'velocity' AND NOT hazmat), SUM(units) FILTER (WHERE ships_to = 'velocity' AND hazmat) FROM per_line GROUP BY day, asin`, P);

    // B. Refunds by posted day (§2): the live refund rows per (order, refund id, SKU).
    await q(`
      WITH live AS (${LIVE_REFUND_TX_SQL}),
      rl AS (
        SELECT l.posted_day AS day, COALESCE(NULLIF(l.asin, ''), '') AS asin, l.line, l.amount, l.quantity, live.order_id, live.refund_id
          FROM live JOIN finances_lines l ON l.transaction_id = live.transaction_id AND l.sku IS NOT DISTINCT FROM live.sku
         WHERE l.posted_day BETWEEN $1::date AND $2::date AND l.line <> 'tax')
      INSERT INTO fin_out (day, asin, line, amount, quantity, est_amount, est_units, prep_units, prep_hazmat_units)
      SELECT day, asin, line, SUM(amount), 0, 0, 0, 0, 0 FROM rl GROUP BY day, asin, line
      UNION ALL
      SELECT day, asin, 'refunds', 0, COUNT(DISTINCT (order_id, refund_id)), 0, 0, 0, 0 FROM rl GROUP BY day, asin
      UNION ALL
      SELECT day, asin, 'refund_units', 0, SUM(q), 0, 0, 0, 0 FROM (SELECT DISTINCT day, asin, order_id, refund_id, COALESCE(quantity, 0) AS q FROM rl) u GROUP BY day, asin`, P);

    // C. Service fees by posted day (§4 allocation).
    await q(`
      WITH svc AS (
        SELECT l.id, l.posted_day AS day, l.line, l.amount, l.order_id AS ref, l.asin AS ctx_asin
          FROM finances_lines l WHERE l.transaction_type = 'ServiceFee' AND l.posted_day BETWEEN $1::date AND $2::date),
      -- shipment-level fees over the shipment's contents by weight
      ship AS (
        SELECT s.id, s.day, s.line, s.amount, i.asin, i.qty_shipped * COALESCE(NULLIF(a.weight_lb, 0), 0) AS w, i.qty_shipped AS u
          FROM svc s JOIN sc_inbound_items i ON i.shipment_id = s.ref LEFT JOIN asins a ON a.asin = i.asin
         WHERE s.line IN ('svc:FBAPostInboundTransportation', 'svc:FBAInboundTransportation', 'svc:FBAInboundConvenience')),
      ship_tot AS (SELECT id, SUM(w) AS tw, SUM(u) AS tu FROM ship GROUP BY id),
      ship_alloc AS (
        SELECT sh.id, sh.day, sh.line, COALESCE(sh.asin, '') AS asin,
               sh.amount * CASE WHEN st.tw > 0 THEN sh.w / st.tw ELSE sh.u / NULLIF(st.tu, 0) END AS part
          FROM ship sh JOIN ship_tot st ON st.id = sh.id),
      -- storage: the report of the month before the posting, per ASIN
      stor AS (
        SELECT s.id, s.day, s.line, COALESCE(f.asin, '') AS asin, -SUM(f.fee) AS part
          FROM svc s JOIN fba_storage_fees f ON f.month = to_char((s.day - INTERVAL '1 month')::date, 'YYYY-MM')
         WHERE s.line = 'svc:FBAStorageBilling' GROUP BY s.id, s.day, s.line, f.asin),
      -- removal / disposal: the removal order's SKUs by requested quantity
      rem AS (
        SELECT s.id, s.day, s.line, COALESCE(r.asin, '') AS asin, s.amount * r.requested_qty / NULLIF(SUM(r.requested_qty) OVER (PARTITION BY s.id), 0) AS part
          FROM svc s JOIN fba_removals r ON r.order_id = s.ref
         WHERE s.line IN ('svc:FBARemoval', 'svc:FBADisposal') AND r.requested_qty > 0),
      alloc AS (
        SELECT id, day, line, asin, part FROM ship_alloc WHERE asin <> ''
        UNION ALL SELECT id, day, line, asin, part FROM stor WHERE asin <> ''
        UNION ALL SELECT id, day, line, asin, part FROM rem WHERE asin <> ''),
      alloc_sum AS (SELECT id, SUM(part) AS allocated FROM alloc GROUP BY id),
      rest AS (
        -- the account-only part: the row's own ASIN (customer-return fee) when the context names one, else the unallocated remainder
        SELECT s.id, s.day, s.line,
               CASE WHEN s.line = 'svc:FBACustomerReturn' AND s.ctx_asin IS NOT NULL THEN s.ctx_asin ELSE '' END AS asin,
               s.amount - COALESCE(a.allocated, 0) AS part
          FROM svc s LEFT JOIN alloc_sum a ON a.id = s.id)
      INSERT INTO fin_out (day, asin, line, amount, quantity, est_amount, est_units, prep_units, prep_hazmat_units)
      SELECT day, asin, line, SUM(part), 0, 0, 0, 0, 0 FROM (SELECT day, line, asin, part FROM alloc UNION ALL SELECT day, line, asin, part FROM rest) x WHERE part <> 0 GROUP BY day, asin, line`, P);

    // D. Reimbursements by posted day: the cash line per reason, and Lost/damaged by Amazon valued at the period cost (§2).
    await q(`
      WITH rb AS (
        SELECT l.posted_day AS day, COALESCE(l.asin, '') AS asin, l.line, l.leaf_path AS reason, l.amount, COALESCE(l.quantity, 0) AS qty,
               cp.cost_per_unit, cp.ships_to, COALESCE(h.hazmat, false) AS hazmat
          FROM finances_lines l
          LEFT JOIN fin_periods cp ON cp.asin = l.asin AND l.posted_day BETWEEN cp.from_day AND cp.to_day
          LEFT JOIN fin_hazmat h ON h.asin = l.asin
         WHERE l.transaction_type = 'FBAInventoryReimbursement' AND l.posted_day BETWEEN $1::date AND $2::date),
      val AS (
        SELECT day, asin, CASE WHEN reason = ANY($3::text[]) THEN -1 ELSE 1 END AS sign, qty, cost_per_unit, ships_to, hazmat
          FROM rb WHERE reason = ANY($3::text[]) OR reason = ANY($4::text[]))
      INSERT INTO fin_out (day, asin, line, amount, quantity, est_amount, est_units, prep_units, prep_hazmat_units)
      SELECT day, asin, line, SUM(amount), SUM(qty), 0, 0, 0, 0 FROM rb GROUP BY day, asin, line
      UNION ALL
      SELECT day, asin, 'lost_damaged', SUM(sign * qty * COALESCE(cost_per_unit, 0)), SUM(sign * qty), 0, 0,
             SUM(sign * qty) FILTER (WHERE ships_to = 'velocity' AND NOT hazmat), SUM(sign * qty) FILTER (WHERE ships_to = 'velocity' AND hazmat)
        FROM val GROUP BY day, asin`, [from, to, LOST_REASONS, FOUND_REASONS]);

    // E. Customer returns by return day: Value of returned items (sellable × period cost), the counts behind Sellable returns.
    await q(`
      WITH r AS (
        SELECT c.return_day AS day, COALESCE(c.asin, '') AS asin, c.quantity AS qty, c.disposition = 'SELLABLE' AS sellable,
               cp.cost_per_unit, cp.ships_to, COALESCE(h.hazmat, false) AS hazmat
          FROM fba_customer_returns c
          LEFT JOIN fin_periods cp ON cp.asin = c.asin AND c.return_day BETWEEN cp.from_day AND cp.to_day
          LEFT JOIN fin_hazmat h ON h.asin = c.asin
         WHERE c.return_day BETWEEN $1::date AND $2::date)
      INSERT INTO fin_out (day, asin, line, amount, quantity, est_amount, est_units, prep_units, prep_hazmat_units)
      SELECT day, asin, 'returned_value', SUM(qty * COALESCE(cost_per_unit, 0)), SUM(qty), 0, 0,
             SUM(qty) FILTER (WHERE ships_to = 'velocity' AND NOT hazmat), SUM(qty) FILTER (WHERE ships_to = 'velocity' AND hazmat) FROM r WHERE sellable GROUP BY day, asin
      UNION ALL SELECT day, asin, 'returns_units', 0, SUM(qty), 0, 0, 0, 0 FROM r GROUP BY day, asin
      UNION ALL SELECT day, asin, 'returns_sellable', 0, SUM(qty), 0, 0, 0, 0 FROM r WHERE sellable GROUP BY day, asin`, P);

    // F. Disposal of sellable products by completion day (removal order detail).
    await q(`
      WITH d AS (
        SELECT r.completed_day AS day, COALESCE(r.asin, '') AS asin, r.disposed_qty AS qty, cp.cost_per_unit, cp.ships_to, COALESCE(h.hazmat, false) AS hazmat
          FROM fba_removals r
          LEFT JOIN fin_periods cp ON cp.asin = r.asin AND r.completed_day BETWEEN cp.from_day AND cp.to_day
          LEFT JOIN fin_hazmat h ON h.asin = r.asin
         WHERE r.order_type = 'Disposal' AND r.disposition = 'Sellable' AND r.disposed_qty > 0 AND r.completed_day BETWEEN $1::date AND $2::date)
      INSERT INTO fin_out (day, asin, line, amount, quantity, est_amount, est_units, prep_units, prep_hazmat_units)
      SELECT day, asin, 'disposal_value', -SUM(qty * COALESCE(cost_per_unit, 0)), -SUM(qty), 0, 0,
             -SUM(qty) FILTER (WHERE ships_to = 'velocity' AND NOT hazmat), -SUM(qty) FILTER (WHERE ships_to = 'velocity' AND hazmat) FROM d GROUP BY day, asin`, P);

    // G. Other transaction types (Retrocharge, ShippingService, …) by posted day, account level, under their Amazon name.
    await q(`
      INSERT INTO fin_out (day, asin, line, amount, quantity, est_amount, est_units, prep_units, prep_hazmat_units)
      SELECT l.posted_day, COALESCE(l.asin, ''), l.line, SUM(l.amount), 0, 0, 0, 0, 0
        FROM finances_lines l JOIN finances_transactions t ON t.transaction_id = l.transaction_id
       WHERE l.line LIKE 'other:%' AND t.superseded_at IS NULL AND l.posted_day BETWEEN $1::date AND $2::date GROUP BY 1, 2, 3`, P);

    // Replace the range.
    await q(`DELETE FROM finances_daily WHERE day BETWEEN $1::date AND $2::date`, P);
    const r = await q(`
      INSERT INTO finances_daily (day, asin, line, amount, quantity, est_amount, est_units, prep_units, prep_hazmat_units)
      SELECT day, asin, line, COALESCE(SUM(amount), 0), COALESCE(SUM(quantity), 0), COALESCE(SUM(est_amount), 0), COALESCE(SUM(est_units), 0), COALESCE(SUM(prep_units), 0), COALESCE(SUM(prep_hazmat_units), 0)
        FROM fin_out GROUP BY day, asin, line`);
    // §8: sales_daily's refund columns follow the aggregate.
    await q(`
      UPDATE sales_daily s SET units_refunded = COALESCE(x.units, 0), refund_amount = COALESCE(x.amount, 0)
        FROM (SELECT a.id AS asin_id, d.day,
                     SUM(d.quantity) FILTER (WHERE d.line = 'refund_units') AS units,
                     -SUM(d.amount) FILTER (WHERE d.line = 'refund_amount') AS amount
                FROM finances_daily d JOIN asins a ON a.asin = d.asin WHERE d.day BETWEEN $1::date AND $2::date AND d.line IN ('refund_units', 'refund_amount') GROUP BY a.id, d.day) x
       WHERE s.asin_id = x.asin_id AND s.sale_date = x.day`, P);
    await q(`UPDATE sales_daily SET units_refunded = 0, refund_amount = 0 WHERE sale_date BETWEEN $1::date AND $2::date AND (units_refunded <> 0 OR refund_amount <> 0)
               AND NOT EXISTS (SELECT 1 FROM finances_daily d JOIN asins a ON a.asin = d.asin WHERE a.id = sales_daily.asin_id AND d.day = sales_daily.sale_date AND d.line IN ('refund_units', 'refund_amount'))`, P);
    return { rows: Number(r.rowCount ?? 0) };
  };
  const out = opts.q ? await run(opts.q) : await aggregateDeps.transaction(run);
  L(`finances_daily ${from}..${to}: ${out.rows} rows`);
  return out;
}

// ── Read side ──────────────────────────────────────────────────────────────

export interface AggRow { line: string; amount: number; quantity: number; est_amount: number; est_units: number; prep_units: number; prep_hazmat_units: number }
const r2 = (n: number) => Math.round(n * 100) / 100;
const pct = (ratio: number) => Math.round(ratio * 10000) / 100;

/** Pure: aggregate rows for a range (+ the Settings prep values) → the breakdown of §1 / §6. */
export function breakdownFromRows(rows: AggRow[], settings: Pick<Settings, "prepCost" | "hazmatPrepSurcharge">, meta: { from: string; to: string; asin: string | null; dataFrom: string | null }): FinancesBreakdown {
  const P = settings.prepCost ?? 0, H = (settings.prepCost ?? 0) + (settings.hazmatPrepSurcharge ?? 0);
  const prepOf = (r: AggRow) => r.prep_units * P + r.prep_hazmat_units * H;
  const by = new Map(rows.map((r) => [r.line, r]));
  const amt = (line: string) => by.get(line)?.amount ?? 0;
  const qty = (line: string) => by.get(line)?.quantity ?? 0;
  const lines: FinancesBreakdownLine[] = [];
  const push = (line: string, amount: number, extra: Partial<FinancesBreakdownLine> = {}) => lines.push({ line, label: labelOf(line), group: groupOf(line), amount: r2(amount), ...extra });
  const sales = amt("sales"), units = qty("units"), refunds = qty("refunds");
  push("sales", sales); push("units", 0, { quantity: units }); push("refunds", 0, { quantity: refunds }); push("promo", 0); push("advertising", 0);
  // Refund cost
  for (const r of rows) if (groupOf(r.line) === "refund_cost" && r.line !== "returned_value") push(r.line, r.amount);
  const returned = by.get("returned_value"); const returnedValue = returned ? returned.amount + prepOf(returned) : 0;
  if (returned) push("returned_value", returnedValue);
  // Amazon fees
  for (const r of rows) if (groupOf(r.line) === "amazon_fees") push(r.line, r.amount, r.est_amount || r.est_units ? { estAmount: r2(r.est_amount), estUnits: r.est_units } : {});
  // Cost of goods
  const cogsRow = by.get("cogs"); const prepRow = by.get("prep");
  const cogs = cogsRow?.amount ?? 0; const prep = prepRow ? -prepOf(prepRow) : 0;
  push("cogs", cogs, { quantity: cogsRow?.quantity ?? 0 }); push("prep", prep, { quantity: prepRow?.quantity ?? 0 });
  const disp = by.get("disposal_value"); if (disp) push("disposal_value", disp.amount + prepOf(disp));
  const ld = by.get("lost_damaged"); if (ld) push("lost_damaged", ld.amount + prepOf(ld));
  const sum = (g: string) => r2(lines.filter((l) => l.group === g).reduce((s, l) => s + l.amount, 0));
  const refundCost = sum("refund_cost"), amazonFees = sum("amazon_fees"), costOfGoods = sum("cost_of_goods");
  const refundCostCash = r2(refundCost - r2(returnedValue));
  const grossProfit = r2(sales + refundCost + amazonFees + costOfGoods);
  const netProfit = grossProfit;
  const estPayout = r2(sales + refundCostCash + amazonFees);
  const ordersRow = by.get("orders");
  const retUnits = qty("returns_units"), retSellable = qty("returns_sellable");
  // Order inside groups: the fixed lines in SB's order, then the Amazon-named lines most negative first.
  const order = (g: keyof typeof GROUP_ORDER) => { const fixed = GROUP_ORDER[g]; return (a: FinancesBreakdownLine, b: FinancesBreakdownLine) => { const ia = fixed.indexOf(a.line), ib = fixed.indexOf(b.line); if (ia >= 0 || ib >= 0) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib); return a.amount - b.amount; }; };
  const sorted = [
    ...lines.filter((l) => l.group === "top"),
    ...lines.filter((l) => l.group === "refund_cost").sort(order("refund_cost")),
    ...lines.filter((l) => l.group === "amazon_fees").sort(order("amazon_fees")),
    ...lines.filter((l) => l.group === "cost_of_goods").sort(order("cost_of_goods")),
  ];
  return {
    from: meta.from, to: meta.to, asin: meta.asin, lines: sorted,
    totals: {
      sales: r2(sales), units, orders: meta.asin ? null : (ordersRow ? ordersRow.quantity : null), refunds,
      refundCost, refundCostCash, amazonFees, costOfGoods, grossProfit, netProfit, estPayout,
      margin: sales ? pct(netProfit / sales) : null,
      roi: costOfGoods ? pct(netProfit / Math.abs(costOfGoods)) : null,
      refundRate: units ? pct(refunds / units) : null,
      sellableReturns: retUnits ? pct(retSellable / retUnits) : null,
    },
    dataFrom: meta.dataFrom,
  };
}

export async function loadProfitSettings(q: QueryFn = defaultQuery as any): Promise<Settings> {
  return settingsFromRows((await q(`SELECT key, value FROM settings`)).rows);
}

/** The breakdown for a Pacific-day range, account-wide (asin null) or for one ASIN (§6). */
export async function readBreakdown(from: string, to: string, asin: string | null, q: QueryFn = defaultQuery as any, settings?: Settings): Promise<FinancesBreakdown> {
  const s = settings ?? (await loadProfitSettings(q));
  const rows = (await q(
    `SELECT line, SUM(amount)::float8 AS amount, SUM(quantity)::float8 AS quantity, SUM(est_amount)::float8 AS est_amount, SUM(est_units)::float8 AS est_units, SUM(prep_units)::float8 AS prep_units, SUM(prep_hazmat_units)::float8 AS prep_hazmat_units
       FROM finances_daily WHERE day BETWEEN $1::date AND $2::date ${asin ? "AND asin = $3" : ""} GROUP BY line`,
    asin ? [from, to, asin] : [from, to],
  )).rows as AggRow[];
  const first = (await q(`SELECT MIN(day)::text AS d FROM finances_daily WHERE line = 'sales'`)).rows[0]?.d ?? null;
  const dataFrom = first && from < first ? first : null;
  return breakdownFromRows(rows.map((r) => ({ ...r, amount: Number(r.amount), quantity: Number(r.quantity), est_amount: Number(r.est_amount), est_units: Number(r.est_units), prep_units: Number(r.prep_units), prep_hazmat_units: Number(r.prep_hazmat_units) })), s, { from, to, asin, dataFrom });
}

export interface AsinActuals { asin: string; sales: number; units: number; refunds: number; refundAmount: number; refundCost: number; amazonFees: number; cogs: number; prep: number; costOfGoods: number; netProfit: number; estPayout: number; cogsMissingUnits: number }

/** Per-ASIN Actuals for a range — ONE accessor for every table (§6): the same facts as the panel, so a table's Actual Profit equals its panel's Net profit. */
export async function readAsinActuals(from: string, to: string, asins: readonly string[] | null, q: QueryFn = defaultQuery as any, settings?: Settings): Promise<Map<string, AsinActuals>> {
  const s = settings ?? (await loadProfitSettings(q));
  const rows = (await q(
    `SELECT asin, line, SUM(amount)::float8 AS amount, SUM(quantity)::float8 AS quantity, SUM(est_amount)::float8 AS est_amount, SUM(est_units)::float8 AS est_units, SUM(prep_units)::float8 AS prep_units, SUM(prep_hazmat_units)::float8 AS prep_hazmat_units
       FROM finances_daily WHERE day BETWEEN $1::date AND $2::date AND asin <> '' ${asins ? "AND asin = ANY($3::text[])" : ""} GROUP BY asin, line`,
    asins ? [from, to, asins] : [from, to],
  )).rows;
  const byAsin = new Map<string, AggRow[]>();
  for (const r of rows) (byAsin.get(r.asin) ?? byAsin.set(r.asin, []).get(r.asin)!).push({ line: r.line, amount: Number(r.amount), quantity: Number(r.quantity), est_amount: Number(r.est_amount), est_units: Number(r.est_units), prep_units: Number(r.prep_units), prep_hazmat_units: Number(r.prep_hazmat_units) });
  const out = new Map<string, AsinActuals>();
  for (const [asin, rs] of Array.from(byAsin.entries())) {
    const b = breakdownFromRows(rs, s, { from, to, asin, dataFrom: null });
    const l = (line: string) => b.lines.find((x) => x.line === line)?.amount ?? 0;
    out.set(asin, { asin, sales: b.totals.sales, units: b.totals.units, refunds: b.totals.refunds, refundAmount: r2(-l("refund_amount")), refundCost: b.totals.refundCost, amazonFees: b.totals.amazonFees, cogs: l("cogs"), prep: l("prep"), costOfGoods: b.totals.costOfGoods, netProfit: b.totals.netProfit, estPayout: b.totals.estPayout, cogsMissingUnits: rs.find((x: AggRow) => x.line === "cogs_missing")?.quantity ?? 0 });
  }
  return out;
}
