-- Pack-size reconciliation (2026-10-29): Velocity's own units_per_pack for the
-- orders that resolve to this ASIN row (1 for individual), written by shipment
-- sync A. NULL = no Velocity line seen, or a bundle (not compared). AF's
-- sold_as / units_per_pack stay AF's; this column only lets the derived
-- "Pack size mismatch" action item see the disagreement.
ALTER TABLE po_asins
  ADD COLUMN velocity_units_per_pack INTEGER;
