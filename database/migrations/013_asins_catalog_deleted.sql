-- DA-1: catalog-deleted tracking.
--
-- is_catalog_deleted means ONE precise thing: getCatalogItem returned 404
-- (the ASIN's product record is gone from Amazon's catalog). It is NOT a
-- general "deactivated" flag — SC's other deactivated states, if ever needed,
-- get separate fields later.
--
-- archive_reason records WHY an ASIN was archived. The revival dialog only
-- offers to auto-unarchive ASINs whose archive_reason matches the recovery
-- signal (catalog_deleted → catalog restored; gated → now ungated). Manual
-- archives have archive_reason=NULL and are never auto-revived.

ALTER TABLE asins ADD COLUMN is_catalog_deleted BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE asins ADD COLUMN catalog_checked_at TIMESTAMPTZ;
ALTER TABLE asins ADD COLUMN archive_reason VARCHAR(20);

ALTER TABLE asins ADD CONSTRAINT asins_archive_reason_check
    CHECK (archive_reason IN ('catalog_deleted', 'gated') OR archive_reason IS NULL);

-- Partial index for the revival dialog query — only rows where the ASIN is
-- archived (small subset of ~1914 total). Lookup pattern:
--   SELECT ... WHERE is_active = FALSE AND archive_reason = $1
--                AND is_catalog_deleted = FALSE   (or eligibility != 'no')
CREATE INDEX idx_asins_archive_reason ON asins(archive_reason) WHERE is_active = FALSE;

COMMENT ON COLUMN asins.is_catalog_deleted IS
  'getCatalogItem returned 404 (product record gone from Amazon catalog). Reversible — flips back to false on next 200. Owned by analyze path per SPEC §14. NOT a general "deactivated" flag.';
COMMENT ON COLUMN asins.catalog_checked_at IS
  'Timestamp of the most recent getCatalogItem call that set is_catalog_deleted.';
COMMENT ON COLUMN asins.archive_reason IS
  'Why an ASIN was archived. NULL = manual archive (never auto-revived). catalog_deleted/gated = auto-archive — revival dialog offers to unarchive when the matching signal clears.';
