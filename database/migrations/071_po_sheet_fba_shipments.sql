-- Orders-sheet Col P "FBA Shipment ID" (2026-10-29): the FBA shipment ids a
-- sheet row says it went out in, with the qty in parentheses. A matching
-- signal for shipment sync A, not PO data: Sync POs replaces the whole table
-- from the sheet on every live run ([ ] notes stripped). Keyed by the sheet's
-- identity (supplier, order #, ASIN, line position) — the sheet is intake for
-- the PO itself, so no AF row is written from it.
CREATE TABLE po_sheet_fba_shipments (
  supplier TEXT NOT NULL,
  order_id TEXT NOT NULL,
  asin TEXT NOT NULL,
  line_position INTEGER NOT NULL,
  fba_shipment_id TEXT NOT NULL,
  qty NUMERIC(10,2),            -- NULL when the cell gave none or a non-number ("3/5")
  qty_raw TEXT,                 -- the parenthesised text, verbatim
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (supplier, order_id, asin, line_position, fba_shipment_id)
);
CREATE INDEX po_sheet_fba_shipments_fba_idx ON po_sheet_fba_shipments (fba_shipment_id);

-- Col P candidates for a line it could not place on exactly one PO ASIN row:
-- [{po_asin_id, order_id, supplier, asin}], shown in the Unmatched picker.
ALTER TABLE shipment_unmatched
  ADD COLUMN candidates JSONB;
