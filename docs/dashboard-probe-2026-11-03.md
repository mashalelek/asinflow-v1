# Dashboard — commit 0 probe report (2026-11-03)

Patch: `docs/claude_spec-patch-analytics-dashboard.md` §3 commit 0. Read-only against **production** (`--prod`): nothing was written to the DB or the sheet. Scratch script in the session scratchpad; not in the repo.

## P1 — the one finding that touches the patch's text: `order_total` already nets the refund on most sheet-imported POs

§2.3 defines Spend per PO as `order_total − Σ po_line_refunds.amount`. On a sheet-imported PO `order_total` is col AG verbatim, and D3 says AG is *supposed* to be net of the refund (AG = AB + AC + AD − AE − AF) — so on every PO where the sheet did what D3 expects, the formula subtracts the refund **twice** (the 150 `po_line_refunds` rows that exist today are the col AF backfill, source `sheet`). Measured on production (item 3b): 108 POs / $13,824 would be double-counted; the 33 "AG not netted" data errors (the D3 list) would come out right by accident. Form / capture POs are unaffected: their `order_total` is the checkout total and refunds only ever arrive later as rows.

**Resolution built in commit 3 (deviation from §2.3's formula text, faithful to D3 "Spend = Order Total net of refunds"; one SQL expression, trivially changed):** a refund row is subtracted from `order_total` unless it is a sheet-backfilled row (`source = 'sheet'`) on a PO whose stored header already nets its refund — `|order_total − (subtotal + tax + sh_donations − discount − refund_amount)| ≤ $0.01` with `refund_amount > 0`. Every other row (manual, email, a due row the editor proposes, a sheet row on a gross-AG PO) is subtracted. The 10 POs that are neither net nor gross (item 3b) take the formula as written and are listed for Maria. Nothing is written; no stored value changes.

## 1. `sales_daily`

- Range: **2024-09-09 → 2026-11-03**, 23946 rows, 1492 ASINs, 40605 units, $839,082.41 revenue (UTC-day basis today).
- Last sales component run (`refresh_runs` stage 19_sales / sales): 2026-11-03T21:47:24.534Z.
- By year: 2024: 1105 rows / 2587 units / $58,524.47 · 2025: 12143 rows / 21327 units / $374,605.89 · 2026: 10698 rows / 16691 units / $405,952.05.
- Duplicate (asin_id, sale_date) pairs: 0 (the PK / upsert conflict target).
- `sales_orders` exists: no (migration in commit 2).
- `po_line_refunds.status` exists: no (migration in commit 2).

## 2. `purchase_orders`

- 2501 POs, order_date **2024-05-19 → 2026-11-02**; 187 open / 2314 closed; 0 with NULL order_total.
- By source: sheet_import: 2496 (2024-05-19 → 2026-10-23) · extension: 5 (2026-11-01 → 2026-11-02).
- By year: 2024: 124 POs / $56,264 · 2025: 1245 POs / $210,032.59 · 2026: 1132 POs / $230,638.85.
- Refunds today: 151 POs with a non-zero header `refund_amount` (Σ $19,809.51); 150 `po_line_refunds` rows on 150 POs (Σ $19,819.48), 52 of them PO-level placeholders (`po_line_item_id` NULL).

## 3. Orders sheet — AG ≠ AB + AC + AD − AE − AF on POs with a refund (D3 data errors)

Sheet read: 4136 rows. Columns used: AB "Order Subtotal", AC "Tax", AD "S&H + Donations", AE "Discount", AF "Refund Amount", AG "Order Total", AH "Order Total (no duplicates)".
2525 distinct (supplier, order #) on the sheet; 155 with a non-zero AF refund; **46 where AG ≠ AB + AC + AD − AE − AF** (tolerance $0.01) — `docs/dashboard-probe-d3-refund-errors-2026-11-03.csv`. 60 unparseable money cells among the keyed rows.
Of those, 35 are exactly "AG = AB + AC + AD − AE" (the refund not netted — the D3 case); the rest differ by another amount.

### 3b. Stored header on the 151 POs with a header refund — is `order_total` already net?

- **net**: 108 POs, Σ refund $13,823.94
- **neither**: 10 POs, Σ refund $925.8
- **gross**: 33 POs, Σ refund $5,059.77

The 108 "net" POs are the double-count P1 describes. The "neither" / NULL ones and any PO whose patch-formula Spend would be negative (63) are in `docs/dashboard-probe-header-net-or-gross-2026-11-03.csv` for Maria — the Dashboard takes them as the formula says (never corrected).

## 4. Fully-canceled POs (every line `qty_canceled ≥ qty_ordered`)

73 fully-canceled POs; **18 with order_total − Σ line refunds > $0** (Σ $7,410.82) — the rule forces them to $0 Spend; listed in `docs/dashboard-probe-fully-canceled-2026-11-03.csv`.
By year: 2024: 2 POs / $5,150.1 · 2025: 6 POs / $427.32 · 2026: 10 POs / $1,833.4.

## 5. Canceled lines with no refund row (the "no $ amount" list — informational, expected messy)

80 lines on 60 POs carry `qty_canceled > 0`; **52 have no `po_line_refunds` row on the line** (31 of them on a PO with no refund row at all, 21 on a PO that has a PO-level / other-line row) — `docs/dashboard-probe-canceled-no-refund-2026-11-03.csv`. Nothing in the patch depends on this list being clean (C1).

## 6. Header `refund_amount` ≠ Σ `po_line_refunds.amount`

**1 POs** differ (tolerance $0.005): 1 have a header refund and no line rows, 0 have rows that do not sum to the header — `docs/dashboard-probe-header-vs-line-refunds-2026-11-03.csv`. From this patch on the line rows are the money of record; the header is not read by the Dashboard.

## 7. `po_asins` rows with NULL `units_per_pack`

**3022 of 3906 rows** (1914 POs, 1305 ASINs, 37942 ASIN units) have no pack size — the Individual units cell shows "n rows missing pack size" for them, never ×1.
By year: 2024: 231 / 231 · 2025: 1991 / 1991 · 2026: 800 / 1684. By sold_as: (null): 3022 / 3022 · individual: 0 / 665 · multi-pack: 0 / 205 · bundle: 0 / 14.

## 8. Other facts

- Server clock at probe time: 2026-11-03 22:07:40.844347+00; today in America/New_York = 2026-11-03, in America/Los_Angeles = 2026-11-03.
- Last sales backfill job (components [19] with params.sales_window): #10 done, queued 2026-10-16T16:51:24.381Z, window {"to":"2026-10-16","from":"2024-05-01"}.
- 2026 POs: 1132, Σ order_total $230,638.85, net of line refunds $223,332.17 (before the fully-canceled rule).

## 9. Verdict

One finding (P1) contradicts the patch's Spend formula text on sheet-imported POs; it is resolved as stated above (a one-expression rule honouring D3) and flagged for Maria's confirmation in the final report — everything else proceeds as the patch says. Items 3–6 are review lists for Maria (nothing is auto-corrected); items 1, 2, 7 size the work.
