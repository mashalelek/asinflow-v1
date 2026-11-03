# Spec patch — Dashboard (Spend · Sales · Profit grid + charts)

Status: APPROVED 2026-11-02 (v4) — ready for Claude Code
Source: Maria's doc "AsinFlow - Analytics dashboard" (revised 2026-11-02)
+ whiteboard photo (2026-11-02); decisions D1–D8, C1–C2 answered 2026-11-02
Touches: SPEC §8 (nav: Analytics → ASIN Analytics, new Dashboard route),
§11 (component 19: Pacific day, order ids), §22 (`po_line_refunds` status,
Refunds due filter), new SPEC §28 "Dashboard"
Related: `docs/claude_spec-patch-po-cancellations-from-email.md` (not
built yet — this patch takes over the "expected refund" piece of its data
model; that patch is to be amended to write `po_line_refunds` rows with
`status = 'due'` instead of its own `refund_amount_email` column)

## 1. What Maria asked for

1. Date range options (one selector, four sets):
   1. Today / This Week / Month to date / 30 days
   2. Today / Yesterday / Month to date / Last month
   3. Today / Yesterday / 7 days / 14 days / 30 days
   4. Custom range
2. Metrics
   1. Spend: **Spend** (PO total after refunds, discounts, tax, shipping
      etc.; gift-card % discount NOT included; Col AH in the Orders
      sheet) · ASIN units ordered · Individual units ordered · Avg. PO
      value — plus **Refunds due** (added 2026-11-02, clickable)
   2. Sales: Sales · Orders / Units (same as SellerBoard) · Refunds
   3. Profit: Gross profit · Net profit · Est. payout
3. Graphs — last 12 months by default, option to change the date range.
   Spend and Sales with checkboxes to add/remove each. **3 graphs**:
   30-day running, Monthly, Weekly.

Whiteboard: a **grid** — columns = the date ranges of the selected set,
rows = the metrics in three groups (SPEND / SALES / PROFIT), one value
per cell. Below it, charts with Sales as bars (left axis) and Spend as a
line (right axis).

Decided 2026-11-02:
- D1 new tab **"Dashboard"**; the existing Analytics page is left alone
  and renamed **"ASIN Analytics"**. No ASINs table on the Dashboard.
- D2 weeks start **Monday**.
- D3 Spend = Order Total net of refunds (Col AG/AH); AG not netting a
  refund is a data error → listed by the probe, never auto-corrected.
- D4/D6 every row that needs the Finances API is a **placeholder** now
  ("I mostly want to see the spend right now"); the Finances patch fills
  them. **Orders** does not need it (the orders report carries the order
  id) and is built now (C2).
- D5 canceled POs are reflected in Spend: full cancel → $0, partial →
  reduced — via the expected refund amount (C1, §2.3).
- D7 Amazon's sales basis is **US Pacific**; `sale_date` moves to the
  Pacific day in this patch.
- D8 chart range: **Last 12 months (default) and Custom** only.
- C1 "Refunds due" is a Spend row, **clickable → POs page filtered to
  POs with refunds due**. The probe's list of canceled lines with no $
  amount is expected to be messy now; it gets cleaned up over time
  through the cancellations emails and the Orders sheet — nothing in
  this patch depends on it being clean.

## 2. Design

### 2.1 Page and nav
- New route `/dashboard`, nav tab **Dashboard** in the slot the Analytics
  tab holds today; the renamed **ASIN Analytics** tab right after it.
  Default landing page unchanged.
- The old page: route key / title / §8 row → "ASIN Analytics"; nothing
  else on it changes (global date picker, `fba-include-inbound` toggle,
  grouping, export).
- The Dashboard **ignores the global date picker** (same rule as §23
  Repricer) and is not in the §8 shared date-picker route list. Its
  ranges come from its own set selector; the charts have their own
  local picker.

### 2.2 Range set selector
Segmented control above the grid; the choice is remembered per browser
(localStorage `af-dashboard-range-set`, moves with the Buy-List-to-DB
patch):

