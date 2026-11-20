-- Finances API patch commit 1 (SPEC §5 "Settings live in the database",
-- 2026-11-20): every field of the profit Settings has a `settings` row, so the
-- browser's localStorage copy can go. Existing rows keep their value; the
-- three rows no page ever wrote get the browser defaults. prep_cost and
-- hazmat_prep_surcharge are set to the values Maria's browser holds today
-- (acceptance table rows 11 / 13: $1.20 and $1.00) — the Settings dialog
-- changes them from here on.
INSERT INTO settings (key, value, updated_at) VALUES
  ('min_profit_unit',          '3'::jsonb,  NOW()),
  ('max_cogs_min_margin_pct',  '12'::jsonb, NOW()),
  ('max_cogs_min_roi_pct',     '20'::jsonb, NOW()),
  ('max_cogs_min_profit_unit', '3'::jsonb,  NOW()),
  ('inbound_shipping_per_lb',  '0.5'::jsonb, NOW()),
  ('additional_fees',          '0'::jsonb,  NOW()),
  ('low_inventory_surcharge',  '0.26'::jsonb, NOW()),
  ('hazmat_ship_surcharge',    '0'::jsonb,  NOW()),
  ('min_roi',                  '15'::jsonb, NOW()),
  ('min_margin',               '10'::jsonb, NOW())
ON CONFLICT (key) DO NOTHING;

INSERT INTO settings (key, value, updated_at) VALUES
  ('prep_cost',            '1.2'::jsonb, NOW()),
  ('hazmat_prep_surcharge', '1'::jsonb,  NOW())
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();
