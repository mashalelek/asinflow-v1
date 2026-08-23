-- Migration 030: canceled/returned/final quantities on po_line_items
-- (SPEC §22 "Canceled / returned / final quantities"; decisions 2026-08-22).
--
-- RENAME qty_refunded → qty_returned: data preserved. The 2026 import wrote
-- blank Col R as 0, which stands — a blank refund cell means none occurred.
--
-- qty_canceled: NULLable, NO default. NULL = not tracked (all 1,158
-- sheet-imported rows stay NULL — NO backfill; the sheet recorded only
-- status tokens + ordered qty). The entry form writes explicit values
-- (its 0 default lives in the form, not the column).
--
-- final_qty: GENERATED ALWAYS, plain arithmetic, NO COALESCE — NULL
-- propagates by design. Historical rows (qty_canceled NULL) render final
-- as an em-dash ("not tracked"); app-entered rows compute real values.

BEGIN;

ALTER TABLE po_line_items RENAME COLUMN qty_refunded TO qty_returned;

ALTER TABLE po_line_items ADD COLUMN qty_canceled INTEGER;

ALTER TABLE po_line_items ADD COLUMN final_qty INTEGER
  GENERATED ALWAYS AS (qty_ordered - qty_canceled - qty_returned) STORED;

COMMIT;
