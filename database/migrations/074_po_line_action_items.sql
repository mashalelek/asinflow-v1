-- 074_po_line_action_items.sql — PO table v2 (docs/claude_spec-patch-po-table-v2.md §3,
-- amended 2026-10-29). Action items get their own table on the product line:
-- who set them (source), why (reason, auto items), when, and when / how they
-- were cleared. Labels are sentence case (Maria 2026-10-29).
--
-- The backfill runs HERE, not in a separate script: the readers switch to this
-- table in the same deploy, and a gap would show no items and let auto-close
-- close POs that have open ones. `npm run backfill:line-action-items` is the
-- read-only dry run before, and the check after.
--
-- po_line_items.action_items and purchase_orders.action_items stay one more
-- release, neither read nor written, then a cleanup migration drops both.
CREATE TABLE po_line_action_items (
  id              bigserial PRIMARY KEY,
  po_line_item_id uuid NOT NULL REFERENCES po_line_items(id) ON DELETE CASCADE,
  item            text NOT NULL CHECK (item IN (
                    'Need to return', 'Missing / damaged from supplier', 'Confirm refund / replacement',
                    'ATTN: Velocity', 'See comments', 'SHIP', 'Received - FBM', 'Review Velocity')),
  source          text NOT NULL CHECK (source IN ('manual', 'sheet', 'auto')),
  reason          text,
  set_at          timestamptz NOT NULL DEFAULT now(),
  cleared_at      timestamptz,
  cleared_by      text CHECK (cleared_by IN ('manual', 'auto')),
  CHECK ((cleared_at IS NULL) = (cleared_by IS NULL))
);
CREATE UNIQUE INDEX po_line_action_items_open_key ON po_line_action_items (po_line_item_id, item) WHERE cleared_at IS NULL;
CREATE INDEX po_line_action_items_line_idx ON po_line_action_items (po_line_item_id) WHERE cleared_at IS NULL;
CREATE INDEX po_line_action_items_item_idx ON po_line_action_items (item) WHERE cleared_at IS NULL;

-- Backfill 1: every item on a line today, mapped to sentence case. Every PO is
-- a sheet import and no item was ever edited by hand (0 po_edit_log rows).
INSERT INTO po_line_action_items (po_line_item_id, item, source)
SELECT DISTINCT l.id,
       CASE x WHEN 'Need to Return' THEN 'Need to return'
              WHEN 'Missing / Damaged from Supplier' THEN 'Missing / damaged from supplier'
              WHEN 'Confirm Refund / Replacement' THEN 'Confirm refund / replacement'
              WHEN 'See Comments' THEN 'See comments'
              ELSE x END,
       'sheet'
  FROM po_line_items l, unnest(l.action_items) x;

-- Backfill 2: Review Velocity on every line of each PO whose tracking has an
-- open review reason (same condition the derived item used, SPEC §26).
INSERT INTO po_line_action_items (po_line_item_id, item, source, reason)
SELECT l.id, 'Review Velocity', 'auto', r.reasons
  FROM po_line_items l
  JOIN (SELECT t.po_id, string_agg(DISTINCT t.review_reason, '; ' ORDER BY t.review_reason) AS reasons
          FROM po_tracking t
         WHERE t.po_id IS NOT NULL AND t.review_reason IS NOT NULL AND t.suppressed_at IS NULL
         GROUP BY t.po_id) r ON r.po_id = l.po_id;

-- One History row per PO that received items.
INSERT INTO po_edit_log (po_id, user_id, entity, entity_id, field, old_value, new_value)
SELECT l.po_id, NULL, 'po', NULL, 'action_items_moved',
       'po_line_items.action_items',
       count(*) || ' open item(s) on ' || count(DISTINCT a.po_line_item_id) || ' line(s) → po_line_action_items: ' || string_agg(DISTINCT a.item, ', ' ORDER BY a.item)
  FROM po_line_action_items a JOIN po_line_items l ON l.id = a.po_line_item_id
 GROUP BY l.po_id;

COMMENT ON TABLE po_line_action_items IS 'Action items per product line (PO table v2). Open = cleared_at IS NULL. Review Velocity is source auto, mirrored from po_tracking. Extra units shipped / pack size / receiving mismatch stay derived from po_asins.';
COMMENT ON COLUMN po_line_items.action_items IS 'DEPRECATED 2026-10-29: moved to po_line_action_items (074); neither read nor written. Dropped in a later cleanup migration.';
