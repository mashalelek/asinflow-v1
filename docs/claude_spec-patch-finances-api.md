# SPEC Patch — Finances API (Actuals that match SellerBoard)

*Drafted 2026-11-20 with Maria. Status: APPROVED 2026-11-20, in
implementation (Claude Code).
Answer keys: `docs/claude_finances-sb-fixture.md`. Look:
`docs/mockups/finances-breakdown-2026-11-19.html` (approved). Test:
`docs/claude_finances-acceptance-2026-11-20.md` (approved). Research:
`docs/finances-probe-2026-11-18.md`. Folds into SPEC §1, §6, §11, §13, §23
and the scheduler component table (19–21).*

## Goal

AF's Actual numbers come from Amazon's own money records and match
SellerBoard closely enough that Maria can cancel SellerBoard. Every Actual
figure in AF (Dashboard, ASIN tables, exports) reads the same stored facts.

## 1. The model (SellerBoard's, line for line)

```
Sales            product principal net of promotion, tax excluded
Units            units ordered (pending included, cancelled excluded)
Refunds          number of refunds
Promo            shown, $0.00 (promotions are netted into Sales)
Advertising cost shown, $0.00 until AF has an ads source

Refund cost      = Refunded amount + Refund commission
                 + FBA customer return per unit fee + restocking deduction
                 + variable closing fee returned + Refunded referral fee
                 + Value of returned items
Amazon fees      = every fee line and every reimbursement / clawback line
Cost of goods    = COGS + Prep + Disposal of sellable products
                 + Lost/damaged by Amazon

Gross profit     = Sales + Promo + Advertising cost + Refund cost
                 + Amazon fees + Cost of goods
Net profit       = Gross profit − Indirect expenses (shown, $0.00)
Estimated payout = Sales + Refund cost without Value of returned items
                 + Amazon fees                     (cash only, every surface)
Margin           = Net profit ÷ Sales
ROI              = Net profit ÷ |Cost of goods|
Refund rate      = Refunds ÷ Units
Sellable returns = share of returned units that came back sellable
```

Line names, order and grouping are the fixture's. A line that is $0.00 for
the range is not listed inside a group. Shipping charged, shipping discount
and shipping chargeback net to zero and stay out of Sales; tax is never
shown.

## 2. Where each line comes from

**Source:** Finances API v2024-06-19 `listTransactions`. Rate-limit bucket
0.5 rps added to `server/spapi-rate-limit.ts`. `DEFERRED_RELEASED` rows are
ignored on ingest. v0 is not used.

| Lines | Source | Day it counts on | ASIN |
|---|---|---|---|
| Sales, Units, Orders | the order's own Finances row (principal − promotion) when one exists, RELEASED or DEFERRED; otherwise its orders-report line. Never a day average | order's Pacific purchase day | on the row |
| FBA per unit fulfilment fee, Referral fee, Variable Closing Fee (on shipments) | see §3 | order's Pacific purchase day | on the row |
| Refunded amount (principal + shipping + promo / goodwill lines), Refund commission, Refunded referral fee, restocking, VCF returned; Refunds count | Refund transactions | posted Pacific day | on the row |
| FBA customer return per unit fee, Inbound transportation, FBA inbound convenience fee, FBA storage fee, FBA removal fee, FBA disposal fee, long-term storage, Subscription | ServiceFee transactions | posted Pacific day, as Amazon labels them, not amortized | §4 |
| Warehouse lost, Warehouse damage, Missing from inbound, Removal order lost, Creturn wrong item, Free replacement refund items, Reversal reimbursement, Compensated clawback, Missing from inbound clawback | FBAInventoryReimbursement transactions, one line per reason (cash) | posted Pacific day | on the row |
| Lost/damaged by Amazon | same rows, valued not cash: WAREHOUSE_LOST, WAREHOUSE_DAMAGE, MISSING_FROM_INBOUND = −units × (COGS + Prep); COMPENSATED_CLAWBACK, MISSING_FROM_INBOUND_CLAWBACK = +units × (COGS + Prep); cost period of the posted day (§5). Other reasons: nothing | posted Pacific day | on the row |
| Value of returned items; Sellable returns | FBA customer returns report: units returned sellable × (COGS + Prep) at the cost period of the return day | return day (commit 0 confirms against the fixtures) | on the row |
| Disposal of sellable products | removal order detail report: sellable units disposed × (COGS + Prep) | commit 0 confirms | on the row |
| COGS, Prep | §5 | the sale's day | — |
| Disbursements (Transfer rows) | stored with settlement id and date; shown nowhere in this patch | — | — |

