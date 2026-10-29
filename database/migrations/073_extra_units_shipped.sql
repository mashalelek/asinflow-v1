-- "Extra units shipped" (Maria 2026-10-29): an auto-managed action item on a
-- PO ASIN row whose Shipped FBA is over Ordered. Derived (po-action-items.ts),
-- so nothing is stored to raise it; these columns hold the human side:
--   extra_units_note            the latest note — from the picker's overshoot
--                               confirm or from a manual clear; shown on hover
--   extra_units_cleared_shipped Shipped FBA when it was cleared by hand; the
--                               item stays hidden until shipped goes past it
--   extra_units_cleared_at / _by when and who cleared it
-- And the optional note on a dismissed Unmatched shipments line.
ALTER TABLE po_asins ADD COLUMN IF NOT EXISTS extra_units_note TEXT;
ALTER TABLE po_asins ADD COLUMN IF NOT EXISTS extra_units_cleared_shipped NUMERIC(10,2);
ALTER TABLE po_asins ADD COLUMN IF NOT EXISTS extra_units_cleared_at TIMESTAMPTZ;
ALTER TABLE po_asins ADD COLUMN IF NOT EXISTS extra_units_cleared_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE shipment_unmatched ADD COLUMN IF NOT EXISTS dismiss_note TEXT;
