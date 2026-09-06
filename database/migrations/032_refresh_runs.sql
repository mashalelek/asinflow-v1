-- 032: Refresh run ledger (SPEC §11 "Refresh job & price refresh v2",
-- 2026-09-06). One row per stage per run: the answer to "which ASINs
-- failed" is a row, not terminal scrollback; the results dialog's history
-- and Retry-failed read from here. outcomes holds {asin: outcome[/message]}
-- for every non-updated item; rate_limit_stats is the per-bucket
-- {rate, sent, throttled, adjusted} snapshot proving the pacing worked.
CREATE TABLE refresh_runs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  trigger VARCHAR(10) NOT NULL CHECK (trigger IN ('manual', 'refresh', 'cron')),
  stage VARCHAR(20) NOT NULL,
  scope VARCHAR(10) NOT NULL CHECK (scope IN ('full', 'subset')),
  requested INTEGER NOT NULL DEFAULT 0,
  counts JSONB,
  outcomes JSONB,
  rate_limit_stats JSONB,
  error TEXT
);
CREATE INDEX idx_refresh_runs_started ON refresh_runs (started_at DESC);
