-- 066_po_tracking.sql (2026-10-21)
--
-- PO tracking numbers → Velocity (docs/claude_spec-patch-po-tracking-velocity.md
-- §3; SPEC §26). Supplier shipping emails at orders@ are parsed into
-- po_tracking rows, matched to AF POs, and their tracking numbers pushed to the
-- matching Velocity inbound orders.

CREATE TABLE IF NOT EXISTS po_tracking (
  id                    BIGSERIAL PRIMARY KEY,
  po_id                 UUID REFERENCES purchase_orders(id) ON DELETE SET NULL,  -- NULL = unmatched
  carrier               TEXT NOT NULL,   -- UPS / FEDEX / USPS / DHL / AMAZON / ONTRAC / LASERSHIP / OTHER
  tracking_number       TEXT NOT NULL,
  retailer_order_id     TEXT,            -- as printed in the email
  supplier_guess        TEXT,            -- from the sender domain map
  sender_domain         TEXT,            -- the email's sender domain (what the domain map keys on)
  ship_to_street        TEXT,            -- normalized "<number> <first street word>", e.g. "805 grandy"
  shipped_at            TIMESTAMPTZ,     -- email date unless the email states a ship date
  items_json            JSONB,           -- [{name, qty}] when the email lists per-shipment items
  gmail_message_id      TEXT NOT NULL,
  gmail_thread_id       TEXT,
  email_subject         TEXT,
  source                TEXT NOT NULL CHECK (source IN ('regex','ai','manual')),
  status                TEXT NOT NULL CHECK (status IN ('unmatched','matched','pushed','push_failed','held')),
  -- Why an unmatched row is unmatched (§5 / §11 queue): unknown_sender | no_po | ambiguous | ai_disabled | unpaired | dismissed.
  match_reason          TEXT,
  -- Why this row raises the "Review Velocity" action item (§7 / §8); NULL = none.
  review_reason         TEXT,
  push_error            TEXT,
  pushed_at             TIMESTAMPTZ,
  pushed_velocity_ids   TEXT[],
  suppressed_at         TIMESTAMPTZ,     -- Maria cleared "Review Velocity" while this row existed (§8)
  reassigned_from_po_id UUID REFERENCES purchase_orders(id) ON DELETE SET NULL,
  reassigned_at         TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (carrier, tracking_number)
);
CREATE INDEX IF NOT EXISTS po_tracking_po_idx ON po_tracking (po_id);
CREATE INDEX IF NOT EXISTS po_tracking_status_idx ON po_tracking (status);

-- Where the PO ships: Velocity (the prep center) or home. Existing POs → velocity.
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS ships_to TEXT NOT NULL DEFAULT 'velocity';
DO $$ BEGIN
  ALTER TABLE purchase_orders ADD CONSTRAINT purchase_orders_ships_to_check CHECK (ships_to IN ('velocity','home'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Settings (§3). The Gmail watermark lives here too (tracking.gmail_watermark).
INSERT INTO settings (key, value) VALUES
  ('tracking.velocity_street', '"805 grandy"'::jsonb),
  ('tracking.home_streets', '["65 rivercrest"]'::jsonb),
  ('tracking.supplier_domain_map', '{}'::jsonb),
  ('tracking.carrier_map', '{"FEDEX":"FedEx","UPS":"UPS","USPS":"USPS","DHL":"DHL","AMAZON":"Amazon","ONTRAC":"OnTrac","LASERSHIP":"LaserShip"}'::jsonb),
  ('tracking.gmail_watermark', '{"last_scanned_at": null, "last_history_id": null}'::jsonb)
ON CONFLICT (key) DO NOTHING;
