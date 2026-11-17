-- 119: the "Walmart card" payments with no last 4 get 0302 (Maria 2026-11-17: there is one Walmart card; production
-- 2026-11-16: 57 card rows nicknamed "Walmart card" with last4 NULL, POs of 2026-07-19 … 10-23 — typed before migration 118
-- put the card's last 4 on record). One History row each; a row with any last 4 already, or another nickname, is left
-- alone. Idempotent.
WITH t AS (
  SELECT id, po_id FROM po_payments
   WHERE method = 'card' AND nickname = 'Walmart card' AND last4 IS NULL
), u AS (
  UPDATE po_payments p SET last4 = '0302' FROM t WHERE p.id = t.id RETURNING p.id
)
INSERT INTO po_edit_log (po_id, user_id, entity, entity_id, field, old_value, new_value, derived)
SELECT t.po_id, NULL, 'po', t.po_id::text, 'payment last 4 (Walmart card 0302 filled in, migration 119)', NULL, '0302', false
  FROM t;
