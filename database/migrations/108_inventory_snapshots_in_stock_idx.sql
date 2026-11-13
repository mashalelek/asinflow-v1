-- migrate: no-transaction
-- 108: the in-stock snapshot index for the ASINs page's "days in stock" (2026-11-13).
-- GET /api/asins counted distinct snapshot days with available_fba > 0 per ASIN over the date range by seq-scanning
-- all 1.3M inventory_snapshots rows (15k disk pages on the 256 MB instance) and sorting 130k rows to disk: 6 s per
-- page load, 70 s under the hourly pass (Postgres log 11/13). The query now hashes the distinct (asin, day) pairs
-- (server/routes.ts) off this partial index — range on snapshot_at, asin_id in the key, so an index-only scan.
-- CONCURRENTLY: the hourly inventory component keeps writing snapshots while it builds (ONE statement, no transaction).
CREATE INDEX CONCURRENTLY IF NOT EXISTS inventory_snapshots_in_stock_idx ON inventory_snapshots (snapshot_at, asin_id) WHERE available_fba > 0;
