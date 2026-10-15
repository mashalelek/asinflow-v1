-- 053_jobs_components.sql — scheduler patch commit 4 (decision 9).
--
-- Add to SC probes gating live for its selection and Push to Aura reads the
-- PO sheet for its selection first: each enqueues a tiny manual job that
-- runs ONE component (8 or 9) and waits for it. The jobs row therefore needs
-- to say which components it runs. NULL keeps the existing rule: the whole
-- sequence, the daily block only with include_daily.

ALTER TABLE jobs ADD COLUMN components INTEGER[];
COMMENT ON COLUMN jobs.components IS 'Component numbers this job runs, in sequence order; NULL = the whole sequence (daily block per include_daily). Decision 9 jobs carry {8} or {9}.';
