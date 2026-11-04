-- 087_po_line_total_price_precision.sql (Maria 2026-11-04, acmetools.com
-- 42838131; SPEC §22 "Costs", patch po-ai-prefill §7.1 as corrected).
-- A line whose total ÷ qty is not whole cents (79.70 ÷ 30) keeps the LINE
-- TOTAL as captured; the unit price is derived from it at full precision and
-- shown to 2 dp. Every cost is computed from line totals (shared/po-cost.ts
-- v3). line_total NULL = a line saved before this (or typed without one):
-- its money is price × qty, as before.
ALTER TABLE po_line_items ADD COLUMN line_total numeric(12,2);
ALTER TABLE po_line_items ALTER COLUMN price TYPE numeric(12,6);
