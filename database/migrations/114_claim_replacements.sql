-- 114: replacements + dismiss with note (claims commit 8, docs/claude_spec-patch-supplier-claims.md §3.13, 2026-11-14).
-- A. Every number kept on a PO besides its own order # carries a label saying why it is there (Maria 2026-11-14):
--    replacement_order (+ its claim), previous_number (after a rename), invoice, confirmation, other (+ a note).
--    purchase_orders.alt_order_ids stays as the derived text every matcher reads (server/po-other-numbers.ts keeps it in
--    sync); the existing numbers come over as 'other' with no note — never guessed (the step 1 report lists them).
CREATE TABLE po_other_numbers (
  id          bigserial PRIMARY KEY,
  po_id       uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  number      text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('replacement_order', 'previous_number', 'invoice', 'confirmation', 'other')),
  note        text,
  claim_id    bigint REFERENCES supplier_claims(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by_user_id integer,
  UNIQUE (po_id, number)
);
CREATE INDEX po_other_numbers_number_idx ON po_other_numbers (number);
INSERT INTO po_other_numbers (po_id, number, kind)
SELECT p.id, n, 'other' FROM purchase_orders p, unnest(regexp_split_to_array(p.alt_order_ids, '[\s,;/]+')) AS n
 WHERE COALESCE(p.alt_order_ids, '') <> '' AND n <> ''
ON CONFLICT DO NOTHING;
-- B. Dismiss a warning with a note (§3.8, rows 10–13): one row per dismissal with the ASIN row it sits on (NULL = the PO:
--    Review Velocity), the numbers at dismissal (the warning returns when they change), undo. The Extra-units clear notes
--    (migration 073) become dismissals — the same numbers, the same note.
ALTER TABLE po_warning_dismissals
  ADD COLUMN po_asin_id uuid REFERENCES po_asins(id) ON DELETE CASCADE,
  ADD COLUMN undone_at  timestamptz,
  ADD COLUMN undone_by  integer;
CREATE INDEX po_warning_dismissals_live_idx ON po_warning_dismissals (po_id, warning_type) WHERE undone_at IS NULL;
INSERT INTO po_warning_dismissals (po_id, po_asin_id, warning_type, quantities_json, note, dismissed_by, dismissed_at)
SELECT a.po_id, a.id, 'Extra units shipped', jsonb_build_object('shipped', a.extra_units_cleared_shipped, 'ordered', a.qty),
       COALESCE(NULLIF(a.extra_units_note, ''), 'cleared before 2026-11-14 (no note kept)'), a.extra_units_cleared_by, COALESCE(a.extra_units_cleared_at, now())
  FROM po_asins a WHERE a.extra_units_cleared_at IS NOT NULL;
-- C. The replacement's own facts on the claim: delivered (the carrier's scan — a home PO's Arrived / Short), where Shipped came
--    from ('tracking' | 'email' | 'manual'), the reship's own order # when it has one, and a short arrival's count.
ALTER TABLE supplier_claims
  ADD COLUMN replacement_delivered_at timestamptz,
  ADD COLUMN replacement_shipped_source text,
  ADD COLUMN replacement_order_id text,
  ADD COLUMN replacement_short_qty numeric;
-- D. One task kind: confirm_arrival (Money and arrivals; a home PO's replacement delivered — Arrived / Short, row 6).
--    Two event types: replacement_delivered, reship_dismissed ("It's not": never proposed for this claim again).
ALTER TABLE supplier_claim_tasks DROP CONSTRAINT supplier_claim_tasks_kind_check;
ALTER TABLE supplier_claim_tasks ADD CONSTRAINT supplier_claim_tasks_kind_check CHECK (kind IN (
  'review_suggestion', 'confirm_outcome', 'enter_quantity', 'contact_supplier', 'follow_up_supplier', 'confirm_reship_order',
  'send_label', 'tell_velocity_replacement', 'dispose_units', 'update_velocity_order',
  'refund_received', 'replacement_arrived', 'upload_return_label', 'check_on_it',
  'read_reply', 'review_email_match', 'closed_claim_email', 'drop_off_return', 'confirm_arrival'));
ALTER TABLE supplier_claim_events DROP CONSTRAINT supplier_claim_events_type_check;
ALTER TABLE supplier_claim_events ADD CONSTRAINT supplier_claim_events_type_check CHECK (type IN (
  'found', 'opened', 'dismissed', 'reported', 'supplier_reply', 'outcome_set', 'label_saved', 'return_shipped', 'return_delivered',
  'supplier_confirmed', 'refund_received', 'replacement_shipped', 'replacement_arrived', 'task_done', 'amount_overridden',
  'remainder_written_off', 'reopened', 'closed', 'converted',
  'timed_out', 'snoozed', 'followed_up', 'checked', 'reship_confirmed', 'refund_short',
  'email_attached', 'email_review', 'email_dismissed', 'replacement_delivered', 'reship_dismissed'));
