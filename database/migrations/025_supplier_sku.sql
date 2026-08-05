-- Migration 025: supplier_sku — the supplier's own catalog/item number.
--
-- NEVER from Amazon; unrelated to primary_sku / asin_skus. User-controlled
-- per §14: sources are CSV upload and manual inline edit only. Analyze MUST
-- NOT write it — on the main path it rides the asymmetric-UPSERT INSERT
-- branch only (like estimated_cogs/notes), never the ON CONFLICT branch; the
-- bulk sink never includes it in its SET list.

ALTER TABLE asins ADD COLUMN IF NOT EXISTS supplier_sku VARCHAR(100);
ALTER TABLE bulk_list_asins ADD COLUMN IF NOT EXISTS supplier_sku VARCHAR(100);
