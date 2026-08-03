-- §19 panel dismiss action: acknowledged-flags timestamp.
-- Dismiss hides a terminal row from needs-attention; issues/review_flags stay.
-- NULL = not acknowledged. Set by POST /api/submissions/dismiss-flags.
-- (023: 022 is taken by the in-flight bulk-profit-calculator work.)
ALTER TABLE listing_submissions
  ADD COLUMN IF NOT EXISTS flags_acknowledged_at TIMESTAMPTZ;