| Set | Columns | Range (inclusive calendar days) |
|---|---|---|
| 1 | Today · This week · MTD · 30 days | today; Monday of this week → today; 1st → today; today−29 → today |
| 2 | Today · Yesterday · MTD · Last month | today; yesterday; 1st → today; previous calendar month |
| 3 | Today · Yesterday · 7 days · 14 days · 30 days | N days = today−(N−1) → today |
| 4 | Custom | one column; two-date control local to the grid |

"N days" **includes today**. AF's existing `last_30_days` preset ends
yesterday, so the Dashboard does not reuse `computePresetRange`; it has
its own small, unit-tested range resolver. Column headers show the
resolved dates in small text. "Today" is resolved on the server: for
Spend in America/New_York (the `order_date` basis), for Sales in
America/Los_Angeles (the `sale_date` basis after §2.5) — each column
carries both resolved ranges in the response.

### 2.3 Grid
Rows (label column + one value per range column). Quiet chrome: `Card`
tokens, a rule between groups, the main metric of each group (Spend,
Sales, Gross profit) in the larger weight like a SellerBoard tile, the
rest in the normal row weight. No red/orange anywhere.

**SPEND** — source `purchase_orders` / `po_asins` / `po_line_items` /
`po_line_refunds`, by `purchase_orders.order_date`.

| Row | Definition |
|---|---|
| Spend | Σ per PO of `order_total − refunds(PO)`, where `refunds(PO)` = Σ `po_line_refunds.amount` for that PO, **any status (due or received)**. A fully-canceled PO (every line `qty_canceled ≥ qty_ordered`) is **forced to $0** whatever its rows say. Gift-card % is never applied; cashback never counts |
| Refunds due | Σ `po_line_refunds.amount` where `status = 'due'` over the column's POs. **Clickable**: opens the POs page with the new `refunds=due` filter and the column's date range (§2.4) |
| ASIN units ordered | Σ `po_asins.qty` − canceled ASIN units (Σ lines `COALESCE(qty_canceled,0) × asin_qty_per_product`); fully-canceled POs → 0 |
| Individual units ordered | Σ (ASIN units ordered per row × `units_per_pack`); a row with NULL `units_per_pack` contributes its ASIN units and the cell shows "n rows missing pack size" in small text — never ×1 silently (2026-11-01 rule) |
| Avg. PO value | Spend ÷ PO count, "—" when 0 POs; the PO count in the cell's small text. Fully-canceled POs are not counted |

**Expected refunds (C1).** `po_line_refunds` (migration 075) gains
`status text NOT NULL DEFAULT 'received' CHECK (status IN ('due',
'received'))`. Existing rows (the Col AF backfill, manual entries) stay
`received`. A **due** row = a refund the supplier owes (canceled items,
returns): `amount` is the expected amount, `refunded_at` / `method` /
`nickname` / `last4` NULL until received. Marking it received sets
`status = 'received'`, `refunded_at` and the method fields, and lets the
amount be corrected to what actually arrived (the edit log records the
change). Entry points in this patch:
- The PO editor's line **Cancel qty** action (and the product qty-canceled
  cell) proposes a due refund row for the canceled qty with
  `amount = qty × line price × (1 − PO discount ratio) + the line's tax
  share` (PO discount ratio = `discount ÷ subtotal`; tax share = `tax ×
  line value ÷ subtotal`), **editable before save**, same pattern as the
  cost calculator; saving the cancel without a refund row is allowed
  (then the probe/“no $ amount” list shows it).
- The PO editor's Payment tab lists the PO's refund rows with status;
  **Add refund** (status due or received) and **Mark received** on a due
  row.
- The cancellations-from-email patch, when built, writes its confirmed
  cancellations as due rows here (its `refund_amount_email` → `amount`,
  `status = 'due'`) and its "Refund received" action marks them received
  — amend that patch's §3/§5 accordingly; no `po_cancellations.refund_*`
  columns.
`purchase_orders.refund_amount` (header, Col AF) is **not read** by the
Dashboard; the probe reports POs where it differs from Σ line refunds so
the two can be reconciled once, and SPEC §22 states that the line rows
are the money of record for refunds from this patch on.

