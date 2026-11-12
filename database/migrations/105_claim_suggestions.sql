-- Supplier claims, commit 5 (SPEC §22 "Supplier claims", claims patch §3.1 / D8): auto-found claims. AF suggests
-- missing (D8), never_received (§3.1) and canceled (cancellation emails) claims as status 'suggested' with a
-- review_suggestion task; nothing changes a PO until Maria opens one.
--   suggestion_key   what the suggestion rests on (kind + line / PO + the figures or the email): the same key is
--                    never suggested twice — a dismissed suggestion comes back only when its figures change.
ALTER TABLE supplier_claims ADD COLUMN suggestion_key text;
CREATE INDEX supplier_claims_suggestion_key_idx ON supplier_claims (suggestion_key) WHERE suggestion_key IS NOT NULL;
-- The cancellation-email Haiku fallback logs under its own kind.
ALTER TABLE po_prefill_log DROP CONSTRAINT po_prefill_log_kind_check;
ALTER TABLE po_prefill_log ADD CONSTRAINT po_prefill_log_kind_check
  CHECK (kind IN ('capture', 'backfill', 'promo_classify', 'doc_classify', 'tracking_fallback', 'capture_preview', 'supplier_check', 'pack_review', 'cancellation'));
