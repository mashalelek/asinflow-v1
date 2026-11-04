-- 085_tracking_fallback_log_kind.sql — the PO tracking AI fallback is built
-- (Maria 2026-11-04; SPEC §26, server/tracking-ai.ts): one Haiku call per
-- "email:" placeholder whose order # names exactly one AF PO, reading the
-- carrier + tracking number (or its track link) from the email. Every call
-- is logged in po_prefill_log under kind 'tracking_fallback'.
ALTER TABLE po_prefill_log DROP CONSTRAINT po_prefill_log_kind_check;
ALTER TABLE po_prefill_log ADD CONSTRAINT po_prefill_log_kind_check
  CHECK (kind IN ('capture', 'backfill', 'promo_classify', 'doc_classify', 'tracking_fallback'));
