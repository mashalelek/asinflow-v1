# Finances API patch — acceptance results (2026-11-20)

Built in one session: commits `7ba2f2d` (commit 0 probe) → `48c7589`, 14
commits, migrations 122–124, not pushed. Gate on every commit:
`npm run check` 4 baseline TS1252 / 0 introduced, `npm run check:tests` 4
baseline / 0 introduced, `npm test` 2,740 / 2,740 (266 files) at the last
commit. Every figure below is from the **local** database after
`npm run backfill:finances -- --from 2026-07-20` (the Finances pull, the
orders report, the three reports) and a direct `rebuildFinancesDaily` —
the local DB is a stale copy of production (POs entered since the copy are
missing, so COGS / Prep on recent sales differ slightly from what
production will show). Production numbers appear once the backfill below
has run after the deploy.

## Production: the backfill, ready to run after the deploy

```bash
npm run backfill:finances -- --prod            # from the earliest day Amazon still answers for (730 days; 2024-11-21 on 2026-11-21), to today
# narrower, e.g. the fixtures' months first:
npm run backfill:finances -- --prod --from 2026-07-20
```

ONE manual job (components 19 + 20 + 21): the orders report in 30-day
chunks, the Finances transactions week by week (progress "week n/N" in the
jobs dialog), then the customer returns, storage fee and removal order
reports and the `finances_daily` rebuild. Render's running server executes
it; it needs the deployed code (migrations 122–124 apply at deploy).
Idempotent — it can be re-run for any window. Expect 1–2 hours for the full
history; the report quota (`createReport`, one a minute) is the slow part.
Watch for `removals: error: … ended FATAL` on the 21 step: Amazon ends the
removal order report FATAL when a report for an overlapping range is
already being generated (seen twice locally while a probe ran beside the
job; a lone request for the same window succeeded). Since `688f359` the
error carries Amazon's reason document; a rerun of the window fixes it.

## The acceptance table, rows 1–20

