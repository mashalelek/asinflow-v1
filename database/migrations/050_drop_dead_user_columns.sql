-- 050_drop_dead_user_columns.sql — remove the Replit-era "who did it" columns
-- (SPEC §25, follow-up to 049; decided 2026-10-14).
--
-- 049 dropped the old users table with CASCADE, which silently removed the
-- four foreign keys below. Audit before this migration: every one of the
-- four columns is NULL in every row, no server code writes any of them, and
-- the only reader (GET /api/view-presets selected created_by) was removed in
-- the same commit. Their type is UUID; the new users.id is an integer, so
-- they could never have been re-pointed. Ledger attribution of actions to
-- users is a later concern and will get its own columns (SPEC §25 "Data
-- model").
--
-- Safe to re-run: IF EXISTS on every statement.

ALTER TABLE asins                  DROP COLUMN IF EXISTS added_by;
ALTER TABLE asin_tags              DROP COLUMN IF EXISTS applied_by;
ALTER TABLE view_presets           DROP COLUMN IF EXISTS created_by;
ALTER TABLE brand_product_registry DROP COLUMN IF EXISTS registered_by;
