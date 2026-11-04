-- 086_tracking_multi_po_alt_order_ids.sql (Maria 2026-11-04, the tracking
-- queue follow-ups; SPEC §26, §22).
-- 1. One tracking number on more than one PO (SupplyHouse 28686630 and
--    28686630_1 shipped in one box): the extra PO gets its own row with
--    split_of = the primary row, so each PO routes and pushes it on its own.
--    The (carrier, tracking_number) uniqueness holds for primary rows only.
--    qty = the units of that PO in the shipment, when the email states them.
-- 2. A dismissed row keeps why (dismiss_reason, e.g. "personal order").
-- 3. purchase_orders.alt_order_ids: other order #s the retailer uses for the
--    same order (Adventure Challenge ships 18936582013059 as #3029684),
--    comma-separated; every email matcher reads them with the order #.
ALTER TABLE po_tracking ADD COLUMN split_of bigint REFERENCES po_tracking(id) ON DELETE CASCADE;
ALTER TABLE po_tracking ADD COLUMN qty numeric(12,2);
ALTER TABLE po_tracking ADD COLUMN dismiss_reason text;
ALTER TABLE po_tracking DROP CONSTRAINT po_tracking_carrier_tracking_number_key;
CREATE UNIQUE INDEX po_tracking_primary_number_key ON po_tracking (carrier, tracking_number) WHERE split_of IS NULL;
CREATE UNIQUE INDEX po_tracking_split_po_key ON po_tracking (split_of, po_id) WHERE split_of IS NOT NULL;
ALTER TABLE purchase_orders ADD COLUMN alt_order_ids text;
