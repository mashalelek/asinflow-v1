-- 065_hygiene_close_breaker_50.sql (2026-10-21)
--
-- Listing hygiene breakers (Maria 2026-10-21): closes hold above 50 per run,
-- deletes stay at 25. 064 seeded both at 25; the first live 00:00 pass
-- closed 24 and held 162 deletes.
INSERT INTO settings (key, value, updated_at) VALUES ('hygiene_close_breaker', '50'::jsonb, NOW())
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();
INSERT INTO settings (key, value, updated_at) VALUES ('hygiene_delete_breaker', '25'::jsonb, NOW())
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();
