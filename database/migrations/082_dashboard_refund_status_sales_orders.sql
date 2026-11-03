-- 082_dashboard_refund_status_sales_orders.sql — Dashboard patch (SPEC §28,
-- docs/claude_spec-patch-analytics-dashboard.md §2.3 C1 and §2.5 C2).
--
-- 1. po_line_refunds.status: a refund row is either 'due' (the supplier owes
--    it — canceled items, returns; amount = the expected amount, the
--    refunded_at / method / nickname / last4 fields NULL until received) or
--    'received'. Every existing row (the col AF backfill, manual entries) is
--    received. Spend subtracts rows of any status; "Refunds due" sums the due
--    ones. From this patch on the line rows are the money of record for
--    refunds; purchase_orders.refund_amount is not read by the Dashboard.
-- 2. sales_orders: one row per (Amazon order id, ASIN) from the orders
--    report — the Dashboard's Orders count is COUNT(DISTINCT amazon_order_id)
--    per range. Written by component 19 next to sales_daily (same chunk,
--    same delete + reload), cancelled orders skipped as there. sale_date is
--    the US Pacific day of the purchase (D7).
ALTER TABLE po_line_refunds
  ADD COLUMN status text NOT NULL DEFAULT 'received' CHECK (status IN ('due', 'received'));
CREATE INDEX po_line_refunds_status_idx ON po_line_refunds (po_id, status);

CREATE TABLE sales_orders (
  amazon_order_id text NOT NULL,
  asin_id         uuid NOT NULL REFERENCES asins(id) ON DELETE CASCADE,
  sale_date       date NOT NULL,
  units           integer NOT NULL DEFAULT 0,
  synced_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (amazon_order_id, asin_id)
);
CREATE INDEX sales_orders_date_idx ON sales_orders (sale_date);
CREATE INDEX sales_orders_asin_date_idx ON sales_orders (asin_id, sale_date);