| # | Where | Result |
|---|---|---|
| 1 | Dashboard, any range set | **Pass.** Every tile's SALES and PROFIT read numbers (Sales, Orders / ASIN units, Refunds "32 · $962.50", Net profit, Gross profit, Est. payout, Margin, ROI). No "—" placeholders, no "after the Finances API patch" text (the only "—" left: a profit cell of a range the backfill has not covered, with the tooltip "no Finances data for this range yet — run backfill:finances"). Screenshot `Claude outputs/finances-ui-2026-11-20/dashboard-aug-1440.png`. |
| 2 | Dashboard, custom Aug 1 – 31, 2026 | **Pass.** Sales $33,775.91 · Units 1,232 · Refunds 32 · Est. payout $21,003.36 ($2.69 from $21,000.67). |
| 3 | "More" on that tile | **Pass.** The panel from the mockup (its stylesheet verbatim, `client/src/components/finances-breakdown.css`): same line names and order as SB; Refund cost, Amazon fees, Cost of goods collapse and expand on the chevron. Side by side: `dashboard-more-1440.png` vs `mockup-1440.png`. |
| 4 | More panel, Amazon fees | **Pass.** To the cent: Inbound transportation −1,275.27, FBA inbound convenience fee −70.80, Compensated clawback −44.54, Subscription −39.99, Missing from inbound clawback −21.61, Free replacement refund items +15.74, Warehouse lost +18.09, Missing from inbound +53.01, Creturn wrong item +147.15, Warehouse damage +169.84, Reversal reimbursement +359.21. FBA per unit fulfilment fee −6,241.29 (SB −6,241.30; the one pending unit is estimated at −5.76, SB −5.77), Referral fee −4,886.99 (SB −4,886.96; the pending unit −3.90 vs −3.87). Removal −35.84 + disposal −4.79 = −40.63 vs SB −43.39 (together within $7 ✓). Storage −51.47 vs −51.42 (within $0.10 ✓). Group total −11,909.55 vs −11,912.24: **$2.69** ✓. |
| 5 | More panel, Refund cost | **Pass.** Refunded amount −962.50, Refund commission −27.21, FBA customer return per unit fee −9.28, Refunded referral fee +135.99 — all to the cent. Value of returned items +265.31 vs 260.63 (1.8 %, within 5 % ✓; the 4.68 is the Settings prep 1.20 on 22 sellable units against SB's per-PO prep). |
| 6 | More panel, Cost of goods | **Pass with two notes.** COGS −16,210.44: the −16,198.54 of the acceptance row plus 11.90 for the pending unit (SB counts its sale; AF counts its COGS too — within $10 only without it). Prep its own line, −1,376.00. Disposal of sellable products −10.66 ✓. Lost/damaged by Amazon −195.03 vs −189.18: outside $2 by the Settings prep (1.20 on every Velocity unit lost or found, where SB's per-PO prep was 1.00 or 0) — the accepted difference 1, applied to this line. |
| 7 | More panel, bottom block | **Pass.** Gross profit = Net profit ($3,476.54), Estimated payout $21,003.36 = Sales + Refund cost without Value of returned items (−863.00) + Amazon fees; Refund rate 2.60 %, Sellable returns 68.75 % (SB 68.75 %), Margin 10.29 %, ROI 19.54 %. No deposits line. |
| 8 | ASINs page, Oct 19 – Nov 17, B0756KB8N1, Actual Profit cell | **Pass on every Finances line; two lines differ by decision / local data.** Sales $2,330.82 ✓ · Units 26 ✓ · Refunds 1 ✓ · Refund cost −$79.19 ✓ · Referral fee −$349.64 (±0.01 ✓) · FBA fee −$293.02 ✓ · both clawbacks −$22.55 ✓. **FBA storage fee −23.30, not −10.33:** SB's −10.33 is amortized (13/31 of October's 23.30); Maria's decision is not amortized, so the whole November 7 posting shows (commit 0 (c), `docs/finances-probe-commit0.md`). **Inbound transportation −107.49 (probe −95.73, SB −95.66):** the weight split is right; the local DB lacks the ASIN rows (weights) of a few SKUs in the November shipments, so B0756KB8N1's share is larger here; production has them. COGS −1,056.90 (local: the 11-01 POs at 45.43 are not in the local copy; production gives −1,066.46). Estimated payout $1,433.08 (±6 of 1,457.89 ✗ — the storage and inbound lines above, 24.81 together). Screenshot `asin-panel-1440.png`, `asins-row-1440.png`. |
| 9 | ASIN panel vs account panel | **Pass.** Subscription is on no ASIN row (`finances_daily` has 0 ASIN rows for it). Every other line's ASIN rows + account-only part = the account line by construction (one `fin_out` per rebuild; the real-schema test asserts it for storage: −49.75 + −0.47 + −1.25 = −51.47). |
| 10 | ASINs table, Repricer, ASIN Analytics, CSV | **Pass.** One accessor (`readAsinActuals` → `actuals.fin` on every row; `getActualProfit` reads it; `getRowValue` feeds render, sort, filter and the CSV). The Repricer takes its effective range as the Actuals range. The table's Actual Profit cell for B0756KB8N1 reads $428.68 = the panel's Net profit $428.68 (`asins-row-1440.png`). |
| 11 | Prep, a Velocity PO unit | **Pass.** Prep = Settings `prep_cost` (1.20 after migration 122) per unit; `finances-aggregate.db.test.ts`: 2 Velocity units → −2.40. |
| 12 | Prep, a Home PO unit | **Pass.** $0.00 (same test: the Aug 20 unit on the Home PO takes none). |
| 13 | Prep, hazmat ASIN on a Velocity PO | **Pass.** Settings prep + hazmat prep surcharge (1.20 + 1.00): the test's hazmat ASIN, 3 units → −6.60. |
| 14 | Settings, change prep to $1.30, another browser | **Pass by construction.** `PUT /api/settings/profit` writes the `settings` row; every page loads it once (`useProfitSettings`) and the dialog re-reads it on open; the aggregate stores prep UNITS and applies the current value at read, so every Prep line and profit follows the change without a rebuild, in every browser. Not clicked through in two browsers here (one headless session). |
| 15 | Recent days | **Pass.** Sales and Units include pending orders (the August pending unit at 25.96); fee lines carry Amazon's own fee for DEFERRED rows and the same ASIN's last posted per-unit fee for units with no row; the hover reads "includes $5.76 estimated for 1 pending unit" on the August FBA line, nothing else marks it. |
| 16 | The same range weeks later | **Pass by construction, tested.** A RELEASED row supersedes its DEFERRED twin (same key; `finances.db.test.ts`: Σ fee stays −4.35 after the release, not −8.70); the estimated part and its hover go to 0 when every unit has a posted row. |
| 17 | Cancellations | **Pass by construction, tested.** Component 19 re-reads 30 days; a line Amazon reports Cancelled (order or item status) is stored as Cancelled and leaves Sales / Units / Orders on its day (`sales-sync.test.ts`). |
| 18 | Refunds posted today | **Pass.** By posted Pacific day on the Dashboard and the ASIN (the hourly Finances window is the trailing 3 days). |
| 19 | History from Nov 19, 2024 | **Pass by construction.** `retentionStart` clamps the backfill to Amazon's 730 days; a range starting before the first `finances_daily` day shows "data from <date>" on the profit cells (`dataFrom`). Real numbers appear after the production backfill. |
| 20 | Hourly pass, jobs dialog | **Pass.** Components 19–21 ledger real counts (job 61 / 70 locally: `20_refunds … transactions_read=11415 transactions_stored=6616`, `21_actual_fees … daily_rows=27852`). Hourly cost: one Finances page (3 days), a 30-day orders report, a 60-day rebuild (≈ 0.7 s locally for 4 months). |

## August 2026 beside the fixture

| Line | SB (fixture 3) | AF (local) | Δ |
|---|---:|---:|---:|
| Sales | 33,775.91 | 33,775.91 | 0.00 |
| Units | 1,232 | 1,232 | 0 |
| Orders | — (mockup 1,067) | 1,067 | |
| Refunds | 33 | 32 | −1 (accepted) |
| Refunded amount | −962.50 | −962.50 | 0.00 |
| Refund commission | −27.21 | −27.21 | 0.00 |
| FBA customer return per unit fee | −9.28 | −9.28 | 0.00 |
| Refunded referral fee | +135.99 | +135.99 | 0.00 |
| Value of returned items | +260.63 | +265.31 | +4.68 (prep) |
| FBA per unit fulfilment fee | −6,241.30 | −6,241.29 | +0.01 |
| Referral fee | −4,886.96 | −4,886.99 | −0.03 |
| Inbound transportation | −1,275.27 | −1,275.27 | 0.00 |
| FBA inbound convenience fee | −70.80 | −70.80 | 0.00 |
| FBA storage fee | −51.42 | −51.47 | −0.05 |
| Compensated clawback | −44.54 | −44.54 | 0.00 |
| FBA removal fee | −42.55 | −35.84 | +6.71 (posting day) |
| Subscription | −39.99 | −39.99 | 0.00 |
| Missing from inbound clawback | −21.61 | −21.61 | 0.00 |
| FBA disposal fee | −0.84 | −4.79 | −3.95 (posting day) |
| Reimbursements (6 lines) | +763.04 | +763.04 | 0.00 |
| Amazon fees total | −11,912.24 | −11,909.55 | +2.69 |
| COGS | (in 17,319.08) | −16,210.44 | |
| Prep | (in 17,319.08) | −1,376.00 | Settings rule: 1,232 units; Velocity non-hazmat × 1.20, Velocity hazmat × (1.20 + 0 hazmat prep surcharge + 1.00 hazmat shipping surcharge) = 2.20, Home × 0. Re-read 2026-11-20 after Maria's settings landed (migration 122 amended): unchanged, the hazmat unit was 2.20 under both seeds |
| Disposal of sellable products | −10.66 | −10.66 | 0.00 |
| Lost/damaged by Amazon | −189.18 | −195.03 | −5.85 (prep) |
| Estimated payout | 21,000.67 | 21,003.36 | +2.69 |

## B0756KB8N1, Oct 19 – Nov 17 beside the fixture

| Line | SB (fixture 2) | AF (local) | Δ |
|---|---:|---:|---:|
| Sales | 2,330.82 | 2,330.82 | 0.00 |
| Units | 26 | 26 | 0 |
| Refunds | 1 | 1 | 0 |
| Refund cost | −79.19 | −79.19 | 0.00 |
| Referral fee | −349.63 | −349.64 | −0.01 |
| FBA per unit fulfilment fee | −293.02 | −293.02 | 0.00 |
| Inbound transportation | −95.66 | −107.49 | −11.83 (local weights) |
| Compensated clawback | −22.55 | −22.55 | 0.00 |
| Missing from inbound clawback | −22.55 | −22.55 | 0.00 |
| FBA storage fee | −10.33 (amortized) | −23.30 | by decision |
| COGS | (1,104.46 incl. prep) | −1,056.90 (local POs) | |
| Prep | | −31.20 | |
| Lost/damaged by Amazon | +88.58 | +83.70 | local POs |
| Estimated payout | 1,546.47 (product page) / 1,457.89 (cash) | 1,433.08 | storage + inbound |

## Browser check

Headless Chrome over CDP, a throwaway `zz-browser@example.com` admin
(deleted afterwards; `users` back to 0 `zz-` rows), 1440 × 1000 and
1280 × 1000: `document.documentElement.scrollWidth === clientWidth` on the
Dashboard with the Custom Aug 1 – 31 tile, with the More panel open, on the
ASINs page with the B0756KB8N1 row, and with the ASIN panel open (all
eight screenshots under `Claude outputs/finances-ui-2026-11-20/`). Things a
user would notice: the panel is taller than a 1000 px viewport and scrolls
inside its dimmed overlay (the mockup draws it unbounded); the ASIN panel's
title wraps to two lines for a long product name; the line "Other Amazon
fees on orders" appears only when a shipment carried a fee type outside
Commission / FBA / VCF (none in August). The quantity label stays "Orders /
ASIN units" where the mockup wrote "Orders / Units" (the quantity-names rule
wins, as on the claims pages).

