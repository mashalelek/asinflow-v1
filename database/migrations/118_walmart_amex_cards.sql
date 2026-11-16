-- 118: two more cards the way every card is stored (Maria 2026-11-16; migrations 115 / 117 are the template). Idempotent.
--
-- 1. The Walmart card, last 4 0302. "Walmart card" has been the canonical name since migration 029 (aliases
--    "OnePay Cash" / "OnePay CashRewards" since 078 / 081, reward 5 %), but it had no last 4 on record, so a payment
--    typed by last 4 alone never resolved to it. The name and the aliases stay; only the last 4 is added.
INSERT INTO settings (key, value) VALUES ('po_payment_method_last4', '{"Walmart card": "0302"}'::jsonb)
ON CONFLICT (key) DO UPDATE SET value = settings.value || EXCLUDED.value, updated_at = now();

-- 2. Amex (1008): a fourth Amex number (1001 / 1002 / 1005 are the others; none of the existing entries carries 1008 —
--    checked on production 2026-11-16), named like Amex (1001) / Amex (1002). No bare "Amex" alias: four cards share the
--    word, so a typed "Amex" resolves by its last 4 (resolvePaymentNickname), as it does for 1001 / 1002 today.
UPDATE settings SET value = value || '["Amex (1008)"]'::jsonb, updated_at = now()
 WHERE key = 'po_payment_methods' AND NOT value ? 'Amex (1008)';

INSERT INTO settings (key, value) VALUES ('po_payment_method_last4', '{"Amex (1008)": "1008"}'::jsonb)
ON CONFLICT (key) DO UPDATE SET value = settings.value || EXCLUDED.value, updated_at = now();

-- 3. The card payments typed by hand (production 2026-11-16: one "OnePay CashRewards" 0302 row of 2026-11-01 — the 27
--    "Walmart card" 0302 rows are already canonical; 14 "Amex" 1008 rows, POs of 2024-11-04 … 2025-09-07) take the
--    canonical name, one History row each. A payment already on the canonical name, another card's row with the same
--    last 4, and a "Walmart card" row with no last 4 on it are left alone.
WITH t AS (
  SELECT id, po_id, nickname, 'Walmart card' AS canonical FROM po_payments
   WHERE method = 'card' AND last4 = '0302'
     AND (nickname IS NULL OR nickname ILIKE 'walmart%' OR nickname ILIKE 'onepay%')
     AND nickname IS DISTINCT FROM 'Walmart card'
  UNION ALL
  SELECT id, po_id, nickname, 'Amex (1008)' FROM po_payments
   WHERE method = 'card' AND last4 = '1008'
     AND (nickname IS NULL OR nickname ILIKE 'amex%')
     AND nickname IS DISTINCT FROM 'Amex (1008)'
), u AS (
  UPDATE po_payments p SET nickname = t.canonical FROM t WHERE p.id = t.id RETURNING p.id
)
INSERT INTO po_edit_log (po_id, user_id, entity, entity_id, field, old_value, new_value, derived)
SELECT t.po_id, NULL, 'po', t.po_id::text,
       CASE t.canonical WHEN 'Walmart card' THEN 'payment nickname (Walmart card last 4 added, migration 118)' ELSE 'payment nickname (Amex (1008) card added, migration 118)' END,
       t.nickname, t.canonical, false
  FROM t;
