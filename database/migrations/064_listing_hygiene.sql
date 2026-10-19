-- 064_listing_hygiene.sql (2026-10-19)
--
-- Listing hygiene (docs/claude_spec-patch-listing-hygiene.md, SPEC §11
-- components 22–24, §14 ownership). Decisions confirmed by Maria 2026-10-18/19.

-- Every FBA bucket per SKU, from component 15's getInventorySummaries
-- (details=true). Owner: component 15 only. One row per SKU, upserted every
-- pass; a SKU absent from a COMPLETE paginated response is written all-zero
-- (absence from a complete pull is conclusive). last_nonzero_at only moves
-- forward.
CREATE TABLE IF NOT EXISTS sku_fba_inventory (
  sku                    TEXT PRIMARY KEY,
  asin                   TEXT NOT NULL,
  fnsku                  TEXT,
  fulfillable            INTEGER NOT NULL,
  inbound_working        INTEGER NOT NULL,
  inbound_shipped        INTEGER NOT NULL,
  inbound_receiving      INTEGER NOT NULL,
  reserved_customer      INTEGER NOT NULL,   -- pendingCustomerOrderQuantity
  reserved_fc_transfer   INTEGER NOT NULL,   -- pendingTransshipmentQuantity
  reserved_fc_processing INTEGER NOT NULL,   -- fcProcessingQuantity
  unfulfillable          INTEGER NOT NULL,   -- totalUnfulfillableQuantity
  researching            INTEGER NOT NULL,   -- totalResearchingQuantity
  future_supply          INTEGER NOT NULL,   -- reservedFutureSupply + futureSupplyBuyable
  last_nonzero_at        TIMESTAMPTZ,        -- any bucket > 0; only moves forward
  observed_at            TIMESTAMPTZ NOT NULL,
  job_id                 BIGINT
);

-- Inventory Ledger summary (GET_LEDGER_SUMMARY_VIEW_DATA, DAILY, COUNTRY).
-- Owner: component 23 only. Keyed by MSKU, no FK — SKUs AF has not onboarded
-- are kept.
CREATE TABLE IF NOT EXISTS sku_ledger_state (
  sku                 TEXT PRIMARY KEY,
  last_stocked_date   DATE,          -- latest Date with Σ(ending balance, all dispositions) > 0; only moves forward
  ledger_window_start DATE NOT NULL, -- earliest date this row's reports have covered
  checked_at          TIMESTAMPTZ NOT NULL
);

-- Close / delete ledger. Writers: components 22 and 24 (and their Release
-- job); verification (verified / not_effective, verified_at, verify_passes)
-- by component 16.
CREATE TABLE IF NOT EXISTS listing_actions (
  id             BIGSERIAL PRIMARY KEY,
  sku            TEXT NOT NULL,
  asin           TEXT NOT NULL,
  action         TEXT NOT NULL CHECK (action IN ('close','delete')),
  job_id         BIGINT,
  dry_run        BOOLEAN NOT NULL,
  evidence       JSONB NOT NULL,   -- buckets, blockers checked, clock dates, thresholds
  status         TEXT NOT NULL CHECK (status IN
                   ('would_fire','held','accepted','invalid','error','verified','not_effective')),
  submission_id  TEXT,
  issues         JSONB,
  fired_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  verified_at    TIMESTAMPTZ,
  -- Component-16 passes that probed the SKU after an accepted action and did
  -- not see it take effect; at 2 the row becomes not_effective.
  verify_passes  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS listing_actions_job_idx ON listing_actions (job_id);
CREATE INDEX IF NOT EXISTS listing_actions_sku_idx ON listing_actions (sku, fired_at DESC);
CREATE INDEX IF NOT EXISTS listing_actions_accepted_idx ON listing_actions (status) WHERE status IN ('accepted','held');

-- Listing state per SKU, from component 16's getListingsItem (summaries +
-- attributes). Owner: component 16 only. A probe that finds no listing (404
-- or empty summaries, §18 A1) stamps listing_checked_at and clears the other
-- two; a transient probe writes nothing. offer_end_at means "closed now" when
-- <= now() — Amazon rewrites end_at on close, so it is never "closed since".
ALTER TABLE asin_skus ADD COLUMN IF NOT EXISTS listing_created_at TIMESTAMPTZ;
ALTER TABLE asin_skus ADD COLUMN IF NOT EXISTS offer_end_at       TIMESTAMPTZ;
ALTER TABLE asin_skus ADD COLUMN IF NOT EXISTS listing_checked_at TIMESTAMPTZ;

-- Circuit breakers: more than N closes / deletes in one run → nothing is
-- written, every candidate is held for Release.
INSERT INTO settings (key, value) VALUES
  ('hygiene_close_breaker', '25'::jsonb),
  ('hygiene_delete_breaker', '25'::jsonb)
ON CONFLICT (key) DO NOTHING;
