-- 062_po_quantities_decimal.sql (2026-10-18)
--
-- Every PO quantity holds decimals (2 places), like the six ASIN-level
-- quantities and the shipment rows already do. The Orders sheet carries
-- fractional quantities (Col L 13.5, Col N 2.5 packs, 4.8 …) that the
-- integer columns rounded on import (5 units of a 2-pack stored as 3 packs).
--   po_line_items: qty_ordered, qty_received, qty_returned, qty_canceled,
--                  final_qty (GENERATED — dropped and re-added, same expression)
--   po_asins:      qty (Ordered), unreimbursed_loss_qty
-- integer → numeric(10,2) is lossless. Units / pack and unique products stay
-- integer (counts, not quantities).
ALTER TABLE po_line_items DROP COLUMN final_qty;
ALTER TABLE po_line_items
  ALTER COLUMN qty_ordered  TYPE numeric(10,2),
  ALTER COLUMN qty_received TYPE numeric(10,2),
  ALTER COLUMN qty_returned TYPE numeric(10,2),
  ALTER COLUMN qty_canceled TYPE numeric(10,2);
ALTER TABLE po_line_items ADD COLUMN final_qty numeric(10,2) GENERATED ALWAYS AS ((qty_ordered - qty_canceled) - qty_returned) STORED;
ALTER TABLE po_asins
  ALTER COLUMN qty TYPE numeric(10,2),
  ALTER COLUMN unreimbursed_loss_qty TYPE numeric(10,2);
