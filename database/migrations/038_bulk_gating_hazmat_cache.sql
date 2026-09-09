-- §21 shared gating/hazmat cache (2026-09-09, decision): stamps live in ONE
-- place, keyed by ASIN — every bulk list shares them, so re-uploading the
-- same ASINs stops paying the ~45-minute probe tax. Fully bulk-side: no FK
-- to asins, no main-table reads. Rows survive list deletion by design
-- (shared state). Backfilled from the freshest per-ASIN row stamps, then
-- the per-row stamp columns are DROPPED — one place decides "needs probe";
-- per-row eligibility_status / is_hazmat stay as the display copy.
BEGIN;
CREATE TABLE bulk_gating_hazmat_cache (
  asin VARCHAR(10) PRIMARY KEY,
  eligibility_status TEXT NULL,
  is_hazmat BOOLEAN NULL,
  gating_checked_at TIMESTAMPTZ NULL,
  hazmat_checked_at TIMESTAMPTZ NULL
);
INSERT INTO bulk_gating_hazmat_cache (asin, eligibility_status, is_hazmat, gating_checked_at, hazmat_checked_at)
SELECT DISTINCT ON (asin)
       asin, eligibility_status, is_hazmat, gating_checked_at, hazmat_checked_at
  FROM bulk_list_asins
 WHERE gating_checked_at IS NOT NULL OR hazmat_checked_at IS NOT NULL
 ORDER BY asin, GREATEST(COALESCE(gating_checked_at, 'epoch'), COALESCE(hazmat_checked_at, 'epoch')) DESC;
ALTER TABLE bulk_list_asins DROP COLUMN gating_checked_at;
ALTER TABLE bulk_list_asins DROP COLUMN hazmat_checked_at;
COMMIT;
