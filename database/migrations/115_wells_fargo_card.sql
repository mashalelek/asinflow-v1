-- 115: the Wells Fargo card, last 4 0875, type card (Maria 2026-11-15) — stored the way every card is
-- (migrations 028 / 029 / 081): the canonical name in settings.po_payment_methods (the payment picker on
-- New PO / Edit PO / Capture PO lists it), its last 4 in settings.po_payment_method_last4 (the form and the
-- capture prefill resolve a card by nickname first, by last 4 second — resolvePaymentNickname; a refund email's
-- "card ending in 0875" names it the same way, server/claim-emails.ts) and "Wells Fargo" as an alias so a
-- hand-typed nickname lands on the canonical name (canonicalPaymentName). Idempotent.
UPDATE settings SET value = value || '["Wells Fargo (0875)"]'::jsonb, updated_at = now()
 WHERE key = 'po_payment_methods' AND NOT value ? 'Wells Fargo (0875)';

INSERT INTO settings (key, value) VALUES ('po_payment_method_last4', '{"Wells Fargo (0875)": "0875"}'::jsonb)
ON CONFLICT (key) DO UPDATE SET value = settings.value || EXCLUDED.value, updated_at = now();

INSERT INTO settings (key, value) VALUES ('po_payment_method_aliases', '{"Wells Fargo": "Wells Fargo (0875)"}'::jsonb)
ON CONFLICT (key) DO UPDATE SET value = settings.value || EXCLUDED.value, updated_at = now();

-- The card payments typed by hand before the card existed (production 2026-11-15: 4 rows — yarnspirations
-- SPIN-1747783, afa-motors AFA15255, shop.equalexchange.coop SHOP542527, acehardware 78398189; nickname
-- "Wells Fargo" or blank, last 4 0875) take the canonical name, one History row each (po_edit_log, as the
-- Amex-split backfill wrote them). A payment already on the canonical name is left alone.
WITH t AS (
  SELECT id, po_id, nickname FROM po_payments
   WHERE method = 'card' AND last4 = '0875'
     AND (nickname IS NULL OR nickname ILIKE 'wells%')
     AND nickname IS DISTINCT FROM 'Wells Fargo (0875)'
), u AS (
  UPDATE po_payments p SET nickname = 'Wells Fargo (0875)' FROM t WHERE p.id = t.id RETURNING p.id
)
INSERT INTO po_edit_log (po_id, user_id, entity, entity_id, field, old_value, new_value, derived)
SELECT t.po_id, NULL, 'po', t.po_id::text, 'payment nickname (Wells Fargo card added, migration 115)', t.nickname, 'Wells Fargo (0875)', false
  FROM t;