A reason or fee type AF has not seen before is stored and shown under its
Amazon name in the group it belongs to (fee → Amazon fees); it is never
dropped.

## 3. Orders Amazon has not settled

One fee row per (order id, shipment id, SKU), with a `source`:

1. **posted** — the RELEASED row's fee lines.
2. **deferred** — the DEFERRED row's own fee lines (Amazon's numbers).
3. **estimated** — no row yet: the same ASIN's most recent posted per-unit
   FBA fee and commission rate × the order's price; AF's fee estimate if
   the ASIN has no posted history.

A later state replaces the earlier one for the same key; nothing is added
twice. `transactionId` is never the key. The same key rule (order id,
refund id, SKU) applies to refunds.

**Cancellations:** an order Amazon reports as Canceled leaves Sales, Units
and Orders on its day, whenever the cancellation happens. Sales sync
re-reads a trailing window long enough for that (30 days or more) or checks
order status; a 48-hour window is not enough.

## 4. Account-level lines on the ASIN

| Line | On the ASIN panel |
|---|---|
| Inbound transportation | each fee row names an FBA shipment; split over that shipment's contents (`sc_inbound_shipments` / `sc_inbound_items`). Weighting (units, weight or volume) = whichever reproduces −95.66 for B0756KB8N1, Oct 19 – Nov 17, 2026; fixed in commit 0 |
| FBA storage fee | per-ASIN amounts from the monthly storage fee report, counted on the day the Finances storage row posts. The account line stays the Finances row |
| Reimbursements, clawbacks, FBA customer return fee where an order links it | the row's own ASIN |
| Inbound convenience, removal, disposal, long-term storage | on the ASIN when the row or its shipment / removal order identifies one; otherwise account only |
| Subscription | account only |

Σ of a line over all ASIN panels + the account-only part = the account
panel's line.

## 5. COGS and Prep

- **COGS by cost period.** A unit's COGS is the cost on the PO in force on
  its day: the newest non-canceled, non-components-only `po_asins` row with
  `order_date` ≤ that day (then entry sequence). A sale before the ASIN's
  first PO uses the first PO. No PO at all: COGS 0 and the existing "no PO
  cost" marker. Historical PO costs are not changed.
- **Prep is its own line**, never inside COGS:
  - PO in force ships to Home → $0.00.
  - PO in force ships to Velocity → Settings prep; hazmat ASIN → Settings
    prep + the DG/Hazmat prep surcharge + the DG/Hazmat shipping surcharge
    (per unit; 1.20 + 0 + 1.00 on 2026-11-20 — Maria's values, which
    migration 122 seeds; the Settings dialog changes them).
  - Computed when viewed from the current Settings values; `po_asins.prep_cost`
    is not read by Actuals.
- **Settings live in the database.** Prep, hazmat surcharge and every other
  value the profit math uses are read from `GET /api/settings` and saved
  through it; the browser's localStorage copy is removed as a source. A
  value Maria saves shows in every browser.
- Later, not this patch: a PO's prep billed by Velocity overrides the
  Settings value for that PO.

## 6. What Maria sees

Per the approved mockup (its stylesheet is the spec for the look).

- **Dashboard tile.** SALES: Sales, Orders / Units, Refunds (count · $
  refunded). PROFIT: Net profit (main), Gross profit, Est. payout, Margin,
  ROI, and a **More** link. The "after the Finances API patch" text and
  the "—" placeholders are gone.
