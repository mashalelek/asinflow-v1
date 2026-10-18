-- 061_po_af_owned.sql — AF owns POs (patch docs/claude_spec-patch-po-af-owned.md
-- §3, §5; pre-flight docs/po-af-owned-preflight-2026-10-18.md). The sheet
-- becomes intake-only: it inserts new POs, AF is the record after that.
--
-- 1. po_edit_log: one row per changed field of every AF edit (§3), shown
--    as the History tab on PO detail.
-- 2. deleted_pos: tombstones (§5.3) so Sync POs never re-imports a PO
--    deleted in AF.
-- 3. purchase_orders.entry_seq: the "which is newer" tie-break for POs on
--    the same order date (Maria 2026-10-18; B076692G4N, staples.com
--    9929903576 vs 9929903025, both 2025-05-01). "Newest" = order_date
--    DESC, entry_seq DESC. Sheet-imported POs carry (total sheet rows −
--    the PO's first sheet row) at import — the sheet runs newest-first,
--    so a higher row is newer and gets a larger value (< 10^6). POs created
--    in AF carry their creation time in epoch milliseconds (> 10^12), so an
--    AF-created PO counts as newer than any sheet PO of the same date.
--    Existing rows are backfilled from the sheet by committed code
--    (script/backfill-po-entry-seq.ts), not here; NULL sorts last.
-- (po_asin_shipments.assigned_by already exists — migration 060.)
CREATE TABLE po_edit_log (
  id         bigserial PRIMARY KEY,
  po_id      uuid NOT NULL,                       -- no FK: the log outlives a deleted PO
  user_id    integer NULL REFERENCES users(id) ON DELETE SET NULL,
  entity     text NOT NULL CHECK (entity IN ('po', 'line', 'asin', 'shipment')),
  entity_id  text NULL,
  field      text NOT NULL,
  old_value  text NULL,
  new_value  text NULL,
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX po_edit_log_po_idx ON po_edit_log (po_id, at DESC);

CREATE TABLE deleted_pos (
  supplier   text NOT NULL,
  order_id   text NOT NULL,
  deleted_by integer NULL REFERENCES users(id) ON DELETE SET NULL,
  deleted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (supplier, order_id)
);

ALTER TABLE purchase_orders ADD COLUMN entry_seq bigint NULL;
CREATE INDEX purchase_orders_newest_idx ON purchase_orders (order_date DESC, entry_seq DESC NULLS LAST);
COMMENT ON COLUMN purchase_orders.entry_seq IS 'Same-day tie-break: newest = order_date DESC, entry_seq DESC. Sheet POs: total sheet rows − first sheet row at import (< 1e6); AF-created POs: creation epoch ms.';
