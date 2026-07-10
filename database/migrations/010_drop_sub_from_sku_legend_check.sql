-- Drop 'sub' from sku_legend.type CHECK constraint.
-- SUB removed from the SKU format per Option 3 after the 1914-ASIN scan:
-- 755 distinct sub-categories in a long-tail distribution (390 needed to
-- cover 80% of catalog) — not a viable grouping scheme.
--
-- SKU format is now BRD-DEP-AS3-TTL-NNN[-X] (5 segments).
-- Migration 009 was cancelled (no sub_category column on asins).
--
-- Belt-and-suspenders: TypeScript LegendType union is also narrowed to
-- 'brand' | 'dept'. No sub rows ever existed in sku_legend so no data migration.

ALTER TABLE sku_legend DROP CONSTRAINT sku_legend_type_check;
ALTER TABLE sku_legend ADD CONSTRAINT sku_legend_type_check
    CHECK (type IN ('brand', 'dept'));
