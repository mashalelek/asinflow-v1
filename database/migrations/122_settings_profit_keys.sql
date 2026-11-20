-- Finances API patch commit 1 (SPEC §5 "Settings live in the database",
-- 2026-11-20): every field of the profit Settings has a `settings` row, so the
-- browser's localStorage copy can go. The values are Maria's real ones, read
-- off her browser's Settings dialog on 2026-11-20 (they replace the earlier
-- seeds: the 1.00 hazmat PREP surcharge was wrong — it is the hazmat SHIPPING
-- surcharge that is 1.00). The Settings dialog changes them from here on.
-- Display options (price source, show gated / meltable / parked / dead) are
-- per-browser toggles in localStorage, not settings rows.
INSERT INTO settings (key, value, updated_at) VALUES
  ('prep_cost',                '1.2'::jsonb,  NOW()),
  ('additional_fees',          '0'::jsonb,    NOW()),
  ('low_inventory_surcharge',  '0.26'::jsonb, NOW()),
  ('hazmat_ship_surcharge',    '1'::jsonb,    NOW()),
  ('hazmat_prep_surcharge',    '0'::jsonb,    NOW()),
  ('inbound_shipping_per_lb',  '0.8'::jsonb,  NOW()),
  ('include_inbound_shipping', 'true'::jsonb, NOW()),
  ('min_margin',               '12'::jsonb,   NOW()),
  ('min_roi',                  '18'::jsonb,   NOW()),
  ('min_profit_unit',          '2'::jsonb,    NOW()),
  ('max_cogs_min_margin_pct',  '12'::jsonb,   NOW()),
  ('max_cogs_min_roi_pct',     '18'::jsonb,   NOW()),
  ('max_cogs_min_profit_unit', '2'::jsonb,    NOW())
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();
