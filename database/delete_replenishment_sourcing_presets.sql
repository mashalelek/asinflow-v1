-- ONE-TIME deletion of the Replenishment + Sourcing built-in view presets
-- (B3 cutover). The Replenishment FILTER LOGIC is now reached via the
-- Replens scorecard tile, which calls isReplens() in shared/profitability.ts.
-- The Sourcing preset had no filter — it was just a column-visibility preset
-- that Maria isn't using; "Full View" and the user-custom "Summer Sourcing"
-- preset remain.
--
-- Deliberately kept OUT of database/migrations/ because this is a one-time
-- data change, not a schema change — matches the database/reset_legacy_hazmat.sql
-- pattern.
--
-- Backup of deleted rows: database/backup_deleted_view_presets_<date>.sql
-- (re-runnable INSERT statements if a rollback is ever needed).
--
-- The DELETE /api/view-presets/:id endpoint blocks is_default=TRUE rows, so
-- this is the supported path for removing built-in presets.

BEGIN;

DELETE FROM view_presets
WHERE id IN (
  '6d2d15f2-fb93-40b0-b7ee-285d5105f7ac',  -- Replenishment
  'f9fe0939-0825-4da6-8ecd-a8ce7215af33'   -- Sourcing
);

-- Confirm exactly 2 rows removed.
DO $$
DECLARE
  remaining_doomed INTEGER;
BEGIN
  SELECT count(*) INTO remaining_doomed
  FROM view_presets
  WHERE name IN ('Replenishment', 'Sourcing');
  IF remaining_doomed <> 0 THEN
    RAISE EXCEPTION 'Expected 0 remaining Replenishment/Sourcing rows, found %', remaining_doomed;
  END IF;
END $$;

COMMIT;
