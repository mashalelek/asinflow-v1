-- New PO form polish round 2 (Maria 2026-11-01):
--   - Cashback site is a dropdown in this exact order (the form reads it from here; "None" is the empty value).
--   - Payment-method alias table: two names, one instrument ("OnePay Cash" = "Walmart card") so history matches;
--     the picker shows the canonical name.
INSERT INTO settings (key, value) VALUES ('po_cashback_sites', '["BeFrugal", "TopCashback", "RetailMeNot", "Rakuten", "Coupert"]'::jsonb)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
INSERT INTO settings (key, value) VALUES ('po_payment_method_aliases', '{"OnePay Cash": "Walmart card"}'::jsonb)
ON CONFLICT (key) DO UPDATE SET value = settings.value || EXCLUDED.value, updated_at = now();
