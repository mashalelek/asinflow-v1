-- 056_po_expand_by_asin.sql — PO module: Expand by ASIN, per-ASIN status
-- quantities, PO-level Closed + Action Items (patch
-- docs/claude_spec-patch-po-expand-by-asin.md §4–§6; decisions 2026-10-15,
-- pre-flight decisions 2026-10-16 in docs/po-expand-preflight-2026-10-16.md).
--
-- Every column added here is AF-OWNED (SPEC §14): the sheet importer never
-- writes it after the one-time §6.4 backfill. All quantities are ASIN
-- (sellable-pack) quantities, numeric(10,2), NULL = not tracked (never 0 by
-- default). Canceled / Returned stay on po_line_items (product level) and
-- are DERIVED on the ASIN row (Σ line qty × yield) — no stored copies.

-- §4 cols 13–18: per-ASIN status quantities.
ALTER TABLE po_asins
  ADD COLUMN qty_shipped_supplier numeric(10,2) NULL,   -- 13 Shipped by Supplier (Phase 2: email tracking)
  ADD COLUMN qty_at_prep          numeric(10,2) NULL,   -- 14 At Prep Center (Phase 2: Velocity; may be fractional)
  ADD COLUMN qty_at_warehouse     numeric(10,2) NULL,   -- 15 At CQG Warehouse (manual)
  ADD COLUMN qty_lost_damaged_us  numeric(10,2) NULL,   -- 16 Lost/damaged by us (manual)
  ADD COLUMN qty_shipped_fba      numeric(10,2) NULL,   -- 17 Shipped FBA = SUM(po_asin_shipments.qty_shipped), trigger-maintained
  ADD COLUMN qty_received_amazon  numeric(10,2) NULL;   -- 18 Received by Amazon = SUM(po_asin_shipments.qty_received), trigger-maintained

-- §4.2 shipments. po_asins.id is uuid (the patch draft said int).
CREATE TABLE po_asin_shipments (
  id                   serial PRIMARY KEY,
  po_asin_id           uuid NOT NULL REFERENCES po_asins(id) ON DELETE CASCADE,
  fba_shipment_id      text NOT NULL,                 -- Amazon FBA shipment ID (FBA…)
  velocity_shipment_id text NULL,                     -- Velocity UUID when known
  qty_shipped          numeric(10,2) NOT NULL,        -- ASIN qty
  qty_received         numeric(10,2) NULL,            -- ASIN qty received by Amazon for this shipment
  shipped_at           date NULL,
  source               text NOT NULL CHECK (source IN ('velocity','sc','manual')),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (po_asin_id, fba_shipment_id)
);
CREATE INDEX po_asin_shipments_po_asin_idx ON po_asin_shipments (po_asin_id);

-- qty_shipped_fba / qty_received_amazon are the SUM over po_asin_shipments,
-- maintained by trigger (the declarative analogue of the GENERATED
-- final_qty on po_line_items — the value can never drift from the rows).
-- NULL when the ASIN has no shipment rows (not tracked), never 0.
CREATE OR REPLACE FUNCTION po_asin_shipments_rollup() RETURNS trigger AS $$
DECLARE
  target uuid := COALESCE(NEW.po_asin_id, OLD.po_asin_id);
BEGIN
  UPDATE po_asins pa SET
    qty_shipped_fba     = (SELECT SUM(s.qty_shipped)  FROM po_asin_shipments s WHERE s.po_asin_id = pa.id),
    qty_received_amazon = (SELECT SUM(s.qty_received) FROM po_asin_shipments s WHERE s.po_asin_id = pa.id)
  WHERE pa.id = target;
  IF TG_OP = 'UPDATE' AND NEW.po_asin_id IS DISTINCT FROM OLD.po_asin_id THEN
    UPDATE po_asins pa SET
      qty_shipped_fba     = (SELECT SUM(s.qty_shipped)  FROM po_asin_shipments s WHERE s.po_asin_id = pa.id),
      qty_received_amazon = (SELECT SUM(s.qty_received) FROM po_asin_shipments s WHERE s.po_asin_id = pa.id)
    WHERE pa.id = OLD.po_asin_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER po_asin_shipments_rollup_trg
  AFTER INSERT OR UPDATE OR DELETE ON po_asin_shipments
  FOR EACH ROW EXECUTE FUNCTION po_asin_shipments_rollup();

-- §5 Closed (NULL = Open) and §6 Action Items. closed_by: 'auto' | 'sheet'
-- (the one-time §6.4 backfill of the sheet's "Closed") | a users.id as text.
-- Auto never reopens 'sheet' or user-closed POs. The old free-text `status`
-- column stays (D5) but nothing reads or writes it after this patch; it is
-- dropped in a follow-up migration once §6.4 is verified in production.
ALTER TABLE purchase_orders
  ADD COLUMN closed_at    timestamptz NULL,
  ADD COLUMN closed_by    text NULL,
  ADD COLUMN action_items text[] NOT NULL DEFAULT '{}';
ALTER TABLE purchase_orders
  ADD CONSTRAINT purchase_orders_action_items_check CHECK (
    action_items <@ ARRAY[
      'Need to Return',
      'Missing / Damaged from Supplier',
      'Confirm Refund / Replacement',
      'ATTN: Velocity',
      'See Comments',
      'SHIP',
      'Received - FBM'
    ]::text[]
  );
CREATE INDEX purchase_orders_open_idx ON purchase_orders (order_date DESC) WHERE closed_at IS NULL;

COMMENT ON COLUMN po_asins.qty_shipped_fba IS 'ASIN qty, SUM over po_asin_shipments.qty_shipped (trigger); NULL = no shipment rows. AF-owned.';
COMMENT ON COLUMN po_asins.qty_received_amazon IS 'ASIN qty, SUM over po_asin_shipments.qty_received (trigger); NULL = no shipment rows. AF-owned.';
COMMENT ON COLUMN purchase_orders.action_items IS 'Multi-select action items (§6.1 display order); replaces the free-text status. AF-owned.';
COMMENT ON COLUMN purchase_orders.closed_at IS 'NULL = Open. Set by the auto-close rule (closed_by=auto), the §6.4 backfill (sheet) or a user (users.id). AF-owned.';