- **More panel** (account, that tile's range): the full breakdown of §1.
  Refund cost, Amazon fees and Cost of goods collapse and expand.
- **ASIN panel:** clicking an ASIN's Actual Profit cell opens the same panel
  for that ASIN and the page's date range, in every table that has the
  Actual columns.
- **Actual columns** — every table that shows them: the ASINs table, the
  Repricer table, ASIN Analytics, Export CSV. Refunds, Refund %, Profit,
  Profit / unit, ROI, Margin come from these facts; the table's Actual
  Profit equals the panel's Net profit. Avg sale price, Revenue and Units
  Sold use §2's Sales and Units. The Repricer's Actual columns show $0
  today because its route reads units only; it gets the same Actuals data
  as the ASINs table, for its own range. One accessor feeds every table.
- **Estimates:** hover on a fee line shows "includes $X estimated for N
  pending units" when the range has deferred or estimated fee rows.
  Nothing else on screen marks it.
- **History:** from 2024-11-19. A range that starts earlier shows the
  existing "data from <date>" marker on the profit cells.

## 7. Jobs

- Components 19–21 run for real: 19 Sales (with the trailing re-read), 20
  Refunds, 21 Actual fees and every other Finances line. One Finances
  pull serves 20 and 21. The hourly pass re-reads a short posted window;
  the 00:00 pass re-reads far enough back to catch late postings and
  releases (60 days or more) and pulls the three reports (customer returns,
  storage fees, removal order detail). The hourly pass is not noticeably
  longer than today.
- **Backfill** `npm run backfill:finances` (local, then `--prod`), chunked
  by week with ledger rows, from the earliest date Amazon accepts
  (2024-11-19 at drafting; the horizon moves a day per day, so it runs as
  soon as the ingest is deployed). Idempotent.
- Fail-closed per chunk (§14): a window's stored facts are replaced only
  after the chunk was fully read and parsed.

## 8. Data

Code designs the tables; requirements:

- Every Finances line is stored at its finest grain (transaction, item,
  breakdown line) with order / shipment / refund / settlement ids, SKU,
  ASIN, quantity, posted time, status, and the natural keys of §3.
- Range reads for the Dashboard and the ASIN tables come from a per-day,
  per-ASIN, per-line aggregate, so a tile or a table page stays as fast as
  today.
- `sales_daily.units_refunded` / `refund_amount` are filled or replaced by
  the aggregate; the three never-read `actual_*_fees` columns are dropped.
- Report rows (returns, storage, removals) are stored as received.

## 9. Accepted differences from SellerBoard

As listed in the acceptance file: COGS / Prep split with Settings prep;
removal and disposal fees on Amazon's posting day; storage not amortized;
fee estimates on orders with no Amazon row yet; cash-only Estimated payout
on the ASIN; refund count can differ by one.

## 10. Commits

0. **Probe, read-only, report before code** (`docs/finances-probe-commit0.md`):
   (a) customer returns report → rule that reproduces Value of returned
   items 260.63 / Sellable returns 68.75 % (Aug) and 956.31 / 77.33 %
   (Oct 19 – Nov 17); (b) removal order detail report → Disposal of
   sellable products −10.66 (Aug); (c) storage fee report → per-ASIN
   storage, B0756KB8N1; (d) inbound transportation weighting → −95.66;
   (e) where prep and hazmat surcharge settings live today (DB key vs
   localStorage) and the migration for them. Stop only if a fixture line
   cannot be reproduced within the acceptance tolerance.
1. Settings from the database everywhere (§5); acceptance rows 11–14 as far
   as today's math allows.
2. Tables, Finances client + bucket, ingest with the §3 keys, tests on
   recorded fixtures (deferred → released replacement, no double count).
3. Sales sync: per-order sales from Finances rows, trailing re-read /
   cancellations.
4. Reports ingest (returns, storage, removals) and the §4 allocations.
5. COGS by cost period + Prep rule; aggregates.
6. Components 19–21, 00:00 additions, `backfill:finances`.
7. API + Dashboard tile + More panel (mockup, side-by-side screenshot).
8. ASIN panel + Actual columns on the ASINs table and the Repricer table +
   Export CSV + ASIN Analytics.
9. SPEC: §1 caveat and §13 "Actual P&L is broken" removed and replaced by
   this model; §6, §11, §23, component table.

Gate per CLAUDE.md on every commit. The report fills in the acceptance
table's Result column, rows 1–20, with August and B0756KB8N1 figures beside
the fixture's.
