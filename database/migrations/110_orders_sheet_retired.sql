-- Orders-sheet retirement commit 3 (2026-11-13, docs/claude_spec-patch-orders-sheet-retirement.md): Sync POs and the
-- Col P matcher signal are gone. The Col P table (migration 071) was replaced from the sheet on every Sync POs run and
-- read only by shipment sync A; a line it once placed resolves through its recorded link (shipment_unmatched with
-- match_reason col_p, or velocity_order_links). The settings key google_sheet_id was never read by code (the env var
-- GOOGLE_SHEET_ID is; it stays, unreferenced — D8).
DROP TABLE IF EXISTS po_sheet_fba_shipments;
DELETE FROM settings WHERE key = 'google_sheet_id';
