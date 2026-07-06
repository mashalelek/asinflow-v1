-- Migration 017: listing_submissions — post-submit verification ledger.
--
-- putListingsItem "ACCEPTED" is only synchronous validation; downstream async
-- processing can still fail/suppress a listing (yesterday's batch: 1 of 8 was a
-- restricted-generic ghost, invisible until manual audit). Every PUT fire is
-- recorded here; an on-demand Verify sweep resolves each row against SC.
--
-- State machine (see server/submission-verify.ts):
--   pending    — submitted, not yet verified (or throttled during verify)
--   processing — verified, not materialized yet, NO terminal signal → re-verify
--   live       — listing materialized (status/offer present); advisory issues
--                (incl. ERROR like 18555 on a buyable listing) go to review_flags
--   failed     — NOT materialized AND a conclusive terminal signal present
--   stale      — processing beyond the time window → needs a manual verdict
--   deleted    — manual verdict: the VA intentionally removed it in SC
--
-- verdict_source records whether the current status came from the API sweep or a
-- human. A deleted listing is API-indistinguishable from a silent ghost (both:
-- absent, no terminal signal), so the manual flow must be able to say "deleted".

CREATE TABLE IF NOT EXISTS listing_submissions (
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  asin              varchar(10) NOT NULL,
  sku               varchar(50) NOT NULL,
  submission_id     text,                       -- from ACCEPTED; NULL for backfilled rows (never stored before)
  submitted_price   numeric(10,2),              -- resolved price at submit; NULL for backfill
  submitted_at      timestamptz NOT NULL DEFAULT now(),
  verify_status     text NOT NULL DEFAULT 'pending'
                       CHECK (verify_status IN ('pending','processing','live','failed','stale','deleted')),
  verified_at       timestamptz,                -- last time a verdict was written (api or manual)
  verdict_source    text CHECK (verdict_source IN ('api','manual')),  -- NULL until first resolved
  issues            jsonb,                      -- snapshot of Amazon issues at last verify
  review_flags      text[] NOT NULL DEFAULT '{}',-- surfaced advisories on a LIVE row (visible, not JSONB-only)
  terminal_conflict boolean NOT NULL DEFAULT false  -- LIVE but a terminal signal is also present (precedence guard)
);

CREATE INDEX IF NOT EXISTS listing_submissions_status_idx ON listing_submissions (verify_status);
CREATE INDEX IF NOT EXISTS listing_submissions_asin_idx   ON listing_submissions (asin);

COMMENT ON TABLE listing_submissions IS
  'Post-submit verification ledger. One row per putListingsItem fire. Verify sweep resolves verify_status against SC; ACCEPTED is never rendered as CREATED.';
