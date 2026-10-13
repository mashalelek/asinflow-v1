-- §18 Part B phase c (2026-10-11): ASINs discovered in Seller Central that
-- AF did not have are onboarded through onboardNewAsins — the ONE insert
-- path (§14) — which writes a refresh_runs row per stage carrying its
-- trigger. 'sc_discovery' is that trigger: the onboarding was not a user
-- upload, a sourcing-sheet row, the Chrome extension or a backfill, and
-- labelling it as any of those would misattribute how the ASIN arrived.
--
-- Same shape as 040, which widened this CHECK for the earlier insert paths.
ALTER TABLE refresh_runs DROP CONSTRAINT refresh_runs_trigger_check;
ALTER TABLE refresh_runs ADD CONSTRAINT refresh_runs_trigger_check
  CHECK (trigger IN ('manual', 'refresh', 'cron', 'sourcing', 'upload', 'extension', 'backfill', 'sc_discovery'));
