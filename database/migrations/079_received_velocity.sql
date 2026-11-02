-- 079_received_velocity.sql — Received by Velocity (Maria 2026-11-02).
--
-- "At Prep Center" (po_asins.qty_at_prep) is Velocity's quantity_remaining,
-- so once Velocity ships it drops to 0 and the total they ever checked in
-- is lost. received_velocity keeps the cumulative count: Σ Velocity
-- quantity_received over the row's live lines (inbound > inventory > newest
-- shipment detail — probe 2026-11-02: quantity_received is order-level and
-- identical on every shipment's line, and a fully shipped order keeps it in
-- the shipment detail), ÷ AF's units_per_pack, in ASIN units like every
-- other PO quantity; never capped at Ordered. NULL = never seen at
-- Velocity. Written by Sync Shipments (component A) only.
ALTER TABLE po_asins ADD COLUMN IF NOT EXISTS received_velocity numeric(10,2);
COMMENT ON COLUMN po_asins.received_velocity IS 'Received by Velocity: cumulative units Velocity ever checked in for this line, in ASIN units (component units ÷ units_per_pack); NULL = never seen at Velocity. Shipment sync component A.';
