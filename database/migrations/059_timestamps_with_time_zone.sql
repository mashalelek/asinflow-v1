-- 059_timestamps_with_time_zone.sql — the two remaining `timestamp without
-- time zone` columns become timestamptz (fix 2026-10-18, the 11-ASIN
-- diagnosis: a 6:05 ET price check rendered as 10:05).
--
-- Every value in these columns was written by Postgres NOW() (or a column
-- default) and therefore holds a clock reading in the DATABASE's configured
-- TimeZone: UTC on production (Render, ALTER DATABASE … TimeZone=utc),
-- America/New_York on the local dev database. So the conversion uses that
-- configured zone, not a hard-coded one. The app process runs TZ=America/
-- New_York, and node-pg read the zone-less values as Eastern — a 4-hour
-- shift on production that this removes. (The bulk-promote writer passed a
-- JS Date into fetched_at, which dropped the offset; with timestamptz that
-- writer is correct too. No stored value came from it on either database.)
--
-- Guard: the zone is taken from the database default (pg_settings.reset_val
-- = the ALTER DATABASE / role / configuration value, unaffected by a SET in
-- this session). The session value is logged next to it; if they differ the
-- default is used explicitly. The zone used is recorded in each column's
-- comment, because the migration runner does not surface notices.
DO $$
DECLARE
  session_tz text := current_setting('TimeZone');
  default_tz text := (SELECT reset_val FROM pg_settings WHERE name = 'TimeZone');
BEGIN
  RAISE NOTICE '059: session TimeZone = %, database default TimeZone = %', session_tz, default_tz;
  IF default_tz IS NULL OR default_tz = '' THEN
    RAISE EXCEPTION '059: database default TimeZone is unknown — refusing to guess';
  END IF;
  IF lower(session_tz) <> lower(default_tz) THEN
    RAISE NOTICE '059: session overrides the database default — converting with the database default %', default_tz;
  END IF;

  EXECUTE format('ALTER TABLE asin_estimates ALTER COLUMN fetched_at TYPE timestamptz USING fetched_at AT TIME ZONE %L', default_tz);
  EXECUTE format('ALTER TABLE sourcing_cost_exports ALTER COLUMN created_at TYPE timestamptz USING created_at AT TIME ZONE %L', default_tz);

  EXECUTE format('COMMENT ON COLUMN asin_estimates.fetched_at IS %L',
    format('Last conclusive price fetch (price-sync). timestamptz since migration 059; old values converted from timestamp using TimeZone=%s (session %s).', default_tz, session_tz));
  EXECUTE format('COMMENT ON COLUMN sourcing_cost_exports.created_at IS %L',
    format('timestamptz since migration 059; old values converted from timestamp using TimeZone=%s (session %s).', default_tz, session_tz));
END $$;
