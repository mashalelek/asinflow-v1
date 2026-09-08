-- §21 bulk-local Notes (2026-09-08): the Spark commentary column, same
-- pattern as promo_notes (migration 031). Unrelated to asins.notes.
ALTER TABLE bulk_list_asins ADD COLUMN notes TEXT NULL;
