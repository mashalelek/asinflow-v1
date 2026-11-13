-- 112: supplier emails (claims commit 6, docs/claude_spec-patch-supplier-claims.md §3.11, 2026-11-13).
-- Three task kinds: read_reply (Supplier; a reply to read), review_email_match (Decide; an email AF is not sure about —
-- rows 2 / 7), closed_claim_email (Decide; an email on a closed or dismissed claim, row 8). A task made by an email keeps
-- the email (gmail_message_id, mailbox) and the facts the decision needs (payload: amount, method, summary, outcome…).
-- Events made by an email keep the mailbox beside gmail_message_id (the "open email" link); three event types:
-- email_attached (attached quietly, rows 6 / 8), email_review (the pending "may belong to this claim" entry),
-- email_dismissed (Not this claim / Nothing to do: never proposed again).
ALTER TABLE supplier_claim_tasks DROP CONSTRAINT supplier_claim_tasks_kind_check;
ALTER TABLE supplier_claim_tasks ADD CONSTRAINT supplier_claim_tasks_kind_check CHECK (kind IN (
  'review_suggestion', 'confirm_outcome', 'enter_quantity', 'contact_supplier', 'follow_up_supplier', 'confirm_reship_order',
  'send_label', 'tell_velocity_replacement', 'dispose_units', 'update_velocity_order',
  'refund_received', 'replacement_arrived', 'upload_return_label', 'check_on_it',
  'read_reply', 'review_email_match', 'closed_claim_email'));
ALTER TABLE supplier_claim_tasks
  ADD COLUMN gmail_message_id text,
  ADD COLUMN mailbox text,
  ADD COLUMN payload jsonb;
CREATE INDEX supplier_claim_tasks_gmail_idx ON supplier_claim_tasks (gmail_message_id) WHERE gmail_message_id IS NOT NULL;
ALTER TABLE supplier_claim_events ADD COLUMN mailbox text;
ALTER TABLE supplier_claim_events DROP CONSTRAINT supplier_claim_events_type_check;
ALTER TABLE supplier_claim_events ADD CONSTRAINT supplier_claim_events_type_check CHECK (type IN (
  'found', 'opened', 'dismissed', 'reported', 'supplier_reply', 'outcome_set', 'label_saved', 'return_shipped', 'return_delivered',
  'supplier_confirmed', 'refund_received', 'replacement_shipped', 'replacement_arrived', 'task_done', 'amount_overridden',
  'remainder_written_off', 'reopened', 'closed', 'converted',
  'timed_out', 'snoozed', 'followed_up', 'checked', 'reship_confirmed', 'refund_short',
  'email_attached', 'email_review', 'email_dismissed'));
CREATE INDEX supplier_claim_events_gmail_idx ON supplier_claim_events (gmail_message_id) WHERE gmail_message_id IS NOT NULL;
ALTER TABLE po_prefill_log DROP CONSTRAINT po_prefill_log_kind_check;
ALTER TABLE po_prefill_log ADD CONSTRAINT po_prefill_log_kind_check
  CHECK (kind IN ('capture', 'backfill', 'promo_classify', 'doc_classify', 'tracking_fallback', 'capture_preview', 'supplier_check', 'pack_review', 'cancellation', 'claim_email'));
