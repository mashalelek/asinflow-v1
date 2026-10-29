# SPEC Patch — Stock and Actuals on Bulk Calc (from the main database)

*Drafted 2026-10-19 with Maria. Status: PROPOSED — decisions D1–D5 open.
Folds into SPEC.md §21 ("Columns", "Isolation guarantee", "`in_database`",
"Nav"), §6 (Stock group scope), and §14 (honest labeling). Research done
against the repo at head 2026-10-19; file/line references are from that
read.*

## Why

Bulk Calc lists increasingly contain ASINs that are already in AF's
`asins` table — restock-priority CSVs, supplier re-quotes, re-uploaded
exports. For those rows the page shows only estimates, while the ASINs
page (one click away through the `in_database` icon) has the stock
position and the actual sales/profit for the same ASIN. Maria wants that
data on the Bulk Calc row itself: "pull all of our stock into this table
if an ASIN is already in our main database."

## What exists today (verified)

1. **The main → bulk push is already built** (`server/scheduler/bulk.ts`,
   decision 5 of scheduler v1, 2026-10-15). A `target: 'bulk'` job runs
   all 21 components against the main tables for the list's in-`asins`
   ASINs — including 15 Inventory and 19 Sales — then `copyMainToBulk`
   copies the refreshed row into `bulk_list_asins`. **But the copy carries
   only catalog, price, fee, BSR, seller and gating fields.** No stock, no
   sales, no `actual_cogs`, no `prep_override`, no PO pipeline. The
   inventory and sales the job just fetched land in `inventory_snapshots`
   and `sales_daily` only.
2. **The ASINs page row builder is inline** in `listAsinsHandler`
   (`server/routes.ts:1146–1470`): latest inventory snapshot
   (`LATEST_INVENTORY_SQL`, `:1050`), PO pipeline (`loadAsinPipeline`,
   `server/asin-po-pipeline.ts:98` — already a reusable function), the
   date-scoped `sales_daily` aggregate and days-in-stock (`:1229–1253`),
   then the `stock` / `fbaStock` / `actuals` objects (`:1337–1371`).
   Nothing reusable builds one row's store data.
3. **Bulk Calc renders nothing from those tables.** `BULK_COLUMN_IDS`
   (`client/src/pages/bulk-calc.tsx:39`) omits every Stock and Actuals
   column; `mapBulkRow` (`:73`) hard-codes `actualCogs: null`,
   `prepOverride: null`, and never sets `stock` / `actuals` / `fbaStock`.
   `GET /api/bulk-lists/:id` returns `SELECT * FROM bulk_list_asins`
   (`server/bulk-lists.ts:123`) with no main-DB join. `/bulk-calc` is not
   in `DATE_PICKER_ROUTES` (`top-nav.tsx:32`), so there is no date range
   to scope Actuals by.
4. `bulk_list_asins` has no stock, sales or actual-cost columns
   (`database/schema_baseline_2026-10-15.sql:314–357` + migrations). Next
   migration number is **064**.
5. The client already computes every derived Actual (avg sale price, days
   left, profit, ROI, margin) in `getRowValue`
   (`client/src/components/results-table.tsx:508–551`) from the `stock`,
   `actuals`, `actualCogs`, `prepOverride` fields of `AsinResult`. Once a
   bulk row carries those fields, the shared table renders the Stock and
   Actuals columns with no new render code.

## Design

### Rule: Stock and Actuals on Bulk Calc are READ LIVE from the main tables

For every bulk row whose ASIN is in `asins`, `GET /api/bulk-lists/:id`
attaches the same `stock`, `fbaStock`, `actuals`, `actualCogs`,
`prepOverride` and `storageOverride` the ASINs page would return for that
ASIN, built by the **same code**. Rows not in `asins` get `stock: null`,
`actuals: null`, `actualCogs: null`, `prepOverride: null`.

Why live, not copied into `bulk_list_asins` (D1 below):

- AF is the source of truth and the main tables are refreshed hourly by
  the scheduled pass. A copy taken at the last Bulk Calc Refresh is a
  freshness cache by another name — exactly what the 2026-10-13 "no
  freshness caches anywhere" decision removed. Stock on Bulk Calc must
  equal Stock on the ASINs page for the same ASIN at the same moment.
