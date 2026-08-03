-- §6 Submission column, item 7: per-ASIN current-issues snapshot.
-- Written by every definitive live-offer probe (cron / rider / recheck) from
-- the SAME getListingsItem call (includedData=summaries,issues). NULL
-- issues_checked_at = never snapshotted; current_issues '[]' = checked, clean.
-- Read-only surface — never derived from or written to listing_submissions.
ALTER TABLE asins
  ADD COLUMN IF NOT EXISTS current_issues JSONB,
  ADD COLUMN IF NOT EXISTS issues_checked_at TIMESTAMPTZ;
