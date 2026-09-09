-- §11 new-ASIN onboarding (2026-09-09): ledger rows now carry the caller's
-- trigger — sourcing sync, CSV upload, Chrome extension, one-time
-- backfills. Widen the trigger CHECK (same shape as 037 did for scope).
ALTER TABLE refresh_runs DROP CONSTRAINT refresh_runs_trigger_check;
ALTER TABLE refresh_runs ADD CONSTRAINT refresh_runs_trigger_check
  CHECK (trigger IN ('manual', 'refresh', 'cron', 'sourcing', 'upload', 'extension', 'backfill'));
