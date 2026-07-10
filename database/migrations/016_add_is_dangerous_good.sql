-- Migration 016: split the conflated hazard signal into two independent flags.
--
--   is_dangerous_good ← getCatalogItem attributes.hazmat present/non-empty
--                       (DG transport classification; presence, not values)
--   is_hazmat         ← getItemEligibilityPreview program=INBOUND, code FBA_INB_0015
--                       (FBA hazmat storage/handling program)
--
-- Both NULLABLE with NO default: NULL = not-yet-checked (unknown ≠ false).
-- Tri-state discipline — throttle/error never writes false; consumers treat
-- NULL as "unknown", not "verified safe".
--
-- ROOT-CAUSE RESET: every existing is_hazmat value was derived from the
-- COMMINGLING/FBA_INB_0096 bug ("ineligible for commingling" ≠ hazmat), which
-- fires broadly now that commingling is discontinued. None are trustworthy, so
-- we reset ALL to NULL and let the 016 backfill re-derive from the correct
-- INBOUND source. This mirrors the reset_legacy_hazmat.sql cutover, but is
-- folded into the migration per the approved plan (all values poisoned → safe
-- to reset unconditionally inside the schema step).

BEGIN;

ALTER TABLE asins
  ADD COLUMN IF NOT EXISTS is_dangerous_good BOOLEAN;   -- nullable, no default → NULL = unknown

-- Stop coercing unchecked → false so NULL can mean "not yet checked".
ALTER TABLE asins
  ALTER COLUMN is_hazmat DROP DEFAULT;

-- Clear the FBA_INB_0096-poisoned values (all 226 trues + the falses are equally
-- untrustworthy). NULL until the backfill re-derives via INBOUND/0015.
UPDATE asins SET is_hazmat = NULL WHERE is_hazmat IS NOT NULL;

COMMENT ON COLUMN asins.is_dangerous_good IS
  'DG transport classification: getCatalogItem attributes.hazmat present/non-empty. NULL = not yet checked. Drives the DG-attribute gate (live-derived at offer-add) and the DG surcharge.';
COMMENT ON COLUMN asins.is_hazmat IS
  'FBA hazmat (storage/handling): INBOUND eligibility code FBA_INB_0015. NULL = not yet checked. KNOWN LIMITATION: 0015 proven only for compressed-gas hazmat; other classes unanchored, read false until validated (see server/hazmat-classify.ts + docs/SPEC.md).';

COMMIT;
