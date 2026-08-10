-- Migration 026: fee_source on asin_estimates — which writer produced the
-- stored FBA/referral fee triple.
--
--   'spapi'    — real getMyFeesEstimateForASIN response (the getFees path)
--   'fallback' — estimateFeeFallback (weight-based, written when the real
--                fetch exhausted retries). Diagnosed 2026-08-09: fallback
--                fees are invisible and materially wrong (B0F74MTVJP stored
--                $3.53 vs Amazon's real $5.66) — ~71 active rows affected.
--   NULL       — legacy (pre-026). Treated as real: the fingerprint backfill
--                (script/backfill-fee-source.ts) marks the known fallback
--                rows, so remaining NULLs are presumed 'spapi'.
--
-- Write gate (upsertAsinResult): 'spapi' always wins; 'fallback' only fills
-- missing fees or refreshes a prior 'fallback' — it never overwrites a real
-- ('spapi' or legacy-NULL) fee.

ALTER TABLE asin_estimates ADD COLUMN IF NOT EXISTS fee_source VARCHAR(10)
  CHECK (fee_source IN ('spapi', 'fallback'));
