-- §11 Bundle identity records (2026-09-21, Parts A + E). Restores the one key
-- Velocity stops serializing: a fully-shipped bundle's shipment rows carry the
-- parent order_id but order_number null and NO bundle_children, and children
-- cannot be enumerated from the parent once it leaves /inbound + /inventory.
--
-- NOT a gatekeeper ledger (§11): records no sends, never causes a create or a
-- skip on its own. A row matters only when Velocity itself returns that parent
-- order_id on a shipment row. A parent deleted in Velocity never appears again
-- and its row is inert. Insert/upsert only — never deleted by code.
BEGIN;

CREATE TABLE velocity_bundle_identity (
  velocity_order_id   TEXT PRIMARY KEY,           -- parent order_id (UUID)
  asin                TEXT NOT NULL,              -- parent ASIN, uppercased
  child_order_numbers TEXT[] NOT NULL,            -- distinct child order_numbers (sheet order IDs) — the match input
  child_order_ids     TEXT[] NULL,                -- child order_ids when observed; NULL for manual rows
  source              TEXT NOT NULL CHECK (source IN ('observed', 'manual_seed', 'manual_map')),
  first_seen_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_velocity_bundle_identity_asin ON velocity_bundle_identity (asin);

-- Part E seed: the five legacy bundles, confirmed by Maria 2026-09-21.
-- child_order_ids NULL for all five — AF never saw them list-visible, so the
-- child order_ids were never observable (only the order NUMBERS are known,
-- reconstructed from the sheet by date + unit match and confirmed by hand).
INSERT INTO velocity_bundle_identity
  (velocity_order_id, asin, child_order_numbers, child_order_ids, source)
VALUES
  ('03bb63ec-20d7-40a9-9794-28cfdd98ee62', 'B0GNHTYGPF', ARRAY['200015210238647'], NULL, 'manual_seed'),
  ('c0835a42-62bf-4926-91dc-97ba664bf4fa', 'B0GNHTYGPF', ARRAY['200015523189765'], NULL, 'manual_seed'),
  ('48f9a158-80a1-4056-aec0-d5420ee60594', 'B0GWG5S64Q', ARRAY['200015210238647'], NULL, 'manual_seed'),
  ('074e6255-8a1b-47a4-8023-e4e4dab6dcec', 'B0DWXWHXP1', ARRAY['130097'],          NULL, 'manual_seed'),
  ('80d43b58-65d0-43d0-9302-0959737fd7ee', 'B0DKT4NDFZ', ARRAY['127552'],          NULL, 'manual_seed');

COMMIT;
