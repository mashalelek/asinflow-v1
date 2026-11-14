-- 113: returns (claims commit 7, docs/claude_spec-patch-supplier-claims.md §3.12, 2026-11-13).
-- The return's own facts on the claim: the return-by date (read from the label email or typed; the row-9 warning fires
-- once per date — return_by_warned), No label (return_no_label), and the Shipped / Delivered dates with their SOURCE
-- ('tracking' = the carrier's first scan / delivery, 'email' = a Walmart pickup / received notice, 'manual' = set by hand
-- in Steps, 'confirmation' = row 12: the temporary commit-2b auto-tick at confirmation, kept and labeled). A date set by
-- hand is never overwritten by tracking, and a tracking date never by a later email (server/claim-returns.ts).
ALTER TABLE supplier_claims
  ADD COLUMN return_by date,
  ADD COLUMN return_by_source text,
  ADD COLUMN return_by_warned date,
  ADD COLUMN return_no_label boolean NOT NULL DEFAULT false,
  ADD COLUMN return_shipped_at timestamptz,
  ADD COLUMN return_shipped_source text,
  ADD COLUMN return_delivered_at timestamptz,
  ADD COLUMN return_delivered_source text;
-- One task kind: drop_off_return (group Money and arrivals) — a home PO's return (row 2).
ALTER TABLE supplier_claim_tasks DROP CONSTRAINT supplier_claim_tasks_kind_check;
ALTER TABLE supplier_claim_tasks ADD CONSTRAINT supplier_claim_tasks_kind_check CHECK (kind IN (
  'review_suggestion', 'confirm_outcome', 'enter_quantity', 'contact_supplier', 'follow_up_supplier', 'confirm_reship_order',
  'send_label', 'tell_velocity_replacement', 'dispose_units', 'update_velocity_order',
  'refund_received', 'replacement_arrived', 'upload_return_label', 'check_on_it',
  'read_reply', 'review_email_match', 'closed_claim_email', 'drop_off_return'));
-- The return tracking row (direction = 'return', claim_id): the last scan's place for the Return card ("In transit ·
-- Memphis, TN"), and a return may reuse the inbound number (§3.9: EasyPost answers with the inbound tracker) — the unique
-- key gains the direction so the return row can sit beside the inbound one.
ALTER TABLE po_tracking ADD COLUMN last_scan_location text;
UPDATE po_tracking SET direction = 'inbound' WHERE direction IS NULL;
ALTER TABLE po_tracking ALTER COLUMN direction SET NOT NULL;
DROP INDEX po_tracking_primary_number_key;
CREATE UNIQUE INDEX po_tracking_primary_number_key ON po_tracking (carrier, tracking_number, direction) WHERE split_of IS NULL;
-- The AI reading of an uploaded label (tracking # / carrier / return-by from the PDF when nothing was typed) is logged like every call.
ALTER TABLE po_prefill_log DROP CONSTRAINT po_prefill_log_kind_check;
ALTER TABLE po_prefill_log ADD CONSTRAINT po_prefill_log_kind_check
  CHECK (kind IN ('capture', 'backfill', 'promo_classify', 'doc_classify', 'tracking_fallback', 'capture_preview', 'supplier_check', 'pack_review', 'cancellation', 'claim_email', 'claim_return_label'));
-- Row 12: claims the temporary auto-tick (commit 2b: Shipped / Delivered ticked themselves at Confirmed by supplier) had
-- ticked keep their dates, labeled "set at confirmation, before tracking"; nothing re-opens. (0 rows on production 2026-11-13.)
UPDATE supplier_claims
   SET return_shipped_at = supplier_confirmed_at, return_shipped_source = 'confirmation',
       return_delivered_at = supplier_confirmed_at, return_delivered_source = 'confirmation'
 WHERE return_required AND supplier_confirmed_at IS NOT NULL AND status IN ('open', 'closed') AND return_shipped_at IS NULL;