## Settings: before and after (migration 122 amended with Maria's values, 2026-11-20)

The display options (price source, show gated / meltable / parked / dead)
are per-browser toggles in localStorage (`fba-price-source`, the view
toggles on each page), not settings rows — left where they are. Acceptance
row 13's rule is now prep + the DG/Hazmat prep surcharge + the DG/Hazmat
shipping surcharge (1.20 + 0 + 1.00); rows 11–12 unchanged.

| Key | Local before (first seed) | Production today (`--prod`, read-only) | After migration 122 (local now; production at deploy) |
|---|---:|---:|---:|
| prep_cost | 1.2 | 1 | 1.2 |
| additional_fees | 0 | 0 | 0 |
| low_inventory_surcharge | 0.26 | 0.26 | 0.26 |
| hazmat_ship_surcharge | 0 | 0 | 1 |
| hazmat_prep_surcharge | 1 (wrong seed) | 0 | 0 |
| inbound_shipping_per_lb | 0.50 | 0.5 | 0.8 |
| include_inbound_shipping | true | true | true |
| min_margin | 10 | 10 | 12 |
| min_roi | 15 | 15 | 18 |
| min_profit_unit | 3 | (no row) | 2 |
| max_cogs_min_margin_pct | 12 | (no row) | 12 |
| max_cogs_min_roi_pct | 20 | (no row) | 18 |
| max_cogs_min_profit_unit | 3 | (no row) | 2 |

