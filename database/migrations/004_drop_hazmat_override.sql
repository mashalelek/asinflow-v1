-- Migration 004: drop hazmat override + effective columns
--
-- Reverts the override scaffolding from migrations 001/002. We're keeping only
-- the original is_hazmat column (auto-detected, "from SP-API — working as
-- intended" per Maria) and removing the manual-override machinery.
--
-- Drop order matters: is_hazmat_effective is a GENERATED column whose
-- expression references is_hazmat_override, so it must drop first.
-- (CASCADE would work too but the explicit ordering is clearer.)

BEGIN;

ALTER TABLE asins DROP COLUMN IF EXISTS is_hazmat_effective;
ALTER TABLE asins DROP COLUMN IF EXISTS is_hazmat_override;

COMMIT;
