-- §18 Price Resolution v2 (2026-10-07): persist the pricing decision so
-- "why this price" is a LEDGER FACT, not a heuristic.
--
-- Motivation: answering "how many offers were capped since 2026-09-15" was
-- only possible by inferring from the price's cent shape (.99 = rule price,
-- .x9 = capped), because nothing about the decision was stored. 36 of 80 was
-- an estimate, not a count. v2 removes the cap, but the same question will
-- recur for the 40%-ROI reprice and the ROI-solve paths.
--
-- ADDITIVE ONLY: all columns nullable, no backfill, no constraint on existing
-- rows. Rows submitted before this migration keep NULLs — absence means
-- "submitted before the decision was recorded", never "no decision".
ALTER TABLE listing_submissions
  ADD COLUMN IF NOT EXISTS price_source            TEXT,           -- fba_anchor | roi_40_floor | roi_60_solve
  ADD COLUMN IF NOT EXISTS price_detail            TEXT,           -- the resolver's human-readable detail string
  ADD COLUMN IF NOT EXISTS anchor_offer_price      NUMERIC(10,2),  -- the qualified FBA offer anchored on (fba_anchor/roi_40_floor)
  ADD COLUMN IF NOT EXISTS anchor_offer_feedback   INTEGER,        -- that seller's feedback count
  ADD COLUMN IF NOT EXISTS cpt_seen                NUMERIC(10,2),  -- CompetitivePriceThreshold at submit time — RECORDED, never used to price
  ADD COLUMN IF NOT EXISTS resulting_roi           NUMERIC(8,2),   -- ROI at the submitted price
  ADD COLUMN IF NOT EXISTS price_warning           TEXT,           -- low_roi_repriced, or NULL
  ADD COLUMN IF NOT EXISTS qualified_offer_count   INTEGER,        -- offers that passed the qualified set
  ADD COLUMN IF NOT EXISTS disqualified_offers     JSONB;          -- [{sellerId, price, isFba, feedbackCount, reason}]

COMMENT ON COLUMN listing_submissions.cpt_seen IS
  'CompetitivePriceThreshold observed at submit time. Recorded for analysis ONLY — §18 v2 never uses CPT as a pricing input.';
COMMENT ON COLUMN listing_submissions.price_source IS
  'Which §18 v2 path set the price: fba_anchor | roi_40_floor | roi_60_solve.';