## Production results

Deployed 2026-11-20 22:33 UTC (`730356e`, migrations 122–124 at boot); the
history backfill `npm run backfill:finances -- --prod` ran as job #784
(22:36 → 01:08 UTC): 19 — 25 orders-report chunks, 34,900 order lines,
none failed; 20 — 105 weekly Finances windows, 77,148 transactions read,
41,749 stored; 21 — customer returns 13 chunks / 1,173 rows, `finances_daily`
161,524 rows. Two report steps did not finish in that job: the removal
order report ended FATAL on its second chunk (Amazon refuses an overlapping
request) and the storage fee report hit `createReport` QuotaExceeded when
25 months were asked at once. Fixed and redeployed (`3fc717e` → `dd514fd`:
a failed chunk is recorded and the rest still run; the storage report is
asked two newest + three missing months per pass; `postedBefore` 5 min
behind now — the first hourly pull after the deploy had answered 400 at
now − 60 s). The reports rerun `npm run backfill:finances -- --prod --from
2025-01-20 --reports-only` is job #790 (started 02:19 UTC): returns 12/12
chunks done; removals move at that report type's own quota, about one
chunk an hour — the storage months and the rebuild follow it. The two
lines that depend on it are marked **pending** below and get filled in when
it ends. Figures read from production with `readBreakdown` (read-only).

