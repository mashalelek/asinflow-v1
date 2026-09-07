# AsinFlow Spec

This document captures the **current rules** of AsinFlow — how the system
behaves today, what each metric means, and the design principles that govern
new work. It is rules-only: no history, no rationale beyond what's needed to
make a rule self-explanatory.

When something here is wrong or stale, fix the doc first, then change the
code. This is the canonical reference both Maria and Claude work from.

Last updated: August 22, 2026.

---

## 1. Domain Model

AsinFlow is an internal FBA profitability dashboard for a single-seller
operation (Maria, Coastal Quality Goods). It is not multi-tenant SaaS.

### Estimated vs. Actual

Every profit-related metric exists in two forms:

- **Estimated** — forward-looking. "What would I make on a reorder right now?"
  Computed from current market prices (Lowest FBA or Buy Box), expected COGS,
  and current settings.
- **Actual** — backward-looking. "What did I actually make on what I sold?"
  Computed from realized sales data (revenue, units sold, fees, etc.) over a
  date range.

The two are never blended. Filters and views must use one or the other, never
a hybrid metric. (Past hybrids like "current price + actual COGS + estimated
fees" are explicitly forbidden.)

### ⚠️ Critical caveat: Actual P&L is broken

AsinFlow's Actual profit/margin/ROI are seriously inaccurate today. Per a
side-by-side comparison with SellerBoard for ASIN B07P7Y5J8H (Kar's Nuts)
over the same period:

| Metric | SellerBoard | AsinFlow | Direction |
|---|---|---|---|
| Sales | $777.05 | $777.05 | ✅ matches |
| Refunds | 8 | 0 | ❌ missing |
| Refund $ | -$121.98 | not captured | ❌ missing |
| **Net profit** | **$77.62** | **$0.86** | ❌ ~90× too low |
| **Margin** | **9.99%** | **0.1%** | ❌ off by ~100× |
| **ROI** | **26.95%** | **0.3%** | ❌ off by ~90× |

The direction of the error is *understating* profit, which suggests costs
are being overstated somewhere — possibly double-counted fees, mismatched
unit counts, or fees from outside the period being subtracted.

Other known gaps in the Actual P&L data path:

- **Refunds** — not ingested from SP-API. Always shows 0.
- **Amazon fees (FBA, referral, other)** — `actual_fba_fees`,
  `actual_referral_fees`, `actual_other_fees` columns exist in `sales_daily`
  but are populated by the fee engine (estimates), not by Amazon's Finances
  API. Their contents are unverified.
- **Inbound shipping** — currently estimated, not actual.
- **Unit count drift** — minor (1–2 unit) discrepancies in some rows.

Until the audit lands: AsinFlow's Actual profit / margin / ROI are NOT
authoritative. Use SellerBoard for real P&L decisions. AsinFlow's Estimated
metrics are still useful for sourcing and replenishment.

This is a critical gap and warrants a dedicated session. See Section 13.

### Date range

Actuals are scoped to a date range selected at the top of each page. Estimates
are point-in-time (current) and ignore the date range.

---

## 2. COGS Rules

### Estimated COGS vs. Actual COGS

AsinFlow tracks two separate COGS values per ASIN. They serve different
purposes and have separate ownership.

**Estimated COGS (`asin_estimates.estimated_cogs`)**
- Forward-looking. Used to compute Estimated Profit / Margin / ROI.
- "What would this ASIN earn at current price assumptions, at this expected
  cost."
- Source labels (`estimated_cogs_source`): `manual`, `csv`, `imported`
  (Chrome extension), `po_sheet`.
- Written by: CSV upload, manual inline edit, Chrome extension import, and
  PO sync (any source except `manual` — see "PO sync behavior").
- Inline-editable in the UI via the CogsEditor popup.

**Actual COGS (`asin_estimates.actual_cogs`)**
- Backward-looking. Used to compute Actual Profit / Margin / ROI from past
  sales.
- "What did the units I sold actually cost."
- Source labels (`cogs_source`): `po_sheet`, `csv`, `manual`.
- Written by: PO sync only (`po_sheet`) — the sole writer, enforced
  (2026-08-30). The dormant API path (`PUT /api/asins/:asin/cogs` with an
  `actual_cogs` body param, source `'manual'`) is REMOVED — the param is
  ignored; the route's `estimated_cogs` handling is unchanged. `cogs_source
  = 'manual'` is now legacy/unwritable (the CHECK-constraint enum cleanup is
  deferred to a future migration). Ruled after the B0G4XGFX1Z phantom: a
  `manual` source marker with a NULL value blocked the sync's actual_cogs
  write forever (19 phantom rows found 2026-08-30), so the sync's
  manual-override guard on `actual_cogs` is also gone — the sync ALWAYS
  overwrites, per the §2 rule above. `estimated_cogs`' manual-override
  semantics are untouched. (CSV upload writes `estimated_cogs`, not
  `actual_cogs`.)
- Read-only in the UI; not user-editable. Eventually derived from FIFO across
  open lots.

### PO sync behavior

When the PO sync job runs for an ASIN that has a matching PO row:

- Always overwrites `actual_cogs` with the latest PO value. Sets
  `cogs_source = 'po_sheet'`.
- For `estimated_cogs` (rule corrected 2026-08-11): **overwrite with the
  latest PO value and set source `'po_sheet'` — unless
  `estimated_cogs_source = 'manual'`**, which is left alone (manual override
  sticks, unchanged semantics). `csv`/`imported` YIELD to PO: those sources
  seed pre-purchase estimates, and a PO row is ground truth for what the
  units cost. (The prior rule — update only `po_sheet`/NULL — silently froze
  `csv`-seeded rows against PO updates: 83 rows had drifted ~$268 total by
  2026-08-10, incl. two stuck at $0.00. The first sync after this change
  heals that population as a side effect; no repair script.)

### Manual override

When the user edits Estimated COGS in the CogsEditor popup:

- `estimated_cogs_source` is set to `'manual'`.
- That ASIN's Est. COGS is now frozen against PO sync.
- A small `M` badge appears next to the value in the Product cell.

### Reset to PO

Two paths to revert a manual override back to PO-sourced:

- **Inline** — "Sync from PO" link in the CogsEditor popup. Visible only when
  source is `'manual'` and a PO COGS exists for the ASIN.
- **Bulk** — "Reset Est. COGS to PO" button in the toolbar. Confirmation
  dialog before run. Overwrites all `manual` rows that have PO data; skips
  manual rows without PO data.

### Product cell display

- The inline COGS line **always shows Estimated COGS**, labeled
  `Est. COGS: $X.XX` (`—` when null). It **never** displays `actual_cogs` — the
  Product cell is a forward-looking sourcing glance. (`CogsDisplay`,
  `client/src/components/results-table.tsx`.)
- **Actual COGS is viewed via its own dedicated sortable column** (the `cogs`
  column), not the Product cell.
- An **`M` badge** appears next to the Est. COGS line when
  `estimated_cogs_source = 'manual'` (tooltip: "Manually entered — PO sync
  skipped"). This behavior is unchanged.
- The inline-edit pencil opens the `CogsEditor` popover, which edits **Estimated
  COGS only** (writes `estimated_cogs`; never `actual_cogs`). When
  `estimated_cogs_source = 'manual'` it also shows a **"Sync from PO"** link that
  re-pulls the estimated COGS from the PO sheet.

---

## 3. Prep Cost Rules

Prep cost is **operationally-determined**, not ASIN-specific. It depends on
the user's current prep arrangement (self-prep vs prep center). This makes
its rules different from COGS.

### Estimated Prep Cost

Always uses `settings.prep_cost` (the global default). Never reads PO data.

Rationale: a reorder will be prepped under the *current* arrangement, not
whatever was true historically.

### Actual Prep Cost

Reads `prep_override` from the asin_estimates table, which is populated from
the PO sheet (Col AS, "Prep cost").

Three render states:

| `prep_override` | Display | Warning |
|---|---|---|
| `> 0` | `$X.XX` | none |
| `0` (PO row exists, cell empty/zero) | `$0.00` | none |
| `NULL` (no PO row at all) | `$0.00` | amber warning indicator |

The warning tooltip reads: *"No PO prep cost found. This indicates a missing
PO record or unmapped sale. Actual profit/margin/ROI may be overstated."*

### PO sync write rule

When syncing PO data: empty Col AS on a row that exists writes `0`, not
`NULL`. NULL is reserved for "no PO row at all."

This distinction lets the warning fire only on legitimate data integrity
issues, not on intentional zeros.

---

## 4. Replenishment Filter

An ASIN passes the Replenishment view if **all three** conditions are true:

**(A) Estimated profitability passes any tier:**
- Tier 1: `estimated_roi > 25%` AND `estimated_margin > 10%`
- Tier 2: `estimated_roi > 20%` AND `estimated_margin > 12%`
- Tier 3: `estimated_roi > 15%` AND `estimated_margin > 14%`

**(B) Estimated profit per unit ≥ $3.00**

**(C) Sales gate:** `SUM(sales_daily.units_sold) > 0` for the currently
selected date range.

The filter uses `getEstimatedProfit()` — the same function that powers the
Estimated ROI/Margin/Profit table columns. If a user can see why a row
qualifies by looking at the Estimated columns, the filter is doing the right
thing.

### Out of scope for Replenishment

- Hybrid metrics (current price + actual COGS + estimated fees) are forbidden.
- Velocity-based gating (e.g., "selling N units/day") is not used. The simple
  `units_sold > 0` gate is the rule.

---

## 5. Visibility Toggles vs. Filters

These are **separate concepts**.

### Visibility toggles (view scope)

Three toggles in the toolbar control what's in the working set:

1. **Show gated** — default OFF (hides gated ASINs)
2. **Show meltable** — default depends on date:
   - Apr 15 – Sep 15: OFF (meltable items hidden during summer)
   - Otherwise: ON (meltable items visible)
   User can override; manual state is remembered across reloads within the
   same seasonal window.
3. **Show archived** — default OFF (hides archived ASINs)

Toggles do **not** count toward the active filter count. They do not appear
in the Active Filters modal. They define scope, not filtering.

### Filters (column-level criteria)

Filters are user-applied criteria on column values (e.g., ROI > 20%, Brand =
X, Search: "ABC"). These DO count toward the active filter badge and appear
in the Active Filters modal.

### Active Filters modal

Triggered by the "Active filters (N)" button in the toolbar, which is hidden
entirely when no filters are active.

The modal lists each active filter grouped by category. Each filter row has
an × to remove it individually. Footer has "Clear All" and "Close."

### Search and ASIN selection are one logical filter

When a user types text in search but hasn't selected an ASIN, the modal shows
"Search: [text]" — count = 1.

When a user selects one or more ASINs from the search dropdown, the modal
shows "Selected ASINs: N ASIN(s): ..." — count = 1, regardless of whether
search input still has text.

The two are never shown as separate filters. They are different
representations of the same logical "narrow to specific ASIN(s)" intent.

---

## 6. Column Structure

### Six groups (canonical order)

1. **Description** — Product, Category, Brand, Supplier, Supplier SKU
2. **Stock** — Stock, Available (FBA), Ordered, Reserved, Sent to FBA, Days Left
3. **Actuals** — Actual COGS, Actual Prep Cost, Actual Units Sold, Refunds,
   Refund %, Actual Avg. Sale Price, Actual Revenue, Actual Total Profit,
   Actual Profit/Unit, Actual ROI, Actual Margin
4. **Estimates** — Estimated COGS, Estimated Prep Cost, Estimated Sale Price,
   Estimated Profit/Unit, Estimated ROI, Estimated Margin, Estimated FBA Fee,
   Estimated Referral Fee, Estimated Inbound Ship., Estimated Additional Fees,
   Max COGS
5. **Sellers** — Sellers (FBA), Sellers (combined), Sellers 7d Δ, Sellers 30d Δ,
   FBA 7d Δ, FBA 30d Δ
6. **Additional info** — Tags, Notes, Promos, Sourcing, Meltable, Hazmat,
   Suppressed, Date Added, Submission

`COLUMN_GROUPS` array in code is the single source of truth. Both Manage
Columns panel order and table render order derive from it.

### Supplier SKU column (2026-08-05)

The supplier's own catalog/item number — NEVER from Amazon, unrelated to
`primary_sku` / `asin_skus`. Labeled "Supplier SKU" everywhere. Lives on both
`asins` and `bulk_list_asins` (migration 025). Sources: CSV upload (mapper
alias, both upload paths) or manual inline edit; analyze never writes it
(§14). `defaultVisible: false` — not in any main-page preset by default.
Included in both pages' CSV exports.

Main-table `supplier_sku` is **display-only today** — populated via the CSV
upload INSERT branch; the inline editor exists only on the Bulk Profit
Calculator (§21). Main-page inline editing is not built yet.

### Submission column (2026-08-03)

Surfaces the §19 ledger per ASIN, in Manage Columns only — **not in any
default preset** (`defaultVisible: false`; DB presets list columns explicitly
so it never appears unbidden).

- **Data:** the LATEST `listing_submissions` row per ASIN (by `submitted_at`)
  drives the badge; superseded submissions appear only in the tooltip history.
  Shipped in `/api/asins` as `submission: { latest, history[] }` (newest
  first), one grouped query over the ledger (indexed by
  `listing_submissions_asin_idx`; measured no meaningful `/api/asins` slowdown).
- **Render:** nothing when no submission exists or the latest is a clean
  `live`. Otherwise a compact badge: amber issue-code chips (e.g. `18555`),
  red `failed`, muted chip for other states (`processing`, `stale`,
  `deleted`). Per §7: semantic color in cell TEXT only — no row tints.
- **Current-issues snapshot is the primary badge (2026-08-03, item 7).**
  Ledger flags freeze at verify time and go stale — Amazon-side issues resolve
  without new submissions. `asins.current_issues` (jsonb) +
  `asins.issues_checked_at` (migration 024) hold a per-ASIN snapshot from
  `getListingsItem` (`includedData=summaries,issues` — issues ride the SAME
  call the live-offer probe already makes, zero extra volume). Badge
  precedence: snapshot when present (empty snapshot = currently clean → no
  badge), else latest-submission flags. Ledger flags stay in the tooltip and
  the filter regardless — the permanent record is unchanged.
  - **Refresh paths:** (a) "Recheck" button in the column tooltip →
    `POST /api/asins/:asin/recheck-issues`, which runs the single-ASIN
    full-scope live-offer pass (same `syncLiveOffers` implementation — single
    owner of `has_live_offer` preserved); (b) EVERY live-offer pass (07:00
    cron, inventory-sync rider, recheck) writes the snapshot for each ASIN it
    definitively probes. Fail-closed: transient probes write nothing.
  - **Rescans never modify ledger rows** — the snapshot lives on `asins`,
    the ledger is append/verify-only.
- **Acknowledgment NEVER hides column flags** (contrast with the §19 panel):
  acknowledged flags render muted/grey instead of amber, permanently. Badge,
  tooltip, and filterability remain. The panel's dismiss is triage; the column
  is the permanent record. Flags are never deleted from the ledger.
- **Filter:** has flags / failed / clean / none — acknowledged still counts as
  "has flags".
- **Read-only end to end:** the column reads the ledger, never writes it.
  Resolution/acknowledgment stay in the §19 panel.
- **Tooltip:** full submission history for the ASIN — submitted date, SKU,
  status, issue codes + messages, flags; newest first — so errors resolved
  over time stay visible.

### Stock object population

The stock object is **always populated** (`routes.ts`, `/api/asins`). ASINs
with no inventory snapshot render Stock as **available 0 + ordered qty** (never
`-`), so numeric Stock filters include them rather than dropping the null row.
`ordered` comes from `asin_estimates.ordered_qty` and surfaces even when the
ASIN has never been seen in Seller Central. A `hasSnapshot` boolean on the
object lets the client hover breakdown distinguish **"no FBA snapshot yet"**
(shows "Not yet synced from SC") from a confirmed zero. This is a display/read
fix only — nothing is written to `inventory_snapshots`.

### Two-row column headers

Estimates and Actuals columns use stacked two-row headers:

- Row 1: qualifier ("Actual" / "Estimated") — smaller, muted text
- Row 2: metric name ("ROI", "COGS", etc.) — primary header text

Description, Stock, Sellers, and Additional info columns use single-line
headers (no qualifier needed).

No top-level "Estimates" / "Actuals" colored band. The qualifier-on-each-column
pattern carries the distinction.

### Fixed order, no reordering

Drag-to-reorder is disabled. Column order is fixed by `COLUMN_GROUPS`. Users
can toggle visibility per column via Manage Columns, but cannot rearrange.

### Frozen columns

The four leftmost columns are sticky during horizontal scroll:

- `#` (sequential row index)
- Checkbox (selection)
- Cart icon
- Product

A 0.5px hairline divider (`--color-border-tertiary`) marks the boundary
between frozen and scrollable areas.

### Sequential row numbers

The `#` column shows position within the current filtered/sorted view (1 to N
where N = total filtered count). Persists across pagination. Updates when
sort/filter change. Non-sortable, non-filterable.

### Default view presets

The three default view presets (Full View, Replenishment, Sourcing) define
initial column visibility, sort, and applied filters. The following columns
are available in the column picker but are NOT included in any preset by
default — the user enables them per-need:

- Date Added
- Category
- Sourcing
- Promos (free-text `promo_notes`) — **inline-editable, same interaction as
  Notes** (2026-08-09): click to edit, save on blur/enter, empty → NULL.
  Seeded by the sourcing sheet on new-ASIN INSERT (§11); manual edit only
  after that — analyze and re-syncs never touch it, so edits are never
  overwritten.
- Max COGS
- Est. COGS (when shown as separate from Actual COGS)
- Meltable, Hazmat, Suppressed (icons appear in Product cell regardless)

---

## 7. Visual Design

### Palette: warm stone

Light mode:
- Page bg: `#F5F4EF`
- Card/tile bg: `#FFFFFF`
- Controls bar: `#E7E5E4`
- Table column header: `#44403C` (dark stone, white text)
- Table row default: `#FFFFFF`
- Table row zebra: `#FAFAFA`
- Top nav: `#292524` (deep stone, white text)
- Top nav active pill: `#44403C`
- Primary text: `#1C1917`
- Secondary text: `#78716C`
- Tertiary text: `#A8A29E`

Dark mode:
- Page bg: `#1C1917`
- Card/tile bg: `#292524`
- Controls bar: `#292524`
- Table column header: `#44403C`
- Table row default: `#292524`
- Table row zebra: `#1F1B18`
- Top nav: `#0C0A09`
- Top nav active pill: `#292524`
- Primary text: `#F5F5F4`
- Secondary text: `#A8A29E`
- Tertiary text: `#78716C`

Top nav and table column header keep dark surfaces in both light and dark
page modes — that's intentional.

### Layering principles

- Hierarchy comes from background color deltas + spacing, NOT from box-borders
  around containers.
- KPI tiles: no border outline. Lifted from page bg via slightly lighter
  surface. Each tile has a 3px colored left-border accent (decorative).
- Filter/controls bar: distinguished from page bg by surface color, not
  borders.
- Table: dark column header bar is the only strong horizontal element. Row
  separation via zebra stripe + 0.5px hairline horizontal borders.

### What NOT to add

- No vertical column dividers (except the single freeze-boundary divider).
- No row-level background tints for profitability (no `bg-emerald-500/8` on
  profitable rows, no `bg-red-500/8` on unprofitable rows). Semantic color
  lives in the cell text only.
- No tinted "Estimates" / "Actuals" group header bands.
- No saturated accent colors for structural elements. Color goes into:
  - Active states (selected nav, primary buttons, focus rings)
  - Semantic text (positive ROI green, negative ROI red)
  - Decorative tile accents (left-borders)
  - Warning indicators (amber)

### Typography & spacing

Small/muted for metadata, larger/primary for values. Minimum form element
borders for hit-target clarity (search, dropdowns) — these are the exception
to the "no container borders" rule.

---

## 8. Top Navigation

Items in order:

- **AsinFlow** (logo, far left)
- **ASINs** — active route
- **Analytics** — active route
- **POs** — active route: the **PO module frame** (§22) — list + read-only
  expanded view over the in-app PO database (768 imported 2026 orders). No
  longer a minimal shell. The toolbar hosts the "Upload to Velocity" action
  (§11) — Velocity upload remains a toolbar ACTION, not page content. (The
  prior PO scaffold was removed 2026-07-30, migration 021; the module was
  rebuilt fresh per §22.)
- **Gift Cards** — disabled, "Soon" badge
- **Repricer** — disabled, "Soon" badge
- **Shipments** — disabled, "Soon" badge
- (right side) **Dark mode toggle**

Disabled items: muted text, no hover state, not clickable. The "Soon" badge
indicates a planned future module.

When a future module ships, its nav item activates. The structure of the top
nav doesn't change.

A sub-nav strip below the top nav will be added when the PO module ships
(for POs / Suppliers / Invoices / Reconciliation sub-pages). Not built yet.

---

## 9. Settings

Accessed via gear icon in the toolbar (not in top nav). Opens a modal with
global defaults:

- **Prep cost** — per unit, used for Estimated Prep Cost calculation
- **Hazmat surcharge** — per unit, applied to hazmat-flagged ASINs
- **Inbound shipping rate** — $/lb, used for Estimated Inbound Ship.
- **Price source** — Lowest FBA or Buy Box (also exposed as a toolbar toggle)
- **Max COGS thresholds** — three values used by the Max COGS column:
  - `max_cogs_min_margin_pct` (default 12)
  - `max_cogs_min_roi_pct` (default 20)
  - `max_cogs_min_profit_unit` (default 3)
- Other operational defaults

Settings values are read by the calculation engine and apply to all Estimated
metrics across the app.

---

## 10. Naming Conventions

### Prep center shipments

All inbound shipments at the prep center are named:

```
YYYY-MM-DD_supplier-domain_orderID_short-description
```

Example: `2026-04-15_acmesupply.com_PO-1247_widgets-blue`

- Underscore-delimited, exactly four fields
- `supplier-domain` = bare domain, no `https://`, no `www.`
- `order_id` matches the PO sheet's order ID exactly

This convention is the foundation for the future prep center webhook
integration. The composite match key is `supplier_domain + order_id` (order
IDs may collide across suppliers).

### Invoice files

PO invoice files (when stored in the in-app PO module) follow:

```
YYYY-MM-DD_SupplierName_OrderID
```

---

## 11. Integration Points

### Google Sheets PO tracker

- **Sheet ID:** `1WC7r4Z-fIVENFoj_Z14rAgXs2U4Etue0BM065DPGl7Q`
- **Tab name:** `Sheet1` — the range in `server/google-sheets.ts` is literally
  `Sheet1!A2:AZ`; the PO data lives on the first tab, named "Sheet1".
- **Range:** `A2:AZ` (widened for the Velocity export fields in Cols AX–AZ; prep
  cost remains Col AS)

**Architecture — the sheet AF reads is a MIRROR, not the real Orders file.**
`GOOGLE_SHEET_ID` points at **"AsinFlow - Purchase Orders"** (tab `Sheet1`), a
mirror spreadsheet populated by an `IMPORTRANGE` formula pulling from Maria's
real Orders file. The real file is **intentionally NOT shared** with the service
account — the mirror is a deliberate read boundary, so AF (and the service-
account credential) can never see or touch the source of truth, only the mirrored
columns Maria chooses to expose.

**Maintenance rule (learned the hard way).** The mirror's `IMPORTRANGE` range
must **always cover the code's read range.** The `IMPORTRANGE` was bounded at
Col AS, so when the code range was widened to `A2:AZ` for the Velocity fields,
the VA's Cols AX–AZ data (already filled in the real file) **did not flow
through** the mirror and AF read them as empty — until the `IMPORTRANGE` range
was extended to match. When widening the code's read range: **widen the mirror
`IMPORTRANGE` FIRST**, then verify the new columns actually flow through (read a
known-populated row) before trusting reads of them.

Column mappings used by AsinFlow (indices 0-based from Col A):

| Column | Index | Field | Notes |
|---|---|---|---|
| B | 1 | Order number | Velocity export |
| C | 2 | Order date | Velocity export row selection; also needed by the SellerBoard COGS export |
| D | 3 | Status | `.toLowerCase().includes()` — drives the canceled/closed filters |
| E | 4 | Retailer | Velocity export |
| H | 7 | ASIN | Match key, `.trim()` |
| I | 8 | Item name | Velocity export |
| U | 20 | Ordered qty | Net (qty − shipped) summed only for rows that are neither closed nor canceled |
| Y | 24 | COGS | True product cost only (prep removed). See selection rule below |
| AS | 44 | Prep cost | Per unit. Empty cell on the selected row → `0`, not `NULL` |
| AX | 49 | sold_as | Velocity-ready, pass through verbatim |
| AY | 50 | units_per_pack | Velocity-ready, pass through verbatim |
| AZ | 51 | quantity | Velocity-ready, pass through verbatim |

**Selection rule (COGS / prep / supplier).** These come from the **first
NON-CANCELED row per ASIN whose Col Y parses to a non-null money value**. The
accumulator gate is "no COGS locked yet," so a leading non-canceled row with a
blank/unparseable Col Y does NOT lock selection — a later non-canceled row can
still win. Prep (Col AS) and supplier (Col E, idx 4) are read from that same
winning row (coupled to the COGS selection).

**"Closed" rows remain COGS-eligible.** Only `canceled` excludes a row from
COGS/prep/supplier selection; `closed` only excludes the row from the
`orderedQty` sum. Status filtering uses `.toLowerCase().includes()` for
compound statuses (e.g., "Closed, Returned" matches "closed"; "Closed, Missing
/ Damaged from Supplier" matches "closed" but not "canceled", so it stays
COGS-eligible).

Note: Col Y was historically prep-inclusive but has been cleaned up — prep is
now in Col AS exclusively. Any `actual_cogs` values in the DB from older PO
syncs are "dirty" until the next sync overwrites them with clean Col Y data.

**Ordered-qty clearing pass (2026-08-23).** `runSheetsSync` is an UPSERT loop
over ASINs present in the current read, so an ASIN whose sheet rows vanish
(ASIN corrected in the sheet, rows deleted) would keep its last-written
`ordered_qty` forever — real case: order 2461171104's correction
B07GC57HR4 → B0HBGJW4JH left BOTH ASINs at qty 10 across multiple syncs, and
the stale value propagated into every new `inventory_snapshots` row. After
the per-ASIN write loop, a clearing pass sets `ordered_qty = 0` for every
ASIN whose `asin_estimates.ordered_qty` is non-zero but which has zero rows
in the current sheet read:

- **Full-catalog runs** (post-analyze background sync, Aura chain, bare
  `POST /api/sheets/sync` with no `asins` body): all such ASINs clear.
- **Scoped runs** (the UI Sync PO path always sends `asins`): clearing is
  restricted to ASINs INSIDE the filter — a scoped sync must never zero an
  ASIN outside its scope. In-filter clearing is what fixes the UI path: the
  stale ASIN sits in the user's selection but is absent from the sheet, so
  the write loop alone can never reach it.
- Every run reports the cleared count + ASIN list (`cleared`,
  `clearedAsins` in the response; also logged), both modes.

**Clears `ordered_qty` ONLY.** The cost snapshots this sync writes —
`cogs`/`actual_cogs`, `estimated_cogs`, `prep_override`, `asins.supplier` —
are point-in-time records ("last known PO cost") and are NEVER cleared when
rows vanish. `ordered_qty` is a live open-quantity that must mirror the
current sheet; the snapshots stay meaningful (and load-bearing — e.g.
`actual_cogs` + `cogs_source = 'po_sheet'` gates the sourcing-cost export)
after the rows are gone.

**Fail-closed gate.** The clearing pass requires an end-to-end successful
read: the sync reads through `fetchSheetDataWithMeta`, which returns
`rawRowsRead` (raw row count the API returned for the range — the same
truncation-tripwire idea as the SellerBoard export), and the pass runs only
when `rawRowsRead > 0`. A thrown read aborts the whole sync; an empty read
(`rawRowsRead = 0` — a creds/range/mirror failure would otherwise zero the
entire catalog) skips the clearing pass entirely and logs the skip. A
partial-but-nonempty read is not detectable at this layer (`values.get` is a
single ranged read: it errors or it returns), so the tripwire's job is the
catastrophic-empty case.

### Velocity upload export

Exports prep-outsourced orders to the Velocity prep service — as a CSV
download (phase 1) or pushed directly to Velocity's API (phase 2, next
subsection); both consume the same records. Built by
`server/velocity-export.ts` (`buildVelocityRecords(from, to)`) over
`fetchSheetRows` (per-row PO-sheet view), delivered by
`GET /api/export/velocity-upload?from=&to=` (both params optional, `M/D/YYYY`,
default = today; `&dryRun=1` returns counts + skip detail as JSON instead of the
file). Gated by DB + Google credentials + `GOOGLE_SHEET_ID`, like the other
sheet integrations.

**Order-date creation floor.** `VELOCITY_MIN_ORDER_DATE` (env, `M/D/YYYY`,
currently `7/30/2026`): orders dated before it must never be **created** in
Velocity via any path. The clamp lives inside `buildVelocityRecords` (the
record builder), so the CSV export and the API upload both inherit it —
`effective_from = max(requested_from, floor)`; an entire range before the
floor yields zero records with an explicit `range_before_floor` indication
(HTTP 400 on both routes). Clamping is reported when it happens ("requested
7/1..7/30, clamped to 7/30..7/30"). Missing/unparseable floor **fails fast**
— never defaults to "no floor". Rationale: pre-floor history was uploaded
manually; recreating it would duplicate or resurrect orders Velocity already
has. The floor gates CREATION only — reconciliation (below) audits matched
existing orders regardless of floor.

**Row selection (in order):**
1. **Order date (Col C, `M/D/YYYY`) within `[from, to]` inclusive.** Parsed by
   splitting on `/` and constructing a local `Date(y, m-1, d)` — **never**
   `new Date(str)` (format/timezone-safe). Out-of-range rows are silently
   excluded; a Col C that does not parse is a `unparseable_date` skip (never
   silently dropped).
2. **Status not `canceled`** (`.toLowerCase().includes()`, same as the COGS
   sync). `closed` rows remain uploadable — closed ≠ canceled for prep.
3. **Col AS (prep cost) > 0.** `AS = 0` or empty (per §3, empty on a real row
   means 0) → the order is **self-prepped** and never goes to Velocity. Counted
   as **`excluded (self-prep): N`** — a separate, intentional tally, NOT a skip.

**SKU join:** for each selected row's ASIN, use `asins.primary_sku` where
`has_live_offer = TRUE`.

**Skip taxonomy** (fail-closed; each skip carries `{orderNumber, asin,
itemName}`):
- `no_live_sku` — no `primary_sku`, or `has_live_offer ≠ TRUE`
- `missing_quantity` — Col AZ empty on a selected row
- `unparseable_date` — Col C does not parse
- ~~`bundle_unsupported`~~ RETIRED for complete groups (2026-08-31) — see
  **Bundles** below. Incomplete/unbuildable bundle groups skip under the
  bundle taxonomy there; complete groups build real bundle records.
- `bundle_incomplete` — a bundle group's row count ≠ its Col S value: the
  remaining components live in ANOTHER order (cross-order composition —
  observed live: B00HX01Z5O, Col S=3 with one component row in each of two
  orders) or the sheet is mid-edit. Cross-order bundle assembly is
  DEFERRED; these skip fail-closed, never guessed.
- `bundle_component_bad_yield` — a bundle component's Col T
  (asin_qty_per_product) is missing/unparseable, or the derived
  units-per-bundle / total units don't come out as positive integers.
- `bundle_sets_disagree` — Col N differs across a bundle group's rows; the
  set count is ambiguous, skip fail-closed.
- `bundle_shipped_unidentified` — a fully-shipped bundle of this ASIN
  exists in Velocity with unrecoverable child keys (see "Shipped-bundle
  identity gap"); ALL bundle creates for the ASIN are suppressed rather
  than risk re-creating it.
- `invalid_pack_math` — `sold_as` is `multi-pack` AND (Col AY
  `units_per_pack` is not a positive integer OR Col AZ `quantity` is not
  divisible by it). Velocity enforces divisibility; catch VA typos before
  they do.

**Bundles (2026-08-31).** A bundle = the rows sharing `(order, ASIN)` with
Col S ≥ 2 (unique products per ASIN); Col AX reads `bundle`. Ground truth
from Maria's manual dashboard entry (B0GNHTYGPF, 2026-08-30) and the raw
GET: the parent carries `asin` / `amazon_sku` / bundle `item_name` (Col I) /
`sold_as bundle` / `units_per_pack` (component units per set) / `quantity`
(TOTAL units) — and **`order_number` + `retailer` are NULL on the parent**;
they live on each `bundle_children` row, which are order-like rows with
their own `order_id` and a `bundle_order_id` pointing at the parent.

- **Derivation (the sheet's AY/AZ are NOT inputs):** sets `N` = Col N;
  component units = Col L (qty ordered) × Col T (yield — a 5-pack supplier
  product ordered ×1 with T=5 contributes 5 units); `units_per_bundle` =
  Σ (component units ÷ N); parent `quantity` = N × units_per_bundle =
  Σ component units. Per component: `item_name` = Col G product name,
  `quantity` = its units, `order_number`/`retailer`/`date` from its row.
  When Maria fills AY (= units per bundle) / AZ (= total units) they are
  CROSS-CHECKED against the derived values and mismatches are FLAGGED in
  the build report — never used as inputs (they were observed wrong:
  AY=1/AZ=7 on the B0GNHTYGPF rows vs ground truth 2/14).
- **Write path (corrected 2026-09-03, proven by the TEST first write):**
  `POST /inbound` as **multipart/form-data with `bulk=false`**, ONE order
  per call (the bulk CSV cannot carry `bundle_items`; decoded from a
  dashboard capture). Every scalar is a STRING; blanks are EMPTY STRINGS
  PRESENT — including top-level `order_number`/`retailer` (parent-null
  contract) and `unit_cost`/`list_price` (cost privacy as
  empty-not-omitted). Dates go as **YYYY-MM-DD** (the sheet's M/D/YYYY is
  converted; Velocity serializes back zero-padded MM/DD/YYYY on GET).
  `bundle_items` is a JSON.stringify'd array of FULL order-shaped children
  mirroring the capture verbatim: filled item_name/quantity(string)/
  order_number/retailer/date; empty asin/amazon_sku/size/brand_sku/color/
  unit_cost/list_price/client_notes/upc; `fulfillment_type` literally
  `"-- select an option --"`; `sold_as "individual"`; `units_per_pack ""`;
  empty arrays trackings/bundle_items/shipping_labels/transparency_files.
  Per-child `order_number`/`retailer`/`date` land verbatim (GET-back
  verified, incl. children `sold_as` normalized to "individual" and child
  fulfillment_type to "fba" server-side). If the API rejects or drops
  per-child fields, STOP and report — no PUT improvisation.
- **Docs-wrong item #7 (2026-09-03):** JSON is NOT accepted on the
  single-order POST — two JSON attempts (number-typed and string-typed
  quantity) both 400'd "Quantity must be a valid number." with the field
  present; the validator reads multipart form fields only. And POST dates
  must be ISO YYYY-MM-DD, not the M/D/YYYY the docs imply.
- **Match key (dedup / fetchAllKnownOrders / reconciliation):** a bundle's
  identity = `bundle_children[].order_number` × parent `asin` — one key
  per distinct child order number, since the parent's own `order_number`
  is null. Keyed this way the manual B0GNHTYGPF classifies `matched`; on
  the parent key alone it sat in `unmatched_velocity`. Quantity audit
  compares UNITS (parent quantity vs derived N × units_per_bundle).
- **Velocity docs discrepancies (4, recorded 2026-08-31 — their docs have
  been wrong before):** (1) POST docs mark `color`/`brand_sku`/
  `unit_cost`/`list_price` Required — the live manual entry has them
  empty/null; (2) POST field is `bundle_items` but GET serializes
  `bundle_children`; (3) the documented `bundle_items` item schema omits
  `order_number`/`retailer`, which is exactly where they actually live;
  (4) pagination metadata documented as `total` is actually
  `total_results`, and `tracking_numbers` (POST docs) serializes as
  `trackings` on GET.

**Record columns** (exact header + order, CRLF line endings, matches Velocity's
sample):
`fulfillment_type,date,retailer,order_number,item_name,color,brand_sku,size,quantity,asin,amazon_sku,unit_cost,list_price,client_notes,trackings,sold_as,units_per_pack`
- `fulfillment_type` = `"fba"` (constant); `date` = Col C verbatim;
  `retailer` = Col E; `order_number` = Col B; `item_name` = Col I;
  `quantity` = Col AZ verbatim; `asin` = Col H; `amazon_sku` = joined SKU;
  `sold_as` = Col AX verbatim; `units_per_pack` = Col AY verbatim.
- `color, brand_sku, size, unit_cost, list_price, client_notes, trackings` =
  empty. `unit_cost` / `list_price` are ALWAYS empty by design — matches the
  manual-CSV format Velocity has accepted, and COGS/pricing never leaves AF
  (cost privacy). This holds for every delivery path.

`buildVelocityRecords` returns `{ records, selfPrepExcluded, skips }` and is
**delivery-agnostic** — the phase-2 API client consumes the same `records`.

### Velocity API delivery (phase 2)

Pushes the same records straight to Velocity's inbound API instead of a manual
CSV upload. Docs: `https://docs.velocityprepservices.com/` (introduction,
warehouses, inbound).

**API client** (`server/velocity-api.ts`):
- Base URL `https://api.velocityprepservices.com/api/v1`; auth header
  `Authorization: ApiKey ${VELOCITY_API_KEY}`; warehouse scoping via
  `X-Warehouse-Id: ${VELOCITY_WAREHOUSE_ID}` header. Both env vars required —
  fail fast with a clear message if either is missing. (Warehouse 1 =
  "Velocity Prep Services", code 001, the only/default warehouse as of
  2026-07-30.)
- `listInboundOrders({limit, offset, ...})` — `GET /inbound`, paginated
  (`data.orders[]` + `data.results.total_results`).
- `submitBulkCsv(csv)` — `POST /inbound` as `multipart/form-data` with
  `bulk=true` and the CSV attached as `file`. Sends the EXACT
  `serializeVelocityCsv` output — the format Velocity has accepted from our
  manual uploads. The per-order form-data path is deliberately NOT built: its
  required color/brand_sku/unit_cost/list_price fields are blank in our
  records; the CSV parser tolerates blanks, per-order validation is an
  unknown we don't need.
- Any non-2xx or `status ≠ "success"` response is a failure with the API's
  `errors` array surfaced verbatim. On 429: back off and retry once, then
  fail.

**Dedup — Velocity is the truth; no local gatekeeper ledger:**
- Before sending, the match set is the COMPLETE-COVERAGE union
  (`fetchAllKnownOrders`, 2026-08-11): `GET /inbound` + `GET /inventory` +
  every `GET /shipments/:id` detail. `GET /inbound` serves ONLY active
  inbound orders (verified: status params silently ignored) — checked-in
  orders live in `/inventory`, fully-shipped orders ONLY in shipment details
  (near-miss 2026-08-07: two completed orders classified as CREATE and would
  have duplicated on send). Union precedence inbound > inventory > shipment;
  shipment-derived rows are pseudo-orders (`status "shipped"`, quantity =
  `quantity_shipped` — never quantity-audited). **Fail-closed:** any leg
  failing, or a malformed shipment detail, aborts the plan — CREATEs are
  never classified against a partial match set.
- **Union dedup keys are CHILD-DERIVED (2026-09-02).** The cross-leg dedup
  originally keyed `(order_number ?? "", asin)` — bundle parents carry
  `order_number` null, so every bundle of the same ASIN collided on
  `("", ASIN)` and all but the first were silently dropped BEFORE
  `matchKeysForOrder` could derive keys. Live incident: the moment a second
  B0GNHTYGPF bundle was entered, the 8/30 one vanished from the match set
  and its sheet group became a phantom CREATE (caught at the first-write
  pre-flight, 2026-09-02 — nothing was sent). `unionKnownOrders` now
  registers each order under its `matchKeysForOrder` key set (bundles → one
  key per distinct child order number × parent asin) and drops an order
  only when ALL its keys are already seen; leg precedence unchanged.
- **Shipped-bundle identity gap (2026-09-02):** fully-shipped bundles exist
  ONLY as shipment-detail pseudo-rows, and the API serializes
  `bundle_children` on LIST endpoints alone (`/inbound`, `/inventory`) —
  shipment details and direct `GET /inbound/:order_id` omit them entirely
  (docs-wrong item #6), so a fully-shipped bundle's child keys are
  unrecoverable. Rule: shipment-leg bundle pseudo-rows are HYDRATED
  in-batch by `order_id` from the inbound/inventory legs (covers
  partially-shipped bundles whose parent is still list-visible); bundles
  visible only as child-less shipment rows are surfaced as
  `unidentifiedShippedBundles`, and the plan SUPPRESSES every bundle
  create for those ASINs with skip `bundle_shipped_unidentified` — loud,
  fail-closed, no persistent identity table (revisit only if this skip
  recurs in practice). Live case: B0GWG5S64Q shipped 2026-09-02 and its
  sheet group became a phantom CREATE until this rule.
- **Pagination tripwire, fail-closed both ways (2026-09-02):** on /inbound
  and /inventory, `data.results.total_results` must be present and finite —
  a missing/moved metadata field THROWS (no silent `?? 0` / `?? page
  length` fallback); after paging, fetched ≠ total THROWS. No plan, dedup,
  or execute runs on partial coverage — silent partial coverage is worse
  than no dedup. (Docs-wrong item #5: their pagination metadata is
  documented as `total`; the real field is `data.results.total_results`.)
- Match key: `(order_number, asin)`, both trimmed; `order_number` compared as
  an exact string, `asin` case-insensitively.
- Records matching an existing Velocity order are dropped as
  **`already_in_velocity: N`** — a separate intentional tally like self-prep,
  NOT an error. Orders deleted in Velocity are simply absent from the list,
  so re-upload works with zero special handling.
- ⚠️ Velocity normalizes `date` to zero-padded `MM/DD/YYYY` on ingest (ours
  are unpadded `M/D/YYYY`). Irrelevant to the (order_number, asin) key, but
  any future date-scoped listing/compare must parse dates, never
  string-compare.

**Endpoint:** `POST /api/upload/velocity?from=&to=` (POST, not GET — it
writes to an external system). Params as the export. Flow: build → guards →
dedup → `submitBulkCsv` → JSON report
`{sent, alreadyInVelocity, selfPrepExcluded, skips[]}`. `&dryRun=1` does
everything EXCEPT the POST and reports what would be sent.

No cron, no UI button yet — those come only after the first real upload
succeeds. First-write protocol: a single deliberately-fake row
(`AF-TEST-001`, obviously-fake item name, qty 1, real ASIN+SKU) round-tripped
via `submitBulkCsv` + `listInboundOrders`, then deleted from the Velocity
dashboard by Maria; the endpoint is cleared for real use only after her
confirmation.

### Velocity reconciliation (plan → approve → execute)

Replaces "already-in-Velocity → silently drop" with a classified plan.
`server/velocity-reconcile.ts`; the floor + dedup + plan-approval + aggregate
check are **layered defenses covering distinct failure classes** — none
replaces another.

**Match key** (as dedup): normalized `(order_number, asin)` — both trimmed,
`order_number` exact string, ASIN case-insensitive. Dates are always
parse-then-compare (Velocity zero-pads `MM/DD/YYYY`). The match set is the
complete-coverage union above — completed (inventory/shipped) orders MATCH
and land in the closed/flag-only buckets, never CREATE.

**Classification** (sheet rows fetched at full range for matching, not just
the upload window):
- **CREATE** — sheet row passes all selection rules (date ≥ floor, in
  requested range, not canceled, prep > 0, live SKU, pack math) and has no
  Velocity match.
- **UPDATE** — matched pair where the audited field differs. The per-order
  audit is **QUANTITY ONLY**: actionable qty mismatches
  (`{order_id, asin, sheet_qty, velocity_qty}` via the diff), not SKU/date
  noise — amazon_sku, date, sold_as, units_per_pack are deliberately NOT
  audited on existing orders (sold_as / units_per_pack still pre-validate
  CREATEs via the pack-math guard). Quantity covers the partial-cancel case
  (supplier OOS).

  **Assertion rules** (a null/empty sheet value is NO ASSERTION — older sheet
  rows predate the Velocity columns AX–AZ; writing null over a real Velocity
  value would be destructive): `quantity` proposes an update only from a
  **positive integer**; an explicit 0 is full-cancel territory — manual
  review, never an update.

  **Shipped/received pairs are compared too.** The quantity comparison runs
  on ALL matched pairs regardless of Velocity status; a mismatch on a
  shipped/received (or unknown-status) order is included in `updates` with
  `actionable: false` — displayed as a flag (amber, "not editable — order
  already shipped"), no checkbox, never a PUT target. Execute independently
  re-checks live status, so a stale flag can't be forced through.
- **DELETE-CANDIDATE** — matched Velocity order whose sheet row is now
  canceled. The API has **no DELETE endpoint** (POST/GET/PUT only, verified
  2026-07-30; edit/delete is a dashboard feature) — delete-candidates are a
  **manual-action list** ("delete these in the Velocity dashboard"), never an
  automated write. Undocumented endpoints are not probed.
- **UNCHANGED** — matched, no diffs. Count only.
- Skips keep the existing taxonomy and appear in the plan.

**Audit scope is bound by Velocity order STATUS, not date.** Only
still-actionable orders are classified for UPDATE / DELETE-CANDIDATE.
Actionable = status `inbound` (the only observed value across all 44 orders,
2026-07-30; docs name `outbound` = shipped — an unknown status is treated as
closed, fail-safe). Non-actionable orders count as `closed_in_velocity: N`
and are never audited per-order (changes to shipped orders are moot; keeps
the audit set small as history grows). **No date floor on reconciliation** —
pre-floor orders (e.g. the 7/18–19 manual uploads) stay auditable while
actionable. Velocity orders with no sheet match at all are counted
(`unmatched_velocity`) but never touched.

**ASIN-level aggregate check — REMOVED (2026-07-30).** The former aggregate
category (per-ASIN sheet-total vs. Velocity-total sums) was deleted, not
hidden. Rationale: per-PO quantity comparison on matched pairs — INCLUDING
shipped/received orders (flag-only, no action) — catches the cross-order
check-in case directly: a partial cancel on the sheet vs. a full check-in in
Velocity is a per-PO mismatch on that order. Dead code with opinions is a
hazard; remove, don't hide.

**Approval contract:**
- `GET /api/velocity/plan?from=&to=` — read-only; full JSON: creates
  (complete records), updates (quantity diffs, `actionable` flag),
  delete-candidates, unchanged + closed counts, skips. (Endpoint name is
  internal — the UI never says "plan", see the dialog spec below.)
- `POST /api/velocity/execute` — body carries the approved plan's items;
  executes ONLY what was submitted, nothing inferred. Creates via
  `submitBulkCsv` (re-checked against live Velocity so a double-execute
  cannot double-create); updates via `PUT /inbound/:order_id`.

  **⚠️ Velocity's PUT is FULL-REPLACE — their docs claimed partial update
  and were FALSIFIED by live testing (2026-07-30).** Three observed failure
  modes on the dress-rehearsal order: (1) `{quantity}` alone → API nulls the
  omitted `date` (NOT NULL violation); (2) adding the documented field set →
  nulls `fulfillment_type`; (3) omitting `trackingNumbers` → their handler
  crashes ("'NoneType' object is not iterable") — an explicit `[]` is
  required. **Future sessions: trust observed behavior over their docs for
  this endpoint.**

  Updates therefore send an **echo-merge body**: the order's CURRENT values
  for `date, retailer, orderNumber, itemName, asin, amazonSKU, sold_as,
  units_per_pack, fulfilledBy, trackingNumbers`, overridden only by the
  approved change (quantity-only audit ⇒ only `quantity` can differ).
  **Echo freshness rule:** the GET that sources echo values happens at
  EXECUTE time, immediately before the PUT loop — never reuse order values
  cached from the plan/review fetch. The review screen can sit open for
  minutes; echoing stale values would full-replace away interim
  Velocity-side changes. (Casing is MIXED per docs — `amazonSKU`/
  `orderNumber`/`itemName` camelCase but `sold_as`/`units_per_pack`
  snake_case; `quantity`/`date` as-is.)

  **`fulfilledBy` rail (reworded for full-replace): never SET it to a
  different value.** It is echoed verbatim from the order's current
  `fulfillment_type` because omitting it is impossible under full-replace;
  structurally no diff can carry it (quantity-only audit). `cogs`/
  `listPrice` are still never sent (cost privacy; null on our orders and
  stay null). Pack math is pre-validated (skip with
  `invalid_pack_math` rather than send a doomed PUT). Velocity errors surface
  verbatim per-item; partial failures are reported per-item, not rolled back.
- The "Upload to Velocity" dialog (below) is the approval flow: review →
  select → send.

### Upload to Velocity dialog

Single-user tool (Maria) — no VA-oriented affordances, no sub-page, no
history view, no scheduled/auto anything. UI vocabulary: **"Upload to
Velocity"** — the word "plan" appears NOWHERE in the UI (internal endpoint
names are unchanged).

**Entry point:** "Upload to Velocity" button in the POs shell toolbar (§8).
Not added to the ASINs toolbar (already crowded — deliberate skip).

**Full-screen dialog** (Add-to-SC preview pattern: wide `DialogContent`,
scrollable sections, §7 design system, no new structural colors; portal like
the SKU popup if stacking demands it — no z-index arms races).

Flow:
1. **Header**: date-range picker, default today. Changing it re-fetches.
2. On open, fetch the reconciliation for the range; sections in order:
   a. **NEW ORDERS** — full record rows (date, retailer, order #, item, qty,
      sold_as/upp, ASIN, SKU). Checkboxes **PRE-TICKED**; uncheck to
      exclude.
   b. **QTY MISMATCHES** — order # · ASIN · sheet qty vs Velocity qty.
      Checkboxes **UNTICKED** (opt-in per row → becomes a quantity PUT).
      Shipped/received mismatches: displayed, amber per §7, no checkbox,
      label "not editable — order already shipped".
   c. **SKIPPED** — rows with reasons. `no_live_sku` rows get a
      **"Create SKU & include"** action: runs the §18 offer-add for that
      ASIN via the existing batch flow; on ACCEPTED (standing rule) the row
      shows the resulting SKU inline and moves into NEW ORDERS pre-ticked —
      same dialog, no re-fetch of the whole set, row expands inline (no
      nested modal). Gated/dead ASINs: reason shown, excluded, no button.
      **`legend_pending` is not a dead end (2026-08-04):** when the offer-add
      returns `legend_pending`, the row expands inline (same no-nested-modal
      pattern) showing what needs approval — the derived brand code and/or
      dept code, each an editable 3-char input prefilled with the proposal —
      with **Approve / Cancel**. Both appear in the one expansion when both
      are pending. Approve commits via `POST /api/sku-legend/approve` — the
      SAME single legend writer the Add-to-SC preview uses (§18 ownership;
      `approve_in_place` when a proposed `legendId` exists, `approve_new`
      otherwise) — then automatically re-fires the offer-add and continues
      the existing success path (SKU shown, row promoted into NEW ORDERS
      pre-ticked, no re-fetch, no dialog restart). Approval errors (e.g.
      code collision) render inline in the expansion for correction. Cancel
      collapses the expansion and leaves the row skipped, as today.
   d. Collapsed one-line counts: unchanged / **shipped** / unmatched —
      expandable, display-only. UI vocabulary is "shipped", never "closed"
      ("closed" collides with the Orders-sheet status vocabulary and reads
      as a closed PO); the internal category key stays `closedInVelocity`.
      Explainer: "Shipped — matched orders already shipped/received with no
      quantity mismatch; not editable." — unified with the "order already
      shipped" tag on mismatch rows.
3. **Footer**: "Send to Velocity (N)" — count reflects current selections.
   Confirmation states exactly what fires: X new orders, Y quantity
   updates. On confirm: POST execute with the selected items only.
4. **Results** render per-row in the same dialog: green success / red
   failure with Velocity's error text verbatim. Dialog stays open until
   closed manually.

### SellerBoard COGS export (INTERIM — bandage)

> **Interim, not the target state.** SellerBoard remains the trusted P&L only
> until the Actuals audit lands; this export is a bandage that pushes YTD PO
> landed costs into SB as per-PO cost periods so SB's numbers aren't stale in the
> meantime. It is **superseded by the Actuals audit** and should be removed once
> AF's own actuals are trusted.

Read-only against AF — **no DB reads/writes, no SC, no cron.** Inputs: the Orders
sheet (`fetchSheetRows`) + an uploaded SB products template xlsx. Built by
`server/sellerboard-cogs.ts` (`buildSellerboardCogs(templateBuffer)`), delivered
by `POST /api/export/sellerboard-cogs` (multipart `file` upload). Gated by Google
credentials + `GOOGLE_SHEET_ID`.

**Step 1 — ASIN → SKU map from the template** (sheet `TDSheet`, columns `ASIN`,
`SKU`): one entry per (ASIN, SKU) row; ASIN normalized **trim + uppercase** (to
match the Orders side of the join), SKU trimmed only (SKUs are case-sensitive);
multi-SKU ASINs keep all SKUs. Rows missing ASIN or SKU are counted as
**templateRowsDropped** (never silent); repeats of an already-loaded (ASIN, SKU)
count as **templateDupeRows**. ASINs seen only on blank-SKU rows are remembered
so the join can report them as **inSbNoUsableSku** instead of not-in-SB.

**Step 2 — YTD PO cost periods** from the Orders tab: exclude **only** rows whose
status contains `canceled` (`.toLowerCase().includes()`, counted as
**excludedByStatus**). **Closed rows are included** — closed POs are completed
purchases, exactly the batch history SB needs (this matches the sheet client's
COGS canonical-row rule). ⚠️ This status rule **deliberately differs** from the
ordered-qty sync (`fetchSheetData`), which excludes closed **and** canceled
because it counts qty still on order; both sites carry cross-referencing
comments. Col C must parse (`M/D/YYYY`, split-on-`/` local Date, never
`new Date(str)`; failure → **badDate**) and fall in **2026** (YTD; a parsed
non-2026 date → **excludedNonYtd**). `Cost = parseMoney(Col Y) + prep`, prep =
`parseMoney(Col AS)` with an empty Col AS on a real row = 0 (§3). Col Y empty /
unparseable / ≤ 0 → **bad-cost** skip. `CostPeriodStartDate` = the Col C date as
`M/D/YYYY`, no leading zeros. Orders-side ASINs are normalized trim + uppercase
before keying/joining.

`BatchQuantity` = **Col U** from the **same canonical row** the cost came from.
Col U is **ASIN-level sellable qty** (raw units ÷ pack size), so **fractional
values are legitimate** and flow into the per-ASIN fractional collapse below;
the integer guarantee for the emitted CSV is enforced after collapse + rounding.
Col U empty / unparseable / non-positive on an otherwise-valid row → **badQty**
skip (`mode` ∈ `empty` / `non_numeric` / `non_positive`; zero qty = returned
order) — a cost row is **never** emitted with a blank qty (a blank
`BatchQuantity` flips the row to time-based-period semantics in SB).

Same-ASIN same-date collapse: same-day rows are **genuine separate orders**, so
they **merge into one batch** — `BatchQuantity` = sum of Col U quantities,
`Cost` = **qty-weighted average** (computed in integer cents, rounded to 2 dp;
e.g. 5@17.61 + 3@19.17 → 8@**18.20**). Same-cost rows are the trivial case of the
same average. Each merged period is counted as **`sameDateMerged`**
(informational: ASIN, date, merged row count, resulting qty + cost). A **badQty**
row is skipped *before* the merge, so it never participates — the remaining valid
rows merge among themselves (or pass through solo). Different dates = separate
periods (intended).

**Fractional collapse (after the same-date merge), per ASIN:** if **any**
included row for the ASIN had a non-integer Col U (detected at row level, not
from period sums, so fractions summing to an integer still trigger), **all** of
that ASIN's periods collapse into **one batch**: `BatchQuantity` = sum of all
quantities, `Cost` = weighted average over the **raw fractional** quantities
(integer cents, round half up), `CostPeriodStartDate` = the **earliest** period
date (the batch must cover the full sales window). All-integer ASINs keep their
separate dated batches. A still-fractional summed qty then **rounds half-up** to
the nearest integer; a batch that rounds to **zero is dropped** and its
constituent rows are reclassified as **badQty/`non_positive`** (decrementing
`includedRows`), so the row-accounting identity still balances. Counted as
**`fractionalCollapsed`** (ASIN, rows folded, final qty/cost/date) and
**`fractionalRounded`** (ASIN, raw sum → rounded; includes rounded-to-zero
drops) — both informational, like `sameDateMerged`.

**Step 3 — join + fan out:** for each (ASIN, date, cost, qty) period, emit one
CSV row per SKU the template maps to that ASIN, duplicating the **full batch
quantity on every SKU row** (per-SKU batches deplete independently in SB — the
qty is deliberately **not** split across SKUs). PO ASINs absent from the template
entirely → **notInSb**; PO ASINs present in the template **only on blank-SKU
rows** → **inSbNoUsableSku** (both counted as **distinct ASINs**, not periods;
export is idempotent so they pick up periods on a later run once SB knows them).
Template ASINs with no YTD PO are simply never emitted (untouched in SB).

**Row accounting (reconciliation identity).** Every Orders row read lands in
exactly one bucket — nothing exits the pipeline silently:

```
rawRowsRead = blankAsinRows + excludedByStatus + badDate + excludedNonYtd
            + badCost + badQty + includedRows        (remainder must be 0)
```

`rawRowsRead` is the total row count the sheet read returned (an
upstream-truncation tripwire, surfaced by `fetchSheetRowsWithMeta`);
`blankAsinRows` are rows dropped upstream for a blank Col H. `sameDateMerged`,
`fractionalCollapsed`, and `fractionalRounded` are informational (their rows
stay included — except a collapsed batch rounding to zero, whose rows are
reclassified from `includedRows` into `badQty`); `notInSb` / `inSbNoUsableSku`
are ASIN-level drops at the join, after row accounting. The identity (with remainder)
is printed by the dry-run script and logged by the endpoint.

**Output CSV** carries **all 15 template headers in template order**:
`ASIN,SKU,Title,Labels,CostPeriodStartDate,Cost,DomesticShippingCost,RestofworldShippingCost,ShippingProfile,Value_of_unsellable_returns,VAT,VAT_CATEGORY,Hide,Marketplace,BatchQuantity`.
Only `ASIN,SKU,CostPeriodStartDate,Cost,BatchQuantity` are populated; **every
other cell is an empty string** so a blank never overwrites SB-side state.
Named `sb-cogs-YYYY-MM-DD.csv`.

**Response** is JSON `{ filename, csv, summary }` (not a raw file, not headers):
`summary = { emitted, asins, periods, rawRowsRead, blankAsinRows, includedRows,
templateRowsLoaded, templateRowsDropped, skips: { excludedByStatus, badDate,
excludedNonYtd, badCost, badQty, sameDateMerged, fractionalCollapsed,
fractionalRounded, notInSb, inSbNoUsableSku }, notInSbAsins: [...],
inSbNoUsableSkuAsins: [...], badQtyRows: [{ asin, date, rawQty, mode }],
fractionalCollapsed: [{ asin, rowsFolded, qty, cost, date }],
fractionalRounded: [{ asin, rawSum, rounded }] }` (`mode` ∈ `empty` /
`non_numeric` / `non_positive`). The client builds the download from the `csv` string and shows a
summary modal with the full row accounting plus the **not-in-SB, no-usable-SKU,
and bad-qty lists expandable**; full detail (incl. merges, per-row badQty with
sheet row + cost, and the identity remainder) is logged server-side. Toolbar
button **"Export SB COGS"** opens the template file picker.

### Amazon sourcing cost export (Manage Your Sourcing Cost)

**There is no API.** Verified Aug 19, 2026 against the SP-API model list and the
Feeds API feed-type list: no endpoint, no feed, nothing on the roadmap. Sourcing
cost moves only through the **Bulk Update** button on the Manage Your Sourcing
Cost page in Seller Central. AsinFlow's job is to prepare that file; the upload
is a manual step and always will be until Amazon ships something.

**This export fills a workbook — it does not generate one.** Amazon owns the row
set and seven of the eight columns. We own exactly one cell per row. Contrast
with the SellerBoard export above, which emits rows from a header list.

Amazon's workbook (`Part_1`..`Part_N` sheets, one row per **ASIN + FNSKU**):

| Column | Owner | Notes |
|---|---|---|
| `Asin` | Amazon | match key |
| `Fnsku` | Amazon | row key — an ASIN can have several |
| `Amazon Estimated Cost` | Amazon | their valuation, per FNSKU |
| `Latest Approved Cost` | Amazon | what reimbursement currently uses |
| `Source of Latest Approved Cost` | Amazon | `AMAZON` or `SELLER` |
| `Currency` | Amazon | `USD` |
| `Date of Last Updated Cost` | Amazon | ISO-8601 **string**, never a date cell |
| **`Seller New Cost`** | **AsinFlow** | the only cell we write |

Columns are located **by header text, never by index**. A missing `Asin` or
`Seller New Cost` header throws rather than writing into the wrong column.

**Cost source: `actual_cogs`, and only where `cogs_source = 'po_sheet'`.**
Sourcing cost sets Amazon's reimbursement valuation for lost/damaged units and
is gated on invoice review, so only a cost with a PO behind it is defensible.
`estimated_cogs` is never submitted. Neither is a `manual`- or `csv`-sourced
actual — those ASINs are skipped and named in the summary, never guessed.

**Confirmed Aug 20, 2026 (Maria): keep this filter narrow.** Widening it to any
`actual_cogs` regardless of source was considered and rejected — non-PO costs
have no invoice behind them, and every submission is document-gated, so a wider
filter only manufactures rejections while spending the scarce per-FNSKU update
attempts (see "attempt budget" below). A cost AsinFlow cannot document is a cost
Amazon will not approve. The
value written is always the latest PO cost on record, regardless of which window
selected the ASIN.

**Scope: ASINs purchased inside the selected date range**, per the PO sheet
(Col C order date, Col H ASIN). Canceled rows are excluded; `closed` IS a
purchase. The range picks *which ASINs*, not which cost.

**Never lower an approved cost — the higher number always wins.** If Amazon's
`Latest Approved Cost` is above our PO cost, the row is skipped and Amazon's
number stands, whatever its source. This is a standing instruction from Maria
(Aug 20, 2026), not a heuristic to be re-litigated by a future refactor.

The reasoning is the asymmetry of the system, measured on the first live upload
(985 rows): Amazon accepted **73.5% of cost reductions** and only **17.2% of
increases**. Combined with a cap of two update attempts per FNSKU per 30 days
(failed attempts count), the process ratchets one way — value surrendered is
effectively unrecoverable. Amazon's definition compounds it: sourcing cost
"specifically excludes shipping, handling, customs duties (tariffs), and other
costs," so the reimbursable value already sits below true landed cost before any
of this. Against a real loss rate that includes entire boxes going missing, a
volunteered reduction is a straight cash loss.

So: never correct downward. Correct upward whenever a PO supports it.

**Never resubmit an approved cost.** A row is skipped when
`Source of Latest Approved Cost = SELLER` **and** `Latest Approved Cost` already
equals the cost we would write. Resubmitting spends a bulk-upload attempt
(sellers hit "Number of attempts exceeded") and re-opens a settled row to
document review for no gain. An `AMAZON`-sourced approval at the same number is
**not** skipped — we still want that row seller-backed.

**Fan-out.** One ASIN's cost is written to every FNSKU row Amazon lists for it.
`asinsWritten` counts ASINs; `rowsWritten` counts cells, and is the larger number
whenever a multi-FNSKU ASIN is in scope.

**Workbook fidelity.** The file is written with SheetJS `bookSST: true`. This is
load-bearing, not cosmetic: without it SheetJS emits text cells as `t="str"`,
which in OOXML means *cached result of a formula* — malformed on a cell with no
`<f>`, and a POI-based reader (which Amazon's bulk upload almost certainly is)
can return null for every string column. Verified against a live 1,415-row
workbook: with `bookSST` all seven Amazon columns read back byte-identical under
an independent parser, and the untouched `Seller New Cost` cells stay empty
strings rather than vanishing. **Do not drop this flag.**

Row accounting is closed:
`rawRowsRead = blankAsinRows + excludedByStatus + badOrMissingDate + excludedOutOfRange + includedRows`.
The remainder is logged, as in the SB export.

**Operating model (set Aug 20, 2026).** Three distinct phases, not one
recurring job:

1. **Backfill (one-off, in progress).** Bring the whole catalog current. This is
   the only phase that touches large row counts, and it is the only reason the
   attempt budget was ever tight.
2. **Steady state — new POs only.** A run submits an ASIN *only* when a new PO
   has moved its cost above what Seller Central currently has approved. ASINs
   whose cost has not changed are never revisited. In practice this is a handful
   of rows per cycle, which keeps every FNSKU well inside its 2-per-30-days
   allowance without any scheduling cleverness.
3. **Quarterly full sweep.** Re-scan the whole catalog for rows where *Amazon's
   own estimate* has risen above the approved value, and submit their number
   back (the restore-to-estimate path — auto-approves, needs no invoice). Amazon
   revises its estimates over time and never volunteers the increase; this sweep
   is the only way to collect it.

**This collapses the two guards into one rule.** Given the model above, the
export writes a row if and only if:

    submit  ⟺  cost > Latest Approved Cost

where `cost` = the PO cost in steady state, or Amazon's estimate in the sweep.
Everything else falls out of it — a reduction is skipped because it is not
greater, an already-approved value is skipped because it is not greater, and an
unchanged cost is skipped because it is not greater. `wouldLowerApproved` and
`alreadyApproved` remain as separate skip *counters* for diagnostics, but they
are two faces of one condition, and no future change should reintroduce them as
independent rules.

**Endpoints**
- `POST /api/export/sourcing-cost` — multipart `file` (Amazon's workbook) plus
  `from` / `to` as `YYYY-MM-DD`. Returns
  `{ filename, xlsxBase64, summary }`. Filename is
  `amzn-sourcing-cost-<from>_<to>.xlsx`.
- `GET /api/export/sourcing-cost/history` — the 50 most recent exports.

`summary.skips` = `{ excludedByStatus, badDate, outOfRange, noCogsRow,
notPoSourced, badCost, notInWorkbook, alreadyApproved }`, each with its ASIN
list expandable in the modal. Full detail — including every cost written and
what it replaced — is logged server-side under `sourcing-cost`.

**Export history** (`sourcing_cost_exports`, migration 027) records one row per
file **generated**. Seller Central issues no upload receipt, so this is a
coverage log, not a confirmation that Amazon accepted anything. A history write
failure is logged and swallowed — it must never cost the user their file.

**UI.** Toolbar button **"Export Sourcing Cost"** opens the workbook picker and
uses the global date range. The clock icon beside it opens the history list.

**Not automated, by design.** The upload leg is manual and invoice-gated, so
there is no cron. Weekly cadence is a human habit, not a scheduled job.

### Google Sheets sourcing sheet (insert-only)

- **Sheet ID:** `1i4kUDG02qIMnhVnSjJ6LRZTuWFNzvP1SVKAmRoXS6kU` (separate from the PO tracker)
- **Tab name:** `ASINs`
- **Range:** `ASINs!A2:AS`
- **Configured via:** `SOURCING_SHEET_ID` env var (mirrors `GOOGLE_SHEET_ID` pattern)

Column mappings:

| Column | Index | Field | Notes |
|---|---|---|---|
| E | 4 | Status | `.toLowerCase().includes("discontinued")` triggers archive (new-insert only) |
| I | 8 | ASIN | Match key, `.trim()` |
| N | 13 | Buy Link | Written to `asins.buy_link`; supplier derived via `extractDomain` |
| O | 14 | Coupons/Gift Cards/Sales | Written to `asins.promo_notes` on the new-ASIN INSERT branch only (asymmetric UPSERT, §14); empty cell → NULL |
| S | 18 | Est. COGS | Written to `asin_estimates.estimated_cogs`, `estimated_cogs_source = 'csv'` |
| AP | 41 | VA notes | Combined into `asins.notes` |
| AS | 44 | My notes | Combined into `asins.notes` |

**⚠️ Col AS means different things per tab.** On the PO `Sheet1` tab, Col AS =
Prep cost (numeric). On THIS `ASINs` tab, Col AS = "My notes" (free text).
The two sheet clients live in separate files (`server/google-sheets.ts` for PO,
`server/sourcing-sheet.ts` for sourcing) and the tab name is hardcoded in each
so they can never cross.

**Insert-only model.** AsinFlow is the source of truth. The sourcing sync:

- **Always skips ASINs that already exist in the `asins` table** — no update,
  no archive, no analyze. The sheet's only job is to add new ASINs to AF.
- For NEW ASINs (not yet in AF), runs the full analyze pipeline (SP-API
  pricing/catalog/fees/eligibility/hazmat) and inserts via the same write path
  CSV upload uses, with `estimated_cogs_source = 'csv'`.
- For NEW ASINs whose collapsed status contains "discontinued" (case-insensitive
  `.includes`), inserts and analyzes them, THEN sets `is_active = false` so
  they land in the Archived view. This is the only place the sync writes
  `is_active`, and only on rows it just inserted.
- An ASIN with multiple sheet rows is collapsed to one record per field:
  first non-empty value wins (mirrors `google-sheets.ts`'s "first non-canceled
  row per ASIN" pattern — top-of-sheet is canonical).
- Archive-on-insert requires EVERY status row for that ASIN to contain
  "discontinued" (empty status exempts). A single "order" row anywhere keeps
  the ASIN unarchived.

Notes combination: `{AS}\nVA: {AP}` — AS (My notes) renders bare with no
label; AP (VA notes) gets the short `VA: ` prefix. Each line only if that cell
is non-empty. Both empty → `notes = NULL`. For new ASINs, notes and
promo_notes are written atomically on the INSERT branch of the analyze UPSERT
(never via post-insert append — see §14 asymmetric pattern). The dedup-aware
`appendNotesForAsin` path applies only to pre-existing ASINs, and only to
notes — promo_notes has no append path at all.

COGS parsing: Col S goes through the shared `parseMoney` helper
(`shared/parse-money.ts`) — strips `$`/`,`/whitespace, returns `null` on
unparseable. Null cogs is acceptable: the new ASIN inserts with `cogs = 0`
(intentionally diverges from the CSV path, which skips NaN-cogs rows).

Triggers:
- Manual: `POST /api/sync/sourcing-sheet` (NDJSON-streaming, auth-gated). Wired
  to the "Sync Sourcing" toolbar button on the home page.
- Scheduled: `cron.schedule("0 9 * * *")` = 09:00 host-local, one hour before
  the inventory sync so newly-pulled ASINs are included in today's inventory +
  price passes. Defined in `server/sourcing-sync-cron.ts`. **Gated behind
  `ENABLE_CRONS` — disabled by default** (§11 "Scheduled crons").

### SP-API

Currently used endpoints:

- `getInventorySummaries` — inventory snapshot (FBA available, reserved,
  inbound shipped, inbound receiving)
- `GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL` — sales data (30-day
  max range; chunked sequentially with 2-second delays)
- Listings Restrictions API (`/listings/2021-08-01/restrictions`) — ungating
  status check
- `getItemOffers` (`GET /products/pricing/v0/items/{Asin}/offers`) — competing
  offer prices; **implemented** (drives the offer-add price resolver, §18).
- `getCompetitivePricing` — pricing / seller counts; `Summary.TotalOfferCount`
  for total seller count is **not yet built**.

Not yet integrated:

- **Finances API** — would provide actual Amazon fees, refund amounts,
  promo costs. Required for true Actuals (see Section 13).
- **Inventory Adjustments report** — for lost/damaged/found units.
- **Removal Orders report** — for removal-and-reship lineage.
- **Returns report** — for sellable/unsellable disposition.

### External tools (cross-reference for accuracy)

- **SellerAmp** — for sourcing decisions and gating/meltable verification
- **SellerBoard** — currently the trustworthy source for actual P&L. Used to
  cross-check AsinFlow's Actuals.
- **Keepa** — price history (graph URL pattern in code)

### Aura repricer (planned)

Repricing is handled by **Aura** (goaura.com). When implemented, COGS and MIN
prices will be pushed to Aura strategies (not the former Seller Snap API).
Inventory age buckets for the MIN floor:
- 0–60 days → 15% ROI floor
- 61+ days → 0% ROI floor (liquidation candidates)

Watch List for liquidation candidates surfaces in-app with manual approval
required before pushing MIN price overrides.

### Aura cost sync (planned)

One-directional **AF DB → Aura** cost push (never Aura → AF). It reads AF data
read-only and writes only to Aura — **no AF DB writes, no AF schema changes**.
It does **not** read the Google Sheet: the PO sync remains the sheet's sole
reader, and Aura consumes what the PO sync already wrote to AF. Design:

- **Source (read-only):** `asin_estimates.actual_cogs` + `prep_override`. Manual
  `actual_cogs` overrides flow through by design — whatever AF holds is what's
  pushed.
- **Mapping:** Aura's API exposes **SKU only, no ASIN** — bridge Aura listing
  `sku` → `asin_skus` → `asins` to reach the estimate row.
- **Cost pushed** = (`actual_cogs` + `prep_override`) **per unit, integer
  cents**. Aura's cost/price fields are integer minor units (e.g.
  `current_price` `3999` = $39.99).
- **NULL `prep_override` → treated as `$0`** for the push, and **flagged in the
  sync report** (mirrors the §3 prep-warning semantics — an absent prep value is
  a $0 assumption worth surfacing, not silent).
- **Fail-closed (skip + report, never guess):** unmapped SKU (no `asin_skus`
  row), ambiguous SKU (one SKU resolving to multiple ASINs), and NULL
  `actual_cogs` are skipped and reported — nothing is pushed for them.
- **Idempotent:** no API write when Aura's stored cost already matches the
  computed cents value; only changed costs are sent.
- **Runs after the PO sync** in the daily chain (so it pushes freshly-synced
  costs), plus a manual trigger. **Dry-run before any live push**, per AF's
  dry-run-before-writes principle.
- **Auth:** Aura API via the `AURA_API_KEY` env var (HTTP Basic — key as
  username, empty password).

**Implemented** (`server/aura-cost-sync.ts`): dry-run (`script/aura-dry-run.ts`)
+ capped live push (`script/aura-push.ts --limit=<n|all>`). Write contract is
`POST /listings/:id?currency=<listing.currency>&cost=<cents>` — **form/query
params, not a JSON body** (a JSON body is silently ignored → 2xx no-op), and
`currency` is **required** alongside `cost`. Persistence is verified from the
POST response object (`response.cost === sent`) plus a list-endpoint re-fetch.
No cron / route / toolbar button yet.

Skip semantics (learned in implementation):
- **Computed cost ≤ 0 is skipped fail-closed** (`SKIP:zero_cost`) — Aura rejects
  `cost=0`, and a zero COGS in AF indicates dirty data, not a real cost.
- **Unmapped SKUs are expected and correctly skipped** — Aura retains deleted SC
  listings, and never-stocked listings are invisible to `asin_skus`. No backfill
  planned.
- **`null_cogs` / `zero_cost` skips are expected and permanent** — sourcing leads
  listed in SC but never purchased have no PO row by design. Fail-closed skip is
  correct; no action needed.

### SP-API rate limiting (2026-09-06)

Every SP-API operation is metered by a token bucket (refill at a fixed
rate to a burst cap; empty bucket → `429 QuotaExceeded`). Motivating
incident 2026-09-04: Sync Prices on 2,208 ASINs fired `getItemOffers`
~3.3 rps into a 1 rps bucket — most calls 429'd, blind per-ASIN retries
tripled the load, projected runtime hours, no failed-list, progress strip
never rendered (gated on `isAnalyzing`). Root cause structural: pacing was
guessed per module.

Published limits for the operations AF uses (rate = req/s; the ceiling for
arbitrary-ASIN price pulls is **getItemOffersBatch: 20 ASINs/call at
0.1 rps = 2 ASINs/s → 2,208 ASINs ≈ 18 min**; nothing pull-based beats it):

| Operation | Rate | Burst | Items/call |
|---|---|---|---|
| getItemOffers | 1 | 2 | 1 |
| **getItemOffersBatch** | **0.1** | 1 | **20** |
| getCompetitivePricing | 0.5 | 1 | ≤20 |
| getMyFeesEstimateForASIN | 1 | 2 | 1 |
| getMyFeesEstimates (batch) | 0.5 | 1 | 20 |
| getCatalogItem / searchCatalogItems | 2 | 2 | 1 / ≤20 |
| getListingsItem / putListingsItem / searchListingsItems / getListingsRestrictions | 5 | 10 | 1 |
| getInventorySummaries | 2 | 2 | page |
| getItemEligibilityPreview | 1 | 1 | 1 |
| createReport / getReportDocument | 0.0167 | 15 | — |
| getReport | 2 | 15 | — |

(The per-call SP-API fees announced for 2026 were cancelled 2026-05-12;
cost is not a design input.)

**The limiter (`server/spapi-rate-limit.ts`)** — one shared client layer,
wired into `spApiGet/spApiPost/spApiPut` in `spapi-auth.ts` (the single
choke point; the S3 report-document download is a plain URL and stays
outside). Path→bucket mapping from the table; unknown paths pass through
un-throttled but logged, and the table is extended — never silently
throttled. FIFO release per bucket (bursts honored, steady state = the
published rate; callers keep their concurrency — serialization happens at
the wire). Header-adaptive: `x-amzn-RateLimit-Limit` on any 2xx/400/404
overrides the bucket's rate (logged). **429 handling lives here, once**: a
429 drains the bucket, transparent retry after a refill interval × a
penalty growing with consecutive 429s (cap ×4), up to 3, then thrown —
per-module retry loops (price-sync 3×backoff, analyze 2×2 s,
listings-offers-fetch 2200 ms doubling) are REMOVED, not layered. **Hard
timeouts** (decision 9): 30 s per API request, 120 s for the
report-document download (the S3 `axios.get` in sales-sync.ts and
suppression-sync.ts, applied 2026-09-07); a timeout is a per-item `error`
outcome, never a frozen job. Diagnostics: `rateLimitStats()` per bucket
`{rate, sent, throttled, adjusted}` — counters are process-lifetime, so
the Refresh job snapshots them at run start and reports PER-RUN DELTAS
(2026-09-07): "0 throttled" in a run report is proof for THAT run, never
diluted by history.
Dependency-free (no `server/index.ts` import). Unit tests: fake clock,
FIFO, burst-then-steady, header override, 429 drain/retry/throw, unknown
path passthrough.

### Refresh job & price refresh v2 (2026-09-06)

**One Refresh button** replaces Sync Inventory + Sync Sales + Sync Prices +
Scan Listings (decision 4; Sync PO, Sync Sourcing, Push to Aura stay
separate — decision 8). `POST /api/refresh` (NDJSON), body
`{asins, startDate, endDate}`; **scope = what is on screen** (decision 7):
the checkbox selection, else the current filtered view including Show
Archived / Show Gated; the client always sends the explicit list. Cron
scope (`asins` omitted) = every non-archived ASIN (`is_active = TRUE`),
sourcing leads included; archived only via the button (decision 10).

Stages, each with per-item outcomes, run concurrently where buckets differ;
`listings` waits for `inventory` (needs its SKUs), `prices` and `sales`
start immediately; full-catalog wall time ≈ the prices stage ≈ 18 min:

| stage | source | replaces |
|---|---|---|
| `inventory` | getInventorySummaries + SKU recording | Sync Inventory |
| `sales` | orders report, 30-day chunks | Sync Sales |
| `prices` | price refresh v2 (below) | Sync Prices |
| `listings` | live-offer reconcile (§18) | Scan Listings + the inventory-sync `notLiveOnly` rider (removed) |

A failed stage does not abort the others. Stream: `{type:"stage", stage,
status, current, total}` + terminal `{type:"complete", data:{stages,
rateLimits}}`; heartbeats as respondLongSync. Old routes stay as thin
one-stage wrappers (single implementation). Toolbar: one Refresh button
with working-set count, active-stage label while running, progress strip
un-gated from `isAnalyzing`; a results dialog shows per-stage counts,
expandable outcome lists, rate-limit stats, duration, and **Retry failed
(N)**; runs persist in `refresh_runs` (migration 032) with a history
clock. The 10:00/12:00 crons collapse into one daily Refresh (still behind
`ENABLE_CRONS`, default off). Dry-run (`?dryRun=1`, Velocity pattern):
listings reports would-be flips/discoveries, prices reports outcomes,
zero writes; the first live run is gated on a reviewed dry-run.

**Price refresh v2** (replaces price-sync.ts's three-pass design):
`getItemOffersBatch`, 20 ASINs/call; the Summary/Offers parser is
extracted to a pure `parseOffersPayload(asin, payload)` shared with the
single-ASIN analyze path (semantics unchanged); `writePrice` columns
unchanged BUT its COALESCE guards drop — a conclusive answer overwrites,
including to NULL. No blind retries: one main pass + ONE trailing pass
over `throttled`/`error` items. Per-ASIN outcomes:

| outcome | meaning | writes |
|---|---|---|
| `updated` | ≥1 price parsed | prices + seller counts + fetched_at |
| `no_offers` | 200, zero New offers | prices → **NULL**, sellers 0, fetched_at (decision 6 — conclusive: nothing is for sale; row becomes uncalculated) |
| `restricted` | 403/restricted | nothing |
| `not_found` | 404 | nothing |
| `throttled` | 429 survived limiter + trailing pass | nothing |
| `error` | timeout/5xx/parse | nothing (message kept) |

`fetched_at` stamps only the two conclusive outcomes — the honest price
age. **Run ledger `refresh_runs`** (migration 032, one table for all
stages): started/finished, scope, trigger (manual|refresh|cron), stage,
requested, per-outcome counts, `outcomes JSONB` (every non-updated ASIN +
error messages), `rate_limit_stats JSONB`. "Which failed" is a row, not
scrollback; retry-failed is one click.

**Price Age column** (`priceAge`, Additional info group, default hidden):
relative age of `pricesFetchedAt` ("2h"/"3d"), tooltip = timestamp,
em-dash when null; filter reuses the `reviewed` mechanism with neutral
labels ("Never synced" / "Older than" / "Within last").

**Future (not this patch):** ANY_OFFER_CHANGED push notifications belong
with the Repricer module; the consumer would write through the same
`writePrice` and the pull path would narrow to no-live-offer ASINs.

### Scheduled crons — disabled by default (`ENABLE_CRONS`)

Three node-cron schedules exist (down from five — the 2026-09-06 Refresh
job collapsed the live-offer, inventory, and price crons into one), all
in-process, registered in one block in `server/index.ts`:

| Cron | File | Schedule (host-local) |
|---|---|---|
| Sourcing-sheet sync | `sourcing-sync-cron.ts` | 09:00 |
| Daily Refresh (inventory + sales + prices + listings) | `refresh-cron.ts` | 10:00 — after the 09:00 sourcing sync so freshly added leads are included |
| Aura cost-sync chain | `aura-sync-cron.ts` | 13:00 |

**All three are gated behind a single env flag: `ENABLE_CRONS=true`. Unset or
any other value = no cron is scheduled.** Rationale (2026-08-01): the host Mac
is asleep at the scheduled times — node-cron fires host-local and silently
skips missed ticks, so schedules only ran when the machine happened to be
awake (08-01 incident: the 07:00/09:00/10:00 crons were all missed, machine
asleep until 11:28; only the 12:00 price refresh fired). **Manual toolbar/API
triggers are the operating model.** The cron code is kept, not deleted —
re-enable with `ENABLE_CRONS=true` at cloud deploy (§12 item 6).

The "EST/UTC" comments inside the older cron files are wrong: node-cron with
no timezone option fires in host-local time (documented in
`live-offer-cron.ts` / `aura-sync-cron.ts`).

---

## 12. Roadmap (Planned, Not Built)

In rough priority order:

1. **PO module** — replaces Google Sheets PO tracker. Two-level hierarchy
   (invoice + line items), per-PO landed cost per unit, gift card discounts,
   tax handling, refund reconciliation. Foundational for several downstream
   features.
2. **Inventory movement journal + FIFO costing** — depends on PO module. See
   Section 15 for the full lifecycle architecture.
3. **FBA inbound shipment reconciliation** — every shipped unit linked to a
   specific PO (or to a removal order, which traces back to a PO). Depends
   on PO module.
4. **Actuals data audit + Finances API integration** — see Section 13. The
   single largest data integrity issue in the system.
5. **Aura COGS + MIN price automation** — depends on PO module (§11 "Aura cost
   sync" + "Aura repricer")
6. **Auth + cloud deploy** — currently local-only
7. **Chrome extension rebuild** — injected content panel architecture
   (replaces the scrapped Side Panel approach)
8. **Prep center webhook integration** — depends on PO module. Parses
   shipment names per the convention above.
9. ~~**Offer-add resets `has_live_offer` to NULL on submitted ASINs**~~ —
   **SUPERSEDED (2026-08-01)** by the rider-scope change in §18b: the
   inventory-sync live-offer rider now probes `has_live_offer IS DISTINCT FROM
   TRUE` (never-checked `NULL` *and* stale `FALSE`), so a prior `f` verdict no
   longer hides a same-day Add-to-SC offer. No offer-add write needed — the
   flag keeps a single set of owners (rider / daily pass / §19 verify-sweep).

---

## 13. Known Data Ingestion Gaps

These are tracked here so we don't lose them. Each represents a column or
metric that exists in the UI but doesn't pull the right data today. To be
addressed in dedicated audit sessions.

### Critical: Actual P&L is broken

Per side-by-side comparison with SellerBoard for ASIN B07P7Y5J8H over the
same period:

| Metric | SellerBoard | AsinFlow |
|---|---|---|
| Sales | $777.05 | $777.05 |
| Refunds | 8 | 0 |
| Refund $ | -$121.98 | not captured |
| Net profit | $77.62 | $0.86 |
| Margin | 9.99% | 0.1% |
| ROI | 26.95% | 0.3% |

AsinFlow's Actual profit is roughly 90× lower than SellerBoard's — costs are
being substantially overstated somewhere in the calculation. The gap is not
"close to right with some missing data." The numbers are wrong by orders of
magnitude.

Specific known gaps:

- **Refunds** — not ingested from SP-API. Always shows 0 in the table, but
  refund effects may be leaking into the cost side of the calculation in an
  unexpected way that warrants diagnosis.
- **Amazon fees (FBA, referral, other)** — `actual_fba_fees`,
  `actual_referral_fees`, `actual_other_fees` columns in `sales_daily` are
  populated by the fee engine, not by Amazon's Finances API. The values are
  unverified.
- **Inbound shipping** — currently estimated, not actual.
- **Unit count drift** — minor (1–2 unit) discrepancies in some rows.
- **Cost double-counting** — suspected based on the magnitude of the
  understatement. Worth specific investigation: are fees being subtracted
  from both revenue AND from a derived field? Are COGS being applied per
  unit but multiplied by total units somewhere downstream?

Required work: full audit of every Actuals field's data path. Trace from
SP-API source → DB write → DB read → table render. Wire Finances API for
fee data. Wire refund ingestion. Verify Actual Avg. Sale Price calculation.
Reconcile against SellerBoard for at least 5–10 representative ASINs across
different volume bands. Plan a dedicated session with diagnosis before
patching.

Until this lands: AsinFlow's Actual profit / margin / ROI are NOT
authoritative. Use SellerBoard for real P&L decisions.

### Inventory adjustment data not synced

SP-API Inventory Adjustments report, Removal Order Details report, and
Returns Report are not yet ingested. Once synced, they feed the inventory
movement journal (see Section 15). Until then, lost/damaged/returned units
do not flow into AsinFlow's inventory state.

### Other gaps

- **Combined Sellers / Sellers 7d Δ / Sellers 30d Δ** — `sellersFbm` field
  is never populated. Need SP-API ingestion for `Summary.TotalOfferCount`,
  schema migration for `sellers_total`, history snapshots for deltas.
- **Meltable flag** — ASINs flagged as meltable in SellerAmp/Amazon don't
  show as meltable in AsinFlow. Diagnose: is the field captured from SP-API?
  Is the column rendering? Is the seasonal hide logic interfering?
- **`is_dangerous_good` over-flags (presence, not value)** — the current
  derivation (`isDangerousGoodFromAttributes` = `attributes.hazmat` non-empty)
  has ≥2 confirmed false positives (B07H3B443Q fuel filter, B001DKV5H8 lubricant
  — Amazon's SC dangerous-goods lookup says NOT DG). The hazmat array is a UN-
  transport block that non-DG items also carry (per-country `*_Unregulated`
  exceptions). **Ground-truth signal:** the catalog's own
  `attributes.supplier_declared_dg_hz_regulation` (`not_applicable` ⇔ not DG; a
  real regulation value ⇔ DG) — matched all four test ASINs exactly. Re-derive
  all 103 DG-flagged ASINs off `supplier_declared_dg_hz_regulation != not_applicable`,
  NOT hazmat-array presence. Fold into the hazmat/meltable audit with its own
  backfill discipline. (The offer-add payload already self-heals via
  `resolveDgHzRegulation` — §18 — so this backfill only fixes the stored column /
  UI DG icon, not submissions.)

---

## 14. Architectural Principles

A few things that aren't strictly rules but inform how decisions get made.

### Source of truth

Every piece of data has exactly one canonical source. Most current examples:

- Column structure → `COLUMN_GROUPS` in shared/schema.ts
- COGS and prep cost → DB fields populated by sync jobs
- Calculations → centralized functions (`getEstimatedProfit`,
  `getEffectivePrep`) that the entire UI reads from

When something has two sources (e.g., search input + ASIN selection both
representing one logical filter), they get consolidated. Two state
representations of the same thing is a bug, not a feature.

### Source-of-truth ownership per field

Each field on `asins` and `asin_estimates` has exactly one owning workflow
that writes it:

| Field | Owner |
|---|---|
| Pricing, fees, BSR, sellers | Analyze path |
| Catalog data (title, brand, category, dimensions, weight, etc.) | Analyze path |
| `estimated_cogs` | CSV upload / manual edit / Chrome extension / PO sync (when source ≠ manual) |
| `actual_cogs` | PO sync only (eventually FIFO calc) |
| `prep_override` | PO sync |
| `buy_link`, `supplier` | CSV upload / manual edit / Chrome extension |
| `supplier_sku` | CSV upload / manual edit — analyze MUST NOT write it (asymmetric-UPSERT INSERT branch only on the main path; never in the bulk sink's SET list) |
| Tags, notes | Manual / CSV upload / Chrome extension |
| `promo_notes` | Manual edit / Sourcing sync (new-ASIN INSERT branch only — never rewritten on re-sync/re-analyze, so manual edits are never overwritten) |
| `is_wholesale`, `is_oa` | Manual edit |
| `is_active` (archive) | Manual edit / Sourcing sync (only on freshly-inserted discontinued rows — never on pre-existing ASINs) |
| Aura listing cost (external, not an AF column) | Aura cost sync path (§11) — reads `asin_estimates`, writes only to Aura |

When a code path needs to touch a field outside its ownership, that's a red
flag. Either the architecture is wrong, or the workflow is misnamed.

### Analyze path constraints

The analyze code path (`/api/analyze`, `/api/analyze/all`, single-ASIN
refresh) refreshes Amazon-side data ONLY.

**Analyze MAY write to:**
- `asins`: title, brand, category, dimensions, weight, size_tier, in_catalog,
  is_meltable, is_hazmat, is_gated, gating_reason, is_listing_active
- `asin_estimates`: sale_price, price_source, fba_fee, referral_fee,
  variable_closing_fee, bsr, sellers_fba, sellers_fbm, fetched_at
- Computed estimate fields (`est_profit_unit`, `est_margin`, `est_roi`) when
  recomputed from the above + existing cost data

**Analyze MUST NOT write to (user-controlled fields):**
- `estimated_cogs`, `estimated_cogs_source`
- `actual_cogs`, `cogs_source`
- `prep_override`
- `buy_link`, `supplier`
- Tags, notes, `promo_notes`
- `is_wholesale`, `is_oa`
- `is_active`
- On `bulk_list_asins` (§21, 2026-09-04): `buy_link`, `supplier`, `tags`,
  `promo_notes`, `added_at`, `supplier_sku`, `estimated_cogs` — the bulk
  sink never writes, clears, or overwrites them

Violations of this rule have caused recurring "COGS clears on analyze" bugs.
When in doubt, the analyze path should leave the field alone.

### Asymmetric UPSERT pattern (interim)

Currently, CSV upload piggybacks on the analyze UPSERT to persist
`estimated_cogs` on first ASIN insertion. To avoid clobbering existing values
on re-analyze of known ASINs, the UPSERT is asymmetric:

- **INSERT branch (new ASIN):** includes `estimated_cogs` (from CSV input)
  and `estimated_cogs_source = 'csv'`.
- **ON CONFLICT UPDATE branch (existing ASIN):** does NOT touch
  `estimated_cogs` or `estimated_cogs_source`. Only refreshes
  pricing/fees/catalog fields.

This is an architectural smell. Long-term, CSV upload should have its own
dedicated write path for user-controlled fields, independent of analyze. Fix
when convenient — likely during the Scan section build.

### Single recalculation point

Profitability is recalculated server-side using current settings. The Chrome
extension sends a minimal payload (`{ asin, cogs?, buy_link?, tags?, notes? }`)
and AsinFlow recomputes. This keeps logic centralized and avoids drift.

### Tiered referral fees (Clothing, Jewelry, Watches, etc.)

Tiered-category referral fees are computed locally from
`shared/fee-engine/feeData.json` at the display price via
`computeReferralFee()` in `shared/schema.ts` — **not** scaled linearly from
SP-API's estimate-price referral fee. Linear scaling is wrong whenever the
display price crosses a tier boundary (e.g. Clothing apparel: 5% ≤$15, 10%
$15.01–$20, 17% >$20 — a sock estimated at $19.94/10% but sold at $25 must be
17%, not a linearly-scaled 10%).

Two tier semantics exist and are distinguished by `tierMode` in feeData.json:
- **bracket** (Clothing, Baby, Beauty/Health, Grocery): one rate, chosen by
  which band the whole price lands in.
- **marginal** (Jewelry, Watches, Furniture, Fine Art, …): per-portion rates
  summed across bands. Default when `tierMode` is absent.

The SP-API browse category (`asins.category`) is a coarse umbrella — e.g.
"Clothing, Shoes & Jewelry" covers tiered apparel **and** flat-15% shoes,
handbags and plush. So the local recompute is only applied when SP-API's own
referral fee at the estimate price matches what the tier table predicts
there; on mismatch (or unmapped/flat category) it falls back to linear
scaling of SP-API's accurate per-ASIN value and logs a `[referral]` warning.

### Fee sources & fallback self-heal (`fee_source`, migration 026)

Every stored fee triple (`fba_fee`, `referral_fee`, `fees_estimate_price`)
carries its provenance in `asin_estimates.fee_source`:

- **`'spapi'`** — a real `getMyFeesEstimateForASIN` response (the `getFees`
  path).
- **`'fallback'`** — `estimateFeeFallback`, the weight-based estimator used
  when the real fetch exhausts its retries. Materially inaccurate (diagnosed
  2026-08-09: B0F74MTVJP stored $3.53 vs Amazon's real $5.66 — the weight-only
  curve ignores dims/size tier; ~71 rows were affected and fingerprint-
  backfilled via `script/backfill-fee-source.ts`).
- **NULL** — legacy (pre-026), presumed real after the backfill.

**Write gate** (the analyze UPSERT — fees + source move as one block):
`'spapi'` always wins; `'fallback'` only fills missing fees or refreshes a
prior `'fallback'` — it **never overwrites a real fee** (`'spapi'` or
legacy-NULL). All-null fee shapes (fetch errors, the degraded-response guard,
discarded fallback-price estimates) write nothing, as before.

**Self-heal:** analyze always re-attempts the real fetch (there is no
"fees already present, skip" path), so a fallback row converges to `'spapi'`
on the first successful real fetch. `script/repair-fallback-fees.ts` is the
paced on-demand version of the same repair for the flagged backlog.

**Honest labeling (this section's rule applied):** the Estimated FBA Fee cell
renders amber with a tooltip when `fee_source = 'fallback'` — a weight-guess
is never presented as a real Amazon fee.

### Forward-looking vs backward-looking

Everything in the system has one of two time orientations:

- **Forward-looking** (Estimated): uses current settings, current market
  prices, current expected COGS. Reflects "what would I do now?"
- **Backward-looking** (Actual): uses historical data within a date range.
  Reflects "what did I do?"

When in doubt about which source a metric should use, ask which question the
user is trying to answer.

### Manual-trigger completeness

All derived state must converge via manual triggers alone. Crons only re-run
existing jobs on a schedule and are **never load-bearing for correctness** —
this deployment runs with `ENABLE_CRONS` off (§11 "Scheduled crons"), so a
code path that only converges "when the daily/scheduled pass runs" is a bug,
not a design. When a definitive fact is established (an API probe, a human
verdict), every field derived from it is written then and there; a later pass
may re-verify, never first-deliver. (Adopted 2026-08-28; first application:
the §19 manual-`'live'` flag write.)

### Honest labeling

If a metric is named "Actual" but computed from Estimates, that's a bug — fix
the data path or rename the metric. Do not accept misleading labels in the
UI.

(The current state of AsinFlow's Actuals violates this principle. Section 13
captures the gap; it must be addressed.)

### Archived ≠ excluded from sync

Archive is a **view-level hide, not a data-freshness opt-out**. An explicitly
selected ASIN syncs — prices, PO, sales, inventory, analyze, scan — regardless
of `is_active`; with no selection, sync scope follows the current view (Show
Archived on → archived included; the UI sends the visible ASIN list, so this
falls out of selection semantics). Unfiltered cron/full-catalog scopes remain
active-only. Any future "never sync archived" behavior must be a deliberate
setting, never a hidden predicate. (Root-caused 2026-08-11: `is_active = TRUE`
inside the explicit-selection branches of prices/inventory/sales/analyze/scan
silently dropped selected archived ASINs; post-sync refreshes also dropped the
Show Archived view scope, hiding even successful writes.)

### Push back on stale spec

If the user is heading in a wrong direction or asking for something that
contradicts an established rule, raise it. Pretend-agreement is worse than
honest pushback. Maria has explicitly asked for this.

---

## 15. Inventory Lifecycle & Lot Tracking (Planned)

This section captures the planned architecture for inventory tracking once
the PO module ships. Not yet implemented.

### Principles

1. **Aggregate FIFO at the ASIN level.** No per-unit tracking. Cost basis is
   maintained as a FIFO queue of lots; sales draw from the front, deposits
   add to the back.
2. **POs define lots.** Each `po_line_items` row is conceptually a lot with
   `landed_cost_per_unit` (product + prep + tax + allocated shipping −
   allocated discounts). Tax and order-level discounts already live in
   Col Y of the PO sheet; only prep (Col AS) and inbound shipping need to
   be added at the lot level.
3. **Inventory state is derived, not stored.** State is computed by walking
   an `inventory_movements` event journal in chronological order.
4. **Every FBA inbound shipment ties to a PO.** Either directly (fresh PO →
   FBA) or indirectly (PO → FBA → removal → re-ship). No orphan shipments.
5. **Removal orders maintain PO linkage.** When units are removed from FBA,
   the removal order ties back to the PO whose units were consumed (FIFO).
6. **Re-shipments link removal order → PO chain.** When previously-removed
   units re-enter FBA via a new inbound shipment, the shipment ties to the
   removal order, which ties back to the original PO.

### Event types in `inventory_movements`

- `inbound` — units arrive at FBA from a fresh PO
- `reship` — units arrive at FBA as a re-ship of a prior removal
- `sale` — units consumed via customer order
- `removal` — units leave FBA via removal order (not yet a write-off)
- `loss` — units leave FBA via Amazon-side loss/damage (permanent inventory
  exit until/unless a `found` event reverses it)
- `found` — Amazon locates previously-lost units and returns them to
  inventory
- `disposed` — units disposed of (write-off)

Each event has: `asin_id`, `event_type`, `event_date`, `qty` (signed),
`unit_cost` (snapshot at inbound/reship), `source_id` (FK to PO line item or
prior event), `notes`.

### FIFO costing

When a sale event occurs, units are consumed from the front of the FIFO
queue. The cost basis at the time of consumption is recorded against that
sale. The same algorithm applies to removals and losses (units leave the
queue, but only sales produce COGS).

### Reshipment reconciliation

When a new FBA inbound shipment lands without a matching open PO, AsinFlow
proposes matches from open removal orders for the same ASIN, ranked by qty
match and recency. User confirms the linkage. Fallback: manual link to a PO
directly.

### Inventory Cost calculation

Total inventory cost = sum over all non-terminal events of
`(remaining_qty × unit_cost)` from the FIFO queue. Includes units in FBA,
units in re-ship limbo (removed but not yet disposed or re-shipped), and
units in open POs not yet shipped. Excludes terminal states (sold, lost,
disposed).

### PO section UI: lifecycle breakdown

Each PO displays a status breakdown showing the current state of its units:

```
Sold:                  N units
Currently in FBA:      N units
Awaiting re-ship:      N units (from removal #XXXX)
Lost (Amazon):         N units
Disposed:              N units
Total:                 N units ✓
```

The PO itself stays at "fully shipped" once all units have been sent to FBA
at least once. Re-ship limbo is an operational state on top, not a
modification to the PO's shipping count.

---

## 16. Sourcing Flags (Wholesale / OA)

Two independent boolean fields on the `asins` table track sourcing type:

- `is_wholesale BOOLEAN DEFAULT FALSE`
- `is_oa BOOLEAN DEFAULT FALSE`

An ASIN may be:
- Wholesale only (`is_wholesale = true, is_oa = false`)
- OA only (`is_oa = true, is_wholesale = false`)
- Both (`is_wholesale = true, is_oa = true`) — e.g., originally OA, now also
  wholesale
- Neither (`is_wholesale = false, is_oa = false`) — legacy/unset only

### Source

User-set only. No auto-detection from supplier domain or other heuristics.

### UI

- **Column:** "Sourcing" — displays "W", "OA", "W + OA", or dash. Inline
  editable via popover with two checkboxes.
- **Filter:** Multi-select dropdown — Wholesale / OA / Both / None, with
  counts. Same pattern as Tags and Supplier filters.
- Not in any view preset by default.

### Legacy "Wholesale" tag

The legacy "Wholesale" tag in the `tags` table is preserved. The boolean
flag and the tag are not synced — they coexist independently.

---

## 17. CSV Upload — Duplicate ASIN Handling (Planned)

When a user uploads a CSV/XLSX containing ASINs that already exist in the
catalog, AsinFlow surfaces them before processing.

### Pre-upload check

Identify which ASINs in the upload already exist in the `asins` table.

### Duplicate dialog

If any duplicates found, show a modal with three options:

- **Skip duplicates** (default): process only new ASINs; existing rows
  untouched.
- **Overwrite duplicates:** for duplicates, update `buy_link`, `supplier`,
  `estimated_cogs`, `notes`, and tag associations to match the upload. Do
  not touch fields not present in the upload — never clear `actual_cogs`,
  analyze-refreshed fields, or other user-controlled state that wasn't part
  of the upload.
- **Cancel upload:** abort entirely.

The "all duplicates" case still surfaces the dialog with the same options.

---

## Maintenance

- Update this doc before changing the rule it describes. The doc is the spec;
  code follows.
- When a memory/conversation gap surfaces, the recovery is "is this in
  SPEC.md?" — not "did Claude remember?"
- Periodic refresh: review the whole doc every few weeks or when a major
  feature ships. Stale rules are worse than missing ones.

## 18. Add Offer to Seller Central (Offer-Only Listing Creation)

AsinFlow's first **write** operation against SP-API. Adds the seller's own
offer to an ASIN that already exists in Amazon's catalog ("offer-only
matching" — not product creation). From the user's perspective the ASIN
becomes a new entry in the AF catalog, but no title/image/description is
supplied — only sales terms (SKU, price, condition, fulfillment).

Triggered by selecting ASINs in the list and clicking **Add to SC**, or via
the per-row **+** button.

### Mechanism

- API: `putListingsItem` (Listings Items API, 2021-08-01) with
  `requirements: "LISTING_OFFER_ONLY"` and `productType: "PRODUCT"`.
- The ASIN attaches via the `merchant_suggested_asin` attribute. A blank
  product-ID makes Amazon create a NEW listing (duplicate ASIN), so this
  must always be populated.
- **Required first step:** call `getDefinitionsProductType` to obtain the
  correct attribute shape before building the payload. Skipping this produces
  `4000001 "invalid value"` errors. Do not hardcode the attribute structure.
- Fulfillment: **FBA always.** Set the FBA `fulfillment_channel_code` and
  **omit the quantity field entirely.** For an AFN/FBA SKU, quantity is owned
  by Amazon (set from warehouse receipts); sending any quantity value
  (including `0`) risks flipping the SKU to merchant-fulfilled.
- **Born closed (close-on-create):** every created offer includes
  `purchasable_offer.end_at` set to a past date, so the listing materializes
  in SC already **Closed**. This is the documented "soft-close" — SC's "Close
  listing" button is literally this field; the SKU, listing data, and report
  presence are retained, nothing is deleted, and no quantity /
  `fulfillment_availability` field is involved (MF-flip rail untouched).
  - **Reopen is done in Seller Central directly by the user** (2026-08-03: the
    in-app reopen action was removed as unnecessary). For reference, the API
    mechanism — should it ever be needed again — is a `patchListingsItem`
    `op: "merge"` on `/attributes/purchasable_offer` with `"end_at": null`;
    never `op: "replace"` (wipes the price) and never with price fields in the
    same patch (a high-price error makes Amazon silently ignore the `end_at`).
    Round-trip was verified live on `CAM-HOM-M64-RQR-003` before removal.
  - **Implemented (2026-08-02):** `end_at` is set unconditionally in
    `buildOfferOnlyPayload` (`BORN_CLOSED_END_AT = "2000-01-01"`). The
    offer-add preview's "Ready to create" section carries a plain one-line
    note that offers are created closed.

### Always-present offer attributes

Sent on every payload, not gated by category/brand/product:

- `condition_type` — `new_new` (New)
- price (see Price Resolution)
- `batteries_required` — always `No` today (hardcoded). TODO: per-ASIN battery
  flag (`offer-add.ts` — no per-ASIN logic exists yet).
- `supplier_declared_dg_hz_regulation` — **pass-through of the catalog's own
  value.** Enum (verified product-type-invariant via getDefinitionsProductType):
  `{ghs, not_applicable, other, storage, transportation, unknown, waste}`.
  Resolution (`resolveDgHzRegulation`):
  - If `attributes.supplier_declared_dg_hz_regulation` (US marketplace) is
    present AND enum-valid → **pass it through verbatim, regardless of the
    is_dangerous_good flag.** Self-healing: the presence-derivation's false
    positives (fuel filter, lubricant) carry `not_applicable` in the catalog, so
    they submit correctly even before the flag is re-derived.
  - Else (absent / enum-invalid): DG-flag TRUE → **fail closed**, excluded in
    preview as `dg_value_unresolved` ("needs manual selection", legend_pending
    family) — no `unknown` guess; flag FALSE → `not_applicable` (proven-safe).
  - The offer-side declaration is **advisory** — Amazon classifies DG from its
    own catalog data (B00HX6N2WW went live with `not_applicable` while Amazon
    held `storage`); our value only needs to be enum-valid and should truthfully
    mirror Amazon's.
  - HISTORY: the prior `consumer_commodity` constant was **enum-invalid for
    every product type** (never a member) and the `attributes.hazmat` array was
    never the source (it's a UN-transport block whose values aren't in this
    enum). Both premises were falsified by the enum + array diagnostics.

`batteries_required` and `supplier_declared_dg_hz_regulation` are NOT
category-specific. Treat them as universally required.

### Gating

Gated ASINs cannot receive an offer. Excluded before submission via the
eligibility data: gate predicate is `eligibility_status !== 'yes'`, read from
`asin_estimates` (written by the analyze path — see `GATED_SQL`,
`server/sku-resurrection.ts`). The former `asins.is_gated` / `gating_reason`
columns were dropped (migration `014_drop_dead_gating_columns.sql`);
`eligibility_status` on `asin_estimates` is the sole gating source. No offer
payload is built for a gated ASIN.

### Expiration attributes

Expiration attributes are NOT part of offer creation (they belong to the
shipment-creation step). If `putListingsItem` returns an expiration-related
issue during an offer add, treat it as a **failed offer** — not a benign
"Successful with other errors."

### Dead ASINs

An ASIN whose product has been removed from Amazon's catalog returns 404
(`NOT_FOUND`) from `getCatalogItem`. This is a reliable, binary dead-ASIN
signal (confirmed: live ASINs return data, dead ones 404, no false positives).
A dead ASIN cannot receive an offer — the generator hard-fails and the
offer-add preview surfaces "dead ASIN — cannot create offer" and excludes it.
(A separate, parked feature will flag/archive dead ASINs catalog-wide.)

### Price Resolution

Offer price is set by priority:

1. **Default (≥1 competing offer):** highest competing offer **× 1.30**, rounded UP to the next `.99`.
2. **No competing offers:** price solved for **100% ROI** on our COGS.
3. **18555 cap (2026-08-02):** the rule price is then capped — `price =
   min(rule price, cap)` — so opening offers stay under Amazon's
   "price appears higher than expected" suppression. See "Suppression cap"
   below. The cap can only lower a price, never raise it.

Rule 1 is the default whenever any competing offer exists. Rule 2 applies only
when the listing has zero competing offers.

**Implementation (verified 2026-07-06, read-only trace):** the offer-add path
calls `getItemOffers` (`GET /products/pricing/v0/items/{Asin}/offers`, ~0.5 rps)
via `fetchCompetingOffers` (`server/listings-offers-fetch.ts`). It does **NOT**
reuse `getPricing` data, and **lowest FBA is never the anchor**.

- **"Competing"** = the **landed price** (`ListingPrice + ShippingPrice`) of
  **every offer from OTHER sellers — FBA and FBM both**. Our own offers are
  filtered out by seller ID, so the price is never set against ourselves.
- **Rule 1 anchor** = `Math.max` of that competing list — the **single highest
  competing offer of any fulfillment type** (NOT the buy box, NOT lowest FBA,
  NOT a median). Price = anchor × 1.30, rounded UP to the next `.99`
  (`ceilToNext99`).

**Rule 2 (0 competing offers)** requires an inverse solve (ROI → price), not a
direct profitability check. `shared/profitability.ts` helpers gate "is this
price profitable"; they don't solve for a target price. A **bisection over
`calculateProfit`** targets `roi === 100`, since FBA/referral fees vary
nonlinearly with price; the result is rounded UP to `.99` (protects the ROI
floor — resulting ROI is always ≥ target). Two guards short-circuit it:
- **`skip_no_cogs`** — COGS is null or ≤ 0 → 100% ROI can't be solved without
  cost; the ASIN is skipped, not priced.
- **`skip_unreachable`** — 100% ROI isn't achievable within the price search
  range (extreme fee/prep structure) → skipped.

### Suppression cap (18555 prevention)

**History.** Anchoring Rule 1 on the *max* competing offer lands far above the
buy box when a junk high outlier exists. Until 2026-08-02 this was treated as
designed behavior ("high placeholder, repricer owns the real price") — but the
`18555` / `LISTING_SUPPRESSED` rows it produced (3 of the Aug-02 batch of 21;
each back-solved to 1.3 × an offer 50–100% above the buy box) are pure
downside: a suppressed opening offer sells nothing and pollutes the
verification ledger with terminal conflicts. The err-high philosophy is kept
**within the non-suppressed range** — the repricer walks the price down after.

**Reference data — free, same call.** `getItemOffers`' response carries
`payload.Summary` alongside `Offers[]`; `fetchCompetingOffers` parses
`CompetitivePriceThreshold` (CPT — present only sometimes; observed 2 of 6
probes, including an ASIN with NO buy box) and the New-condition buy box
landed price. Zero additional API calls.

**Cap chain** (applies to BOTH rules' output):

1. **CPT present** → cap **strictly below CPT**, floored to `.x9`:
   the largest price ending in 9 cents that is `< CPT`. If CPT itself ends in
   `.x9`, step down one dime (CPT `$119.99` → cap `$119.89`).
2. **CPT absent, buy box present** → cap = **buy box × 1.5**, floored to the
   nearest `.x9` (≤). Calibration (Aug-02 data): ≤ 1.94×BB passed, 1.95–2.5×
   tripped; 1.5 errs high with margin for Amazon's drifting heuristic.
3. **Neither reference** → **no silent cap**: the rule price stands and the
   preview row carries a visible flag ("no market reference — 18555 risk") for
   a per-ASIN eyes-on decision.

`.x9` flooring = 10-cent steps ending in 9 (`$18.97` → `$18.89`), NOT
`.99`-dollar steps. The rules' own `.99` ceil-rounding is unchanged; flooring
applies only to the cap value.

**Visibility.** When the cap binds, the resolver reports the uncapped rule
price + cap reference in its detail string, and the preview shows a capped
indicator. If the capped price drops resulting ROI below the min-ROI
threshold, the preview row is **flagged, not blocked** — review decides.
Historical `18555` rows already in the ledger keep their `terminal_conflict`
surfacing unchanged.

### SKU Format

```
BRD-DEP-AS3-TTL-NNN-X
```

| Segment | Chars | Meaning |
|---|---|---|
| BRD | 3 | Brand code (from legend) |
| DEP | 3 | Department / top-level category (from legend) |
| AS3 | 3 | Last 3 chars of the ASIN — MANDATORY in every SKU |
| TTL | 3 | Product title code (auto-derived) |
| NNN | 3 | Product number |
| X | 1 | Variant suffix — ONLY for a duplicate offer on the SAME ASIN |

- AS3 is present in every SKU. It auto-disambiguates the "same product,
  different ASIN" case (two ASINs of one product produce different AS3).
- **In-batch (brand, NNN) claims mirror those semantics (2026-09-04).** Two
  new-product rows in one Add-to-SC batch claiming the same (brand, NNN) is
  NOT automatically an error — it is exactly the documented same-product
  case ("AS3 … auto-disambiguates the 'same product, different ASIN' case
  … with no special-case logic"; live pair B0D97XHDXR + B091ZGHPDR, both
  LEM STD 003, AS3 DXR/PDR). The preview surfaces a per-group resolution —
  "Same product listed under N ASINs?" — on ALL affected rows (groups of
  3+ resolve as one group, never pairwise): **Same product** → the rows
  proceed sharing (brand, NNN); same-product requires an identical TTL
  across the group (inline error otherwise, correctable); the registry
  records ONE product for the group by construction — UNIQUE (brand_code,
  nnn) means the first row's reserve INSERTs and every later same-TTL row
  takes the existing row (reuse_ok, no second registration).
  **Different products** → the later row(s) bump to the next free NNN
  (registry ∪ batch claims), re-rendered for review. The hard error
  REMAINS for byte-identical final SKUs (same AS3 too) — that is X-suffix
  territory and never auto-resolves.
- There is **no SUB (sub-category) segment.** A full-catalog scan found 755
  distinct sub-categories (390 needed to cover 80% of ASINs) — a scattered
  long-tail that produced opaque, colliding codes with no grouping value. SUB
  was dropped from the format entirely, and no `sub_category` column is
  stored.
- TTL is auto-derived from the product's core name: deterministic, 3-char,
  word tokens must start with a letter (drops model-number/digit noise, e.g.
  "Aqua King 790PSC10 Filter, 25Micron" → FMR). TTL collisions are
  acceptable — NNN disambiguates; TTL is a hint, not a key.
- Variant suffix is ONLY for a duplicate offer on the same ASIN.
- Allowed chars: letters, digits, hyphens. Under 40 chars total.

### Catalog data source (live fetch)

The generator **live-fetches** catalog data from `getCatalogItem` at
SKU-creation time — it does NOT depend on AF having analyzed the ASIN first.
This means stale/un-enriched ASINs just work; only truly-dead (404) ASINs
fail.

- `category` (top-level) — read from the **classifications chain top-level**,
  NOT `salesRanks[].displayName`. The DEP legend was seeded from the
  classifications-chain values; reading category from a different source
  (salesRanks) produces legend mismatches (e.g. "Coffee" vs "Grocery &
  Gourmet Food"). A regression test pins this: an ASIN whose salesRanks and
  classifications top-levels differ must use the classifications value.
- `brand` — from `summaries[].brand`.
- Missing brand or unresolvable DEP → `legend_pending` (awaits approval).
  Missing category leaf or 404 → hard-fail.
- **Brand ABSENT from the catalog → `legend_pending` with manual code entry
  (2026-08-29).** When `summaries[].brand` is missing entirely (B00MW6OAK6),
  there is no rawValue to resolve and nothing to derive a proposal from —
  but that is an approval problem, not an error: the row surfaces in the
  need-approval section (`pending.brand.status = "missing"`) with an EMPTY
  3-char code input (A–Z/0–9, validated) plus an OPTIONAL brand-name field.
  Collision against existing legend codes is checked on approve (inline
  error, correctable). **Commit semantics:** name provided → `approve_new`
  through the single legend writer (`POST /api/sku-legend/approve`, §18
  ownership) so the brand resolves automatically wherever the catalog DOES
  carry that name; name blank → **one-off**: the code is used for this SKU
  build only and NO legend row is written. Approve re-fires the payload
  build with the code as a per-ASIN override (`brandCodes` on the offer-add
  preview/submit endpoints) and the row moves to READY inline — no
  re-fetch, no dialog restart. Same treatment in BOTH `legend_pending`
  surfaces (Add-to-SC preview and the Velocity dialog's "Create SKU &
  include"). Self-heal never writes a manually-entered code or name to
  `asins` — catalog stays the only source for catalog fields.

**Self-heal write:** after a successful catalog fetch, the resolver writes
`category` and `brand` (and `title`, `image_url`) back to `asins`,
COALESCE-only (refresh only when the API returns non-null). Catalog-data
ownership per §14 — `getCatalogItem` is an analyze data source. Never touches
COGS, tags, notes, buy_link, supplier, is_active, prep, or estimate fields.

### Brand / Department Legend

Persistent `sku_legend` table maps real-world brand→BRD and category→DEP
codes. The legend is **authoritative**; algorithmic derivation is only a
fallback proposer for codes not yet in the legend, and a derived code is
surfaced for approval (`legend_pending`) before it's committed — never
silently applied.

- Seed: AminoGenesis → AMG; 23 department codes from the catalog's distinct
  top-level categories (BPC for Beauty & Personal Care, SPC for Sports
  Collectibles resolving the SPO collision with Sports & Outdoors, etc.).
- Brand consistency: one code per real brand even across name variants —
  **brand aliases** map multiple raw brand names to one code (AminoGenesis /
  AminoGenesis Cosmetics → AMG; CerMedia / MarinePure → one code). The
  approval flow must allow attaching aliases / merging a pending brand into an
  existing code, so a variant name never splits a brand into two codes.
- Department consistency: never two DEP codes for one category.
- No SUB codes — SUB is not part of the format.

### SKU Resolution (resurrection)

There is **no SKU ledger** — the `listing_submissions` verification ledger
(§19) tracks *submissions*, not SKU history. SP-API's listings endpoints
return 404 for deleted SKUs (no readable "deleted" status), but `asin_skus`
already retains every SKU AF has seen — written by **two** paths:
`getInventorySummaries` (FBA inventory API, long horizon) **and** the offer-add
path's optimistic submit-time write on ACCEPTED (`offer-add.ts`).
Append-accumulate, never pruned. So `asin_skus` is the SKU-history source; no
separate ledger is needed.

Per ASIN at offer-add:

1. Read the ASIN's prior SKU(s) from `asin_skus`.
2. If any match the current SKU format, prefer the **most recent** match
   (by `created_at`) → candidate for reuse.
3. Live status check (`getListingsItem`) on that SKU for THIS ASIN:
   - 404 / absent (deleted) → reuse the matched SKU.
   - present (active / closed / out-of-stock) → a live offer already exists →
     duplicate-offer WARNING path, not resurrection.
4. If no `asin_skus` SKU matches the current format → generate a new SKU.

Any non-conforming prior SKU (legacy AMG `BRD-DD-...` with no AS3,
Amazon-random, all-digit, prep-center-created like `PFL_...`) does not match
the current format and is therefore regenerated, never reused. No legacy
allowlist, no subtypes, no quarantine — the format check is the sole
discriminator.

**`asin_skus` membership ≠ "listing is alive."** It means "FBA inventory has
observed this SKU **or** AF optimistically wrote it at submit time." Because
that submit-time write fires on ACCEPTED — before any inventory, and even for
submissions that later ghost (async-failed / suppressed) — **presence does not
even guarantee the listing ever materialized.** The live status check
(`getListingsItem`, step 3) is what makes reuse safe; never infer listing state
from `asin_skus` presence.

### Duplicate-offer confirmation

If the ASIN already has a live offer (the status check returns present),
prompt before creating an additional offer:

> "[ASIN, TITLE] is already in your catalog. Create an additional offer?"

On confirm, proceed and assign the next variant suffix.

### Write flow (dry-run first)

Per AF's dry-run-before-live-writes principle, and because this is the first
live write to Seller Central:

1. User selects ASINs → **Add to SC** (selection-aware), or per-row **+**.
2. Per ASIN, AF resolves: SKU (reuse or generate), price, full payload.
   Gated, dead, and `legend_pending` ASINs are surfaced and excluded /
   gated for approval.
3. Dry-run preview renders SKU + price + payload per ASIN. The preview must
   clearly show "reusing existing SKU X" vs "generating new SKU Y" — since
   there is no ledger, the preview is the only check that the right SKU
   resolved. Duplicate-offer confirmations surface here.
4. On explicit confirm, AF fires `putListingsItem` per ASIN.
5. Issues are surfaced per ASIN; expiration issues count as failures.
6. On success, the created SKU is **promoted to primary**: one atomic
   statement sets `asin_skus.is_primary = true` on it and `false` on all
   other SKUs for the ASIN, and updates `asins.primary_sku` to match. The
   live-offer SKU is the lead SKU. Applies to **both** new-SKU generation and
   resurrection-reuse; the two fields never disagree.
7. A batch with ≥1 ACCEPTED submission schedules the §19 **auto verify after
   submit** (probe ladder T+1m/+3m/+10m/+30m/+60m, each firing only while
   rows stay open; any 200 for the submitted SKU writes `has_live_offer`
   immediately — 2026-09-06) — nothing manual needed after a routine batch.

### Source-of-truth ownership

| Field | Owner |
|---|---|
| Offer creation (putListingsItem) | Add-Offer path (only writer) |
| Offer price at creation | Add-Offer path (price resolver) |
| `primary_sku`, `asin_skus.is_primary` | Add-Offer path (promotes the live-offer SKU on creation); inventory-sync may set them only as bootstrap when no primary exists, never overwrite |
| `has_live_offer`, `offer_checked_at` | Daily live-offer staleness pass (`live-offer-sync.ts`) + §19 API verify-sweep `'live'` transition (`verifyPending`) — both getListingsItem-derived — + §19 **manual `'live'` verdict** (2026-08-28, a definitive human determination; §14 manual-trigger completeness). Manual `'failed'`/`'deleted'` never write it |
| `sku_legend` entries (brand/dept codes, aliases) | Add-Offer approval flow |
| `category`, `brand` (self-heal) | Add-Offer catalog fetch (per §14 catalog ownership) |

The Add-Offer path does NOT modify user-controlled fields (COGS, tags, notes,
etc.).

**Primary-SKU ownership (rewritten 2026-08-03, item 8c).** Three writers:

1. **Add-to-SC promotion on create** — the freshly created live-offer SKU is
   promoted to primary (unchanged).
2. **Full-scope listing scan enforcing latest-live-wins** — after probing, for
   every ASIN: primary = the most recently observed SKU
   (`asin_skus.created_at`) among SKUs whose listing is LIVE, with
   **`amzn.gr.*` excluded from the candidate set** (the repo-wide
   never-amzn.gr-primary invariant; if only `amzn.gr.*` SKUs are live, primary
   stays unchanged — dry-run 2026-08-03 found 4 such cases). If the winner
   differs from the current primary, re-point (`asins.primary_sku` +
   `asin_skus.is_primary`, atomically in one statement) — including demoting
   an older SKU that is still live. If NO eligible SKU is live, primary is
   left unchanged (never point primary at a dead SKU; never null it out).
   Every re-point is reported as "primary → newest live: old → new".
3. **inventory-sync bootstrap — for the no-primary case ONLY** (`primary_sku
   IS NULL` and no `is_primary` row); it never recomputes or demotes.

*Legacy state:* an ASIN whose only SKUs are `amzn.gr.*` got `primary_sku` set
by bootstrap with no matching `is_primary` row; the full-scope scan's
latest-live-wins rule now heals these whenever any SKU is live. A primary
whose listing was deleted in SC self-corrects on the next full-scope scan
(if another SKU is live) — the catalog **icon** is separately driven by
`has_live_offer` (below).

### Catalog icon: live-offer truth (`has_live_offer`)

The Product-cell "in catalog" icon (blue checkmark vs. "+" Add-to-SC) reads
**`has_live_offer` only** — never `in_catalog`, `asin_skus` presence, or
inventory summaries.

- **`in_catalog` is demoted to an internal discovery latch** — it is NOT a
  live-offer signal. It is a one-way TRUE-only flag (set by sales-sync on any
  order and by inventory-sync for every ASIN in `getInventorySummaries`, which
  **retains tombstones for deleted listings**), so it stays TRUE forever and
  over-reports. It is no longer read by the UI.
- **`has_live_offer` is tri-state — ONE definition (2026-09-06):**
  `TRUE` ⇔ a listing record for ≥1 of the ASIN's SKUs EXISTS at Seller
  Central (`getListingsItem` 200), regardless of Active/Inactive status or
  the §19 ledger state; `FALSE` ⇔ every known SKU definitively 404s AND
  ASIN discovery is empty (the 2026-08-28 rule, unchanged); `NULL` = never
  probed. Fail-closed on transients. `offer_checked_at` records the last
  definitive write. This resolves the 2026-09-04 defect where §19's
  materialized-only classifier and §18's exists-at-SC probes disagreed and
  the icon needed a manual Scan Listings after every Add-to-SC: the §19
  ledger keeps its own live/processing/failed classifier (it answers "did
  the offer materialize"), but the `has_live_offer` WRITE is decoupled from
  it — the post-submit probe ladder (§19) writes TRUE on any 200 for the
  submitted SKU immediately. Icon tooltip wording: "Listed in Seller
  Central (Active or Inactive)" vs "Not listed — Add to SC".
- **Truth source = `getListingsItem`** (via `checkSkuListingStatus`, the same
  404 primitive as §18 resurrection). Multi-SKU: check `primary_sku` first, then
  other `asin_skus` rows, short-circuit on the first live hit
  (`live-offer-check.ts`, shared by the daily pass and the one-off backfill).
- **Writers:** (1) the daily staleness pass (`live-offer-sync.ts`, 07:00
  host-local; cron gated behind `ENABLE_CRONS`, default off — §11 "Scheduled
  crons") over every `in_catalog=TRUE` ASIN **that has ≥1 `asin_skus` row**
  — no-SKU ASINs are excluded (nothing to probe; they stay `NULL`/"+" and are
  picked up once inventory-sync records a SKU); (1b, "§18b") the
  **inventory-sync trailing rider** — same `syncLiveOffers` implementation,
  mirroring the sync's `asinFilter`, scoped to `has_live_offer IS DISTINCT
  FROM TRUE`: never-checked (`NULL`) **and** stale-`FALSE` rows are re-probed
  after every inventory sync, because listings are created and deleted
  constantly and a `FALSE` would otherwise go stale with nothing scheduled to
  recheck it (the B0085ZIHR0 incident, 2026-08-01: checked `f` at 07:04, offer
  created 19:54, invisible to the old `NULL`-only rider scope forever after).
  Confirmed-`TRUE` rows stay excluded from the rider — only the full-scope
  daily pass re-verifies live rows; (2) the §19 **API verify-sweep**
  `'live'` transition (`verifyPending`, getListingsItem-derived), which flips
  `has_live_offer = TRUE` same-day after Add to SC so a freshly added offer never
  shows a stale "+"; (3) a **manual `'live'` verdict** (2026-08-28): a
  definitive human determination writes `has_live_offer = TRUE` +
  `offer_checked_at` exactly like the sweep transition — the old "waits for
  the daily pass" rule violated §14 manual-trigger completeness (with crons
  off it meant "waits for a manual scan"). Manual `'failed'`/`'deleted'`
  still write nothing (deleting one SKU ≠ no live offer). The flag is
  **not** written at ACCEPTED (synchronous validation only).
- **Fail-closed:** only a definitive 200 writes `TRUE`; only all-SKUs-404 writes
  `FALSE` — and only after the discovery step below comes back empty; any
  transient (429/5xx/timeout) writes nothing and is retried next run. Never
  coerced from missing data.
- **All-known-SKUs-404 → ASIN discovery before `FALSE` (2026-08-28):** every
  known SKU 404ing proves only "no offer on the SKUs AF knows," not "no
  offer" — an SC-created listing under a new SKU is invisible behind dead
  `asin_skus` rows, and phase b's discovery never fires for such an ASIN (it
  is gated on **zero** `asin_skus` rows). Found live (B0CT61H23P, 2026-08-26:
  live CQ-OMI0-SSZ7 behind dead primary 3E-ZRRX-EQTD → written `FALSE`
  repeatedly). So the shared layer runs `searchListingsItems` by ASIN
  whenever all known SKUs definitively 404, BEFORE any `FALSE`: discovery
  hit → the discovered SKUs are inserted into `asin_skus` and the 8c
  latest-live-wins primary re-point applies (every previously-known SKU
  including the old primary just definitively died; `amzn.gr.*` never
  primary — if only amzn.gr.* is discovered, rows insert non-primary and
  primary stays), the flag is written per the discovered listing, and the
  ASIN is counted as a **discovery** in the pass report; discovery empty
  (200, zero items) → `FALSE` exactly as before; discovery transient →
  nothing written, fail-closed unchanged. Lives in `live-offer-check.ts`
  (`discoverAsinListings` + `recordDiscoveredSkus`, composed by
  `checkAsinLiveOffer`), inherited by the daily pass, the §18b rider, the
  backfill, and full-scope phase a; dry-run modes probe and report the
  discovery but write nothing.
- **Issue snapshot rider (2026-08-03):** every definitive probe also writes
  `asins.current_issues` / `issues_checked_at` (§6 Submission column) — the
  issues arrive in the same `getListingsItem` response (`includedData=
  summaries,issues`), zero extra calls. `live` verdict → the live SKU's
  issues; `no_offer` → `[]` (no listing = no listing issues). Same fail-closed
  rule: transient probes write neither field.

### Manual full-scope listing scan (2026-08-03, item 8; toolbar button REMOVED 2026-09-06)

**Scan Listings is no longer a toolbar button** — the scan IS the Refresh
job's `listings` stage (§11 Refresh job): every in-scope ASIN with ≥1
`asin_skus` row probes per SKU across ALL flag states including TRUE (a
listing deleted in SC flips FALSE on the next Refresh), then no-SKU ASINs
run phase-b discovery — same primitives, one implementation.
`POST /api/listings/full-scope-pass` remains as a script/dry-run entry
point, **selection-aware** (selected ASINs, else full active
catalog). Two sequential phases over one NDJSON progress stream
(`POST /api/listings/full-scope-pass`, body `{asins?}`):

- **Phase a — every active ASIN with ≥1 `asin_skus` row, ALL flag states**
  (TRUE/FALSE/NULL): `getListingsItem` per SKU — deliberately NO
  first-live short-circuit, because 8c needs per-SKU liveness. Per
  definitively-probed ASIN it writes `has_live_offer` (any SKU live),
  `offer_checked_at`, the §6 issue snapshot (newest-live SKU's issues; `[]`
  when none live), and applies the **latest-live-wins primary re-point**
  (Primary-SKU ownership above). Any transient SKU probe → the whole ASIN is
  skipped, fail-closed. When ALL SKUs definitively 404, the all-404 →
  discovery rule above runs before `FALSE` is written; discovered ASINs are
  reported per-phase as **discoveries**.
- **Phase b — active no-SKU ASINs**: `searchListingsItems` by ASIN (the §19
  fallback endpoint, `includedData=summaries,issues`) to discover SC-created
  SKUs. Found → write `asin_skus` rows (bootstrap primary only if none
  exists), `has_live_offer`, issue snapshot. Not found → stays NULL, counted
  **"no listing"** (sourcing leads — expected, the majority).
- **Pacing:** 260ms between calls, both phases (getListingsItem and
  searchListingsItems share the 5 rps Listings bucket; phases are sequential).
- **Per-phase report:** probed / flips / discovered SKUs / no-listing count /
  re-points ("primary → newest live: old → new") / duration.
- **Dry-run (`?dryRun=1`, Velocity pattern):** both probe phases run
  read-only and report what WOULD change — flag flips, discovered SKUs, the
  full 8c re-point list — with **zero DB writes**. The first live run is
  gated on a reviewed dry-run.
- **`is_listing_active`** (a dead `DEFAULT TRUE` column, zero readers) was
  dropped in migration 018 — its default would have poisoned the tri-state.

## 19. Post-Submit Verification (Submission Ledger)

`putListingsItem` returning **ACCEPTED** is only synchronous validation —
Amazon then processes the offer asynchronously (minutes to hours), and any
downstream step can suppress or reject it. ACCEPTED is therefore **never**
rendered as "created/live." A batch audit found ~1-in-8 submissions were
silent ghosts (e.g. restricted-generic `5886`, suppressed `13013`), invisible
until manual checking. This system records every submission and resolves its
real state on demand.

No background jobs / notifications infra: verification is an on-demand,
read-only sweep against SC plus status writes to the ledger — plus one
in-process, one-shot follow-up per submit batch (below), which is a delayed
invocation of the same sweep, not a scheduler.

### Ledger: `listing_submissions`

One row per `putListingsItem` **fire** (not per SKU), written best-effort at
submit time — a ledger-write failure must never mask a real SC submission.
Columns: `asin`, `sku`, `submission_id`, `submitted_price`, `submitted_at`,
`verify_status`, `verified_at`, `verdict_source`, `issues` (jsonb),
`review_flags` (text[]), `terminal_conflict`, `flags_acknowledged_at`
(timestamptz NULL — set by the dismiss action, migration 023; see "Panel
bulk actions & dismiss" below).

### Six states

| state | meaning |
|---|---|
| `pending` | submitted, not yet probed |
| `processing` | verified, not materialized yet, no terminal signal → re-verify later |
| `live` | listing materialized (status/offer present) |
| `failed` | not materialized AND a conclusive terminal signal present |
| `stale` | `processing` older than the window → needs a manual verdict |
| `deleted` | manual verdict: the listing was intentionally removed in SC |

### Verify sweep (on-demand, paced, fail-closed)

`POST /api/submissions/verify` sweeps every non-terminal row
(`pending`/`processing`/`stale`), paced for the Listings API rate limit.
Primary probe is `getListingsItem` (`summaries,issues,offers,fulfillmentAvailability`);
on a 404 it **falls back to `searchListingsItems` by ASIN** to catch a listing
that materialized under a drifted SKU. **Fail-closed:** a throttled/5xx probe
leaves the row **unchanged in whatever state it was** (a `processing` row stays
`processing`, keeping its stale clock) — never a guessed verdict. Idempotent
and safe to re-run — the manual sweep remains available and is the fallback
whenever the auto sweep couldn't finish the job.

### Auto verify after submit (2026-08-09; ladder + immediate flag write 2026-09-06)

After a batch submit completes with **≥1 ACCEPTED** submission, AF schedules
an in-process, one-shot follow-up: the SAME `verifyPending` sweep **scoped to
that batch's ledger ids** (`ids` option — the status filter still applies, so
already-resolved rows fall out of the scoped re-run), on a ladder of
**T+1m, +3m, +10m, +30m, +60m**, each firing only if rows in scope are
still open. On EVERY probe, a `200` for the submitted SKU writes
`has_live_offer = TRUE` + `offer_checked_at` **immediately**, independent
of whether the ledger row moves to `live` or stays `processing` (§18 one
definition, 2026-09-06) — a just-created SKU returns 200-with-empty-status
while materializing, which is "listed", not "live yet". Manual `'live'`
still writes TRUE; manual `'failed'`/`'deleted'` still write nothing;
ACCEPTED alone still writes nothing (synchronous validation only). A
server restart loses the timers; the Refresh `listings` reconcile catches
up.

- **Not a cron, not persisted:** timers are in-process only (`unref`ed). A
  server restart before firing simply leaves the rows in the pill; the manual
  sweep is the fallback. Deliberate — this is a follow-up to a user action,
  not a schedule.
- **No new writers:** the scoped sweep carries `verifyPending`'s existing
  semantics — fail-closed probes (throttle/not-yet-found write nothing) and
  the `'live'` → `has_live_offer` transition.
- Batch ids resolve from the newest `pending` ledger row per submitted
  (asin, sku) pair; pairs whose best-effort ledger write failed drop out
  (covered by pill + manual sweep, as before).
- Every firing logs what it swept and what it resolved; rows still open
  after the retry stay in the pill for the manual sweep.
- UI: nothing new — the pill count reflects the auto-resolution on its next
  natural refetch (page load / panel close). No polling added.

### Classifier (precedence order)

Evaluated per probed listing, in this order:

1. **Materialized → `live`.** `summaries[0].status` non-empty OR an offer/
   fulfillment is present. Any ERROR-severity issues are surfaced as
   **`review_flags`** (visible, not just JSONB) — they do **not** downgrade a
   materialized listing. *ERROR severity ≠ failed* (a live, buyable listing
   routinely carries an `18555` price advisory).
2. **Precedence guard:** if a **terminal signal is present alongside a
   materialized listing**, it is still `live` but `terminal_conflict = true`
   with a prominent "verify manually" review flag — never silently `live`.
3. **Terminal signal + not materialized → `failed`.** Terminal = an issue code
   in the **observed terminal set `{5886, 13013}`** OR an enforcement action
   `LISTING_SUPPRESSED`. The code set is **observed, not inferred** — extend it
   deliberately from re-probed evidence; **never infer terminality from issue
   severity.**
4. **Otherwise → `processing`.** Empty status, transient issues (e.g. an `8541`
   matching-conflict that later resolves), unknown codes, or an ASIN not yet
   indexed. Defaults toward not-failed.

A `processing` row older than **48h** is promoted to `stale` (needs a human
verdict). There is no submission-status API to poll and no processing SLA, so
time alone never forces `failed`.

### Manual verdicts

`POST /api/submissions/{id}/resolve` with `verdict ∈ {live, failed, deleted}`,
allowed on **any non-terminal row** (`pending`/`processing`/`stale`) — not
stale-only; stale is merely when we *prompt*, a human may answer earlier.
Already-resolved rows are rejected (409). Every verdict records `verdict_source`
= `api` (sweep) or `manual` (human).

**Manual `live` writes the flag (2026-08-28):** a manual `'live'` verdict
writes `asins.has_live_offer = TRUE` + `offer_checked_at`, exactly like the
API sweep's `'live'` transition. A manual verdict is a definitive human
determination; the old defer-to-daily-pass rule violated §14 manual-trigger
completeness (with crons off, "waits for the daily pass" meant "waits for a
manual scan"). Manual `'failed'`/`'deleted'` still write **nothing** to the
flag — deleting or failing one SKU doesn't mean the ASIN has no live offer.

**Rationale for the manual flow:** a listing the user deleted in SC is
**API-indistinguishable** from a silent ghost — both read as absent with no
terminal signal. The VA can also delete listings AF never recorded. So the
resolution flow must let a human state "this was deleted," rather than the
system inferring failure.

**`deleted` scope:** touches **only** the ledger row and `asin_skus.is_primary`
(demoted to false). It **never** writes the analyze-owned `asins` fields
(`in_catalog`, `primary_sku`) — those are §14-owned and self-correct on the
next analyze; deleting one SKU doesn't mean a multi-offer ASIN has no live
offer. The `asin_skus` row is kept, so resurrection can reuse a 404'ing SKU.

### Panel bulk actions & dismiss (2026-08-03)

The panel is clearable after review without per-row clicking:

- **Verify all** (header) — the existing sweep endpoint, summarized as
  "N resolved live · N failed · N still processing/stale (· N throttled)"
  and the list refetched. Sweep semantics unchanged.
- **Bulk manual verdicts** — row checkboxes + "Resolve selected as… (live /
  failed / deleted)". `POST /api/submissions/resolve-bulk` `{ids, verdict}`
  applies the single-row manual-verdict semantics per id (same repo function,
  including the `deleted` → `is_primary` demote). Already-terminal rows are
  **skipped and reported** (`skipped: [{id, reason}]`) — the batch never fails
  on them; the single-row endpoint keeps its 409.
- **Dismiss (acknowledge)** — terminal rows surfaced in needs-attention
  (`failed`, and `live` with `review_flags`/`terminal_conflict`) previously had
  no reviewed state and sat there forever. `POST /api/submissions/dismiss-flags`
  `{ids}` sets `flags_acknowledged_at = now()` on **terminal rows only**
  (non-terminal ids are skipped and reported — `stale` needs a verdict, not an
  ack). Single-row and bulk in the UI. **Dismiss hides, never deletes**:
  `issues`/`review_flags`/`terminal_conflict` stay in the ledger untouched.
  Acknowledged rows leave needs-attention. Stable: the sweep only probes
  non-terminal rows, so a dismissed terminal row is never re-flagged.
- **Pill = non-terminal + unacknowledged-attention-terminal:**
  `pending/processing/stale` PLUS (`failed` OR flagged-`live`) with
  `flags_acknowledged_at IS NULL`. After sweep + review (bulk verdicts) +
  dismiss, the badge reaches zero. Note this WIDENS the old pill (which counted
  only non-terminal): flagged/failed rows now count until acknowledged.
- **Pill is ALWAYS visible** (2026-08-03): it is the panel's only entry point,
  so it renders at count 0 too (extra-muted "0 submissions") — a hidden pill
  made "count endpoint broken" indistinguishable from "legitimately zero".
- **Dismiss scope:** acknowledgment affects PANEL triage (and the pill) only.
  The §6 Submission column keeps showing acknowledged flags permanently
  (muted/grey) — the column is the permanent record; nothing is ever deleted
  from the ledger.

### Backfill = repair path

`script/backfill-listing-submissions.ts` seeds ledger rows from `asin_skus`
(canonical-SKU-format filter, so inventory-observed SKUs aren't mistaken for AF
submissions; `submission_id`/`submitted_price` are NULL for pre-ledger rows). It
is **idempotent by (asin, sku)** and therefore doubles as the **repair path for
any submission whose best-effort ledger write failed** — re-running fills gaps
without duplicating. Preserve that property across refactors.

The ledger is per-fire, but the backfill is idempotent by `(asin, sku)` — so
for a resubmitted SKU it guarantees the pair is *tracked*, not one row per
historical fire. For pre-ledger or repair-path rows the ledger is therefore
**not a complete fire count.** That is acceptable — do **not** "fix" the
backfill into inserting duplicate rows.

### Relationship to `asin_skus`

`listing_submissions` tracks **submissions and their verified state**;
`asin_skus` remains **SKU history** (§18 "no SKU ledger" still holds — this is
not a SKU ledger). Both can name the same SKU: `asin_skus` says "this SKU was
observed/submitted," `listing_submissions` says "this specific submission
resolved to live/failed/deleted."

## 20. Tags

Free-form labels applied to ASINs (`tags` + `asin_tags` join).

- **`tags` table:** `name` (unique), `color`, `tag_group` (NULL = ungrouped),
  `sort_order` (ordering within a group).
- **Render order — everywhere tags are listed** (tag filter dropdowns, the tag
  picker popover): **ungrouped tags first** in their current order, then each
  **group under a header**, its tags in `sort_order`. (`/api/tags` returns this
  order; `client/src/lib/use-tag-groups.ts` drives it client-side.)
- **Row tag chips are unaffected by grouping** — grouping only changes
  list/picker ordering, not how chips render on a row.
- **Current groups:** `Seasonal` — Fall/Q4, St. Valentine's Day,
  St. Patrick's Day, Spring, Easter, Summer, Back to School (in that
  `sort_order`).
- **Deletion cascades:** deleting a tag removes its `asin_tags` associations
  (`ON DELETE CASCADE`); the ASINs themselves are untouched.


## 21. Bulk Profit Calculator

A standalone page for evaluating arbitrary ASIN lists (supplier catalogs,
substitution lists, wholesale sheets) without touching the main catalog.

### Isolation guarantee

Bulk Profit Calculator data lives in its own tables. No cron, sync job, or
main-catalog code path reads or writes them. Conversely, no action on this
page writes to `asins`, `asin_estimates`, `asin_estimates_history`,
`asin_tags`, `tags`, `sales_daily`, or `asin_skus`.

The single permitted main-DB access is one READ: a set-based EXISTS query
(`WHERE asin = ANY($1)`) against `asins.asin` to populate `in_database`.

Bulk tags are FREE TEXT on the bulk row (2026-09-04). They never read or
write `tags` / `asin_tags`, carry no FK, and have no relationship to
main-page tags even when the labels match. The main TagEditor is never
mounted on this page.

### Tables (migration 022)

- `bulk_lists` — id, name, source_filename, asin_count, created_at
- `bulk_list_asins` — list_id (FK, ON DELETE CASCADE), asin, added_at,
  catalog snapshot (title, image_url, brand, category, weight_lb, length_in,
  width_in, height_in), pricing/fee snapshot (sale_price, price_source,
  fba_fee, referral_fee, variable_closing_fee, fees_estimate_price, bsr,
  sellers_fba, sellers_fbm), estimated_cogs, estimated_cogs_source,
  supplier_sku, eligibility_status, is_meltable, is_hazmat,
  is_dangerous_good, error, fetched_at; user-controlled fields (migration
  031, 2026-09-04): buy_link, supplier (derived from buy_link), tags
  (TEXT[] — free-text labels, deliberately NOT a join table: there is no FK
  target by design, no cross-list tag queries exist, and a join table would
  re-create the exact shape the isolation guarantee forbids linking to),
  promo_notes.
  UNIQUE(list_id, asin).

No `has_live_offer` column — account state is out of scope (see `in_database`
below). No `size_tier` column — the analyze fetch produces no writer for it,
and a column with no writer is a latent bug.

`length_in`, `width_in`, and `height_in` ARE retained: the catalog fetch
produces `packageDims`, and the bulk sink stores them. They are
stored-but-unrendered — no column in the §21 subset displays dims — kept so a
saved snapshot carries the same catalog facts as the main table and a future
column needs no backfill. `weight_lb` is retained: inbound shipping is
calculated $/lb.

### Fee column semantics

`fba_fee` is the total non-referral fee and INCLUDES the variable closing
fee, matching main-path semantics. `variable_closing_fee` is an
informational breakout of a value already contained in `fba_fee`. Never sum
the two.

`fees_estimate_price` is required: `getEstimatedProfit()` scales the referral
fee from the fee-estimate price to the display price. Without it, bulk
estimates silently diverge from the main table's math for the same ASIN.

### Persistence seam

`runAnalyzeCore` takes a persistence-sink parameter. The parameter is
REQUIRED, not defaulted — every call site names its sink explicitly. A
defaulted sink is fail-open: a future call site that omits the argument
would silently write to the main catalog, which is the single failure this
feature exists to prevent.

The main sink reproduces prior behavior exactly (fire-and-forget, same call
sites, same ordering). The bulk sink writes only to `bulk_list_asins`, via
UPDATE-only statements — list membership is fixed at creation, so a stray
ASIN can never insert a row. Bulk writes are awaited, so the snapshot is
complete before render. `estimated_cogs` and `estimated_cogs_source` are
never in the bulk sink's SET list: a refresh cannot clobber COGS.

Suppressed on the bulk sink:

| Site | What it writes |
|---|---|
| `upsertAsinResult` asins UPSERT | catalog fields; also INSERTs new `asins` rows |
| `applyCatalogDeletedSignal` | `is_catalog_deleted`, and `is_active = FALSE` + `archive_reason` on FALSE→TRUE |
| `appendNotesForAsin` | `asins.notes` |
| `upsertAsinResult` estimates UPSERT | `asin_estimates` |
| `upsertCsvCogs` | `asin_estimates.estimated_cogs` |
| history insert | `asin_estimates_history` |
| `upsertTagsForAsin` | `tags`, `asin_tags` |

`runPostAnalyzeBackgroundSyncs` (PO sheets sync + suppression sync) is fired
by the analyze endpoint wrappers, not the core. The bulk endpoint does not
call it.

The dead-ASIN 404 signal is retained in the result object for display. Only
its DB write is suppressed — including the silent auto-archive.

The §18 `getCatalogItem` self-heal callback is currently unwired. If it is
ever wired to a live call site, it must remain unwired on this page.

### Data sources

- ASINs: CSV upload only. No sheet sync, no Chrome extension, no manual add.
- COGS: CSV column or manual inline edit. `estimated_cogs_source` is `'csv'`
  or `'manual'` only.
- Supplier SKU: CSV column (mapper alias) or manual inline edit — same
  user-controlled contract as COGS (§14); the bulk sink never writes it.
- Buy link / Supplier (2026-09-04): CSV `buyLink` column (aliases incl.
  "source url") or inline edit of the URL — supplier is ALWAYS derived via
  the same `cleanBuyLink` + `extractDomain` as the main path; there is no
  separate free-text supplier override (one source of truth: the URL).
  Clearing the URL nulls both. Same §14 contract; sink never writes it.
- Tags (2026-09-04): CSV `tags` column (comma-delimited, same split as the
  main path) or inline edit. BULK-LOCAL free text — stored as TEXT[] on the
  row, rendered as neutral-colored chips, no relationship to main-page tags
  even when names match. Same §14 contract.
- Promos (2026-09-04): CSV `promos` column (new alias: promos/promo/promo
  notes) or inline edit → `promo_notes`. NOTE THE ASYMMETRY, on purpose:
  on the MAIN page promo_notes still comes ONLY from the sourcing sheet —
  the new CSV alias is parsed but ignored on the main path. Do not "fix"
  this without deciding to.
- Date Added (2026-09-04): when the CSV mapping includes a Date Added
  column (aliases: date added/dateadded/added/date — safe because alias
  matching is exact on the normalized header), the value is written into
  `added_at` (M/D/YYYY parsed as LOCAL midnight — America/New_York in this
  deployment — never UTC midnight, so 09/02/2026 renders 09/02/2026; ISO
  timestamps also accepted, which is what Export CSV emits, so
  export → re-upload round-trips). Absent/unparseable → NOW(), the row
  never fails. Inline date editor on the cell. Snapshot-age display uses
  fetched_at, so a backdated row never looks stale; added_at drives only
  the row ORDER BY.
- Everything else: the analyze pipeline via the bulk sink. The bulk sink's
  UPDATE never touches any user-controlled field above — Refresh Prices is
  column-scoped to the analyze snapshot, so they persist.

`/api/parse-file` and `/api/parse-mapped` are pure and reused. `parse-mapped`
takes an opt-in flag to skip the COGS-column requirement; the default
preserves main-path behavior and only the bulk client passes it. A supplier
catalog with ASINs and no costs is the normal starting case here.

### COGS divergence is expected

The same ASIN may show a different Estimated COGS here than on the main page.
This page reads only the uploaded CSV or manual entry, never `po_sheet` data.
That is the isolation working, not a sync bug.

### Columns

Subset of `COLUMN_GROUPS`:

- **Description** — Product, Category, Brand, Supplier (domain linked to
  buy_link, populated since 2026-09-04; editable via the URL), Supplier SKU
- **Estimates** — full group
- **Sellers** — full group
- **Additional info** — Tags, Promos, Meltable, Hazmat, Suppressed, Date
  Added (Tags + Promos added 2026-09-04 — BULK-LOCAL fields, unrelated to
  main-page tags/promos; a Tags filter dropdown is wired here too)

Excluded: the entire **Stock** and **Actuals** groups (no inventory or sales
data path; empty Actuals columns would violate honest labeling, §14). Notes
and Sourcing are excluded — no data source on this page. Export CSV carries
Tags (comma-joined — re-imports through the same split), Promos, Date
Added, and Supplier.

No date-range selector: nothing here is range-scoped.

The frozen row-action columns stay: **Buy List and Hold are SHARED with the
main page** — same localStorage sets, same toggle handlers, so carting an
ASIN here shows on the main page's Buy List and vice versa. The **selection
checkbox drives Export CSV** on this page: rows selected → export the
selection; none selected → export all. No other batch actions.

`ResultsTable` and `ColumnManager` take an optional `columns?: ColumnDef[]`
prop defaulting to `ALL_COLUMNS`. `lib/columns.ts` takes a parameterized
storage key — the bulk page uses its own key so its column choices never
clobber the main table's saved config.

Estimates use the same `getEstimatedProfit()` / `getEffectivePrep()` and the
same global `settings` as the main table.

### `in_database`

The ONLY main-database value rendered on this page. Occupies the Product cell
slot that the main table uses for `has_live_offer`.

- Present in `asins` → `Database` icon (lucide-react), linking to the main
  ASINs page pre-filtered to that ASIN via `/asins?q=<ASIN>` (home seeds its
  search box from the `?q=` param; inert when absent; archived ASINs stay
  hidden — same as a manual search). Tooltip: "In your AsinFlow database."
- Absent → dash.

Must be visually distinct from the main table's `has_live_offer` shopping-bag
icon. Computed at render time from the set-based EXISTS query, never stored.

`has_live_offer` is NOT displayed and NOT stored here. This page is an
explicit exception to the §18 catalog-icon rule: the tri-state
`has_live_offer` icon and its NULL-state "+" create-listing link do not
appear, because Add to SC is not on this page.

**The distinction:** account-specific Seller Central state (live offers, SKUs,
inventory, sales) is excluded. Product-level Amazon catalog data from the
analyze pipeline (meltable, hazmat, DG, eligibility, pricing, fees, BSR,
seller counts) is retained — it describes the ASIN, not your relationship to
it.

### Saved lists

Lists persist and are selectable from a dropdown at the top of the page.
Selecting a list renders its stored snapshot.

Prices and fees are a snapshot from the last analyze run, not live. Creating
a list auto-runs the first analyze; subsequent refreshes are manual only. A
manual "Refresh Prices" button re-runs the bulk analyze for the selected list
and overwrites `bulk_list_asins` only. Snapshot age is shown next to the list
name. Lists can be renamed and deleted; delete cascades.

### Toolbar

Present: Upload CSV, Refresh Prices, Export CSV, Manage Columns, Settings,
list selector, save/rename/delete.

Export CSV downloads `bulk-<listname>.csv` with the visible §21 column set —
including Supplier SKU — honoring the checkbox selection (above).

Absent: Add to SC, Sync PO, Push to Aura, Sync Inventory, Sync Sales,
Sync Sourcing, Export SB COGS, Archive, Buy List.

### Nav

Top nav gains "Bulk Calc" as an active route, immediately after ASINs.
Structure otherwise unchanged (§8); added to the settings-gear routes, NOT to
the date-picker routes.

## 22. PO Module (Frame)

An in-app purchase-order database replacing the Google Sheets PO tracker —
eventually. The frame (schema, 2026 importer, read-only list + expanded view)
is **purely additive**: the sheet remains the source of truth for every
existing integration (PO sync → `actual_cogs`/`prep_override`, Velocity
export, SB COGS export, sourcing-cost export). Nothing repoints to these
tables until the cutover layer, and each repoint gets its own dry-run.

### Tables (migrations 028–029)

- `purchase_orders` — one row per order. `UNIQUE (supplier, order_id)` (order
  IDs collide across suppliers, §10). `source ∈ {manual, sheet_import}`.
- `po_asins` — one row per ASIN per order. `UNIQUE (po_id, asin)`. Carries
  qty, `cost_per_unit` (adjusted-COGS snapshot), prep, sold_as /
  units_per_pack, unreimbursed loss, Amazon SKU, notes.
- `po_line_items` — one row per supplier product. FK to its `po_asins` row
  (`ON DELETE SET NULL`). Carries price, per-item discount, qtys
  (`qty_ordered`, `qty_received`, `qty_canceled`, `qty_returned`,
  generated `final_qty` — migration 030, below), `asin_qty_per_product`
  (yield), `adjusted_product_cost` snapshot, Supplier SKU / UPC, notes.

Migration 021 dropped an older same-named scaffold; 028 is fresh, not a
revival.

**Lookup lists** live in `settings` as JSONB arrays: `po_payment_methods`
(13), `po_cashback_sites` (5), `po_emails` (2), `po_purchasers` (1).
**List order is meaningful: element 0 is the default** (mpeters.cqg@gmail.com;
Maria). The entry form must preserve order; never sort these lists.

### Stored vs. computed

Stored snapshots, written at save/import, recomputed only on edit (layer 2):
`cost_per_unit`, `adjusted_product_cost`. Migrated rows carry the sheet's
values **verbatim — never re-derived**, so app numbers match the sheet
penny-for-penny.

Computed at render, never stored: ASIN total cost (`qty × cost_per_unit`),
COGS with prep, PO rollups (ASIN count, unit sums, COGS total),
unique-products-per-ASIN (count of line items sharing a `po_asin_id`),
Velocity quantity (`units_per_pack × qty`), invoice file name
(`YYYY-MM-DD_supplier_orderID`, built from local date components — pg returns
DATE as a JS Date; never string-slice it), bundle set-count check.

### Canceled / returned / final quantities (migration 030)

Decisions resolved 2026-08-22:

- `qty_refunded` was RENAMED `qty_returned` (data preserved — the import
  wrote blank Col R as 0, which stands: a blank refund cell means none
  occurred).
- `qty_canceled` is NULLable with NO default. **NULL = not tracked**: all
  sheet-imported rows stay NULL — **no backfill**, and no status-derived
  writes; the sheet recorded only status tokens + ordered qty. The entry
  form writes explicit values (its 0 default lives in the form, not the
  column).
- `final_qty` is GENERATED ALWAYS STORED:
  `qty_ordered − qty_canceled − qty_returned` — plain arithmetic, **no
  COALESCE**. NULL propagates by design: historical rows render Final as a
  muted em-dash ("not tracked"); app-entered rows compute real values.
  Explicit 0 renders muted, never as an em-dash.

**Cutover exclusion rule** (recorded now, applied at the cutover layer): a
PO is excluded from profit calculations when `final_qty = 0`, OR when
`final_qty IS NULL` (not tracked — all sheet-imported rows) AND status
contains `canceled` (case-insensitive containment, the standard
convention). `final_qty` is authoritative when tracked; status is only the
fallback for untracked rows. A partially-canceled PO with `final_qty > 0`
is INCLUDED regardless of status tokens.

### Multi-row same-ASIN semantics

Two distinct cases, distinguished by the sheet's Col S at import (and by
entry-form intent later):

- **Bundle** (S ≥ 2): component rows share one `po_asins` row; the sheet's
  Col N is the group total duplicated per row → **take-first**. Set count =
  `min` over components of `qty_ordered × asin_qty_per_product`.
- **Pack-size merge** (S = 1, same ASIN on 2+ rows): independent supplier
  listings (1-pack / 2-pack / …) feeding one ASIN → contributions are
  **additive**: `qty = SUM(Col N)`; cost is verbatim when rows agree, else
  qty-weighted average in integer cents (the §11 SB same-date-merge
  precedent), reported as a deviation-from-verbatim.
- N-weighted cost basis reviewed 2026-08-20 and stands (homedepot WN63100522
  $17.61 outlier accepted) — do not reopen.
- A mixed group (S=1 and S≥2 rows for one ASIN in one order) is a data error:
  report and skip the PO, never guess.

Both cases render identically in the ASINs tab: one row with an expander
revealing component line items.

### Importer (`script/import-po-2026.ts`)

2026 data only (prior years deferred — a future import extends the cleanup
map after its own profiling pass). **Input source: the mirror sheet, read
directly (2026-08-24)** — the default mode fetches `Sheet1!A2:AZ` from
`GOOGLE_SHEET_ID` through the same shared raw read as the PO sync
(`server/sheet-read.ts`), with the header sanity check reading `A1:AZ1`.
`--csv <path>` remains an explicit fallback for file-based runs. Parsing,
the cleanup map, all gates, and the row-accounting identity are IDENTICAL
in both modes; `rawRowsRead` comes from the ranged read's row count either
way, and source-row numbering matches (CSV data starts at line 2 after the
header; the sheet range starts at A2). The §11 mirror caveats apply: the
`IMPORTRANGE` must cover A:AZ, and a sheet correction reaches the importer
only after the mirror refreshes — freshness-gate any correction-driven
re-import by reading the changed row back first. **Dry-run by default**,
`--live` explicit. Idempotent on `(supplier, order_id)`: existing
POs skip and report — re-runs and resumes are safe. Row-accounting identity
printed every run; remainder must be 0. Every cleanup-map hit is reported and
row-identified; nothing normalizes silently. Single-token payment/cashback
normalization is case-insensitive against the seeded spellings;
split-payment free-text strings import verbatim and are never substring-
edited. `qty_received` blank → NULL (never 0); prep blank on a real row → 0
(§3). Amazon SKU joins `asins.primary_sku` at import time; no match → NULL.
A row with a parseable date but a blank/whitespace Order ID lands in its own
`blank_order_id` skip bucket (row-identified, part of the identity), never
grouped or imported — guard added 2026-08-24 after a live dry run showed an
in-progress sheet row would otherwise import as `(supplier, "")`.

### UI rules

- Route `/purchase-orders`: list (25/page, `order_date DESC`) → expanded view
  (three tabs: PO Details · ASINs · Products). Read-only in the frame; **+
  New PO renders disabled** until the entry form ships. The Upload to
  Velocity toolbar action (§11) is unchanged and stays on this page.
- Search spans order_id, ASIN, and product name in one box. Supplier and
  status filters are **searchable multi-selects** (OR within a facet, AND
  across facets); status matches by token containment (`.includes()`, same
  convention as the sheet sync). Status renders as comma-split token chips in
  the FIRST column, color-coded by family — lifecycle: Ordered blue, SHIP
  indigo, Received* green, Closed neutral gray (recedes), Canceled muted red;
  returns orange; attention tags (ATTN: Velocity, See Comments, Confirm
  Refund / Replacement, Missing/Damaged, Lost/Damaged) amber. Tinted
  text/chip only — never saturated badge fills (§7). The sheet's vocabulary
  imports verbatim; no CHECK constraint.
- **SKU labels are never ambiguous:** column headers read **"Amazon SKU"**
  (ours, ASIN-level; amber "No SKU — create offer first" warning when NULL)
  and **"Supplier SKU / UPC"** (theirs, product-level). Component rows under
  an expander show a muted dash for Amazon SKU.
- **All money renders neutral** — no red/green on any money field (Discount
  and Refund included). `$0.00` renders muted. NULL money renders a muted
  em-dash, never `$0.00` — including rollups over all-NULL sets (a canceled
  order's COGS Total is unknown, not zero). Amber is reserved for warnings.
- Invoice file name renders in the Meta card with a copy icon.

### Source-of-truth ownership (additions to §14)

| Field | Owner |
|---|---|
| `purchase_orders` / `po_asins` / `po_line_items` (all fields) | PO module UI + importer — nothing else writes them |
| `settings.po_*` lookup lists | Migrations (seed/append) + entry form (layer 1) |

The PO module writes nothing outside its own tables. `asin_estimates`
(`actual_cogs`, `prep_override`) remains owned by the sheet-based PO sync
until cutover.

### Deferred (agreed order)

1. Entry form (create; managed dropdowns; ASIN search; bundle merge prompt)
2. Edit + COGS formula engine (recompute snapshots; per-item discount math)
3. Invoice file upload (indicator → stored file)
4. POs-by-ASIN cross-PO view
5. Cutover (repoint syncs/exports sheet → tables; retire mirror; POs sub-nav)
6. Later: gift-card ledger, subscription alerts, Velocity bundles, %-type
   product discounts, §15 FIFO/lots, pre-2026 import
7. Velocity qty check-in pull — read-only sync of received/checked-in
   quantities from Velocity into a Velocity-owned po_asins column, matched on
   (order_number, asin); Velocity order quantity corresponds to the computed
   Velocity quantity (units_per_pack × qty), so no backfill or conversion
   layer is needed. Discovery probe first.
