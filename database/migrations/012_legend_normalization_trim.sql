-- Tighten normalization on legend + alias unique indexes to also TRIM.
-- The previous indexes (migration 008, migration 011) only collapsed internal
-- whitespace runs — leading/trailing spaces remained in the folded form,
-- causing legitimate spelling variants to miss lookup:
--   'AminoGenesis' (stored)  vs  'AminoGenesis ' (queried with trailing space)
-- folded differently. Now both fold to 'aminogenesis'.
--
-- No existing rows have leading/trailing whitespace (all seed data was clean),
-- so DROP+CREATE INDEX is safe — no duplicate-key conflicts.

DROP INDEX IF EXISTS uq_sku_legend_type_raw;
CREATE UNIQUE INDEX uq_sku_legend_type_raw
  ON sku_legend (type, LOWER(TRIM(REGEXP_REPLACE(raw_value, '\s+', ' ', 'g'))));

DROP INDEX IF EXISTS uq_sku_legend_alias_raw;
CREATE UNIQUE INDEX uq_sku_legend_alias_raw
  ON sku_legend_alias (LOWER(TRIM(REGEXP_REPLACE(raw_value, '\s+', ' ', 'g'))));
