-- §21 bulk-local Last Reviewed (2026-09-10): the §6 review stamp, on this
-- table — set by the same Product-cell link clicks, never by the pipeline.
ALTER TABLE bulk_list_asins ADD COLUMN last_reviewed_at TIMESTAMPTZ NULL;
