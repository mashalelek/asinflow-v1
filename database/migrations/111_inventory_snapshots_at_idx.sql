-- migrate: no-transaction
-- 111: snapshot_at alone (2026-11-13). The Repricer's zero-sales view opens with `SELECT MAX(snapshot_at) FROM
-- inventory_snapshots` — a parallel seq scan over 1.3M rows (4.6 s on production; the two existing indexes lead with
-- asin_id or are partial on available_fba > 0, so neither answers a bare MAX). A plain btree on snapshot_at makes it an
-- index-only scan. CONCURRENTLY: the hourly inventory component keeps writing while it builds (one statement, no transaction).
CREATE INDEX CONCURRENTLY IF NOT EXISTS inventory_snapshots_at_idx ON inventory_snapshots (snapshot_at DESC);
