# Claims commit 1 — dry run 2026-11-09 (production)

Before: 3963 ASIN rows, 4040 lines, 1061 shipment rows, 151 refund rows (1 due), 1 defect(s); open items: Missing / damaged from supplier open PO ×12, Missing / damaged from supplier closed PO ×48, Confirm refund / replacement open PO ×24; sheet losses 143 rows $7059.23
Velocity plan 2026-01-01..2026-11-09: fetching Velocity (read-only) for the BEFORE plan…
Migration 101 applied inside the transaction in 5702 ms (rolled back at the end).
Fetching Velocity again for the AFTER plan…
D17: ASIN rows 1923 converted / 2040 left in ASIN units (0 with a known pack but a value that does not convert); lines 3564 converted / 476 left in Product units (0 with a known pack); basis after: asin rows asin_legacy 2040, asin rows individual 1923, lines individual 3564, lines product_legacy 476; 142 bundle values listed separately.
D17 on OPEN POs: 6 legacy ASIN row(s) on 6 open PO(s) and 3 legacy line(s) on 2 open PO(s) — docs/claims-d17-unconverted-open-pos-2026-11-09.csv (the rest are on closed POs).
Fraction kept, example: drinkarizona.com AZT181138 B0D757SPTJ (individual × 1) — before: Ordered 30.00 ASIN units, sheet loss 0.17 ASIN units; after: Ordered 30.00 Individual units, loss 0.17 Individual units (the row converts, the loss keeps its fraction × 1).
Refunds due (POs list / Dashboard): today $5.97 (the due refund rows + open defect $ no refund row carries) → after $5.97 (Σ remaining on open claims whose outcome is unset or a refund / credit; a claim with no quantity or no $ adds nothing).
Proof: On Order per ASIN — 1704 ASINs, 0 difference(s); auto-close verdict per PO — 2543 POs (424 would be closed before, 429 after), 5 difference(s); the plan's input rows — 4040 before / 4040 after, 0 difference(s); Velocity plan — before: 12 create, 0 bundle create, 2 update, 85 unchanged, 773 closed, 3 skip, 9 home; after: 12 / 0 / 2 / 85 / 773 / 3 / 9; 0 difference(s) over 26 keys.
  Δ 44506497-9a12-4674-9124-d24d9fedf451 verdict: false → true
  Δ 7867d2e1-c78b-442c-8584-ccf11d3dbb07 verdict: false → true
  Δ 7e6969d5-8f22-4322-9a94-2918e43e5dc3 verdict: false → true
  Δ d5a51a12-f459-44d9-9eb3-cd8fe8d0daf0 verdict: false → true
  Δ f54167e9-d3c0-4610-b6c6-e7792042f195 verdict: false → true
Conversions: 383 claim(s) — confirm_refund_item: 24 (24 open, $287.42 owed); defect: 1 (1 open, $5.97 owed); missing_damaged_item: 59 (11 open, $0 owed); qty_canceled: 112 (8 open, $8585.46 owed); qty_returned: 44 (0 open, $5050.83 owed); sheet_loss: 142 (0 open, $7026.98 owed); sheet_loss_added: 1 (0 open, $8.55 owed); kind unclear on 225, quantity not known on 113 (32 sheet-zeroed lines, 75 badges awaiting Enter quantity), legacy units on 113.
Needs attention on day one: 43 open claim(s) with an open task (39 enter_quantity, 32 refund_received, 11 contact_supplier).

## Reading the proof

On Order, the Velocity plan and its input rows are identical before and after. The auto-close verdicts that flip are POs the sheet already closed (`closed_by = 'sheet'`): before, a retired badge ("Confirm refund / replacement", "Missing / damaged from supplier") or a col V / W loss kept the rule from being true; after, the badge is a claim (not an item) and the loss is a closed write-off claim that counts, so the rule becomes true — on a PO that is closed already, which changes nothing. Auto never reopens a sheet-closed PO and never re-closes one.

## How a row's basis is tracked

`po_asins.qty_basis` and `po_line_items.qty_basis` say what the stored numbers are: `individual` = Individual units (every row whose pack was known converted at the migration, and every row written by AF since); `asin_legacy` / `product_legacy` = the pack was not known, so the stored numbers are still the ASIN units / Product units they always were. A CHECK forbids `individual` on a row with no pack; a BEFORE INSERT trigger makes a pack-less insert legacy; a BEFORE UPDATE trigger converts a legacy row the moment its pack arrives (× pack, History row `qty_basis`), and clearing a pack converts it back. The views read `qty_basis` per row: a legacy row's ASIN / Product figures are its stored numbers, its Individual figures are NULL (shown as "—"), so a reader never needs to know which basis a row is in. The POs page shows such rows with the amber "pack size missing" and no Individual count.

## Why the history columns keep a fraction

The quantities that drive On Order and auto-close (ordered, shipped by supplier, at prep, at warehouse, received by Velocity, the shipment rows) had to convert to a whole number of Individual units, and all did. Three history columns can hold a fraction of a pack in the sheet's data: the col V / W loss (`unreimbursed_loss_qty`), Lost / damaged by us and a line's received / canceled / returned (now claim quantities). Holding a whole row in its old basis because its sheet loss says 0.17 of a pack would have kept Ordered, Shipped and At Prep un-converted on rows that are otherwise fine — six ASIN rows and two lines on the first dry run. So those columns convert × the pack and keep their fraction at 2 dp; the example row above shows one. They never feed Expected or auto-close.
After the migration: po_line_items.qty_canceled / qty_returned / final_qty present: 0; po_line_refunds.status present: 0; tables: po_warning_dismissals, supplier_claim_conversions, supplier_claim_events, supplier_claim_refunds, supplier_claim_tasks, supplier_claims.

Files: docs/claims-d17-conversion-2026-11-09.csv, docs/claims-d17-bundle-rows-2026-11-09.csv, docs/claims-d17-unconverted-2026-11-09.csv, docs/claims-proof-2026-11-09.csv, docs/claims-conversions-2026-11-09.csv, docs/claims-needs-attention-2026-11-09.csv

ROLLED BACK — nothing written. The live run is the deploy of migration 101 (the runner applies this same file).
