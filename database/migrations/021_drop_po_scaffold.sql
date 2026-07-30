-- Migration 021: drop the PO scaffold (SPEC §8, teardown 2026-07-30).
--
-- The PO module scaffold (migration 003) is removed wholesale: its API
-- (registerPoRoutes) was never mounted, the pages called a dead API, and the
-- tables held only seed/test rows (3 purchase_orders: Walmart/Target seed +
-- one bambulab test; 4 line items; 1 gift card) — confirmed disposable by
-- Maria. The real PO module will be built fresh later; nothing here is
-- load-bearing.
--
-- Drop order respects FKs: children first, then parents.

BEGIN;

DROP TABLE IF EXISTS po_gift_cards;
DROP TABLE IF EXISTS po_asins;      -- FK → po_line_items: drops before it
DROP TABLE IF EXISTS po_line_items;
DROP TABLE IF EXISTS purchase_orders;
DROP TABLE IF EXISTS gift_cards;

-- 003's asins augmentation: referenced nowhere outside the PO code
-- (prep math uses settings prep cost + asin_estimates.prep_override, §3).
ALTER TABLE asins DROP COLUMN IF EXISTS prep_cost_per_unit;

COMMIT;
