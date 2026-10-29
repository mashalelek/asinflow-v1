-- §18 Relist (2026-10-29): a relist submission may ask to come up OPEN —
-- the §19 ladder then skips close-after-create for that row. Default FALSE:
-- normal Add to SC behavior (close right after create) is unchanged.
ALTER TABLE listing_submissions
  ADD COLUMN open_on_create BOOLEAN NOT NULL DEFAULT FALSE;
