-- ONE-TIME legacy hazmat reset (cutover step 3 — NOT a schema migration).
--
-- Clears the ~72 legacy is_hazmat=TRUE flags accumulated under the obsolete
-- attrs.hazmat (DOT/IATA transport classification) detection + the old
-- sticky-OR UPSERT. After this, the COMMINGLING-based backfill repopulates
-- is_hazmat correctly.
--
-- Deliberately kept OUT of the schema migrations so this destructive,
-- one-time data change can be audited independently and is never re-run by
-- a migration runner.
--
-- is_hazmat_override is intentionally NOT touched — any manual user overrides
-- are preserved (none exist at first cutover, but future re-runs must be safe).
-- The is_hazmat_effective generated column updates automatically.

UPDATE asins SET is_hazmat = FALSE WHERE is_hazmat IS DISTINCT FROM FALSE;
