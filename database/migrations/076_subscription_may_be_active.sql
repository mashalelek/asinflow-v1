-- 076 — "Subscription may be active" (Maria 2026-11-01; SPEC §27).
-- Every sheet-flagged subscription is backfilled as canceled (the sheet's
-- notes cannot say which still run). A confirmation email that matches a
-- CANCELED subscription's supplier + ASIN still creates the renewal PO
-- (source email_renewal) and raises this item on its lines; the
-- subscription flips to active only when Maria sets it so on the
-- Subscriptions page, which clears the item.
ALTER TABLE po_line_action_items DROP CONSTRAINT po_line_action_items_item_check;
ALTER TABLE po_line_action_items ADD CONSTRAINT po_line_action_items_item_check CHECK (item IN (
  'Need to return', 'Missing / damaged from supplier', 'Confirm refund / replacement',
  'ATTN: Velocity', 'See comments', 'SHIP', 'Received - FBM', 'Review Velocity',
  'Confirm order details', 'Subscription renews', 'Review renewal PO', 'Subscription may be active'));
