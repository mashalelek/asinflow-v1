-- 094_po_line_defects.sql — Supplier defects (SPEC §22 "Supplier defects",
-- Maria 2026-11-05). One row per PO product line per thing the supplier got
-- wrong: units missing from the delivery, damaged, or the wrong item. Built as
-- the line-resolution model of the cancellations patch
-- (docs/claude_spec-patch-po-cancellations-from-email.md §3/§5): a per-line
-- record with its qty, linked to po_line_refunds rows for the money, so the
-- cancellations-from-email confirm can reuse it later.
--
-- qty is RETAILER units of the line and is STORED — never derived from
-- Ordered − Received. amount is what the supplier owes (qty × the line's cost
-- per retailer unit, editable). status: open → resolved; resolution says how:
--   refund      — linked refund rows (po_line_defect_refunds) received in full;
--                 a partial refund leaves the rest open (derived on every change)
--   replacement — the PO line that supplied the replacement units
--   write_off   — Maria's call, with a reason
-- The "Missing / damaged from supplier" action item is derived from open rows.
CREATE TABLE po_line_defects (
  id                          bigserial PRIMARY KEY,
  po_id                       uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  po_line_item_id             uuid NOT NULL REFERENCES po_line_items(id) ON DELETE CASCADE,
  kind                        text NOT NULL CHECK (kind IN ('missing', 'damaged', 'wrong_item')),
  qty                         numeric(10,2) NOT NULL CHECK (qty > 0),
  amount                      numeric(12,2) CHECK (amount IS NULL OR amount >= 0),
  opened_at                   date NOT NULL DEFAULT CURRENT_DATE,
  note                        text,
  status                      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  resolution                  text CHECK (resolution IN ('refund', 'replacement', 'write_off')),
  replacement_po_line_item_id uuid REFERENCES po_line_items(id) ON DELETE SET NULL,
  write_off_reason            text,
  resolved_at                 timestamptz,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  CHECK (status = 'open' OR resolution IS NOT NULL),
  CHECK (resolution IS DISTINCT FROM 'write_off' OR NULLIF(btrim(write_off_reason), '') IS NOT NULL)
);
CREATE INDEX po_line_defects_po_idx ON po_line_defects (po_id, status);
CREATE INDEX po_line_defects_line_idx ON po_line_defects (po_line_item_id);

CREATE TABLE po_line_defect_refunds (
  defect_id         bigint NOT NULL REFERENCES po_line_defects(id) ON DELETE CASCADE,
  po_line_refund_id bigint NOT NULL REFERENCES po_line_refunds(id) ON DELETE CASCADE,
  PRIMARY KEY (defect_id, po_line_refund_id)
);
CREATE INDEX po_line_defect_refunds_refund_idx ON po_line_defect_refunds (po_line_refund_id);
