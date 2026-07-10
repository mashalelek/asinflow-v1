-- Migration 001: per-ASIN manual hazmat override
--
-- Adds a nullable override column distinct from the auto-detected is_hazmat.
--   NULL  = no override; use auto-detection (is_hazmat)
--   TRUE  = user forces hazmat regardless of auto-detection
--   FALSE = user forces NOT hazmat regardless of auto-detection
--
-- Effective hazmat (for display + calculations) =
--   COALESCE(is_hazmat_override, is_hazmat)
--
-- This is intentionally a SEPARATE migration from the legacy is_hazmat reset
-- so each cutover step can be audited independently.

ALTER TABLE asins
  ADD COLUMN IF NOT EXISTS is_hazmat_override BOOLEAN DEFAULT NULL;

COMMENT ON COLUMN asins.is_hazmat_override IS
  'Manual hazmat override: NULL=use auto is_hazmat, TRUE=force hazmat, FALSE=force not-hazmat. Effective = COALESCE(is_hazmat_override, is_hazmat).';
