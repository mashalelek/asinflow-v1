-- 063_po_line_items_po_asin_idx.sql (2026-10-18)
--
-- po_line_items had no index on po_asin_id. Every per-ASIN-row lookup of its
-- lines (Canceled / Returned derivation on the POs page and PO detail, the
-- ASINs page On Order / At Prep pipeline before its rewrite, edits) was a
-- sequential scan of the whole table: 412,607 seq scans on production by
-- 2026-10-18, ~30 M row checks per ASINs-page load after the history import.
CREATE INDEX IF NOT EXISTS po_line_items_po_asin_idx ON po_line_items (po_asin_id);
