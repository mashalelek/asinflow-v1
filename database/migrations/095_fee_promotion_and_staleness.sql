-- 095_fee_promotion_and_staleness.sql — Fees (Maria 2026-11-06, SPEC §11
-- component 13).
--
-- fba_fee_promotion: the part of the FBA fee Amazon's estimate waived by a
-- fee promotion (FeePromotion). fba_fee now holds the fee BEFORE the
-- promotion (conservative); the promotion is shown on hover ("FBA fee waived
-- by promotion ($X)"). NULL = none on the last estimate.
-- fee_fetched_at: when the stored fee last came from SP-API (NULL = before
-- this migration, or never).
-- fee_error / fee_error_at: the last failure after the step's retry, cleared
-- by the next success. A failure never overwrites the stored fee; with
-- fee_error set the fee shows as stale with fee_fetched_at's date.
ALTER TABLE asin_estimates
  ADD COLUMN fba_fee_promotion numeric(10,2),
  ADD COLUMN fee_fetched_at timestamptz,
  ADD COLUMN fee_error text,
  ADD COLUMN fee_error_at timestamptz;
