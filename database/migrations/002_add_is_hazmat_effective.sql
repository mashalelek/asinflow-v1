-- Migration 002: effective-hazmat generated column
--
-- Single source of truth for "is this ASIN hazmat for display + calculations":
--   is_hazmat_effective = COALESCE(is_hazmat_override, is_hazmat)
--
-- Implemented as a STORED generated column so the COALESCE lives in exactly
-- one place (the schema) instead of being inlined in every query/calc path.
-- It auto-updates whenever is_hazmat (auto-detection) or is_hazmat_override
-- (manual) changes — including the one-time legacy is_hazmat reset.
--
-- Requires PostgreSQL 12+.

ALTER TABLE asins
  ADD COLUMN IF NOT EXISTS is_hazmat_effective BOOLEAN
  GENERATED ALWAYS AS (COALESCE(is_hazmat_override, is_hazmat)) STORED;

COMMENT ON COLUMN asins.is_hazmat_effective IS
  'Generated: COALESCE(is_hazmat_override, is_hazmat). The single value all display + profit/inbound/prep calculations must read.';
