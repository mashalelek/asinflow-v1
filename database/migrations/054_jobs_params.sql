-- 054_jobs_params.sql — per-job parameters (sales history backfill, 2026-10-16).
--
-- A job may carry parameters its components read. First use: the sales
-- component (19) takes `params.sales_window = {from, to}` (YYYY-MM-DD) for
-- the one-off history backfill enqueued by POST /api/jobs/backfill-sales;
-- absent, it keeps its 48-hour default. NULL = no parameters.

ALTER TABLE jobs ADD COLUMN params JSONB;
COMMENT ON COLUMN jobs.params IS 'Per-job parameters read by components; NULL = none. {"sales_window": {"from": "YYYY-MM-DD", "to": "YYYY-MM-DD"}} for the sales backfill.';