### Row 2 and rows 4–7 — Aug 1 – 31, 2026, the account (production)

| Line | SB | Production | Δ | Cause |
|---|---:|---:|---:|---|
| Sales | 33,775.91 | 33,775.91 | 0.00 | |
| Units | 1,232 | 1,232 | 0 | |
| Refunds | 33 | 32 | −1 | accepted: SB counts a two-item refund twice; the money matches |
| Refunded amount | −962.50 | −962.50 | 0.00 | |
| Refund commission | −27.21 | −27.21 | 0.00 | |
| FBA customer return per unit fee | −9.28 | −9.28 | 0.00 | |
| Refunded referral fee | +135.99 | +135.99 | 0.00 | |
| Value of returned items | +260.63 | +265.31 | +4.68 | 22 sellable units × the Settings prep 1.20 where SB had the per-PO prep (accepted difference 1) |
| FBA per unit fulfilment fee | −6,241.30 | −6,241.29 | +0.01 | the one still-pending unit estimated at −5.76 (SB −5.77) |
| Referral fee | −4,886.96 | −4,886.99 | −0.03 | the same unit at −3.90 (SB −3.87) |
| Inbound transportation | −1,275.27 | −1,275.27 | 0.00 | |
| FBA inbound convenience fee | −70.80 | −70.80 | 0.00 | |
| FBA storage fee | −51.42 | −51.47 | −0.05 | SB rounds the storage report; AF books the Finances row (accepted) |
| Compensated clawback | −44.54 | −44.54 | 0.00 | |
| FBA removal fee | −42.55 | −35.84 | +6.71 | posting day vs SB's removal-order day (accepted); with disposal below, together +2.76 |
| Subscription | −39.99 | −39.99 | 0.00 | |
| Missing from inbound clawback | −21.61 | −21.61 | 0.00 | |
| FBA disposal fee | −0.84 | −4.79 | −3.95 | the 08-16 disposal of a returned unit, which SB lists under removal (accepted) |
| Free replacement refund items | +15.74 | +15.74 | 0.00 | |
| Warehouse lost | +18.09 | +18.09 | 0.00 | |
| Missing from inbound | +53.01 | +53.01 | 0.00 | |
| Creturn wrong item | +147.15 | +147.15 | 0.00 | |
| Warehouse damage | +169.84 | +169.84 | 0.00 | |
| Reversal reimbursement | +359.21 | +359.21 | 0.00 | |
| **Amazon fees total** | **−11,912.24** | **−11,909.55** | **+2.69** | removal / disposal dating +2.76, storage rounding −0.05, the pending unit −0.02 — within row 4's $3 |
| COGS | (in −17,319.08) | −16,210.44 | | row 6's −16,198.54 + 11.90 for the pending unit's COGS (its sale is counted); 1,231 of 1,232 units have a PO cost |
| Prep | (in −17,319.08) | −1,376.00 | | the Settings rule (Velocity units × 1.20, hazmat × 2.20, Home × 0); SB's single line carries 1,115.50 of per-PO prep |
| Disposal of sellable products | −10.66 | **pending** | | the removal order detail report for Aug 2026 is a later chunk of job #790; locally (same rule, same report) it was −10.66 |
| Lost/damaged by Amazon | −189.18 | −195.03 | −5.85 | 29 lost − 11 found units at the Settings prep 1.20 instead of SB's per-PO prep (accepted difference 1; −189.53 with the PO prep in the probe) |
| Gross profit = Net profit | 3,742.38 | 3,487.20 | −255.18 | = the Prep difference (−260.50) + the returned-items / lost-damaged prep effects (−1.17) + fees +2.69 + the pending unit's COGS −11.90; moves by +10.66 when the disposal line lands |
| Estimated payout | 21,000.67 | 21,003.36 | +2.69 | the fee Δ; within row 2's $3 |
| Refund rate / Sellable returns | 2.68 % / 68.75 % | 2.60 % / 68.75 % | | 32 vs 33 refunds; the returns report agrees with SB on sellable units |