- No new columns, no migration, nothing for `copyMainToBulk` to keep in
  step as the Stock/Actuals model grows (Finances API patch adds refund
  and fee columns next).
- The isolation guarantee was always about **writes**. Reading the main
  tables to describe an ASIN that is already yours is the same category of
  access as `in_database`; it just returns more than a boolean.

The §21 isolation text changes from "the single permitted main-DB access is
one READ (`in_database`)" to: **the main tables are read, never written,
from this page.** The one user-initiated write (promote) is unchanged. The
`bulk.test.ts` source pin ("no asins / asin_estimates write statement")
still holds and stays.

### One row builder, two callers (§14 "one accessor, no duplicates")

Extract the store-data assembly out of `listAsinsHandler` into
`server/asin-store-data.ts`:

```ts
export interface StoreDataRange { startDate: string; endDate: string }
export interface StoreRow {
  stock: StockData; fbaStock: number;
  actuals: ActualsData | null;
  actualCogs: number | null; prepOverride: number | null; storageOverride: number | null;
}
export async function loadStoreData(
  query: QueryLike, asins: string[] | null /* null = every asins row */, range: StoreDataRange | null,
): Promise<Map<string, StoreRow>>
```

It runs the four queries that exist today — latest inventory
(`LATEST_INVENTORY_SQL`), `loadAsinPipeline`, the `sales_daily` aggregate,
days-in-stock — plus `actual_cogs` / `prep_override` / `storage_override`
from `asin_estimates`, and folds them per ASIN with the exact `stock` /
`fbaStock` / `actuals` logic now at `routes.ts:1337–1371`. `listAsinsHandler`
calls it and keeps everything else (deltas, SKUs, tags, estimates) inline;
`getBulkListWithRows` calls it with the list's in-`asins` ASINs. The SQL
moves, it is not copied. Behaviour on the ASINs page is byte-identical —
the `/api/asins` response shape does not change, and the §6 "stock object
always populated / `hasSnapshot`" and "FBA Stock computed once server-side"
rules now live in one place.

`latest-inventory.test.ts` pins the exact `invResult` line and six
`onlyA(n)` occurrences inside `listAsinsHandler`; those pins move to the new
module (same assertions, new file) rather than being deleted.

### `GET /api/bulk-lists/:id`

Accepts `startDate` / `endDate` (same names as `/api/asins`). Response rows
gain `store: StoreRow | null`. `in_database` is derived from `store !== null`
in the same response, so the separate `POST /api/asins/in-database` call
the page makes today becomes redundant for this page (keep the route — the
in-database filter and promote flow are untouched; the page just stops
calling it when the list response carries the flag). One request, one
read of the main tables per page load.

### Client

- `mapBulkRow` spreads `row.store` into the `AsinResult` (`stock`,
  `fbaStock`, `actuals`, `actualCogs`, `prepOverride`, `storageOverride`)
  when present. `cogs` / `estimatedCogs` keep coming from
  `bulk_list_asins.estimated_cogs` — **Estimates still use the bulk row's
  own COGS, Actuals use the main row's `actual_cogs`.** The §21 "COGS
  divergence is expected" rule is unchanged; the two columns sit side by
  side.
- `BULK_COLUMN_IDS` adds the full **Stock** group (`stock`, `availableFba`,
  `onOrder`, `atPrep`, `fbaStock`, `reserved`, `sentToFba`, `daysLeft`) and
  the full **Actuals** group (`cogs`, `actPrepCost`, `actUnitsSold`,
  `actRefunds`, `actRefundPct`, `actAvgSalePrice`, `actRevenue`,
  `actProfit`, `actProfitPerUnit`, `actRoi`, `actMargin`). Column order
  stays `COLUMN_GROUPS` order (§6).
- `/bulk-calc` joins `DATE_PICKER_ROUTES` (D2). The page reads
  `useDateRange()` and passes the range to the list fetch; Actuals are
  scoped by it exactly as on the ASINs page. `dateRangeLabel` is passed to
  `ResultsTable` so the Actuals headers show the range.