**SALES** — source `sales_daily` (+ `sales_orders`, §2.5) by `sale_date`.

| Row | Definition | This patch |
|---|---|---|
| Sales | Σ `revenue` | real |
| Orders / Units | distinct `amazon-order-id` count / Σ `units_sold` | real (C2: `sales_orders`) |
| Refunds | Σ `refund_amount` (units in small text) | **placeholder** — Finances API patch |

**PROFIT** — SellerBoard's definitions so the numbers compare with SB:

| Row | SB definition | This patch |
|---|---|---|
| Gross profit | Sales − refunds − Amazon fees (referral, FBA, other) − promo/other Amazon charges | placeholder |
| Net profit | Gross profit − COGS (actual_cogs + prep for the units sold) − indirect expenses | placeholder |
| Est. payout | Sales − refunds − Amazon fees (what Amazon pays out, before COGS) | placeholder |

Placeholder = "—" with the tooltip "after the Finances API patch". The
grid layout, row keys and API shape are final now; the Finances patch
only supplies numbers.

**Coverage guard** (§23 rule) on every Sales cell: if a column's range
starts before the earliest `sales_daily.sale_date`, the cell shows the
value with a "data from <date>" marker. The grid header shows once:
"Sales through <newest sale_date> · synced <time>". Spend needs none
(POs are complete back to the import floor).

### 2.4 POs page — Refunds due filter
- New list filter **Refunds: any / due / none** beside the Open/Closed
  filter (`?refunds=due`), plus the existing date range params; the
  Dashboard cell links to `/pos?refunds=due&from=…&to=…`.
- The POs list gains a small **Refund due** amount in the PO row's money
  area when the PO has due rows (quiet text, no chip).
- `GET /api/pos` accepts `refunds=due|none`.

### 2.5 Sales ingestion changes (component 19)
- **Pacific day (D7).** `sale_date = (purchase-date AT TIME ZONE
  'America/Los_Angeles')::date` instead of `substring(0,10)` of the UTC
  timestamp. Report windows are requested with Pacific day boundaries
  converted to UTC (`dataStartTime` / `dataEndTime`), the hourly 48-hour
  window unchanged in length. Before a chunk's upsert the chunk's
  `sales_daily` rows for the window are deleted and reloaded
  **fail-closed** (delete only after the report chunk was fully read and
  parsed — §14 manual-trigger completeness), so UTC-keyed rows disappear
  as the backfill passes over them. §11 note updated; the Finances patch
  inherits the Pacific basis.
- **Orders (C2).** Migration: `sales_orders (amazon_order_id text,
  sale_date date, asin_id uuid, units integer, PRIMARY KEY
  (amazon_order_id, asin_id))` written by the same parser (cancelled
  orders skipped as today); the dashboard counts `COUNT(DISTINCT
  amazon_order_id)` per range. Same delete+reload per chunk.
- **Re-backfill**: after deploy, `npm run backfill:sales` over the full
  coverage (local first, then `--prod`); the jobs dialog shows it like
  any job. Until it has run on Render the coverage marker and the §2.3
  header say so.
- The ASINs page's Actuals and the Repricer tab read the same
  `sales_daily` and move to the Pacific day with it — one basis
  everywhere. SPEC §6/§23 notes updated.

### 2.6 Charts
Three charts stacked under the grid, one shared `DashboardChart`
component (`recharts ^2.15`, already a dependency; AF's first chart
component):

| Chart | X | Sales (bars, left $ axis) | Spend (line, right $ axis) |
|---|---|---|---|
| 30-day running | day | Σ revenue over `[d−29, d]` | Σ Spend over `[d−29, d]` |
| Monthly | calendar month | Σ revenue | Σ Spend |
| Weekly | week starting Monday | Σ revenue | Σ Spend |

- Each chart: **Spend** and **Sales** checkboxes, both on by default;
  unchecking removes the series and its axis.
