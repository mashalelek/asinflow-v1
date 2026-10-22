-- tracking.velocity_start_date (SPEC §26; Maria 2026-10-22): the Velocity
-- start date for the ships_to sanity check = the first PO dated with any ASIN
-- row prep_cost > 0 (2026-04-07 on production). Stored once, not recomputed:
-- a later edit that puts prep on an older PO is then the data error the check
-- reports. Separate from VELOCITY_MIN_ORDER_DATE, the Upload to Velocity
-- creation floor (env, 7/30/2026), which stays where it is.
INSERT INTO settings (key, value, updated_at)
SELECT 'tracking.velocity_start_date', to_jsonb(MIN(p.order_date)::text), NOW()
  FROM purchase_orders p JOIN po_asins a ON a.po_id = p.id
 WHERE a.prep_cost > 0
HAVING MIN(p.order_date) IS NOT NULL
ON CONFLICT (key) DO NOTHING;
