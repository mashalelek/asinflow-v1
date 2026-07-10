-- Brand aliases: multiple raw_value spellings → one canonical legend code.
-- Without this, "CerMedia" and "MarinePure" would propose separate codes,
-- splitting one real brand into two SKUs. Same pattern as
-- AminoGenesis / AminoGenesis Cosmetics → AMG.
--
-- Pattern works for any legend type but aliases are mostly meaningful for
-- brands (Amazon dept strings are stable). Lookup MUST go through this
-- table — the canonical sku_legend row has a self-alias inserted on create.

CREATE TABLE sku_legend_alias (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    legend_id    UUID NOT NULL REFERENCES sku_legend(id) ON DELETE CASCADE,
    raw_value    TEXT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    note         TEXT
);

-- A spelling can map to at most one canonical (case/whitespace-insensitive).
-- Resolution always uses this folded form; the note column is informational
-- only and never participates in lookup.
CREATE UNIQUE INDEX uq_sku_legend_alias_raw
  ON sku_legend_alias (LOWER(REGEXP_REPLACE(raw_value, '\s+', ' ', 'g')));

CREATE INDEX idx_sku_legend_alias_legend ON sku_legend_alias(legend_id);

COMMENT ON TABLE sku_legend_alias IS
  'Spelling variants that map to a canonical sku_legend row. Created at brand-approval time. Resolver MUST lookup via this table (not sku_legend.raw_value directly) so aliases work.';

COMMENT ON COLUMN sku_legend_alias.note IS
  'Informational only (e.g. "self-alias backfilled", "merged from pending approval on YYYY-MM-DD"). Never used as a resolution key.';

-- Backfill self-aliases for all existing legend rows (1 brand + 23 dept = 24).
INSERT INTO sku_legend_alias (legend_id, raw_value, note)
SELECT id, raw_value, 'self-alias backfilled from sku_legend'
FROM sku_legend;

-- Worked example: spec mentions AminoGenesis / AminoGenesis Cosmetics →
-- both must resolve to AMG. Seed the second spelling as an alias now so the
-- pattern is exercised in production from day one.
INSERT INTO sku_legend_alias (legend_id, raw_value, note)
SELECT id, 'AminoGenesis Cosmetics', 'spec-mentioned brand variant'
FROM sku_legend WHERE type='brand' AND raw_value='AminoGenesis';
