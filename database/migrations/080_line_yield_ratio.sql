-- 080_line_yield_ratio.sql — exact line yield (Maria 2026-11-02).
--
-- po_line_items.asin_qty_per_product held the yield as a 2-dp number, so a
-- 1/15 line (walmart 200014971489745 B071G486Q7: 30 retailer units → 2 ASIN
-- units) was stored as 0.07 and its lines computed 2.1. The yield is now two
-- integers: retailer_units_per_product (the retailer's pack: 1 for a single,
-- 9 for a 9-pack) and asin_units_per_pack (the ASIN row's pack size at the
-- time); Ordered = Σ qty × retailer ÷ asin in exact arithmetic, rounded once
-- (shared/yield.ts). asin_qty_per_product stays, read-only, derived =
-- retailer ÷ asin, for history. NULL / NULL = a line the backfill
-- (npm run backfill:yield-ratio) could not resolve; it reads its stored
-- yield as before.
ALTER TABLE po_line_items ADD COLUMN IF NOT EXISTS retailer_units_per_product integer CHECK (retailer_units_per_product IS NULL OR retailer_units_per_product >= 1);
ALTER TABLE po_line_items ADD COLUMN IF NOT EXISTS asin_units_per_pack integer CHECK (asin_units_per_pack IS NULL OR asin_units_per_pack >= 1);
COMMENT ON COLUMN po_line_items.retailer_units_per_product IS 'Exact yield numerator: units of the ASIN''s product in one retailer unit of this line (1 for a single, 9 for a 9-pack). Migration 080.';
COMMENT ON COLUMN po_line_items.asin_units_per_pack IS 'Exact yield denominator: the ASIN row''s pack size when the line was written. Yield = retailer_units_per_product / asin_units_per_pack. Migration 080.';
COMMENT ON COLUMN po_line_items.asin_qty_per_product IS 'Derived yield = retailer_units_per_product / asin_units_per_pack (history / display only since migration 080); read as the value of record only on a line without the two integers.';
