-- 099_velocity_order_links.sql — a stored link "Velocity order → PO ASIN row"
-- (Maria 2026-11-07, SPEC §22 / §26). One row per Velocity order (its
-- order_id uuid, not the order # typed at Velocity, which can be blank or
-- wrong): every Velocity matcher asks it first — shipment placement,
-- Received by Velocity / At Prep (inbound, inventory or shipped), Velocity's
-- pack size, the Upload to Velocity plan / dedup / execute guard, tracking
-- push. Several orders may link to one PO ASIN row (PO 71160468: 90 + 30);
-- their quantities add up. Unlink deletes the row; link and unlink each write
-- a PO History row (entity 'shipment'). The order as typed at Velocity is
-- kept for display only.
CREATE TABLE velocity_order_links (
  velocity_order_id text PRIMARY KEY,
  po_asin_id uuid NOT NULL REFERENCES po_asins(id) ON DELETE CASCADE,
  velocity_number text,        -- Velocity's own order # (#8785)
  order_number text,           -- as typed at Velocity (may be blank)
  retailer text,
  asin text,
  quantity numeric,
  linked_by integer REFERENCES users(id) ON DELETE SET NULL,
  linked_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'picker', 'backfill')),
  note text
);
CREATE INDEX velocity_order_links_po_asin_idx ON velocity_order_links (po_asin_id);

-- Velocity orders the sync could place nowhere that have not shipped (still
-- inbound or in inventory): the "Velocity orders with no PO" section of the
-- Unmatched panel. Derived state, rewritten by every Sync Shipments; a
-- dismissed order stays dismissed while it is listed.
CREATE TABLE velocity_orders_unplaced (
  velocity_order_id text PRIMARY KEY,
  line jsonb NOT NULL,
  reason text NOT NULL CHECK (reason IN ('no_order', 'po_not_found')),
  candidates jsonb,
  nearest_miss text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  dismissed_at timestamptz,
  dismiss_note text
);

-- Review Velocity, second source (beside po_tracking.review_reason): a
-- Velocity order matched a PO whose ships_to is 'home'. Written by Sync
-- Shipments (the Velocity order #s, NULL when none); open while ships_to is
-- still 'home' and not cleared by hand.
ALTER TABLE purchase_orders
  ADD COLUMN velocity_home_orders text,
  ADD COLUMN velocity_home_cleared_at timestamptz;
