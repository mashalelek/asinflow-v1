-- 117: the CapitalOne card, last 4 6830, type card (Maria 2026-11-15) — the same way as Wells Fargo (migration 115):
-- the canonical name appended to settings.po_payment_methods, its last 4 in settings.po_payment_method_last4, the
-- aliases "CapitalOne" and "Capital One" (canonicalPaymentName ignores case and punctuation, so "capital one" lands too).
-- Idempotent.
UPDATE settings SET value = value || '["CapitalOne (6830)"]'::jsonb, updated_at = now()
 WHERE key = 'po_payment_methods' AND NOT value ? 'CapitalOne (6830)';

INSERT INTO settings (key, value) VALUES ('po_payment_method_last4', '{"CapitalOne (6830)": "6830"}'::jsonb)
ON CONFLICT (key) DO UPDATE SET value = settings.value || EXCLUDED.value, updated_at = now();

INSERT INTO settings (key, value) VALUES ('po_payment_method_aliases', '{"CapitalOne": "CapitalOne (6830)", "Capital One": "CapitalOne (6830)"}'::jsonb)
ON CONFLICT (key) DO UPDATE SET value = settings.value || EXCLUDED.value, updated_at = now();

-- The card payments typed by hand before the card existed (production 2026-11-15: 31 rows, nickname "CapitalOne",
-- last 4 6830, POs of 2026-10-17 … 10-23) take the canonical name, one History row each. A payment already on the
-- canonical name is left alone.
WITH t AS (
  SELECT id, po_id, nickname FROM po_payments
   WHERE method = 'card' AND last4 = '6830'
     AND (nickname IS NULL OR nickname ILIKE 'capital%')
     AND nickname IS DISTINCT FROM 'CapitalOne (6830)'
), u AS (
  UPDATE po_payments p SET nickname = 'CapitalOne (6830)' FROM t WHERE p.id = t.id RETURNING p.id
)
INSERT INTO po_edit_log (po_id, user_id, entity, entity_id, field, old_value, new_value, derived)
SELECT t.po_id, NULL, 'po', t.po_id::text, 'payment nickname (CapitalOne card added, migration 117)', t.nickname, 'CapitalOne (6830)', false
  FROM t;
