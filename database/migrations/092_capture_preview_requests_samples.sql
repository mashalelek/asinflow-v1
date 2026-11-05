-- 092_capture_preview_requests_samples.sql — extension reliability (Maria
-- 2026-11-05; SPEC §11 "Chrome extension — Capture PO", v1.4).
-- (1) Every capture-preview request the server receives or rejects leaves a
--     po_prefill_log row (http_status, note = the reason: a cache hit, 401,
--     400 …), cost 0 when no model call ran — the 409s of 2026-11-04 left
--     nothing behind.
-- (2) supplier_check joins the kinds (the monthly AI spend lists it).
-- (3) capture_page_samples: a captured page whose Products or Totals stayed
--     empty after the AI layer — its scrubbed text kept 30 days (deleted on
--     the next insert after that), admin-only, for test fixtures.
ALTER TABLE po_prefill_log ADD COLUMN IF NOT EXISTS http_status integer;
ALTER TABLE po_prefill_log ADD COLUMN IF NOT EXISTS note text;
ALTER TABLE po_prefill_log DROP CONSTRAINT po_prefill_log_kind_check;
ALTER TABLE po_prefill_log ADD CONSTRAINT po_prefill_log_kind_check
  CHECK (kind IN ('capture', 'backfill', 'promo_classify', 'doc_classify', 'tracking_fallback', 'capture_preview', 'supplier_check'));

CREATE TABLE IF NOT EXISTS capture_page_samples (
  id          bigserial PRIMARY KEY,
  created_at  timestamptz NOT NULL DEFAULT now(),
  user_id     integer REFERENCES users(id) ON DELETE SET NULL,
  retailer    text NOT NULL,
  page_key    text NOT NULL UNIQUE,
  step        text,
  url         text,
  title       text,
  text        text NOT NULL,
  fields      jsonb NOT NULL DEFAULT '[]'::jsonb,
  missing     text[] NOT NULL,
  layers      jsonb
);
CREATE INDEX IF NOT EXISTS capture_page_samples_created_idx ON capture_page_samples (created_at);
