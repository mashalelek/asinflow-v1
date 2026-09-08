-- §21 bulk run ledger (2026-09-09): scope now carries `bulk:<list_id>`
-- (41 chars) — varchar(10) silently dropped every bulk stage row on the
-- first pipeline run (caught by the write-failure log, not the ledger).
ALTER TABLE refresh_runs ALTER COLUMN scope TYPE TEXT;
