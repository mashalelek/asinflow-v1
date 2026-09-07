-- 033: Parked / Dead status replaces is_active (SPEC §14, 2026-09-07).
-- One boolean conflated "set aside, may come back" with "gone for good".
-- status_reason absorbs archive_reason (same semantics: machine reasons are
-- fixed strings, manual ones free text — the old CHECK is dropped since
-- manual free text is now allowed). gating/hazmat_checked_at back the §11
-- Product Info 30-day re-check rule. Single transaction with the backfill
-- and the is_active DROP: a stale reader must fail loudly, never silently
-- treat dead as parked.
BEGIN;

ALTER TABLE asins ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN ('active', 'parked', 'dead'));
ALTER TABLE asins ADD COLUMN status_reason TEXT NULL;
ALTER TABLE asins ADD COLUMN status_changed_at TIMESTAMPTZ NULL;
ALTER TABLE asins ADD COLUMN gating_checked_at TIMESTAMPTZ NULL;
ALTER TABLE asins ADD COLUMN hazmat_checked_at TIMESTAMPTZ NULL;

UPDATE asins SET
  status = CASE
    WHEN is_active THEN 'active'
    WHEN archive_reason = 'catalog_deleted' THEN 'dead'
    ELSE 'parked'
  END,
  status_reason = archive_reason,
  status_changed_at = CASE WHEN is_active THEN NULL ELSE NOW() END;

DROP INDEX IF EXISTS idx_asins_active;
DROP INDEX IF EXISTS idx_asins_archive_reason;
ALTER TABLE asins DROP COLUMN is_active;
ALTER TABLE asins DROP COLUMN archive_reason;
CREATE INDEX idx_asins_status ON asins (status);

COMMIT;
