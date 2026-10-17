-- 057_shipment_reconciliation.sql — Shipment reconciliation: Velocity +
-- Seller Central → PO ASIN rows (patch
-- docs/claude_spec-patch-shipment-reconciliation.md §2; evidence
-- docs/phase2-probe-2026-10-17.md).
--
-- po_asin_shipments is re-keyed on the VELOCITY shipment (the unit that
-- joins to a PO); the Amazon FBA shipment ids it fanned out to are an array
-- (D1). Every quantity stays ASIN (sellable-pack) qty — the rollup trigger
-- sums whatever unit the rows carry, so Velocity's individual units are
-- divided by units_per_pack BEFORE a row is written. The table was empty on
-- both databases at cut time (probe C9); the data moves below are for safety.

-- ── po_asin_shipments: id → uuid, velocity key, FBA id array, SC match ──────
ALTER TABLE po_asin_shipments DROP CONSTRAINT IF EXISTS po_asin_shipments_po_asin_id_fba_shipment_id_key;
ALTER TABLE po_asin_shipments DROP CONSTRAINT IF EXISTS po_asin_shipments_source_check;
ALTER TABLE po_asin_shipments
  ADD COLUMN fba_shipment_ids text[] NOT NULL DEFAULT '{}',
  ADD COLUMN sc_match         text   NOT NULL DEFAULT 'none';
UPDATE po_asin_shipments SET fba_shipment_ids = ARRAY[fba_shipment_id] WHERE fba_shipment_id IS NOT NULL AND fba_shipment_id <> '';
UPDATE po_asin_shipments SET velocity_shipment_id = 'manual:' || uuid_generate_v4()::text WHERE velocity_shipment_id IS NULL;
UPDATE po_asin_shipments SET source = 'manual' WHERE source = 'sc';
ALTER TABLE po_asin_shipments
  DROP COLUMN fba_shipment_id,
  ALTER COLUMN velocity_shipment_id SET NOT NULL,
  ALTER COLUMN qty_shipped TYPE numeric(10,2),
  ALTER COLUMN qty_received TYPE numeric(10,2);
-- serial → uuid primary key (empty table; the trigger does not depend on id).
ALTER TABLE po_asin_shipments DROP CONSTRAINT po_asin_shipments_pkey;
ALTER TABLE po_asin_shipments DROP COLUMN id;
ALTER TABLE po_asin_shipments ADD COLUMN id uuid NOT NULL DEFAULT uuid_generate_v4();
ALTER TABLE po_asin_shipments ADD PRIMARY KEY (id);
DROP SEQUENCE IF EXISTS po_asin_shipments_id_seq;
ALTER TABLE po_asin_shipments
  ADD CONSTRAINT po_asin_shipments_source_check   CHECK (source IN ('velocity', 'manual')),
  ADD CONSTRAINT po_asin_shipments_sc_match_check CHECK (sc_match IN ('none', 'matched', 'ambiguous', 'unmatched')),
  ADD CONSTRAINT po_asin_shipments_po_asin_id_velocity_shipment_id_key UNIQUE (po_asin_id, velocity_shipment_id);
COMMENT ON COLUMN po_asin_shipments.velocity_shipment_id IS 'Velocity shipment UUID, or manual:<uuid> for a hand-entered row. Sync-owned (SPEC §14).';
COMMENT ON COLUMN po_asin_shipments.fba_shipment_ids IS 'Amazon FBA shipment ids this Velocity shipment fanned out to (one per FC), from the SC match (§4.2).';
COMMENT ON COLUMN po_asin_shipments.qty_received IS 'ASIN qty received by Amazon, allocated oldest-PO-first across the rows sharing an ASIN in one Velocity shipment (§4.3, D2). NULL until the Velocity shipment is matched to SC.';

-- ── velocity_shipments: one row per Velocity shipment; the SC match lives here ──
CREATE TABLE velocity_shipments (
  id              text PRIMARY KEY,                       -- Velocity shipment_id (UUID)
  shipped_at      date NULL,                              -- ET calendar date of shipped_at
  shipped_at_ts   timestamptz NULL,                       -- the instant, for the SC name-timestamp match (§4.2)
  status          text NOT NULL,
  raw             jsonb NOT NULL,                         -- { list: <list row>, detail: <GET /shipments/:id data> }
  sc_shipment_ids text[] NOT NULL DEFAULT '{}',
  sc_match        text NOT NULL DEFAULT 'none' CHECK (sc_match IN ('none', 'matched', 'ambiguous', 'unmatched')),
  synced_at       timestamptz NOT NULL DEFAULT now()
);

-- ── shipment_unmatched: Velocity lines the sync could not place (§5.3) ──────
CREATE TABLE shipment_unmatched (
  id                   uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  velocity_shipment_id text NOT NULL REFERENCES velocity_shipments(id) ON DELETE CASCADE,
  velocity_order_id    text NOT NULL,                     -- the line's order_id (one row per line; re-sync updates)
  line                 jsonb NOT NULL,                    -- the line as Velocity returned it
  reason               text NOT NULL CHECK (reason IN ('no_order', 'po_not_found')),
  created_at           timestamptz NOT NULL DEFAULT now(),
  resolved_at          timestamptz NULL,
  resolved_po_asin_id  uuid NULL REFERENCES po_asins(id) ON DELETE SET NULL,
  UNIQUE (velocity_shipment_id, velocity_order_id)
);
CREATE INDEX shipment_unmatched_open_idx ON shipment_unmatched (created_at DESC) WHERE resolved_at IS NULL;

-- ── Seller Central cache (Fulfillment Inbound v0) ────────────────────────────
CREATE TABLE sc_inbound_shipments (
  shipment_id text PRIMARY KEY,                           -- FBA…
  name        text NULL,                                  -- "FBA STA (10/15/2026 18:01)-IND9"
  name_ts     timestamptz NULL,                           -- the timestamp parsed from the name (UTC)
  status      text NOT NULL,
  ship_from   text NULL,                                  -- ShipFromAddress.Name
  fc          text NULL,                                  -- DestinationFulfillmentCenterId
  raw         jsonb NOT NULL,
  synced_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sc_inbound_items (
  shipment_id  text NOT NULL REFERENCES sc_inbound_shipments(shipment_id) ON DELETE CASCADE,
  seller_sku   text NOT NULL,
  fnsku        text NULL,
  asin         text NULL,                                 -- resolved from asin_skus / asins.primary_sku when known
  qty_shipped  numeric(10,2) NOT NULL,                    -- SC QuantityShipped (packs)
  qty_received numeric(10,2) NOT NULL DEFAULT 0,          -- SC QuantityReceived (packs)
  PRIMARY KEY (shipment_id, seller_sku)
);
CREATE INDEX sc_inbound_shipments_name_ts_idx ON sc_inbound_shipments (name_ts);

COMMENT ON COLUMN po_asins.qty_at_prep IS 'ASIN qty still at Velocity: Σ quantity_remaining ÷ units_per_pack over Velocity lines for (Order #, retailer, ASIN); NULL when no Velocity line references the key (D6). Sync-owned.';
