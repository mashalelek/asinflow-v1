-- 058_row_level_status.sql — Row-level Status (patch
-- docs/claude_spec-patch-row-level-status.md §2; pre-flight
-- docs/row-level-status-preflight-2026-10-17.md).
--
-- 1. Action items live on the PRODUCT (a sheet row = a po_line_items row).
--    Same allowed values as purchase_orders.action_items (migration 056).
--    The PO-level column stops being written; kept one release, then dropped.
-- 2. po_asins.unique_products = the sheet's Col S (unique products per ASIN).
--    For sold_as = 'bundle' the derived Canceled / Returned divide by it
--    (Maria 2026-10-17: stored yields are each component's standalone
--    yield, so Σ(line qty × yield) counts a bundle N times). The sheet sync
--    writes it from Col S; this backfill uses the line count for bundles
--    (one line per component) until the next sync overwrites it.
-- Line action items are backfilled by the sheet sync (committed code), not here.
ALTER TABLE po_line_items
  ADD COLUMN action_items text[] NOT NULL DEFAULT '{}';
ALTER TABLE po_line_items
  ADD CONSTRAINT po_line_items_action_items_check CHECK (
    action_items <@ ARRAY[
      'Need to Return',
      'Missing / Damaged from Supplier',
      'Confirm Refund / Replacement',
      'ATTN: Velocity',
      'See Comments',
      'SHIP',
      'Received - FBM'
    ]::text[]
  );
CREATE INDEX po_line_items_action_items_idx ON po_line_items USING gin (action_items) WHERE action_items <> '{}';

ALTER TABLE po_asins ADD COLUMN unique_products smallint NULL;
UPDATE po_asins pa SET unique_products = (SELECT COUNT(*) FROM po_line_items l WHERE l.po_asin_id = pa.id)
 WHERE pa.sold_as = 'bundle';

COMMENT ON COLUMN po_line_items.action_items IS 'Action items for this product (sheet row). Sheet-owned for now (row Status → full replace); editable per line or per ASIN (write-through). The ASIN shows the union, the PO the union over all lines.';
COMMENT ON COLUMN po_asins.unique_products IS 'Sheet Col S (unique products per ASIN). For sold_as = bundle, derived Canceled/Returned = Σ(line qty × yield) ÷ this.';
COMMENT ON COLUMN purchase_orders.action_items IS 'DEPRECATED 2026-10-17: no longer written; action items live on po_line_items. Dropped in a later cleanup migration.';
