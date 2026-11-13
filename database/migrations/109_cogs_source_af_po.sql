-- 109: cogs_source 'po_sheet' → 'af_po' (Orders-sheet retirement commit 1, 2026-11-13).
-- The label named the Orders Google Sheet; since 2026-10-18 the value has come from AF's own PO tables
-- (loadAfAsinCostMap: the newest non-canceled PO ASIN row by order date, then entry sequence), and since this commit
-- every PO write syncs it at once (server/asin-po-costs.ts). The stored value says what it is now. Same two columns,
-- same other values ('manual', 'csv').
ALTER TABLE asin_estimates DROP CONSTRAINT IF EXISTS asin_estimates_cogs_source_check;
ALTER TABLE asin_estimates DROP CONSTRAINT IF EXISTS asin_estimates_estimated_cogs_source_check;
UPDATE asin_estimates SET cogs_source = 'af_po' WHERE cogs_source = 'po_sheet';
UPDATE asin_estimates SET estimated_cogs_source = 'af_po' WHERE estimated_cogs_source = 'po_sheet';
ALTER TABLE asin_estimates ADD CONSTRAINT asin_estimates_cogs_source_check CHECK (cogs_source = ANY (ARRAY['af_po'::text, 'manual'::text]));
ALTER TABLE asin_estimates ADD CONSTRAINT asin_estimates_estimated_cogs_source_check CHECK (estimated_cogs_source::text = ANY (ARRAY['manual'::text, 'af_po'::text, 'csv'::text]));
COMMENT ON COLUMN asin_estimates.cogs_source IS 'af_po = Actual COGS from AF''s PO tables (the newest non-canceled PO ASIN row by order date; migration 109, was po_sheet), manual = typed.';
