-- 088_capture_preview_log_kind.sql — the extension's AI preview (Maria
-- 2026-11-04; SPEC §11 "Chrome extension — Capture PO", v1.3): each Capture
-- click sends that page's scrubbed text to one small Haiku extraction (the
-- prefill's schema) that fills the panel's buckets; cached per page. Every
-- call is logged in po_prefill_log under kind 'capture_preview', with cost.
ALTER TABLE po_prefill_log DROP CONSTRAINT po_prefill_log_kind_check;
ALTER TABLE po_prefill_log ADD CONSTRAINT po_prefill_log_kind_check
  CHECK (kind IN ('capture', 'backfill', 'promo_classify', 'doc_classify', 'tracking_fallback', 'capture_preview'));
