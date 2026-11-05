-- History rows a cost recompute writes are derived, not typed (2026-11-04).
-- recomputePoCosts keeps a typed cost / unit: it treats an ASIN row with a
-- cost_per_unit History row as manual. Its own cost_per_unit rows counted
-- too, so after the first recompute that changed COGS the row was frozen
-- (found with the card reward %, migration 090). Recompute now marks its rows
-- derived; the manual check ignores them.
ALTER TABLE po_edit_log ADD COLUMN IF NOT EXISTS derived boolean NOT NULL DEFAULT false;

-- Existing recompute rows: an ASIN cost row written in the same transaction
-- (same `at`) as a sourcing_cost / paid_cost row for the same ASIN row — only
-- recompute writes those two fields.
UPDATE po_edit_log e SET derived = true
 WHERE e.entity = 'asin' AND e.field IN ('cost_per_unit', 'sourcing_cost', 'paid_cost')
   AND EXISTS (SELECT 1 FROM po_edit_log s WHERE s.po_id = e.po_id AND s.entity = 'asin' AND s.entity_id = e.entity_id
                 AND s.at = e.at AND s.field IN ('sourcing_cost', 'paid_cost'));
