-- 081_amex_split.sql — two Amex cards end in 1005 (Maria 2026-11-02).
--
-- "Amex (1005)" was one canonical payment method; it is two cards, "Amex Gold"
-- and "Amex Plus", both last 4 = 1005. The canonical list is renamed in place
-- (order is meaningful: Amex Plus follows Amex Gold), three sheet spellings
-- become aliases, and a new settings map, po_payment_method_last4, records
-- each method's last 4 — the picker and the prefill resolve a card by nickname
-- first, by last 4 second, and never by last 4 alone when two methods share
-- it. Idempotent. The po_payments backfill is npm run backfill:amex-split.
UPDATE settings SET value = (
  SELECT jsonb_agg(x ORDER BY ord) FROM (
    SELECT ord * 2 AS ord, CASE WHEN e = 'Amex (1005)' THEN to_jsonb('Amex Gold'::text) ELSE to_jsonb(e) END AS x
      FROM jsonb_array_elements_text(settings.value) WITH ORDINALITY AS t(e, ord)
    UNION ALL
    SELECT ord * 2 + 1, to_jsonb('Amex Plus'::text)
      FROM jsonb_array_elements_text(settings.value) WITH ORDINALITY AS t(e, ord) WHERE e = 'Amex (1005)'
  ) s), updated_at = now()
WHERE key = 'po_payment_methods' AND value ? 'Amex (1005)';

INSERT INTO settings (key, value) VALUES ('po_payment_method_aliases', '{"Amex (1005) - Gold": "Amex Gold", "Amex Gold (1005)": "Amex Gold", "Amex Plus (1005)": "Amex Plus"}'::jsonb)
ON CONFLICT (key) DO UPDATE SET value = settings.value || EXCLUDED.value, updated_at = now();

INSERT INTO settings (key, value)
SELECT 'po_payment_method_last4',
       COALESCE(jsonb_object_agg(e, substring(e from '\((\d{4})\)')) FILTER (WHERE e ~ '\(\d{4}\)'), '{}'::jsonb) || '{"Amex Gold": "1005", "Amex Plus": "1005"}'::jsonb
  FROM settings s, jsonb_array_elements_text(s.value) AS e
 WHERE s.key = 'po_payment_methods'
ON CONFLICT (key) DO UPDATE SET value = settings.value || EXCLUDED.value, updated_at = now();
