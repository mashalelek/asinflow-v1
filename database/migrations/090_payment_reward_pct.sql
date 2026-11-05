-- 090_payment_reward_pct.sql (Maria 2026-11-04; SPEC §22 "Costs").
-- A card's reward % counts toward COGS like a gift card's discount %.
-- 1. po_payments.reward_pct: the card payment's reward % (percent units,
--    5.00 = 5 %), filled from its canonical method's default and editable
--    per PO; cards only. NULL = none.
-- 2. settings.po_payment_method_reward_pct: canonical method → default
--    reward % (Walmart card 5 %; every other method 0, i.e. absent).
-- 3. The Walmart card's second alias, "OnePay CashRewards".
-- "Weighted GC %" becomes "Weighted payment discount %" — the same column
-- (purchase_orders.weighted_gc_discount_pct), now Σ(gift-card amount × GC %
-- + card amount × reward %) ÷ order total. Cashback portals never count.
ALTER TABLE po_payments ADD COLUMN reward_pct numeric(6,2);
INSERT INTO settings (key, value) VALUES ('po_payment_method_reward_pct', '{"Walmart card": 5}'::jsonb)
ON CONFLICT (key) DO NOTHING;
UPDATE settings SET value = value || '{"OnePay CashRewards": "Walmart card"}'::jsonb, updated_at = NOW()
 WHERE key = 'po_payment_method_aliases' AND NOT value ? 'OnePay CashRewards';
