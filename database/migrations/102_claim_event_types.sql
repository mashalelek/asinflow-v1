-- Supplier claims, commit 2 (SPEC §22 "Supplier claims" §3.2–3.5): the timeline gains the events the tasks and the
-- 5-business-day timer write — timed_out (the sweep created follow_up_supplier / check_on_it), snoozed, followed_up
-- (a Follow up tick), checked (a Check on it tick), reship_confirmed (the reship order # added to alt_order_ids),
-- refund_short (a refund posted short of what is owed). The §4.3 list otherwise unchanged.
ALTER TABLE supplier_claim_events DROP CONSTRAINT supplier_claim_events_type_check;
ALTER TABLE supplier_claim_events ADD CONSTRAINT supplier_claim_events_type_check CHECK (type IN (
  'found', 'opened', 'dismissed', 'reported', 'supplier_reply', 'outcome_set', 'label_saved', 'return_shipped', 'return_delivered',
  'supplier_confirmed', 'refund_received', 'replacement_shipped', 'replacement_arrived', 'task_done', 'amount_overridden',
  'remainder_written_off', 'reopened', 'closed', 'converted',
  'timed_out', 'snoozed', 'followed_up', 'checked', 'reship_confirmed', 'refund_short'));
