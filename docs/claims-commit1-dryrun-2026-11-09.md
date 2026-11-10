# Claims commit 1 — dry run 2026-11-09 (production)

Before: 3963 ASIN rows, 4040 lines, 1061 shipment rows, 151 refund rows (1 due), 1 defect(s); open items: Missing / damaged from supplier open PO ×12, Missing / damaged from supplier closed PO ×48, Confirm refund / replacement open PO ×24; sheet losses 143 rows $7059.23
Velocity plan 2026-01-01..2026-11-09: fetching Velocity (read-only) for the BEFORE plan…
Migration 101 applied inside the transaction in 2982 ms (rolled back at the end).
Fetching Velocity again for the AFTER plan…
D17: ASIN rows 1923 converted / 2040 left in ASIN units (0 with a known pack but a value that does not convert); lines 3564 converted / 476 left in Product units (0 with a known pack); basis after: asin rows asin_legacy 2040, asin rows individual 1923, lines individual 3564, lines product_legacy 476; 142 bundle values listed separately.
Proof: On Order per ASIN — 1704 ASINs, 0 difference(s); auto-close verdict per PO — 2543 POs (424 would be closed before, 429 after), 5 difference(s); the plan's input rows — 4040 before / 4040 after, 0 difference(s); Velocity plan — before: 12 create, 0 bundle create, 2 update, 85 unchanged, 773 closed, 3 skip, 9 home; after: 12 / 0 / 2 / 85 / 773 / 3 / 9; 0 difference(s) over 26 keys.
  Δ 44506497-9a12-4674-9124-d24d9fedf451 verdict: false → true
  Δ 7867d2e1-c78b-442c-8584-ccf11d3dbb07 verdict: false → true
  Δ 7e6969d5-8f22-4322-9a94-2918e43e5dc3 verdict: false → true
  Δ d5a51a12-f459-44d9-9eb3-cd8fe8d0daf0 verdict: false → true
  Δ f54167e9-d3c0-4610-b6c6-e7792042f195 verdict: false → true
Conversions: 383 claim(s) — confirm_refund_item: 24 (24 open, $287.42 owed); defect: 1 (1 open, $5.97 owed); missing_damaged_item: 59 (11 open, $0 owed); qty_canceled: 112 (8 open, $8585.46 owed); qty_returned: 44 (0 open, $5050.83 owed); sheet_loss: 142 (0 open, $7026.98 owed); sheet_loss_added: 1 (0 open, $8.55 owed); kind unclear on 225, qty assumed = ordered on 75, legacy units on 113.
Needs attention on day one: 43 open claim(s) with an open task (32 refund_received, 11 contact_supplier).
After the migration: po_line_items.qty_canceled / qty_returned / final_qty present: 0; po_line_refunds.status present: 0; tables: po_warning_dismissals, supplier_claim_conversions, supplier_claim_events, supplier_claim_refunds, supplier_claim_tasks, supplier_claims.

## Reading the proof

- **On Order:** identical for every ASIN (1,704). **Velocity plan:** identical for every key (12 creates, 2 updates, 85 unchanged, 773 closed, 3 skips, 9 home) and for every one of the 4,040 input rows.
- **Auto-close:** 5 verdicts flip false → true, all on POs **already closed by the sheet** (auto never reopens a sheet-closed PO, so nothing changes on production): firstchoicebuying 13166 and bambulab us750452803197317121 carried a "Missing / damaged from supplier" item that blocked the old verdict and is a closed claim now (the spec's "48 on closed POs → closed claims for history"); michaels 4800110175975417, walmart 200015088519560 and target 102003592413875 carry a sheet col V / W loss that is a closed write-off claim now — the written-off units leave Expected (§3.6), so what shipped covers the rest.
- A sheet line canceled with no ordered quantity (0 / 0 — the sheet's "canceled with no ordered qty") keeps its canceled marker as a **0-unit canceled claim**, so the plan still skips it and the COGS map still ignores it (32 such lines; the first dry run showed them as "Canceled → Ordered" and two "create 0" plan rows before this fix).
- **D17 rows left in their old basis:** every one of the 2,040 ASIN rows and 476 lines has no pack size on record (`sold_as` / `retailer_units_per_product` NULL) — none is held back by a value that does not convert. The history columns (`unreimbursed_loss_qty`, `qty_lost_damaged_us`, a line's `qty_received` / canceled / returned, a refund or claim qty) keep a fraction × pack (a 0.17-pack sheet loss → 0.17); the quantities that drive On Order and auto-close (ordered, shipped by supplier, at prep, at warehouse, received by Velocity, the shipment rows) had to come out whole, and all did (2-dp thirds and sixths within 0.05 rounded: 3.33 × 3 → 10).

Files: docs/claims-d17-conversion-2026-11-09.csv, docs/claims-d17-bundle-rows-2026-11-09.csv, docs/claims-d17-unconverted-2026-11-09.csv, docs/claims-proof-2026-11-09.csv, docs/claims-conversions-2026-11-09.csv, docs/claims-needs-attention-2026-11-09.csv

ROLLED BACK — nothing written. The live run is the deploy of migration 101 (the runner applies this same file).