### Row 8 — B0756KB8N1, Oct 19 – Nov 17, 2026 (production)

| Line | SB (fixture 2) | Production | Δ | Cause |
|---|---:|---:|---:|---|
| Sales | 2,330.82 | 2,330.82 | 0.00 | |
| Units | 26 | 26 | 0 | |
| Refunds | 1 | 1 | 0 | |
| Refund cost | −79.19 | −79.19 | 0.00 | −89.99 / −2.70 / +13.50 |
| Referral fee | −349.63 | −349.64 | −0.01 | within row 8's ±0.01 |
| FBA per unit fulfilment fee | −293.02 | −293.02 | 0.00 | 3 units still on DEFERRED rows (hover: "includes $33.81 estimated for 3 pending units") |
| Inbound transportation | −95.66 | −95.73 | −0.07 | the weight split over the shipments' contents (commit 0 (d)); within $5 |
| Compensated clawback | −22.55 | −22.55 | 0.00 | |
| Missing from inbound clawback | −22.55 | −22.55 | 0.00 | |
| FBA storage fee | −10.33 | **pending** (will read −23.30) | | the storage fee report (October) is pulled by job #790 / the next nightly passes; by decision not amortized, the whole November 7 posting shows — SB's −10.33 is 13/31 of it (row 8's ±$1 cannot hold under that decision) |
| COGS | (in −1,104.46) | −1,066.46 | | = the acceptance figure exactly (cost period: 40.65 → 45.43 on 11-01) |
| Prep | | −31.20 | | 26 Velocity units × 1.20 |
| Lost/damaged by Amazon | +88.58 | +88.48 | −0.10 | two found units at 40.65 + 1.20 and 45.43 + 1.20 (SB's per-PO prep 1.50 / 1.00) |
| Estimated payout | 1,457.89 (cash) | 1,468.14 | +10.25 | reads 1,444.84 once the storage line lands (−23.30 vs SB's −10.33: −12.97 by decision, inbound −0.07) — outside row 8's ±6 by the storage decision alone |
| Net profit | 448.71 (mockup, prep 1.20) | 458.96 | +10.25 | the same storage line |

### The first 00:00 ET pass after the deploy

Hourly passes since the fix (jobs #791 at 02:04 UTC and #792 at 03:04 UTC)
ran 19 (30-day window, 2 chunks, 0 failed), 20 (1 call, ~420 transactions
read, 3–5 deferred rows superseded) and 21 (16k-row rebuild) with no error.
The 00:00 ET pass (05:04 UTC on 2026-11-21) with the three reports: **pending**
— filled in below when it has run.

## Open items for Maria

1. **Storage per ASIN** (acceptance row 8): −23.30 by the not-amortized
   decision vs SB's −10.33. If the amortized number is wanted on the ASIN,
   that is a later setting (spread the month's report over its days).
2. **Lost/damaged and Value of returned items** carry the Settings prep
   (1.20) per unit, so they sit a few dollars from SB's per-PO-prep figures.
3. **The pending unit's COGS**: AF counts COGS for a pending unit it counts
   as a sale (August: +11.90); say if it should wait for the shipment.
4. **Removal order report FATAL** when two requests overlap; the nightly
   pass makes one — watch the first production 00:00 pass.