- One range control for all three: **Last 12 months** (default; 12
  calendar months ending with the current one, the partial current
  period labeled "to date") or **Custom** (two dates). Local state,
  remembered per browser.
- Running sums in SQL (`generate_series` + window), never on the client.
- Tooltip: period, Sales $, Spend $, PO count, units sold, orders. Two
  series colors from the palette tokens; no gradients.
- A Sales series whose range starts before the earliest `sale_date` is
  drawn from that date and the chart says so.

### 2.7 API
- `GET /api/dashboard/grid?set=1|2|3|4&from&to` → columns (label,
  Eastern range, Pacific range), every row key's value per column,
  `poCount`, `missingPackSize`, coverage (`earliestSaleDate`,
  `newestSaleDate`, `lastSalesSyncAt`), placeholders as `null` with
  `pending: true`.
- `GET /api/dashboard/series?kind=running30|monthly|weekly&from&to` →
  `[{period, sales, spend, poCount, units, orders}]`.
- All aggregation in SQL. Read-only except the PO editor's refund rows
  (§2.3) and the ingestion change (§2.5).

### 2.8 Tests
- Range resolver: every column of every set, "N days includes today",
  MTD on the 1st, Last month across a year boundary, Monday weeks,
  Eastern vs Pacific "today" around midnight.
- SQL: fixture POs across month/week boundaries, a fully-canceled PO
  (forced $0), a partially-canceled PO with a due refund, a PO with a
  received refund, a row with NULL `units_per_pack`; every grid cell and
  each series kind; `refunds=due` filter.
- Component 19: Pacific-day bucketing around midnight UTC/Pacific,
  delete+reload is fail-closed on a failed chunk, `sales_orders` distinct
  count.
- Coverage marker; placeholder rendering; nav rename + new route (route
  registration test); dialog sweep still passes (the PO editor's new
  refund controls live in the existing dialog).

## 3. Commits

0. **Probe** (`--prod`, read-only) → `docs/dashboard-probe-<date>.md`:
   `MIN/MAX(sale_date)` + row count; `MIN(order_date)`, PO count by
   `source`; POs with any refund whose AG ≠ AB+AC+AD−AE−AF on the sheet
   (D3 data errors, for Maria's review — CSV); fully-canceled POs with
   `order_total − Σ line refunds > 0` (forced to $0 by rule — listed);
   lines with `qty_canceled > 0` and no refund row (the "no $ amount"
   list — expected messy, informational); POs where header
   `refund_amount` ≠ Σ `po_line_refunds.amount`; `po_asins` rows with
   NULL `units_per_pack`. Report; no stop.
1. Rename Analytics → **ASIN Analytics** (route, nav, title, SPEC §8);
   register the empty **Dashboard** route in its slot; route test.
2. Migration: `po_line_refunds.status`; `sales_orders`. Component 19 →
   Pacific day + order ids + fail-closed delete/reload; backfill script
   unchanged in interface; SPEC §11; tests. Run `backfill:sales` locally.
3. `server/dashboard.ts`: range resolver + SQL aggregations + the two
   endpoints; tests.
4. PO editor: due refund proposal on Cancel qty / qty-canceled cell;
   Payment tab refund rows (Add refund, Mark received); `refunds=` filter
   on `/api/pos` + POs page + Refund due amount; SPEC §22; tests.
5. Dashboard page: set selector, `MetricGrid`, coverage header,
   placeholders, Refunds due link.
6. `DashboardChart` + the three charts, checkboxes, local range picker.
7. SPEC §28 "Dashboard" (page, every definition, SB mapping, what is
   pending and which patch fills it), §6/§23 Pacific note, CLAUDE.md
   (re-backfill step after deploy); amend
   `docs/claude_spec-patch-po-cancellations-from-email.md` §3/§5 to write
   `po_line_refunds` due rows.
After push + deploy: run `backfill:sales --prod` (one job), confirm the
coverage header on the live Dashboard.

Gate per commit: `npm run check`, `npm run check:tests`, tests; one
report at the end; stop only for a real deviation from this patch.
