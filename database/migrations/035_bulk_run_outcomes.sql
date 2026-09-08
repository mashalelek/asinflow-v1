-- §21 bulk run pipeline (2026-09-09): per-leg outcomes + the same 30-day
-- gating/hazmat stamps the main page uses, on this table.
ALTER TABLE bulk_list_asins ADD COLUMN catalog_outcome TEXT NULL;
ALTER TABLE bulk_list_asins ADD COLUMN price_outcome TEXT NULL;
ALTER TABLE bulk_list_asins ADD COLUMN gating_checked_at TIMESTAMPTZ NULL;
ALTER TABLE bulk_list_asins ADD COLUMN hazmat_checked_at TIMESTAMPTZ NULL;
