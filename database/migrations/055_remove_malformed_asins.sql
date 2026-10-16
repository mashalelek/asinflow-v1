-- 055_remove_malformed_asins.sql — data migration (Maria, 2026-10-16).
--
-- Two malformed ASIN strings in `asins`:
--   B0DP1JCPS  — a typo of B0DP1JCP6S, which already exists (nothing to
--                merge); dead/invalid_asin since 2026-07-19.
--   UNKNOW     — the orders report's placeholder string, onboarded by the
--                first local sales backfill (job 8, 2026-10-16) before the
--                well-formed-ASIN guard (fca5e64). Never existed on Render.
--
-- Idempotent: a no-op where the rows are absent. The FKs onto asins.id
-- (asin_skus, asin_tags, sales_daily, inventory_snapshots,
-- asin_estimates_history) are ON DELETE CASCADE; asin_estimates is keyed by
-- the asin TEXT with no FK, so it is deleted explicitly first.

DELETE FROM asin_estimates WHERE asin IN ('B0DP1JCPS', 'UNKNOW');
DELETE FROM asins WHERE asin IN ('B0DP1JCPS', 'UNKNOW');
