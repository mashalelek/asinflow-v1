-- Migration 020: promo_notes — user-controlled free text from the sourcing
-- sheet's Col O ("Coupons/Gift Cards/Sales").
--
-- Ownership (§14): user-controlled, same owner class as notes (sourcing sync
-- on new-ASIN insert; manual edit later if a UI edit path is added). Analyze
-- MUST NOT write it. Persisted via the asymmetric-UPSERT pattern (like
-- notes/estimated_cogs): INSERT branch only — the ON CONFLICT UPDATE branch
-- never touches it, so re-analyze/re-sync of existing ASINs can't clobber.
-- NULL = no promo info (empty Col O cell stays NULL, never '').

BEGIN;

ALTER TABLE asins
  ADD COLUMN IF NOT EXISTS promo_notes TEXT;

COMMENT ON COLUMN asins.promo_notes IS
  'Promo/coupon/gift-card notes from sourcing sheet Col O ("Coupons/Gift Cards/Sales"). User-controlled (§14): written on the new-ASIN INSERT branch only; analyze and re-sync never overwrite.';

COMMIT;