- `onStockClick` is wired for rows with `store` so the stock & sales
  history popup opens for in-database rows (D4).
- Export CSV carries the new columns under the same group-qualified
  headers as the ASINs page ("Actual COGS", "Stock", …). The "Actual"
  headers remain inert on re-upload (existing rule).

### Rows NOT in the database (D3)

A bulk-only ASIN has no account relationship, so its Stock and Actuals
are **unknown, not zero**. These cells render **`—`** (the text-column
dash), and `getRowValue` returns `null` for them so sort places them
last and numeric filters exclude them. This is a deliberate carve-out from
the §6 "numeric cells render zero, never a dash" rule, which exists so a
*confirmed* zero is filterable; "no relationship" is not a confirmed zero
and showing `0` next to a real `0` would read as "out of stock". The
in-database icon in the Product cell already tells the reader which rows
these are.

### Refresh

Unchanged. A Bulk Calc Refresh still runs the full job for in-`asins`
ASINs (inventory and sales included) and the public pass for the rest.
Because the page reads live, the refreshed stock shows on the next
refetch, which the page already does when the job finishes.

### Settings dialog

No change to the disabled set (`showParked`, `showDead`, `resetCogs`).
Parked/dead rows in `asins` still count as in-database and still get
their store data.

## Decisions

- **D1 — Live read vs. copy.** Proposed: live read, as above. Alternative:
  add stock/sales/actual columns to `bulk_list_asins` (migration 064) and
  extend `copyMainToBulk`. Trade-off: the copy matches the 2026-10-13
  wording ("push the result into the bulk tables") and keeps the page
  reading one table, but it is stale between Bulk refreshes and has to be
  extended every time the Stock/Actuals model changes.
- **D2 — Date range for Actuals.** Proposed: add the global date picker to
  `/bulk-calc` (same `asinflow-date-range-v2` state as the ASINs page, so
  the two pages always agree). Alternative: a fixed trailing window (e.g.
  last 30 days) with no picker. Actual COGS / Actual Prep Cost are not
  range-scoped either way.
- **D3 — Not-in-database rows.** Proposed: `—` + null (excluded from
  numeric sort/filter). Alternative: `0` per the §6 rule, accepting that a
  bulk-only row then looks out of stock.
- **D4 — Stock history popup** on in-database rows. Proposed: yes (it is
  the existing `onStockClick`; nothing new to build). Alternative: skip.
- **D5 — Default visibility.** Proposed: Stock and Actuals default
  **hidden** on Bulk Calc (the page's existing saved column config is
  keyed `fba-bulk-column-config`; new columns appear in Manage Columns and
  are enabled per need, like Max COGS on the ASINs page). Alternative:
  default visible — same as the ASINs page.

## Commits (after approval)

1. `server/asin-store-data.ts` — extract `loadStoreData` from
   `listAsinsHandler`; `/api/asins` response unchanged; move the
   `latest-inventory.test.ts` pins to the new module; add a unit test that
   the folded `stock` / `fbaStock` / `actuals` for a fixture ASIN equal
   what the inline code produced (snapshot taken before the move).
2. `GET /api/bulk-lists/:id` — accept `startDate`/`endDate`, attach `store`
   for in-`asins` rows, derive `in_database` from it; route-inventory test
   unchanged (no new route); test: a list with one in-DB and one bulk-only
   ASIN returns `store` for exactly the first.
3. Client — `mapBulkRow` spreads `store`; `BULK_COLUMN_IDS` gains Stock +
   Actuals; `/bulk-calc` in `DATE_PICKER_ROUTES`; range passed to the fetch
   and `dateRangeLabel` to the table; `onStockClick` wired; the page stops
   calling `/api/asins/in-database`; D3 dash/null rendering with a
   `numeric-zero.test.ts` case for the not-in-DB carve-out; Export CSV
   carries the new columns.
4. SPEC §21 / §6 / §14 text per this patch.

Gate per CLAUDE.md on every commit: `check`, `check:tests`, `test`,
baseline-vs-introduced labelled. No test rows created — the gate for
commit 2 runs against an existing list that already contains in-database
ASINs.
