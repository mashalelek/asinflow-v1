-- 052_scheduler_v1.sql — Scheduler v1 (SPEC §11 "Refresh job"; patch
-- docs/claude_spec-patch-scheduler-v1.md, decisions 3, 11, 12, 13).
--
-- One durable Postgres job queue (decision 13), consumed by one runner, one
-- job at a time, in one fixed component order. Scheduled passes and the
-- Refresh button enqueue the same `refresh` job with different scopes.

CREATE TABLE jobs (
  id            BIGSERIAL PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('refresh')),      -- room for later kinds
  trigger       TEXT NOT NULL CHECK (trigger IN ('scheduled','manual','onboarding','bulk')),
  target        TEXT NOT NULL DEFAULT 'main' CHECK (target IN ('main','bulk')),
  bulk_list_id  UUID REFERENCES bulk_lists(id) ON DELETE SET NULL, -- when target = 'bulk' (bulk_lists.id is uuid, not integer as drafted)
  include_daily BOOLEAN NOT NULL DEFAULT FALSE,                   -- daily block (components 2–8)
  scope_asins   TEXT[],                                           -- NULL = scheduled scope rule (active + parked)
  status        TEXT NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued','running','done','failed','cancelled')),
  progress      JSONB NOT NULL DEFAULT '{}',   -- {component: n, asin_cursor: 'B0…', done: [n, …]}
  summary       JSONB,                         -- per-component counts + flips, written at the end
  requested_by  INTEGER REFERENCES users(id),  -- NULL for scheduled
  queued_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ,
  error         TEXT
);
CREATE INDEX jobs_status_idx ON jobs (status) WHERE status IN ('queued','running');
CREATE INDEX jobs_queued_at_idx ON jobs (queued_at DESC);

-- Decision 12: CPT lives on asin_estimates and is written by the prices
-- component every pass (it rides the itemOffers response already fetched).
ALTER TABLE asin_estimates ADD COLUMN competitive_price_threshold NUMERIC(10,2);

-- Decision 11: in_catalog retired. Nothing read it (2026-10-14 audit); its
-- three writers (inventory, sales, phase-c onboarding) lose the statement
-- in the same commit.
ALTER TABLE asins DROP COLUMN in_catalog;

-- Decision 3: no freshness caches. Bulk Calc's 30-day gating/hazmat cache
-- goes; the bulk refresh is rewired onto the job in commit 3 of the patch.
DROP TABLE IF EXISTS bulk_gating_hazmat_cache;

-- refresh_runs stays the per-component ledger: one row per component per
-- job. job_id links them; the trigger CHECK gains the four job triggers and
-- KEEPS the historical values (1,600 existing rows carry them); stage is
-- widened for component names like "16_live_offer".
ALTER TABLE refresh_runs ADD COLUMN job_id BIGINT REFERENCES jobs(id) ON DELETE SET NULL;
CREATE INDEX refresh_runs_job_id_idx ON refresh_runs (job_id);
ALTER TABLE refresh_runs ALTER COLUMN stage TYPE TEXT;
ALTER TABLE refresh_runs DROP CONSTRAINT IF EXISTS refresh_runs_trigger_check;
ALTER TABLE refresh_runs ADD CONSTRAINT refresh_runs_trigger_check CHECK (
  trigger IN (
    'manual', 'refresh', 'cron', 'sourcing', 'upload', 'extension', 'backfill', 'sc_discovery', -- historical
    'scheduled', 'onboarding', 'bulk'                                                            -- jobs (manual shared)
  )
);
