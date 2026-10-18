-- 060_shipment_assignment_pin_and_po_rename.sql (2026-10-18)
--
-- 1. po_asin_shipments.assigned_by ('auto' default | 'manual') and the
--    Velocity line identity a manual assignment pins (velocity_shipment_id
--    is already on the row; + the Velocity order # as Velocity holds it).
--    Pulled forward from claude_spec-patch-po-af-owned.md §5.2: Sync
--    Shipments never moves or overwrites a 'manual' row — it refreshes its
--    quantities only.
-- 2. leadersrpmshop.com PO of 2026-06-21: the correct order ID is 10548557.
--    Velocity holds it as 10507736 (typo, uneditable after shipping). The
--    sheet row is now 10548557_10507736; the AF PO is renamed IN PLACE (same
--    ids, same shipment rows) so the 2025 order 10507736 can import as its
--    own PO, and its two shipment rows are pinned 'manual' with Velocity
--    order # 10507736 so the next Sync Shipments cannot move them onto the
--    2025 PO. Idempotent: matches only the unrenamed 2026 PO.
ALTER TABLE po_asin_shipments
  ADD COLUMN assigned_by text NOT NULL DEFAULT 'auto',
  ADD COLUMN velocity_order_number text NULL;
ALTER TABLE po_asin_shipments
  ADD CONSTRAINT po_asin_shipments_assigned_by_check CHECK (assigned_by IN ('auto', 'manual'));
COMMENT ON COLUMN po_asin_shipments.assigned_by IS 'auto = placed by Sync Shipments; manual = pinned by a user / data fix — Sync Shipments refreshes its quantities but never moves it.';
COMMENT ON COLUMN po_asin_shipments.velocity_order_number IS 'The Velocity line''s Order # as Velocity holds it (identity of a manual pin: velocity_shipment_id + this + the ASIN).';

UPDATE po_asin_shipments s
   SET assigned_by = 'manual', velocity_order_number = '10507736', updated_at = now()
  FROM po_asins pa JOIN purchase_orders p ON p.id = pa.po_id
 WHERE s.po_asin_id = pa.id
   AND p.supplier = 'leadersrpmshop.com' AND p.order_id IN ('10507736', '10548557_10507736') AND p.order_date = DATE '2026-06-21'
   AND s.source = 'velocity';

UPDATE purchase_orders
   SET order_id = '10548557_10507736', updated_at = now()
 WHERE supplier = 'leadersrpmshop.com' AND order_id = '10507736' AND order_date = DATE '2026-06-21';
