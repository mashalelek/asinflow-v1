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
3. **Show parked** — default OFF (hides parked ASINs; replaced Show
   archived 2026-09-07 when `is_active` split into parked/dead — same
   persistence, same semantics)
4. **Show dead** — default OFF (hides dead ASINs)

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

1. **Description** — Product, Category, Brand, Supplier, Buy Link, Supplier SKU
2. **Stock** — Stock, Available (FBA), On Order, At Prep, **FBA Stock**,
   Reserved, Sent to FBA, Days Left
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
   Suppressed, Date Added, Last Reviewed, Price Age, Status (2026-09-07:
   active/parked/dead + reason; default hidden; multi-select filter),
   Submission

`COLUMN_GROUPS` array in code is the single source of truth. Both Manage
Columns panel order and table render order derive from it.

### Last Reviewed (documented 2026-09-10)

Backed by `asins.last_reviewed_at`. **Set automatically** when the user
clicks any review link in the Product cell — the Keepa link, the SAS
link, or the supplier/buy-link domain — via `markReviewed()` →
`PUT /api/asins/:asin/reviewed` (stamps NOW(); optimistic client
update). There is no manual date editor and **nothing clears it** — it
answers "when did a human last look at this row," and the honest answer
only moves forward. Renders as the tiny MM/DD/YYYY corner date in the
Product cell (dash when never reviewed, tooltip with the full
timestamp) and as the optional "Last Reviewed" column (Additional info,
default hidden, M/D/YYYY, em-dash when null). Filter: the `reviewed`
mechanism (Never reviewed / not reviewed in last X days / reviewed in
last X days — shared with Price Age's neutral-label variant). Sort is
date-aware (`DATE_VALUE_COLS`). Mirrored bulk-locally on Bulk Calc
(§21, 2026-09-10): same gesture, same renderer, same filter, backed by
`bulk_list_asins.last_reviewed_at` via
`PUT /api/bulk-lists/:id/asins/:asin/last-reviewed` — never the main
table; carried to `asins` on promotion.

### Sale Price cell renders row STATE (2026-09-09)

The Estimated Sale Price cell derives what it shows from the row, same
vocabulary as Bulk Calc (§21): a real price; the amber "BB (no FBA)"
fallback when only a buy-box/lowest price exists (the FBA-fee cell
carries the same amber indicator when the fee was estimated at that
non-FBA price); muted "No offers" when prices are NULL WITH a fetched
stamp (the conclusive nothing-is-for-sale state, check time in the
tooltip); a plain dash when never fetched. "⚠ Error" renders ONLY for a
genuine stored `asin_estimates.error` — never a synthesized
absence message (the 2026-09-09 poisoned-cell incident, §14).

### Buy Link column (2026-10-03)

The full `asins.buy_link` URL as its own Description-group column, sitting
between Supplier and Supplier SKU. Renders as a clickable link
(`target="_blank"`, `rel="noopener noreferrer"`) truncated at 30 chars with
the value on hover — the same truncate-with-tooltip interaction as Notes and
Promos.

**One writer path.** Inline editing reuses `BuyLinkEditor`, the pencil-popover
the Product cell already uses, PUTting `/api/asins/:asin/buy-link`. No second
editor and no second endpoint: Supplier keeps DERIVING from the same stored
URL via `cleanBuyLink` + `extractDomain` (§14), so editing Buy Link updates
Supplier in the same round-trip, and clearing the URL blanks both.

**Default hidden; available in the column picker.** (`defaultVisible: false`.)
No per-view default is possible today: `ColumnDef.defaultVisible` is a single
global boolean with no per-preset dimension — the §21 bulk page gets its own
defaults only by rebuilding the column list with `BULK_DEFAULT_VISIBLE` — and
there is only one default preset anyway (see "Default view presets").

Keepa-style text filter — the `getFilterType` default, no registration needed.
Sorting and filtering read `getRowValue`, the one accessor (§14).

### Export CSV headers — group-qualified, round-trip-safe (2026-10-03)

The ASINs-page export emits `ColumnDef.qualifier` + `label` for every column
that carries one, so the header says **"Estimated COGS" / "Actual COGS"** and
**"Estimated Prep Cost" / "Actual Prep Cost"** rather than two columns both
named "COGS". The qualifier already drives the table header and the column
picker; export now reads the same field instead of `label` alone.

Note on the old symptom: the CSV never contained "COGS.1". It contained the
header "COGS" **twice**, and Excel / Sheets / pandas disambiguate on read by
suffixing. Two same-named columns were the actual defect.

**Round-trip.** The export is an upload source, so headers must be mapper
aliases:
- **"Buy Link"** was already an exact alias of `buyLink` on both matchers —
  verified, not added.
- **"Estimated COGS"** / **"Estimated Prep Cost"** were NOT server aliases
  (`matchColumnName` is an exact match on the normalized header). Added to
  `COLUMN_NAME_ALIASES` for `cogs` / `prepCost`.
- **"Actual COGS"** / **"Actual Prep Cost"** are deliberately NOT aliases.
  Actual COGS comes from the PO sheet and SellerBoard (§2), never from a CSV
  upload, and importing an actual as an estimate would silently corrupt it.
  The client auto-matcher used to match them anyway (`/\bcogs\b/i` matches
  "Actual COGS"), and since Actuals precede Estimates in column order,
  `autoMatch` — first header wins, file order — would have bound Est. COGS to
  the **Actual** column and left the real Estimated column unmapped. A
  `MappingField.excludePatterns` guard (`/^actual\b/i` on `cogs` and
  `prepCost`) blocks that. Renaming the headers is what made this reachable;
  before it, both columns read "COGS" and the first one won regardless.

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
  - **Refresh paths (corrected 2026-10-10):** (a) "Recheck" button in the
    column tooltip → `POST /api/asins/:asin/recheck-issues`, which runs the
    listings reconcile STAGE scoped to one ASIN (`runFullScopePass`); (b)
    EVERY probe through the §18 A2 primitive writes the snapshot for each ASIN
    it definitively probes — the listings component (16) of the Refresh
    job, the §19 ladder, and the §19 verdict/stale re-probes. Fail-closed:
    transient probes write nothing.
    The previous text named `syncLiveOffers`, a "07:00 cron" and the
    "inventory-sync rider" — the rider was removed 2026-09-06, no cron ever
    called the pass, and the module was deleted 2026-10-09.
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

### Lead Source column (2026-10-13)

Where a lead came from, as a first-class field. In the **Additional info**
group directly after **Sourcing**, `defaultVisible: false`. It sits there
rather than in Description because it is the same kind of field as Sourcing
— how the lead reached us — not a product attribute (moved 2026-10-13).

- **Closed set:** `ER` · `Spark` · `OA Hunt` · `OAL 24/7` · `MP` · `RA`,
  enforced by a CHECK on `asins.lead_source` and `bulk_list_asins.lead_source`
  (migration 048). **NULL is meaningful** — "we don't know" — and is what
  §18 phase c leaves an SC-discovered ASIN, which has no lead source AF can
  honestly claim.
- **Chip colours (2026-10-13)**, distinct from each other AND from the §20
  tag palette, because a lead chip and a tag chip sit on the same row:

  | | |
  |---|---|
  | ER | `#9B7BD6` soft violet |
  | MP | `#5B8DEF` mid blue |
  | RA | `#8A94A6` cool grey |
  | **OAL 24/7** | `#7A2E45` burgundy, darkest |
  | **Spark** | `#96405A` burgundy, mid |
  | **OA Hunt** | `#B0546F` burgundy, lightest |

  The three **OA-family** sources are a burgundy ramp, dark → light in even
  steps (RGB distance 39.4 then 38.9), so they read as one family at a
  glance; the three standalone sources take unrelated hues.

  `LEAD_SOURCE_COLORS` in `shared/schema.ts` is the ONE source — the row
  chip, the inline-edit popover and the filter swatches all read it, so a
  colour change is a one-line edit and cannot half-apply.

  **Known proximity, accepted:** MP `#5B8DEF` is close to the OTHER-group
  tag colours Wholesale `#3B82F6` and especially SC import `#60A5FA` (RGB
  distance 26.9). A row carrying both an MP lead source and an SC import tag
  shows two similar blues. They are different shapes in different columns,
  so this is tolerable, but it is the tightest pair across the two palettes
  and worth knowing before either is changed again.
- **Inline edit** — single-select popover (the Sourcing pattern) with a
  Clear. `PUT /api/asins/:asin/lead-source`; an unrecognised value is a
  **400 naming the allowed set**, not a CHECK-violation 500.
- **Filter** — multi-select with counts, listing **every** enum value
  including `(0)`, plus "No lead source". Same rule as the §20 tag filter:
  the set is closed and known, so deriving the list from the result set
  would hide a source that merely has no match in the current view.
- **Export CSV** and the export → Bulk Calc round trip carry it, through
  `getRowValue` — the one accessor for sort, filter and export (§6).

**Replaces three tags.** Spark Lead, OA Hunt and OAL 24/7 encoded this in a
structure that cannot express "exactly one of these": an ASIN could carry
two, or none, and nothing noticed. The 2026-10-13 backfill migrated them and
the tags were deleted (§20).

### Catalog icon — three states (2026-10-10)

The Product cell's catalog icon reads from **two sources, because it shows
two different facts** (§18): liveness from `asins.has_live_offer`, which only
a probe of SC may write, and pendingness from the §19 ledger. Neither
pretends to be the other.

| state | render | condition | tooltip |
|---|---|---|---|
| **Pending** | hollow bag + small clock | the NEWEST `listing_submissions` row for the ASIN is `pending`, `processing` **or `stale`** — **regardless of the flag** | "Submitted — waiting for Amazon to publish" |
| **Listed** | solid bag | `has_live_offer = TRUE` | "Listed in Seller Central (Active or Inactive)" + the age of `offer_checked_at` |
| **Not listed** | `"+"` (Add to SC) | `FALSE` or `NULL` with no open ledger row | "Not listed — Add to SC"; when the newest ledger row is `failed`, **its** failure reason instead |

Precedence is top to bottom: an open ledger row shows PENDING even if the
flag is already TRUE (the submit is genuinely still unresolved), and even if
it is FALSE (Amazon hasn't published yet — that is the whole point of the
state).

**The failure reason comes from the newest LEDGER ROW, not from
`current_issues`.** This is not a style preference, it is forced: §18 writes
the issue snapshot from the live probe, and an ASIN with no listing correctly
snapshots `[]` (no listing, no listing issues). B07J2WWWD4 demonstrates it —
after its 2026-10-10 reconcile, `current_issues` is `[]` while
`listing_submissions` still holds the `13013` + `5886` that explain why there
is nothing there. Reading the tooltip from the snapshot would show an empty
reason on exactly the rows that most need one.

**`in_catalog` no longer exists** (dropped by migration 052, decision 11;
it was a one-way discovery latch that over-reported and retained
tombstones, and nothing read it).

**Add to SC stays DISABLED while the latest submission is unresolved** — same
ledger read as the Pending state, so the guard and the icon can never
disagree about whether a submit is in flight. This is why **`stale` is in the
Pending set**: the server's `NON_TERMINAL` / `countOpenAmong` and the client's
disable set all gate on the same three statuses, and a `stale` row is still an
unresolved submission — it aged out of the probe ladder without a verdict, so
AF still cannot claim "listed". (An earlier draft of this table listed only
`pending` and `processing`; that would have split the icon from the guard.)

**What changed:** until 2026-09-21 the icon was flag-only, and "pending" did
not exist. From 2026-09-21 to 2026-10-10 pendingness was encoded IN the flag
(ACCEPTED wrote `TRUE`), with the ledger supplying only the render style —
so the flag meant "listed OR submitted" and nothing reading it could tell
which. The states above are the same three the user saw; what moved is where
each one's truth comes from.

### Stock object population

The stock object is **always populated** (`routes.ts`, `/api/asins`). ASINs
with no inventory snapshot render Stock as **available 0 + On Order** (never
`-`), so numeric Stock filters include them rather than dropping the null row.
`on_order` comes from the PO tables (`asin_po_pipeline`, below) and surfaces
even when the ASIN has never been seen in Seller Central. A `hasSnapshot` boolean on the
object lets the client hover breakdown distinguish **"no FBA snapshot yet"**
(shows "Not yet synced from SC") from a confirmed zero. This is a display/read
fix only — nothing is written to `inventory_snapshots`.

### On-order columns derived from POs (2026-10-17)

Patch `docs/claude_spec-patch-asins-on-order-from-pos.md` (clean-up the
same day), pre-flight `docs/asins-on-order-preflight-2026-10-17.md`. The
sheet's "Ordered" column (`asin_estimates.ordered_qty`, a copy of the
Orders sheet's open quantity that never decreased when units shipped) is
**gone** (D2 — one number, one meaning). Two columns in the Stock group
are computed live from `po_asins` ⋈ `purchase_orders` by
`server/asin-po-pipeline.ts` (`loadAsinPipeline`, one query folded per
ASIN; no stored column, D3), in ASIN / sellable-pack units, over **open
and closed** POs alike (row-level Status patch §2.4, 2026-10-17 — the
earlier "open POs only" rule (D1) let a wrong Closed hide real units,
e.g. target.com 912003733645362):

| Column | Formula (Σ over the ASIN's `po_asins` rows) | Default |
|---|---|---|
| **On Order** | Σ max(Expected − Shipped FBA, 0), where Expected = Ordered − Canceled − Returned − Lost/damaged by us (NULLs read 0), over rows whose PO is dated on/after the **reconciliation start** (the earliest stored Velocity shipment, 2026-05-20; `VELOCITY_MIN_ORDER_DATE` when none is stored). Older rows contribute 0 — no shipment data exists for them | shown |
| **At Prep** | Σ At Prep Center — Velocity's quantity on every row | hidden |

Shipped-not-received units are Amazon's own number, **Sent to FBA**
(inbound shipped + receiving + working from the FBA inventory sync),
unchanged; the PO-derived Inbound FBA / Pipeline columns of the first cut
were removed in the clean-up. Each cell's tooltip names its formula; the
On Order cell links to `/purchase-orders?asin=<ASIN>`, which opens the
POs page searched on that ASIN, Open and Closed. **Stock total = available +
reserved + Sent to FBA + On Order** and **FBA Stock = Stock − On Order** —
the identity below unchanged. The Stock tooltip reads Available (FBA),
Reserved, Sent to FBA, On Order (POs) — nothing else. Days Left inherits
the Stock change. The history modal shows On Order (POs); the
`inventory_snapshots.ordered_qty` column now records On Order at snapshot
time. Bulk Calc excludes the whole Stock group and is untouched; Analytics
reads the same column ids. `asin_estimates.ordered_qty` is no longer
written or read and is dropped by a later cleanup migration. Fixture
(local and production 2026-10-17): B004WZ4CLW on order 0 / at prep 0;
0349125937 2 / 2; B007ICV2AA (one closed pre-May PO) 0 / 0.

### FBA Stock column (2026-09-17)

**FBA Stock = Stock − On Order** (Stock − Ordered until 2026-10-17), a REAL
numeric field on the row model
(`AsinResult.fbaStock`) computed ONCE server-side where rows are built, from
the same two values the Stock and On Order cells render — never at render
time. Sort, numeric filters, CSV export, and the cell all read that one
field, so they cannot disagree, and it is always `number`-typed (a string
silently breaks numeric "greater than" comparisons). The identity therefore
holds visually row by row. A row with no inventory snapshot renders Stock as
`available 0 + on_order` (the rule above), so its FBA Stock renders **0**, not
the negative of its on-order quantity. Sortable, numeric-filterable, in CSV
export and Manage Columns. **Default-visible wherever Stock/On Order are**
(revised 2026-09-17 — it shipped default-hidden for one day). Present on
every table built from the shared column defs — the ASINs page and the
Repricer tab (§23); absent from Bulk Calc, which excludes the whole Stock
group (§21). Saved view presets list columns explicitly and do not absorb
new ones; adding it to a preset is a deliberate per-preset edit.

### Numeric cells render zero, never a dash (2026-09-17, final)

Every NUMERIC column renders **0** (counts) or **$0.00** (money) where it
used to render `-` / `—`. The reason is behavioral: a dash made the row
invisible to numeric filters and unsortable against real values, so
"Actual Units Sold = 0" or "Estimated ROI ≤ 0" silently skipped exactly the
rows the user was looking for.

**ONE accessor, no duplicates.** `getRowValue` is the only value source for
sort, numeric filters, and CSV export on EVERY table surface. The main ASINs
page previously carried its own near-copy switch for filtering, which drifted
from it: the copy had never heard of FBA Stock (so "FBA Stock > 0" matched
nothing while sorting the same column worked) and returned raw nulls,
bypassing the coercion below. Removed 2026-09-17 and pinned by test — a page
that re-derives filter values is the bug, not a style choice.

**The coercion lives in the ROW DATA MODEL, not the cell renderer.**
`getRowValue` — the single value source for sort, numeric filters, and CSV
export — returns a literal `0` for any numeric column that computes to
null, and the renderer displays that same `0`. Display, sort, filter, and
CSV therefore always agree on the same number. A renderer-only fix would
leave filters blind to exactly the rows this change exists to surface.

Semantics differ by column **PROVENANCE**, not by null-ness:

**A. Event-derived** — computed from order records: Actual Units Sold,
Actual Revenue, Refunds, Refund %, Actual Avg. Sale Price, and any other
order-event aggregate. **Absence of orders in the range IS zero**: 0 sold,
$0.00 revenue. Render plain `0` / `$0.00` in NORMAL text, styled
identically to any other number — no muted colour, no indicator, no
"no data" tooltip. No exceptions.

**B. PO-sheet-derived** — looked up from PO records: **Actual COGS** and
**Actual Prep Cost**. Absence means "no PO record found" — genuinely
unknown, possibly an unmapped sale or a missing row. Render `$0.00` in
NORMAL text AND keep a small amber missing-record indicator (the §3
prep-warning pattern, extended to Actual COGS 2026-09-17). The number is a
first-class `0` for sort/filter/CSV; only the indicator marks the record
gap.

**C. All other numeric columns** — counts, fees, estimates: null renders
and behaves as plain `0` / `$0.00`, normal text. An estimate that is null
because a required input is missing (e.g. no COGS on file) still shows 0 —
the Product cell's Est. COGS line and its M-badge remain the signal for
that.

Scope: the main ASINs table, the Repricer tab (§23), and the Bulk Profit
Calculator (§21) — all shared table surfaces render identically. Any
muted/grey zero styling or "no data" tooltip from the first iteration of
this change is REMOVED. Non-numeric (text) columns keep their dashes.

One deliberate hold-out, unchanged by this rule: **Estimated Inbound Ship.
renders `?`** when the item's weight is unknown, because a missing weight
is an unknown cost, not a zero one, and showing `$0.00` would understate
landed cost (long-standing decision, recorded in CLAUDE.md). It is not a
dash; its sort/filter/CSV VALUE is `0` like every other numeric, so the
filter-visibility guarantee above still holds.

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

**There is ONE default preset: Full View.** It defines initial column
visibility, sort, and applied filters.

**Replenishment and Sourcing are no longer presets (removed 2026-05-23).**
They were seeded as built-ins on 2026-04-04 and deleted in the B3 cutover by
`database/delete_replenishment_sourcing_presets.sql`, with the rows backed up
re-runnably in `database/backup_deleted_view_presets_20260523.sql`. Why each
went:
- **Replenishment** — its FILTER LOGIC moved to the Replens scorecard tile,
  which calls `isReplens()` in `shared/profitability.ts`. §4 documents that
  filter, and §4 is still live: it is a **filter reached from a scorecard
  tile**, not a preset. Only the preset wrapper was removed.
- **Sourcing** — carried no filter at all, just a column-visibility set, and
  was unused.

Earlier wording in this section claimed three default presets; that was
stale from 2026-05-23 until corrected 2026-10-03. `view_presets` currently
holds exactly one row. User-saved presets are unaffected — they are created
through `POST /api/view-presets` with `is_default = FALSE`, and the DELETE
endpoint still blocks `is_default = TRUE` rows, which is why removing the
built-ins needed that one-time script.

The following columns are available in the column picker but are NOT included
in the default preset — the user enables them per-need:

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
- **Repricer** — active route (2026-09-15, Phase 1b): the zero-sales view
  (§23). Added to the settings-gear routes, NOT to the date-picker routes.
  The original reason ("its window is fixed") was superseded 2026-09-16 when
  the window became selectable — but the conclusion is UNCHANGED and now
  load-bearing: the page owns a **page-local** range control that must never
  read or mutate the global range other pages share. Staying out of
  DATE_PICKER_ROUTES is what guarantees that. Nav structure otherwise
  unchanged.
- **Shipments** — disabled, "Soon" badge
- (right side) **Dark mode toggle**

Disabled items: muted text, no hover state, not clickable. The "Soon" badge
indicates a planned future module.

When a future module ships, its nav item activates. The structure of the top
nav doesn't change.

A sub-nav strip below the top nav will be added when the PO module ships
(for POs / Suppliers / Invoices / Reconciliation sub-pages). Not built yet.

---

### ASINs-page toolbar (order + names, 2026-09-07)

**Label uniqueness (standing rule, 2026-09-09; corrected same day): a
button label names exactly one job AT A TIME, app-wide.** The same word
must never be live on two different jobs simultaneously; a label freed by
a rename may be reused (Bulk Calc's "Refresh" reuses the ASINs page's
pre-09-07 label — correct under this rule). Any new or renamed button
must be grepped against every existing button/menu label before commit,
and collisions reported.

Left group, in this exact order — renamed by the data each button updates,
the two sync jobs sharing the `RefreshCw` two-arrows icon so they read as a
pair (route paths did NOT change; they are not user-facing):

| # | Label | Was | Notes |
|---|---|---|---|
| 1–2 | **Refresh (N)** | Product Info + Prices & Stock | one button, one job, all 21 components (§11 "Refresh job", 2026-10-15); N = working-set size; shows the running component and a Cancel; the history clock opens the jobs dialog |
| 3 | **Sync Sourcing** | — | unchanged |
| 4 | **Sync POs** | Sync PO | plural |
| 5 | **Push to Aura** | — | unchanged |
| 6 | **Export SB COGS** | — | unchanged |
| 7 | **Update COGS in SC** | Export Sourcing Cost | its history clock stays beside it. **Since 2026-10-31 it submits the Sourcing cost (col AR — COGS before the gift-card discount, promos applied; §22 "Costs"), not `actual_cogs`** |

Upload File and Export stay on the right. The Archive action is now
**Park** / **Unpark**, plus **Mark dead** (reason: preset `ip_complaint`,
`not_sourceable`, or free text) and **Revive** — all selection-aware.

## 9. Settings

Accessed via gear icon in the toolbar (not in top nav). Opens a modal with
global defaults:

- **Prep cost** — per unit, used for Estimated Prep Cost calculation
- **Hazmat surcharge** — per unit, applied to hazmat-flagged ASINs
- **Inbound shipping rate** — $/lb, used for Estimated Inbound Ship.
- **Price source** — Lowest FBA or Buy Box (also exposed as a toolbar toggle)
- **Max COGS thresholds** — three values used by the Max COGS column, in
  the same field order as Profitability Thresholds (Margin, ROI,
  Profit/Unit — 2026-10-16):
  - `max_cogs_min_margin_pct` (default 12)
  - `max_cogs_min_roi_pct` (default 20)
  - `max_cogs_min_profit_unit` (default 3)
- **SP-API credentials** — read-only status; set as environment variables
  on the server (Render → Environment; locally in `.env`)
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

> **Intake-only since 2026-10-18** (patch `docs/claude_spec-patch-po-af-owned.md`, §22 "AF owns POs").
> The only reader left is Sync POs' intake (`server/po-sheet-sync.ts`): it
> inserts sheet POs that are not in AF and not tombstoned, and never writes
> an existing one. Every former reader of this sheet now reads the AF PO
> tables through `server/po-af-source.ts`:
>
> | Reader | Now reads |
> |---|---|
> | Per-ASIN COGS / prep / supplier (`runSheetsSync` — Sync POs' second half, Push to Aura, component 9), Reset COGS, Sync Est. COGS from PO (single + bulk), the onboarding supplier fallback | `loadAfAsinCostMap`: per ASIN, the **newest non-canceled ASIN row** — `ORDER BY order_date DESC, entry_seq DESC` (`NEWEST_PO_ORDER`, `server/po-entry-seq.ts`); an ASIN row is canceled when every line has `qty_canceled ≥ qty_ordered`. cost = `po_asins.cost_per_unit`, prep = `prep_cost` (NULL → 0), supplier = the PO's |
> | Upload to Velocity (CSV, plan, execute), Export SB COGS, the sourcing-cost export | `loadAfPoRows`: one sheet-shaped row per product line, newest first. Col D ← "Closed" when the PO is closed, "Canceled" when the line is fully canceled; Col U ← qty ordered × yield ÷ unique products (2-dp yields restored to the fraction typed; on a one-product S=1 row the stored integer ASIN qty wins unless the product is the half / third / quarter / sixth it was rounded from); Col AZ ← units (bundle: sets × units per bundle; otherwise U × units / pack); AX / AY / S / T / L / N / Y / AS from the ASIN row and line |
>
> Same outputs as the sheet for unchanged data, verified per reader with a
> before/after diff (commits 4a–4d, 2026-10-18): cost / prep identical on
> 1,597 / 1,597 ASINs; Velocity 505 of 510 records identical (the rest:
> the Tetley supplier alias and one sheet row with a blank order #); SB COGS
> 1,916 of 1,925 rows; sourcing cost 827 / 827. `entry_seq` breaks a
> same-day tie the sheet broke by row order (imported POs: the sheet's
> order, higher row = newer; AF-created POs: creation time) — the 751-ASIN
> pre-2026 cost check reads 751 / 751 with it. No route that used to read
> the sheet is gated on `GOOGLE_SHEET_ID` any more; `POST /api/sheets/sync`
> (the intake) keeps its gate.
>
> The rest of this subsection describes the sheet-era readers and is kept
> as the record of what the AF rows reproduce.

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
| U | 20 | Ordered qty | Read into the in-memory sheet map only; **no longer stored** since 2026-10-17 — On Order is derived from the PO tables (§6) |
| Y | 24 | COGS | True product cost only (prep removed). See selection rule below |
| AS | 44 | Prep cost | Per unit. Empty cell on the selected row → `0`, not `NULL` |
| AX | 49 | sold_as | Velocity-ready, pass through verbatim |
| AY | 50 | units_per_pack | Velocity-ready, pass through verbatim |
| AZ | 51 | quantity | Velocity-ready, pass through verbatim |

**Selection rule (COGS / prep / supplier) — sheet era, to 2026-10-18.** These came from the **first
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

**Ordered-qty clearing pass (2026-08-23 → retired 2026-10-17).** While
`runSheetsSync` wrote `asin_estimates.ordered_qty`, a vanished ASIN (rows
corrected in the sheet) kept its last-written quantity forever, so a
clearing pass zeroed every non-zero `ordered_qty` with no rows in the
current read — all of them on full-catalog runs, in-filter only on scoped
runs, never on an empty read. Since the ASINs page derives On Order from
the PO tables (§6, patch asins-on-order-from-pos), the sync no longer
writes `ordered_qty` at all and the pass is gone; `cleared` /
`clearedAsins` stay in the result (always 0) for the toast and the
component-9 ledger. The cost snapshots this sync writes — `cogs` /
`actual_cogs`, `estimated_cogs`, `prep_override`, `asins.supplier` — are
point-in-time records and were never cleared.

**Fail-closed gate (kept).** The sync reads through `fetchSheetDataWithMeta`, which returns
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
`server/velocity-export.ts` (`buildVelocityRecords(from, to)`) over the
per-row PO view — since 2026-10-18 `loadAfPoRows` over the AF PO tables
(§11 "Google Sheets PO tracker" banner; the sheet columns named below are
the fields each AF value stands in for), before that `fetchSheetRows` —
delivered by
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
3. **Ships to (2026-10-29): a Home PO is never pre-ticked.** Every row of a
   PO with `purchase_orders.ships_to = 'home'` — bundles and multi-ASIN rows
   included, any prep — is built through the same guards but kept apart
   (`homeRecords` / `homeBundles` → the plan's `homeCreates` /
   `homeBundleCreates`, minus what Velocity already has). The review dialog
   lists them in a collapsed **"Self-prep — not uploaded"** group with the
   reason ("Ships to Home"), **unticked**; only a deliberate tick sends one
   (execute takes whatever is ticked). The CSV export leaves them out. Their
   skips are counted (`homeSkipped`), not listed. Motivated by 482270182
   (2026-10-23): a home-shipped PO that reached Velocity.
4. **Col AS (prep cost) > 0** (Velocity POs). `AS = 0` or empty (per §3,
   empty on a real row means 0) → the row is **self-prepped** and never goes
   to Velocity. Counted as **`excluded (self-prep): N`** — a separate,
   intentional tally, NOT a skip.

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
- ~~`bundle_shipped_unidentified`~~ — **RETIRED 2026-09-21.** It suppressed
  every bundle create for an ASIN, permanently, after one shipment of that
  ASIN lost its child keys; three legitimate new orders (134524, 135707,
  200015497641702) were blocked by August shipments. Replaced by the
  identity record below — see "Bundle identity records". Its own revisit
  condition ("revisit only if this skip recurs in practice") had fired: 8
  groups across 4 ASINs.
- `bundle_unplaced_candidate` (2026-09-21) — an UNPLACED shipped bundle (a
  child-less shipment parent with no identity record, i.e. one AF never saw
  on a list leg) has this sheet group as a plausible original: same ASIN,
  derived total units = the parent's `quantity`, and sheet order date within
  ±1 calendar day of the Velocity `date`. Only the candidates are held; every
  other group of that ASIN proceeds normally. Cleared by the dialog's inline
  mapping action, which writes a `manual_map` identity row.
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
  `trackings` on GET. The PUT field is `trackingNumbers` (always sent);
  GET's element is `{carrier, tracking_number, tracking_status}`. PO
  tracking (§26) adds numbers through it — element shape per §26.

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

`velocity_bundle_identity` (migration 044, 2026-09-21) is NOT a gatekeeper
ledger and does not weaken this rule. It records no sends, and never causes
a create or a skip on its own: a row matters ONLY when Velocity itself
returns that parent `order_id` on a shipment row, at which point it restores
a key Velocity has stopped serializing. A parent deleted in Velocity simply
never appears again and its row is inert. Rows are insert/upsert only —
never deleted by code.

- Before sending, the match set is the COMPLETE-COVERAGE union
  (`fetchAllKnownOrders`, 2026-08-11): `GET /inbound` + `GET /inventory` +
  every `GET /shipments/:id` detail. `GET /inbound` serves ONLY active
  inbound orders (verified: status params silently ignored) — checked-in
  orders live in `/inventory`, fully-shipped orders ONLY in shipment details
  (near-miss 2026-08-07: two completed orders classified as CREATE and would
  have duplicated on send). Union precedence inbound > inventory > shipment;
  shipment-derived rows are pseudo-orders (`status "shipped"`; quantity =
  `quantity_shipped` for FLAT orders — never quantity-audited. **Bundles are
  different (2026-09-21, Part C.1):** a bundle's shipment rows are grouped by
  parent `order_id` — one known order per parent, never keyed `("", ASIN)` —
  and its quantity is the parent's `quantity`, the bundle TOTAL, never
  `quantity_shipped`. Split shipments made the old rule wrong twice over:
  c0835a42's four rows (2+6+2+10) collapsed to a single pseudo-row reporting
  quantity 2 instead of 20). **Fail-closed:** any leg
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
- **Bundle identity records (2026-09-21 — replaces "Shipped-bundle identity
  gap", 2026-09-02).** Fully-shipped bundles exist only as
  `GET /shipments/:id` rows. The evidence (read-only research 2026-09-21):

  - A shipment row carries the parent `order_id`, `date`, `quantity` (bundle
    total), `quantity_shipped`, `amazon_sku`, `item_name` — but
    `order_number` is **null** and `bundle_children` is **absent**.
  - `order_number` (the sheet order ID) never lives on the parent, only on
    children. Children are visible nested in `bundle_children` ONLY while the
    parent is on `/inbound` or `/inventory`; they never appear as top-level
    list rows, and there is no documented way to enumerate children from a
    parent once it leaves those legs. (Confirmed: `bundle_children` is absent
    from `GET /inbound/:order_id` for shipped AND still-inbound parents
    alike — it is a property of the single-order endpoint, not of shipping.)
  - A child `order_id` IS independently addressable: `GET /inbound/:child_id`
    returns its `order_number` plus a `bundle_order_id` back-pointer, even
    after the parent ships. What is lost is the ability to ENUMERATE them.
  - Split shipments: every shipment row of one bundle carries the same parent
    `order_id`; `quantity` is the bundle total and constant per parent;
    `quantity_shipped` is the per-shipment part (c0835a42: 2+6+2+10 = 20).
  - Units are total component units on both sides (Velocity `quantity`;
    sheet Σ Col L × Col T). 14 units at `units_per_pack` 2 = 7 bundles.
  - Velocity `date` is NOT reliable for dashboard-entered bundles: 2 of the 5
    legacy bundles are dated one day after their sheet order (c0835a42,
    074e6255) — consistent with the dashboard defaulting to the UTC date on
    late-evening entry (hypothesis; `date` is a supplied field, since two
    bundles created 16 minutes apart carry different dates). AF-created
    bundles send the sheet date explicitly.

  **The rule.** AF keeps an identity record so a key Velocity stops
  serializing can be restored:

  1. **Recording (Part B).** On EVERY `fetchAllKnownOrders` call (plan and
     execute), every `/inbound` or `/inventory` row with `sold_as = bundle`
     and non-empty `bundle_children` upserts a `velocity_bundle_identity`
     row (`source = observed`). While a parent is list-visible Velocity is
     the truth: observed children OVERWRITE the stored array, and a change is
     logged. After each successful bundle create in execute, one fresh
     `GET /inbound` read records the new parent; a failed capture is reported
     amber in the results and is NOT a failure of the create (the next run
     captures it while the bundle is still list-visible). Under `dryRun=1`
     recording is computed and reported ("would record N") but never written.
     A recording write failure is surfaced and the plan still completes —
     in-batch hydration already covers everything list-visible.
  2. **Reading (Part C).** Hydration order for a child-less shipment bundle:
     (a) in-batch from the list legs by `order_id`; (b) from
     `velocity_bundle_identity` by `order_id`. A hydrated parent gets its
     child order numbers and flows through the existing child-derived match
     keys → classified matched, counted under "shipped". Flat-order shipment
     rows are unchanged.
  3. **Unplaced (Part D).** A child-less shipment bundle with NO record is
     *unplaced* — in practice only a bundle entered directly in the Velocity
     dashboard that fully shipped before the next upload run. For each
     unplaced parent, candidate sheet groups in range are those with the same
     ASIN AND derived total units = the parent `quantity` AND a sheet order
     date within ±1 calendar day of the Velocity `date` (parsed dates;
     Velocity serializes zero-padded MM/DD/YYYY, the sheet is M/D/YYYY).
     Candidates are held as `bundle_unplaced_candidate`; every other group of
     that ASIN proceeds normally. An unplaced parent with no candidates holds
     nothing and is listed as info only.
  4. **Mapping (Part D UI).** In the Upload to Velocity dialog's SKIPPED
     section a `bundle_unplaced_candidate` row expands inline (the
     no-nested-modal pattern of `no_live_sku` / `legend_pending`) showing each
     unplaced Velocity bundle — order date, units, item name, SKU, Velocity
     created date — with **"This order is that bundle"** (writes a
     `manual_map` row mapping parent `order_id` → this group's order number;
     the row moves to the shipped count and any other candidates held only by
     that parent are released into NEW ORDERS pre-ticked, with no full
     re-fetch) and **"Map to a different order #"** (text input for the true
     original's order number, when none of the candidates is it; writes the
     `manual_map` row and releases all candidates held by that parent). No
     negative ("not this one") records are kept.

  **Seed (Part E, migration 044, `source = manual_seed`, confirmed by Maria
  2026-09-21):** 03bb63ec→{200015210238647} B0GNHTYGPF 14u;
  c0835a42→{200015523189765} B0GNHTYGPF 20u;
  48f9a158→{200015210238647} B0GWG5S64Q 10u;
  074e6255→{130097} B0DWXWHXP1 10u;
  80d43b58→{127552} B0DKT4NDFZ 10u. `child_order_ids` NULL for all five
  (they were never observed list-visible by AF).

  **History (2026-09-02, superseded):** the original rule surfaced these as
  `unidentifiedShippedBundles` and SUPPRESSED every bundle create for their
  ASINs, fail-closed, with no persistent identity table. That traded one
  phantom-CREATE risk for a permanent block on an entire ASIN — see §14
  "Fail-closed rules must name their victim and their exit".

- **Pagination tripwire, fail-closed both ways (2026-09-02):** on /inbound
  and /inventory, `data.results.total_results` must be present and finite —
  a missing/moved metadata field THROWS (no silent `?? 0` / `?? page
  length` fallback); after paging, fetched ≠ total THROWS. No plan, dedup,
  or execute runs on partial coverage — silent partial coverage is worse
  than no dedup. (Docs-wrong item #5: their pagination metadata is
  documented as `total`; the real field is `data.results.total_results`.)
  **Docs-wrong (2026-10-17): `offset` is a PAGE INDEX, not a row offset**
  — `limit=10&offset=1` returns rows 11–20 and `offset=10` nothing.
  `listInboundOrders({ page })` sends the page number; until 2026-10-17
  both list legs sent `page × 200`, correct only for page 0 (the tripwire
  would have thrown, never silently lost rows).
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

(Order creation / quantity changes: never on a schedule — §14 "Velocity
writes"; tracking-only pushes are the one scheduled write, §26.)
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
  **Execute re-fetches the live match set immediately before any write
  (2026-09-24).** An approved plan is a SNAPSHOT, not a mandate. Execute
  calls `fetchAllKnownOrders` at write time and drops every approved item
  that no longer classifies as a create, reporting it as
  `skipped_already_in_velocity` instead of sending it. Approval authorises a
  set of orders to EXIST in Velocity — not a set of POSTs to fire — so an
  order someone created in between is already satisfied and must not be sent
  again.

  *Origin (2026-09-24):* three bundle creates approved on 9/21 (135707 /
  B0DKT4NDFZ, 200015497641702 / B0GWG5S64Q, 134524 / B0DKT4NDFZ) had ALL
  been created in Velocity on 9/23 before the approval was acted on.
  Sending the approved set would have duplicated all three. The gap between
  approval and execution has a human in it and is unbounded in practice, so
  staleness is the normal case, not the exception.

  **Hydration happens before ANY key set is built — one shared
  implementation (fixed 2026-09-24).** `hydrateChildlessBundles` fills a
  child-less shipment bundle's children from `velocity_bundle_identity`
  (Part C.2), and BOTH `buildVelocityPlan` and execute call it before
  deriving keys. Execute previously built its key set from
  `matchKeysForOrder(live)` with no hydration at all, so a bundle whose
  parent had SHIPPED since approval keyed on the synthetic
  `__velocity_order_id:<uuid>` form, matched nothing, and would have been
  re-sent as a duplicate. Measured on the real 2026-09-24 set before the
  fix: 135707 and 200015497641702 were caught (parents still list-visible),
  **134524 was NOT** (its parent shipped on 9/23) — the duplicate was
  prevented only by re-running the plan by hand, because at that time only
  the plan hydrated. The two paths diverged precisely because each had its
  own copy of the logic; there is now one, and a test pins 134524's case
  (parent shipped, child-less shipment row, approved create must be
  dropped).

  Scope note: `/api/upload/velocity` (the bulk-CSV path) keys on the raw
  `(order_number, asin)` and does NOT hydrate — correct, because it sends
  FLAT records only and never bundles. Any future path that sends bundles
  must hydrate first.

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

> **Rows from the AF PO tables since 2026-10-18** (`loadAfPoRows`, §11 "Google
> Sheets PO tracker" banner). The column letters below name the field each
> AF value stands in for; `rawRowsRead` counts product lines, `blankAsinRows`
> is 0.

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

> **"Purchased in the window" comes from the AF PO tables since 2026-10-18**
> (`loadAfPoRows`, §11 "Google Sheets PO tracker" banner); the cost source is
> unchanged (`actual_cogs` with `cogs_source = 'po_sheet'`, written by
> `runSheetsSync` from the AF tables).

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
- **§6 Lead Source from col G (2026-10-13), NEW ASINs only.** The cell is
  normalised case- and whitespace-insensitively to the enum, with the aliases
  `FBA Spark → Spark` and `OAH → OA Hunt`, and a multi-value cell
  (`"ER, MP"`) resolves by priority **ER > MP > RA** regardless of order
  inside the cell. Multi-value cells are TOKENISED on `, / | & +`, never
  substring-matched — "Supplier" contains `er` and "Amp" contains `mp`.
  Unrecognised or blank → **MP**: the sheet is the marketplace lead pipeline,
  so MP is the honest default for a row that came from it without saying
  otherwise. The run result carries `unrecognizedLeadSources`, the DISTINCT
  unrecognised strings, so a systematic typo is visible rather than quietly
  becoming MP forever.
- For NEW ASINs (not yet in AF), runs the shared **new-ASIN onboarding**
  (`onboardNewAsins`, 2026-09-09; rewired 2026-10-15): the rows are
  inserted with the sheet's fields, then ONE Refresh job scoped to them
  is enqueued (trigger `onboarding`, daily block included — §11 "Refresh
  job"). `estimated_cogs_source = 'csv'`. Same function as CSV upload and
  the Chrome-extension add.
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

#### Second source: the ER leads sheet (2026-10-22, patch er-leads-sheet-sync)

- **Sheet:** "SAS Leads Sheet | ER", `ER_LEADS_SHEET_ID`
  (`12daJUqkYALr9YMCVpPS_KQupRXX6fNA_m59CYcyP0Wk`), tab **`Leads`** (gid 0),
  range `Leads!A1:AM`; client `server/er-leads-sheet.ts` (tab hardcoded, like
  the other two clients). Other tabs are never read.
- **Header tripwire:** row 1 must equal the 39 headers A–AM exactly
  (trimmed; F has no header) — drift aborts the ER leg with the per-column
  diff in the report. Never a guessed column.
- **Filter:** keep a row iff Approved (A) `.trim().toLowerCase() === "yes"`
  AND Date (B) parses (ISO `YYYY-MM-DD` as observed, or `M/D/YYYY`;
  rolled-over dates rejected) AND Date ≥ `ER_LEADS_MIN_DATE` (env, default
  `2026-10-20`, a **fixed floor**). Approved = Yes rows with a blank or
  unparseable Date are skipped and listed (`unparseableDates`: row, ASIN,
  value) — never treated as old or new. A row whose Approved flips to Yes
  later is picked up on the next run if its Date clears the floor.
- **Insert-only, same contract as the Master leg:** an ASIN already in
  `asins` (any status) is skipped untouched; rows collapse per ASIN, first
  non-empty wins, top row canonical (its Date is the lead date). The legs
  run Master first, then ER; an ASIN new in BOTH sheets in one run is
  inserted once, by the Master leg, and listed as `inMasterLeg` in the ER
  report. Both legs' new ASINs go through **one** `onboardNewAsins` call —
  one stream, one Refresh job.
- **Per inserted ASIN:** `lead_source = 'ER'` (no col-G normalisation —
  the sheet is the source); `buy_link` from H (supplier via
  `extractDomain`); `promo_notes` from I; `estimated_cogs` from M (Cost
  Price, per ASIN as-is) via `parseMoney`, `estimated_cogs_source = 'csv'`,
  unparseable → NULL → `cogs = 0`; `notes = "{AM}\nVA: {AJ}"` (Maria /
  Emelie, the Master rule); **`added_at` = the Date** (midnight America/New_York),
  set on the rows the leg just created after the onboarding insert —
  "Date Added IS the lead date". **No archive rule** (no status column).
- **Report:** `sheets[]` in the run result, one entry per sheet — read /
  filtered out / already in AF / inserted / failed (no `asins` row after
  the insert), plus `error` / `warning`; the ER entry also carries
  `unparseableDates`, `inMasterLeg` and `rows` (ASIN, date, buy link, COGS,
  lead source — what it inserts, or would insert on a dry run). The toast
  shows one line per sheet.
- **Fail-closed per leg:** a thrown read (either sheet), header drift or a
  malformed `ER_LEADS_MIN_DATE` aborts that leg only, reported in
  `errors` and its `sheets[]` entry; the other leg still runs. An ER read
  of 0 data rows is a **warning** (creds / share), not "nothing new".
  `ER_LEADS_SHEET_ID` unset → the ER leg is skipped with a logged warning.

Triggers:
- Manual: `POST /api/sync/sourcing-sheet` (NDJSON-streaming, auth-gated). Wired
  to the "Sync Sourcing" toolbar button on the home page. `?dryRun=true`
  reads both sheets and reports, writing nothing.
- Scheduled: **none** (2026-10-15). The 09:00 host-local cron
  (`sourcing-sync-cron.ts`) was deleted with the scheduler patch; Sync
  Sourcing is on-demand (§11 "Scheduled passes").

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
never rendered (gated on `isAnalyzing`; the strip that replaced it was
itself removed 2026-10-17 in favour of the Refresh button and jobs dialog). Root cause structural: pacing was
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
the wire). Header-adaptive **downward only** (2026-09-07):
`x-amzn-RateLimit-Limit` on any 2xx/400/404 may LOWER the bucket's rate
(logged) but never raise it above the table seed — Amazon's advertised 0.1
on itemOffersBatch kept re-raising the deliberate 0.09 seed to 0.095 and
drawing steady-state 429s. **429 handling lives here, once**: a
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

### Refresh job (scheduler v1, 2026-10-15)

Implemented from `docs/claude_spec-patch-scheduler-v1.md` (decisions
confirmed 2026-10-13 through 2026-10-15; component map
`docs/af_data_components.csv`, the CSV snapshot of the "AsinFlow Jobs List
(Cloud Deployment)" sheet). Supersedes the **Product Info** and **Prices &
Stock** job definitions that stood here from 2026-09-06/07, the three
node-cron schedules, onboarding's own stage order and Bulk Calc's own
pipeline. The 2026-10-13 cron audit found three crons that had never run,
no lock anywhere, a cron listings stage that could not onboard SC
discoveries, a Product Info button that fired an unledgered full-catalog
PO sync and a clear-all suppression sync, two buttons with overlapping
stages in different orders, a third order for onboarding, a fourth for
Bulk Calc, a 30-day cache that was supposed to be gone, and schedules
written in UTC comments that fired host-local.

**Rule.** Every refresh of Amazon-side or sheet-side data is a job on one
queue (`jobs`, migration 052), executed by one runner, **one job per
lane** (2026-10-16 — lane S the scheduled pass, lane M everything a person
or an onboarding started), in one fixed component order. Scheduled passes and the Refresh button
enqueue the same job with different scopes. **Nothing refreshes data
outside the queue.**

#### The component sequence

The single ordered list every job follows. Numbers are the component map's;
CALL-n is the API request, shared where several components ride one call;
the ledger stage is the `refresh_runs.stage` key the component writes.

| # | Component | Tier | Call | Ledger stage | Scope (scheduled) |
|---|---|---|---|---|---|
| 1 | SC-only SKU discovery + onboarding | hourly | CALL-1 `searchListingsItems` | `01_sc_discovery` | account |
| 2 | Catalog attributes | daily | CALL-2 Catalog Items batch | `02_catalog` | active+parked |
| 3 | Catalog-deleted signal | daily | rides CALL-2 | `03_catalog_deleted` | " |
| 4 | BSR / rank + category | daily | rides CALL-2 | `04_bsr` | " |
| 5 | Meltable | daily | rides CALL-2 | `05_meltable` | " |
| 6 | Dangerous good | daily | rides CALL-2 | `06_dangerous_good` | " |
| 7 | Hazmat | daily | CALL-3 inbound eligibility, per ASIN | `07_hazmat` | " |
| 8 | Eligibility / gating | daily | CALL-4 Listings Restrictions, per ASIN | `08_gating` | " |
| 9 | Actual COGS from PO sheet | hourly | CALL-5 Orders sheet | `09_po_sheet` | full sheet |
| 10 | Competitive prices | hourly | CALL-6 itemOffers batch | `10_prices` | active+parked |
| 11 | Seller count | hourly | rides CALL-6 | `11_sellers` | " |
| 12 | CPT (`asin_estimates.competitive_price_threshold`, migration 052 — decision 12) | hourly | rides CALL-6 | `12_cpt` | " |
| 13 | FBA fee estimate | hourly | CALL-7 feesEstimate batch | `13_fees` | " |
| 14 | Estimated profit / margin / ROI | hourly | computed | `14_profit` | " |
| 15 | FBA inventory snapshot + per-SKU buckets (`sku_fba_inventory`, 2026-10-18) | hourly | CALL-8 inventory summaries, `details=true` | `15_inventory` | " (buckets: account — every SKU in the response) |
| 16 | Live offer / buyable / issues (§18 reconcile) + listing state per SKU (`asin_skus.listing_created_at` / `offer_end_at` / `listing_checked_at`, 2026-10-18) | hourly | CALL-9 getListingsItem, per SKU, `includedData` + `attributes` | `16_live_offer` | active+parked |
| 17 | Primary SKU | hourly | derived from 15–16 | `17_primary_sku` | " |
| 18 | Suppressions (FYP) | hourly | CALL-10 FYP report | `18_suppressions` | account |
| 19 | Sales units / revenue | hourly | CALL-11 (today: orders report, 48-hour window; `params.sales_window` for the backfill) | `19_sales` | account — every ASIN in `asins`, all statuses (2026-10-16) |
| 20 | Refunds | hourly | rides CALL-11 | `20_refunds` | " |
| 21 | Actual fees charged | hourly | rides CALL-11 | `21_actual_fees` | " |
| 22 | Close OOS listings (listing hygiene, 2026-10-18; daily since 2026-10-20) | daily | CALL-12 `patchListingsItem`, per SKU | `22_close_oos` | every SKU 15/16 observed; **00:00 pass only**, before 24 |
| 23 | Inventory Ledger (`sku_ledger_state`) | daily | CALL-13 `GET_LEDGER_SUMMARY_VIEW_DATA` (DAILY, COUNTRY); `params.ledger_window` for the backfill | `23_ledger` | account |
| 24 | Delete long-dead listings (listing hygiene) | daily | CALL-14 `deleteListingsItem`, per SKU + Velocity `/inbound` + `/inventory` | `24_delete_dead` | every closed SKU; **00:00 pass only** |
| 25 | PO tracking ingest (§26, 2026-10-21) | daily | Gmail API (orders@, DWD, `gmail.readonly`) + matching | `25_po_tracking_ingest` | the mailbox since the watermark; **00:00 pass only**, after 9 |
| 26 | PO tracking push (§26) | daily | Velocity `GET /inbound` + known orders, `GET` / `PUT /inbound/:order_id` | `26_po_tracking_push` | matched tracking rows; **00:00 pass only**, right after 25 |

Dependencies the order encodes: 10 before 13 (fees need the fresh price)
(9 before 15 was retired 2026-10-17 — the inventory snapshot's ordered_qty
is now derived from the PO tables, not copied from the sheet); 15 before 16
(listings need the SKU set); 19–21 last so Actual profit uses this hour's
COGS. **The daily block (2–8) is executed only by the 00:00 pass** and by
any job enqueued with `include_daily` (the Refresh button, onboarding);
every other scheduled pass skips it. 1 runs first in every pass. 22, 23
and 24 are daily too and run only in the 00:00 pass (Maria 2026-10-20:
close moved from hourly to daily) — 22 needs this pass's 15 (complete) and
16 and runs before 24; 24 needs this pass's 15, 16 and tonight's 23.
Appending them after 21, in that order, satisfies every dependency.

**Listing hygiene (22–24, 2026-10-18).** Patch
`docs/claude_spec-patch-listing-hygiene.md` (decisions confirmed by Maria
2026-10-18; it replaces the backlog line "Delete in SC from AF — not
now"). Evaluated **per SKU**; ASIN-level pipeline data applies to every SKU
of the ASIN; `amzn.gr.*` SKUs are never closed (22) and are deleted only
by 24's amzn_gr rule (below; excluded entirely until 2026-10-21).
**Scope (Maria 2026-10-24): every SKU with a listing in Seller Central,
whatever the ASIN's AF status.** A full-scope job (scheduled pass, or the
`/api/listing-hygiene/run` full run) evaluates the scheduled scope (active
+ parked) plus the **dead** ASINs whose SKUs have an SC listing per the last
probe (`asin_skus.listing_created_at IS NOT NULL` — `hygieneScope` /
`deadAsinsWithListing`, `listing-hygiene.ts`). Component 16 probes the same
dead ASINs on every full-scope pass (counted `dead_with_listing`), so their
listing state is from this pass; component 15's `sku_fba_inventory` is
account-wide already. A dead ASIN with no SC listing stays out, a subset
job never widens, and dead ASINs stay out of every other component.

- **22 Close** (daily, 00:00 pass, before 24 — hourly until 2026-10-20) —
  a SKU whose listing exists and is not closed (the closed test, §18 —
  `isOfferClosed`: a create-only literal `2000-01-01` is NOT closed) is closed
  when Available (fulfillable), Inbound (working + shipped + receiving),
  FC Transfer (reserved › pending transshipment), FC Processing (reserved
  › FC processing), Reserved (reserved › pending customer order) and
  future supply are all zero. Unfulfillable and Researching do NOT block;
  stages before FBA (On Order, At Prep, POs, Velocity) are never read.
  The write is `patchListingsItem` `op: "merge"` on
  `/attributes/purchasable_offer` setting `end_at` to
  `BORN_CLOSED_END_AT`, built by the one helper (`closedEndAt`; the create
  payload carries no `end_at` since 2026-10-23 — close-after-create sends
  this same PATCH), with the `findForbiddenQuantityPaths` pre-flight abort
  before every PATCH. Outcomes: `closed` · `would_close` · `skip_has_stock:<bucket>` ·
  `skip_already_closed` · `skip_no_listing` · `skip_pending_submission` ·
  `skip_no_fresh_inventory` · `skip_probe_transient` · `skip_amzn_gr` ·
  `held` · `invalid` / `error`.
- **23 Inventory Ledger** — nightly last 7 days (overlap on purpose);
  `sku_ledger_state.last_stocked_date` (latest Date with Σ Ending
  Warehouse Balance over all dispositions > 0, per MSKU) only moves
  forward. Backfill: one manual one-component job with
  `params.ledger_window {from, to}`, 18 months, in 92-day chunks spaced
  for the report quota; `QuotaExceeded` waits and retries the same chunk,
  never skips it. Parsed with a quoted-TSV reader (titles contain quotes). Fail-closed tripwire: a report with zero rows
  while 15 shows any SKU with fulfillable > 0 is `inconclusive` — nothing
  written, and that night's 24 skips everything as `ledger_unavailable`.
- **24 Delete** — a SKU is deleted when its listing is closed now, every
  FBA bucket is zero (Unfulfillable and Researching included), nothing is
  in the pipeline for the ASIN — `asin_po_pipeline` On Order = 0 and At
  Prep = 0 (`server/asin-po-pipeline.ts`, §6) and no Velocity units on
  hand (live `/inbound` + `/inventory`, `quantity_remaining > 0`); there
  is **no open-PO blocker** (2026-10-19: a PO with nothing left to arrive
  would hold deletes with no visible cause and no exit) — and the OOS clock has run: ever-stocked
  `max(ledger_last_stocked_date, sku_fba_inventory.last_nonzero_at)` more
  than 60 days ago; never-stocked (no ledger history in the 18-month
  window and never nonzero in 15) `listing_created_at` more than 14 days
  ago. `deleteListingsItem` is asynchronous (ACCEPTED ≠ done); the next
  probe verifies (404 / empty summaries). Outcomes: `deleted` ·
  `would_delete` · `skip_not_closed` · `skip_has_stock:<bucket>` ·
  `skip_pipeline:on_order|at_prep|velocity` ·
  `skip_clock:<days>/<threshold>` · `ledger_unavailable` ·
  `velocity_unavailable` (any leg failed — the whole run skips) · `held` ·
  `invalid` / `error`.
  **amzn_gr rule (2026-10-21):** an `amzn.gr.*` SKU (Amazon Grade & Resell)
  is deleted when it has a listing and every FBA bucket is 0 (Unfulfillable
  and Researching included) — no closed-state requirement, no clock, no
  pipeline, unaffected by a ledger / Velocity outage; the freshness gate,
  action-pending guard and delete breaker apply. Outcomes
  `would_delete:amzn_gr` / `deleted:amzn_gr`, evidence `rule: "amzn_gr"`.
  22 never closes one (`skip_amzn_gr`); in both components the listing
  checks run first, so one without a listing is `skip_no_listing`.
- **Every SKU in scope gets an outcome**, and every candidate that fires
  (or would) gets a `listing_actions` row with the full evidence snapshot.
  Component 16 verifies on the next pass (close → the closed test holds with
  this action as the PATCH;
  delete → absent); still not effective after two passes →
  `not_effective`, surfaced in the jobs dialog.
- **Circuit breakers:** more than `settings.hygiene_close_breaker` (50
  since 2026-10-21, migration 065) closes or `hygiene_delete_breaker` (25)
  deletes in one run → write nothing, every candidate `held`. **Release**
  in the jobs dialog or the top-nav "Action required" list (or `POST
  /api/listing-hygiene/release {job_id, action}`) re-evaluates each held
  SKU live and fires only those that still qualify. Every Release opens an
  in-app confirm first ("Delete N listings in Seller Central? Each is
  re-checked live first."); nothing is queued until confirmed. **One
  release per job + action**: a second while one is queued, running or done
  is refused (409); a failed / cancelled one may be retried (one
  transaction, advisory lock 7342101).
- **"Action required" (2026-10-21):** `GET /api/listing-hygiene/pending`
  returns at most one pending hold per action — the newest job that held
  any candidates, while it has open held rows and no release job. The top
  nav shows it on every page in §7 amber ("Action required: 30 deletes held
  for review") until released; a later night's hold supersedes the earlier
  one, and releasing a superseded hold is refused (409 `superseded`). A
  finished pass that tripped a breaker toasts "Daily pass held N closes / N
  deletes — review needed".
- **Live gates:** `LISTING_CLOSE_LIVE` / `LISTING_DELETE_LIVE` env vars,
  unset → dry run (`would_*`, `listing_actions.dry_run = true`, zero SC
  writes).
- **22 and 24 never run in manual / onboarding / bulk jobs** — a Refresh
  click has no SC writes as a side effect. Their own manual entry:
  `POST /api/listing-hygiene/run {action, dryRun}` (admin) enqueues a
  one-component lane-M job over the full scheduled scope.
- PATCH and DELETE on `/listings/2021-08-01/items` share the Listings
  limiter bucket and go only through `spApiPatch` / `spApiDelete` in
  `server/spapi-auth.ts`.
- **Implementation (2026-10-19)** — `server/listing-hygiene.ts` (pure
  predicates, loaders, SC writes, verification), `listing-hygiene-run.ts`
  (the run: pass / manual run / release), `ledger-sync.ts`,
  `sku-fba-inventory.ts`, `listing-hygiene-routes.ts`; components
  `22-close-oos.ts`, `23-ledger.ts`, `24-delete-dead.ts`.
  - **"This pass"** is read from the ledger, so the scheduled pass and the
    manual one-component job decide the same way: inventory counts only if
    the latest component-15 run succeeded within 2 h and the SKU's
    `sku_fba_inventory.observed_at` is from it; listing state only if the
    latest full-scope component-16 run succeeded within 2 h and the SKU's
    `listing_checked_at` is from it. A failed 15 stops the job before 22
    anyway (an incomplete pull throws).
  - **Tonight's 23** = the latest `23_ledger` run, finished within 26 h,
    `counts.conclusive = 1`; and `settings.hygiene_ledger_coverage`
    (contiguous `{from, to}` the ledger has covered, written by 23) must
    reach ≥ 540 days back and end ≤ 2 days ago — so the never-stocked
    branch is never trusted before the 18-month backfill has run.
  - **Live re-read before every write** (`getListingsItem`
    summaries + attributes): the close PATCH takes `productType` from it and
    is skipped if the SKU is already closed; the DELETE is skipped if the
    SKU is no longer closed (reopened in SC since the probe).
  - **Release is a job**: `POST /api/listing-hygiene/release` enqueues a
    lane-M job `components [22|24]`, `params.listing_hygiene {action,
    mode: 'release', release_of_job}`; it re-reads listing and inventory
    live (`getInventorySummaries` by `sellerSkus`), reads the PO pipeline
    and Velocity live, and updates the held rows in place (the outcome of
    the re-evaluation in `evidence.release`; a SKU that no longer qualifies
    stays `held` with its reason). Refused (409) while the gate is unset.
    `POST /api/listing-hygiene/run` refuses `dryRun: false` the same way.
  - **Additions beyond the patch text:** outcome `skip_action_pending` (an
    accepted, unverified action of EITHER kind — close or delete — for the
    SKU within 3 h: Amazon applies writes asynchronously, so the next pass
    neither repeats it nor acts across it; widened 2026-10-20 after
    CS-ZH3X-SXV9's DELETE read back open, end_at null, for ~5½ min before
    the 404); `listing_actions.verify_passes` (the count behind
    `not_effective`). Outcomes are keyed by SKU in the ledger row, so Retry
    failed ignores stages 22 / 24.
  - Ledger backfill: `POST /api/jobs/backfill-ledger {from?, to?}` (admin)
    or `npm run backfill:ledger` (default 548 days back → yesterday).

Three components are ledger-only in this version, by decision:

- **14 persists nothing** (decision A, 2026-10-15). Profit, margin and ROI
  are `calculateProfit` on the client (§14 "Analyze path constraints");
  there are no `est_*` columns. Its ledger row counts the ASINs whose
  inputs are complete (price, fee triple, COGS) vs `incomplete` /
  `missing_row` — the number the Profitable scorecard can trust.
- **20 and 21 record `skipped`** until the Finances API patch lands; 19
  runs against the current source (orders flat-file report). The scheduler
  calls one `syncSales(scope, window)`; the Finances patch swaps the
  implementation, not the schedule. The hourly window is the last 48 hours
  (overlap on purpose; the upsert is idempotent).

  **Sales scope and onboarding (2026-10-16).** The report is account-wide,
  so component 19 matches its rows against **every** row in `asins` —
  active, parked and dead (the old active+parked filter was dropping
  rows). An ASIN the report names that AF does not have at all is
  **onboarded**: inserted through the shared insert half of
  `onboardNewAsins` (`insertNewAsinRows`, tag **`Sales import`** —
  `lead_source` is user-controlled and stays NULL) BEFORE that chunk's
  upsert, so its rows land in the same chunk; when the sync ends, ONE
  Refresh job (daily block included, trigger `onboarding`) is enqueued for
  all of them. The ledger row carries `onboarded_from_sales` and lists the
  ASINs under `_onboarded_from_sales`. Per-chunk results (status, orders,
  days, ASINs, onboarded, earliest/latest `purchase-date` the report
  actually returned) are the `_chunk_NN` outcomes, with
  `_earliest_sale_date_returned` / `_latest_sale_date_returned` for the
  whole run. **A failed chunk fails the component** (a `ComponentError`
  whose partial result is ledgered), never skipped; a "Date range
  exceeded" answer is a failure, not an empty chunk. The UTC day boundary
  of the report request and of `purchase-date` is unchanged — noted for
  the Finances patch.

  **Sales history backfill.** `POST /api/jobs/backfill-sales {from, to}`
  (admin only) or `npm run backfill:sales [-- --from … --to …]` (defaults
  2024-05-01 → today; talks to the database directly, there is no API
  token for scripts) enqueues ONE manual job with `components: [19]` and
  `params.sales_window` (migration 054 `jobs.params JSONB`). It serializes
  behind the hourly passes like any job, chunks 30 days at a time as the
  hourly sync does, writes only `sales_daily.units_sold` / `revenue` (the
  refund and fee columns keep their first-insert 0 and are never in the
  SET list), and shows in the jobs dialog like any other job. No UI
  button.
- **17 is derived**: it re-points `primary_sku` from what 15 and 16 wrote
  (inventory bootstrap when NULL; listings latest-live-wins), and reports
  `from_cache` / `bootstrapped_by_inventory` / `repointed_by_listings`.

#### Scope rules

- **Scheduled pass:** `status IN ('active','parked')` for ASIN-keyed
  components; account-wide for 1, 18, 19–21; full sheet for 9. Dead ASINs
  are never touched by a scheduled pass (decision 10).
- **Refresh button:** the checkbox selection if any, else every row of the
  current filtered view, visibility toggles included (decision 15). Dead
  ASINs in that set are refreshed. The button runs components 1–21 for
  that set — the daily block included — because "refresh" means
  everything (decision 4). Account-wide components (1, 18, 19–21) run
  account-wide regardless of selection; they are cheap.
- **Onboarding** (Upload File, Sync Sourcing, Chrome extension, SC
  discovery, Buy List promote from Bulk Calc): `onboardNewAsins` creates
  the rows with the user-supplied fields only (`insertOnly` through the
  sink — no `fetched_at` stamp, no history row, no catalog-deleted signal)
  and enqueues ONE job scoped to the new ASINs, trigger `onboarding`,
  daily block included. Its own stage order ("Product Info → prices →
  fees", 2026-09-09) is gone; the dependency that order encoded — rows
  exist before anything prices them — holds because the INSERT precedes
  the enqueue. The unledgered post-upload PO-sheet and suppression syncs
  are components 9 and 18 of that job.
- **Bulk Calc Refresh:** enqueues a job with `target: 'bulk'` for the
  list (§21 "Refresh" — the main→bulk copy rule lives there).

#### Runner

`server/scheduler/runner.ts`, started from `server/index.ts` after the
migrations and `registerRoutes` (it needs the injected
`onboardScDiscoveries` and `runSheetsSync`), whenever `SP_API_SELLER_ID`
is set — the runner is always on; only the **schedule** is gated.

- **Two lanes, one loop each** (Maria, 2026-10-16: manual actions never
  wait on the scheduled pass). Lane S claims `trigger = 'scheduled'`; lane
  M claims `trigger IN ('manual','onboarding','bulk')` in queue order. Each
  loop: claim its lane's oldest `queued` job (`SELECT … FOR UPDATE SKIP
  LOCKED`, that lane's `running` job first — that is resume, and both
  lanes resume on boot), run it, repeat; idle poll 5 s. Both lanes run
  concurrently in the same process, so a lane M job starts the moment it
  is enqueued when lane M is idle; within a lane, one job at a time. Two
  `running` rows are normal. Advisory lock `7342002` (one per process)
  guards the zero-downtime deploy overlap for both lanes.
- **Onboarding jobs run the per-ASIN components only** — 2–8 and 10–17 for
  their scope, never the account-wide 1, 9, 18, 19–21, which belong to the
  pass or a manual Refresh. This is what stops an onboarding job from
  discovering more ASINs and enqueuing itself again. Manual and bulk jobs
  keep the full rule. Belt and braces: `enqueueOnboardingJob` drops ASINs a
  queued or running onboarding job already covers and enqueues nothing when
  none remain; an ASIN that failed to insert is logged with the reason and
  not re-enqueued by the same call.
- **What concurrency costs, accepted:** a lane M job and the scheduled pass
  can both append an `inventory_snapshots` row (and a daily-block
  `asin_estimates_history` row) for the same ASIN minutes apart — every
  reader takes the latest row per ASIN or per day (`ORDER BY snapshot_at
  DESC LIMIT 1`, `DISTINCT ON (DATE(snapshot_at))`, `MAX(snapshot_at)`),
  so duplicates are harmless; and both lanes may request the same FYP or
  orders report in the same hour — the `createReport` budget (0.0167/s,
  burst 15) absorbs it. Every per-ASIN write is a single-statement
  overwrite from the same Amazon answer (last writer wins); flip reports
  may appear in both ledgers. The SP-API rate limiter is process-wide, so
  the two lanes share one budget per operation.
- **Components are functions** `run(ctx) → {counts, outcomes, flips}` in
  `server/scheduler/components/NN-name.ts`, one file each, numbered as the
  table, registered in `components/index.ts` in that order. Each reads
  what it needs, writes what it owns (§14 ownership table names the
  component), and returns per-ASIN outcomes. The existing stage functions
  (`refreshPrices`, `runFeesStage`, `syncInventory`, `runFullScopePass`,
  `fetchCatalogBatch`, `getEligibility`, `getInboundHazmat`, the
  suppression parser …) were moved into these files, not rewritten; where
  a stage existed as two paths the one that takes the fresh price was kept.
- **Progress + resume** (decision 14): after each component, and every 50
  ASINs inside a per-ASIN component (batch components at each 100-ASIN
  chunk), the runner writes `jobs.progress`
  `{component, asin_cursor, position, total, done}`. On startup a job left
  `running` is resumed: components in `done` are skipped; the current one
  restarts from `asin_cursor` (ASINs are processed in a stable order —
  `asins.id`); account-level components rerun whole.
- **Failure:** a component that throws marks the job `failed` with the
  error and the component number (`summary.stoppedAt`); the ledger row for
  that component records what was done; later components do not run. The
  next scheduled pass is a new job. **Retry failed (N)** in the jobs dialog
  enqueues a manual job scoped to the ASINs with `error:` outcomes.
- **Cancel:** `PATCH /api/jobs/:id {status:'cancelled'}`; the runner
  checks between components and at every checkpoint; a cancelled job keeps
  its partial ledger.
- **Serialisation is per lane.** "Cron and button collide" is gone
  structurally: a Refresh clicked during a scheduled pass runs at once in
  lane M; a second Refresh queues behind the first and the button shows
  "queued (1 ahead)" — lane M positions only, the scheduled pass never
  counts. `GET /api/jobs/current` returns `{ scheduled, manual, queued }`;
  the Refresh button shows the job this tab enqueued; the jobs dialog lists
  both lanes as running. (The full-width progress bar under the toolbar
  that mirrored the running job, scheduled pass included, was removed
  2026-10-17 — the jobs dialog shows the same status.)
- **Suppressions (18) are stage-then-swap:** the report's ASIN set is
  loaded into a temp table, then one `UPDATE … SET is_search_suppressed =
  (asin IN temp)` — no window where the catalog shows no suppressions, and
  crash-safe. `newly_suppressed` / `cleared` are the flips.
- **Listings (16)** uses the injected `onboardScDiscoveries` callback
  whether the job came from the schedule or the button — there is no
  second entry point, so the old cron divergence cannot recur. The SC-only
  SKU discovery is component 1.
- **Add to SC** (decision 9) checks gating live for its selection
  **inline** (2026-10-16): the preview route calls `probeGatingForAsins`
  (`server/gating-probe.ts`, the one writer of `eligibility_status` /
  `gating_checked_at`, which component 8 also uses) for the selected
  ASINs, then pre-filters on the value just written — no jobs row, no
  wait behind a running pass. Confirmed necessary by the 2026-10-16 test
  (§18): `putListingsItem` accepts a gated ASIN. **Push to Aura**
  (decision 9) reads the PO sheet for its selection first and then pushes
  the same selection — **inline** (2026-10-16): `runSheetsSync` scoped to
  the selection, a Google Sheet read + COGS upsert with no SP-API call, is
  not refresh work and never waits on the scheduled pass; no jobs row. The
  full chain (`POST /api/sync/aura`) is the same function without a
  selection. `jobs.components INTEGER[]` (migration 053) stays for jobs
  that run a subset of the sequence — the sales history backfill uses it.

  **Rule (Maria, 2026-10-16): manual actions never wait on the scheduled
  pass. Only SP-API refresh work goes on the queue.** Sync POs (the PO
  sheet sync of §22 followed by `runSheetsSync`, 2026-10-16), Export SB
  COGS, Update COGS in SC, Push to Aura, Verify now, Recheck now,
  Park/Unpark/Mark dead/Revive stay direct calls. Sync Sourcing and Upload
  File keep their inline sheet/CSV step; only the onboarding Refresh they
  spawn is a queue job.

#### Component details that carry over

The stage code moved; its rules did not. Still true, now per component:

- **Prices (10–12) — price refresh v2.** `getItemOffersBatch`, 20
  ASINs/call at the 0.09 rps seed (×0.95 safety); the Summary/Offers parser
  is the pure `parseOffersPayload(asin, payload)`; `writePrice` has no
  COALESCE guards — a conclusive answer overwrites, including to NULL. One
  main pass + ONE trailing pass over `throttled`/`error` items. Per-ASIN
  outcomes:

  | outcome | meaning | writes |
  |---|---|---|
  | `updated` | ≥1 price parsed | prices + seller counts + CPT + fetched_at |
  | `no_offers` | 200, zero New offers | prices → **NULL**, sellers 0, fetched_at (decision 6 — conclusive: nothing is for sale; row becomes uncalculated) |
  | `restricted` | 403/restricted | nothing |
  | `not_found` | 404 | nothing |
  | `invalid_asin` | Amazon's "invalid ASIN for marketplace" per-item error — conclusive, not transient: excluded from Retry failed, listed separately, and **auto-marks the ASIN dead** (status `dead`, reason `invalid_asin` — §14) | status only |
  | `throttled` | 429 survived limiter + trailing pass | nothing |
  | `error` | timeout/5xx/parse (throttle/invalid excluded) | nothing (message kept) |

  `fetched_at` stamps only the two conclusive outcomes — the honest price
  age. CPT (`Summary.CompetitivePriceThreshold`) is read off the same
  response and written to `asin_estimates.competitive_price_threshold`
  (decision 12; NULL when Amazon returns none).
- **Fees (13).** `POST /products/fees/v0/feesEstimate`, 20 per call at
  0.5 calls/s, input price per ASIN = `getFeePriceForAsin` on the
  just-written prices. ASINs whose price outcome was
  `no_offers`/`invalid_asin`/`error` skip as `skipped_no_price` — never a
  fallback-price estimate. Writes the fee triple with `fee_source =
  'spapi'`; outcomes `updated` / `skipped_no_price` / `error`.
- **Gating (8) and hazmat (7) fail closed** (2026-10-07). A probe that
  does not return an answer writes **nothing**: no fallback value, and
  **the `_checked_at` stamp does not move**. The component records
  `error: <msg>` for that ASIN and Retry failed picks it up. The stored
  `eligibility_status` / `is_hazmat` **stand** until a probe succeeds — a
  throttle is not evidence that a known `no` became unknown.
  `"check"` as a stored `eligibility_status` means **"never probed"** and
  nothing else; it is never written by a failed probe. `getEligibility`
  and `getInboundHazmat` surface failure as a typed result, never a
  sentinel, and every caller has an explicit failure branch. **Every ASIN
  in scope is probed every time** — there is no freshness-based skip
  anywhere in the job (the B00P0OYZ66 incident: gating flipped inside
  three days under a 30-day rule). `gating_checked_at` /
  `hazmat_checked_at` stay, stamped on every successful probe,
  informational only. gated↔ungated transitions are the job's `flips`.
- **Catalog (2–6).** `searchCatalogItems` by ASIN identifiers, 20/call;
  the per-item parser is pure and shared; absent from a **complete** batch
  response is the DA-2 catalog-deleted signal (3), a partial batch is
  `inconclusive` for its missing ASINs — fail-closed, no `catalog_deleted`.
  Meltable (5) and dangerous good (6) ride the same attributes.
- **Inventory (15)** is `getInventorySummaries` + SKU recording, with the
  primary-SKU bootstrap (only when NULL). **Listings (16)** is the §18
  reconcile — phases a/b over the job scope, phase c account-wide on every
  pass (ALL statuses incl. dead, SKU'd and no-SKU alike), one per-ASIN
  outcome for every ASIN probed (§18 A2); its onboards go through
  `onboardNewAsins` with trigger `sc_discovery`.
- **PO sheet (9)** is `runSheetsSync` — full sheet on a scheduled pass,
  filtered to the job's ASINs on a scoped job (the clearing pass stays
  inside the filter).

#### Ledger and history

`refresh_runs` stays the per-component ledger: one row per component per
job, linked by `job_id` (migration 052), `stage` = the keys in the table
above, `scope` ∈ `full` | `subset` | `bulk:<list_id>`, `trigger` ∈
`scheduled` | `manual` | `onboarding` | `bulk` (the CHECK keeps the
historical values), `requested`, per-outcome `counts`, `outcomes JSONB`
(every non-trivial ASIN + error messages). The jobs row carries
`progress` and, at the end, `summary` (per-component counts, `flips`,
duration). "Which failed" is a row, not scrollback.

**Price Age column** (`priceAge`, Additional info group, default hidden):
relative age of `pricesFetchedAt` ("2h"/"3d"), tooltip = timestamp,
em-dash when null; filter reuses the `reviewed` mechanism with neutral
labels ("Never synced" / "Older than" / "Within last").

#### Routes and UI

- `POST /api/jobs {asins?, includeDaily?}` → 201 `{job, ahead}`;
  `GET /api/jobs/current` (running + queued — the client polls it every
  10 s while anything is active); `GET /api/jobs` (history);
  `GET /api/jobs/:id` (one job + its ledger rows); `PATCH /api/jobs/:id
  {status:'cancelled'}`; `GET /api/jobs/scheduler` (enabled, next pass,
  last scheduled job — an ops/API read; no UI consumes it). `POST /api/analyze/all` and
  `POST /api/refresh` survive for ONE release as thin enqueuers (202 + the
  job) and are then deleted; nothing in the client calls them, and
  `runRefreshJob` has no callers left.
- **Toolbar:** one **Refresh (N)** button, N = working-set size. While a
  job runs it shows the component ("Refresh · prices 840/2453") and a
  Cancel; clicking while another job runs enqueues and shows the queue
  position. The history clock opens the jobs dialog. No progress bar
  under the toolbar (removed 2026-10-17); the button, the jobs dialog and
  the completion toast carry the status.
- **Jobs dialog:** one row per job (trigger, scope size, started,
  duration, status), expandable to per-component counts and outcome lists,
  plus **Retry failed (N)**. It replaced the Prices & Stock / Product Info
  results dialogs and the `refresh_runs` history dialog.
- **Completion notification** (decision 16): a toast when a job this tab
  is watching (its own manual jobs, or any scheduled job while the tab is
  open) finishes — "Refresh done · 2,453 ASINs · 44 min" — with a
  **Changes** link when the summary has flips. The flips panel lists the
  ASINs that went gated→ungated, ungated→gated, suppressed→unsuppressed,
  unsuppressed→suppressed in that job, each a link to the row. **Never
  price counts.** Email is pinned.
- **Settings:** no scheduler surface (decided 2026-10-16; the section the
  patch drafted was removed). The jobs dialog is the only surface for
  scheduled and manual jobs alike.

**Future (not this patch):** ANY_OFFER_CHANGED push notifications belong
with the Repricer module; the consumer would write through the same
`writePrice` and the pull path would narrow to no-live-offer ASINs. Keepa
components land as 27+ when their cadence is decided (22–24 are listing
hygiene, 2026-10-18; 25–26 PO tracking, 2026-10-21).

### Scheduled passes (`ENABLE_CRONS`)

`server/scheduler/schedule.ts` is the one schedule definition — node-cron
with `timezone: 'America/New_York'` passed explicitly (decision 7). Never
host-local again: the old crons' "EST/UTC" comments described a timezone
they never passed.

```
0 0 * * *        enqueue refresh { trigger: scheduled, include_daily: true }
0 4-23 * * *     enqueue refresh { trigger: scheduled, include_daily: false }
```

One pass at 00:00 ET that also runs the daily block; no passes 01–03
(both DST transitions fall inside that window); hourly passes
04:00–23:00. 21 passes a day. **No stacking (2026-10-16):** at most one
scheduled pass waits at any time. A tick that finds a scheduled pass
already queued does not enqueue (log: "tick HH:00 skipped — scheduled
pass #N already queued"); the 00:00 tick promotes that queued pass to
carry the daily block instead. A tick that finds one running but none
queued enqueues as before, and it waits — the queue is the lock. Queued
manual jobs (Refresh, backfill) never suppress a tick: a long manual job
delays the next pass but never produces back-to-back identical passes.
`nextPassAfter()` feeds
`GET /api/jobs/scheduler` and is tested across both 2026 DST boundaries.

Gated by `ENABLE_CRONS === 'true'` (and the runner's `SP_API_SELLER_ID`)
in `server/index.ts`; unset or any other value = no schedule, and the log
says `Scheduled crons disabled (ENABLE_CRONS != 'true')`. Locally it stays
off: the host Mac is asleep at night and node-cron silently skips missed
ticks (the 2026-08-01 incident). On Render it is switched on after this
patch's final commit (§24); the first production pass is the next hourly
slot. `TZ=America/New_York` is still required on the host for the
sales-window date derivations (§24).

Expected durations on ~2,450 active+parked at today's pacing: hourly pass
≈ 40–50 min (prices ≈ 21 min is Amazon's rate floor), midnight pass +10–15
min for the daily block. Fits the 04:00–23:00 slots; the midnight pass has
a four-hour window.

The three old cron files (`refresh-cron.ts`, `sourcing-sync-cron.ts`,
`aura-sync-cron.ts`) are deleted (commit 5). **Sync Sourcing** and the
**Aura chain** are on-demand (sheet decisions) and keep their buttons;
the Aura chain's PO-sheet read runs inline, off the queue (2026-10-16).
Scheduled passes are still never load-bearing for correctness (§14
"Manual-trigger completeness"): the Refresh button converges everything
on its own.

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

### PO matchers: exactly one → link, otherwise review

AF's PO matchers (shipment sync A, tracking) auto-link only when exactly
one PO fits, and never past its ordered units; several → a review row with
the candidates ranked; none → a review row that says why (2026-10-29, PO
matching patch).

A Velocity line is matched only to a Velocity-eligible PO: not
`ships_to = 'home'`, not dated before `tracking.velocity_start_date`. That
holds for every rule (keys, alias, normalized, Col P, base order #,
candidate) and for the picker's suggestions; the picker's free-text search
still lists such a PO, marked with the reason, and linking it stays allowed.
A Col P hit that fails the units fit is a hint only — the line still goes
through the base order # and candidate rules (Maria 2026-10-29).

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
| Prices, seller counts, CPT | Refresh job components 10–12 (§11) — `writePrice`; CPT `asin_estimates.competitive_price_threshold` |
| Fee triple, `fee_source` | component 13 |
| Catalog data (title, brand, category, dimensions, weight, image), BSR + category, `is_meltable`, `is_dangerous_good`, `is_catalog_deleted` | components 2–6 (daily block); the onboarding INSERT seeds nothing Amazon-side |
| `is_hazmat`, `hazmat_checked_at` | component 7 — successful probe only |
| `eligibility_status`, `gating_checked_at` | `probeGatingForAsins` (`server/gating-probe.ts`) — successful probe only; called by component 8 and, inline, by the Add to SC preview (decision 9) |
| `actual_cogs`, `cogs_source='po_sheet'`, `prep_override` | `runSheetsSync` — component 9 on a scheduled pass; Sync POs (after the PO intake, §22) and Push to Aura call it inline (decision 9, off the queue 2026-10-16). **Reads the AF PO tables since 2026-10-18** (newest non-canceled ASIN row, §11 banner); the `po_sheet` source label is kept. `asin_estimates.ordered_qty` is no longer written (2026-10-17) and awaits a cleanup migration |
| On Order, At Prep (ASINs page, history modal, `inventory_snapshots.ordered_qty`) | **Derived from the PO tables** by `server/asin-po-pipeline.ts` at read time — never synced from the sheet, never stored on `asins` / `asin_estimates` (§6, 2026-10-17) |
| Inventory snapshot, `asin_skus` recording | component 15 |
| `sku_fba_inventory` (every FBA bucket per SKU, `last_nonzero_at`) | component 15 only (2026-10-18) |
| `has_live_offer`, `has_buyable_offer`, `current_issues` + stamps | component 16 through the §18 A2 primitive (also the §19 ladder / verdicts) |
| `asin_skus.listing_created_at`, `offer_end_at`, `listing_checked_at` | component 16 only (2026-10-18) |
| `sku_ledger_state` | component 23 only (nightly + the `ledger_window` backfill) |
| `listing_actions` | components 22 (close) and 24 (delete) and the hygiene Release route; `verified_at` / `verified` / `not_effective` by component 16 |
| `primary_sku`, `asin_skus.is_primary` | component 17 (bootstrap / re-point); the Add-Offer path on creation (§18) |
| `is_search_suppressed` | component 18 (stage-then-swap) |
| Sales, refunds, actual fees | components 19–21 (20–21 ledger-only until the Finances patch) |
| `estimated_cogs` | CSV upload / manual edit / Chrome extension / PO sync (when source ≠ manual) / Sourcing sync — Master col S and ER col M, new-ASIN INSERT only |
| `actual_cogs` | PO sync only (eventually FIFO calc) |
| `prep_override` | PO sync |
| `buy_link`, `supplier` | CSV upload / manual edit / Chrome extension / Sourcing sync — Master col N and ER col H, new-ASIN INSERT only |
| `supplier_sku` | CSV upload / manual edit — analyze MUST NOT write it (asymmetric-UPSERT INSERT branch only on the main path; never in the bulk sink's SET list) |
| Tags, notes | Manual / CSV upload / Chrome extension; notes also Sourcing sync (Master AS/AP, ER AM/AJ), new-ASIN INSERT only |
| `promo_notes` | Manual edit / Sourcing sync (Master col O, ER col I) / main CSV upload (2026-09-27) — all three write the new-ASIN INSERT branch only; never rewritten on re-sync/re-analyze/re-upload, so manual edits are never overwritten |
| `is_wholesale`, `is_oa` | Manual edit |
| `status` (active/parked/dead — replaced `is_active` 2026-09-07, migration 033) | Manual Park/Unpark/Mark-dead/Revive; Sourcing sync writes `parked`+`discontinued` on freshly-inserted discontinued rows only; the prices stage's `invalid_asin` outcome and the catalog-404 signal (DA-2) write `dead` with their reasons |
| Aura listing cost (external, not an AF column) | Aura cost sync path (§11) — reads `asin_estimates` after an inline PO-sheet read for the selection (decision 9), writes only to Aura |
| `purchase_orders`, `po_asins`, `po_line_items` — every field, incl. action items, `closed_at` / `closed_by`, `qty_canceled`, `unique_products`, `entry_seq` | **AF** (2026-10-18, patch po-af-owned): the PO module UI — edit drawer, Products / ASIN-row inline edits, New PO form, Cancel / Delete PO, Cancel ASIN, Closed toggle, the auto-close rule. **The Orders sheet is intake only**: Sync POs inserts a PO that is not in AF and not tombstoned (`deleted_pos`) and never writes an existing one — its drift is reported (`sheetDiffers`), not applied. **One exception (Maria 2026-10-29, Option 2): Col AS prep cost.** When a 2026 ASIN row's sheet prep differs from AF, Sync POs applies it to `po_asins.prep_cost` and, when that changes the PO's derived ships_to (any prep > 0 → velocity, else home), `purchase_orders.ships_to` too — a History row per change ("prep_cost (from sheet)", "ships_to (from sheet)"), counted as `prepApplied` / `shipsToApplied` and listed in the result. A ships_to set by hand stays unless a sync changes that PO's prep. No other field is ever written to an existing PO. `closed_by = 'sheet'` stays on history; nothing new writes it |
| `po_edit_log` | Every PO-module writer (one row per changed field, §22 "AF owns POs"); read by the History tab |
| `deleted_pos` | Delete PO (tombstone); read by Sync POs' intake |
| `po_asin_shipments.assigned_by`, `velocity_order_number` | Reassign shipment (§22) and the 060 data fix write `'manual'` + the Velocity line identity; component A refreshes a manual row's quantity, never moves it (a hand-split line is compared, not rewritten) |
| `po_asins.qty_at_prep`; `po_asin_shipments` (`source = 'velocity'`: row, `qty_shipped`, `shipped_at`); `velocity_shipments`; `shipment_unmatched` | **Shipment sync, component A** (`server/shipment-sync-velocity.ts`, Sync Shipments button, 2026-10-17) — never the sheet sync, never the UI except the Unmatched picker |
| `po_asin_shipments.fba_shipment_ids`, `sc_match`, `qty_received`; `velocity_shipments.sc_shipment_ids` / `sc_match`; `sc_inbound_shipments`, `sc_inbound_items` | **Shipment sync, component B** (`server/shipment-sync-sc.ts`) |
| `po_asins.qty_shipped_fba`, `qty_received_amazon` | Trigger over `po_asin_shipments` (both components' rows + manual rows) |
| `po_asins.qty_shipped_supplier`, `qty_at_warehouse`, `qty_lost_damaged_us`; `po_asin_shipments` (`source = 'manual'`) | PO module (§22): inline editor / Shipment IDs chip — AF-owned, never the importer, never a sync |
| `po_asins.notes`, `po_asins.sku` after insert, `po_line_items.notes`, `item_discount` | PO module (§22) — the sheet does not carry them; never the sync |

When a code path needs to touch a field outside its ownership, that's a red
flag. Either the architecture is wrong, or the workflow is misnamed.

**Velocity writes (2026-10-21, PO tracking D1).** Creating Velocity orders
and changing their quantities stay **manual-only** (Upload to Velocity, the
reconcile execute — never on a schedule). The one exception is
**tracking-only** pushes (§26): components 25–26 in the 00:00 pass (gated
by `ENABLE_CRONS`) and the Sync tracking button add tracking numbers to
existing inbound orders — never an order, never a quantity, item or
status.

### Analyze path constraints

The analyze code path (`/api/analyze`, `/api/analyze/all`, single-ASIN
refresh) refreshes Amazon-side data ONLY.

**Analyze MAY write to** (column list audited against the live schema
2026-09-09 — the old list named six non-existent columns: is_gated,
gating_reason, is_listing_active, sale_price, price_source,
variable_closing_fee, plus computed est_* fields that never existed —
profit is calculated client-side only):
- `asins`: title, brand, category, image_url, weight_lb,
  length_in/width_in/height_in, is_meltable,
  **is_hazmat — ONLY on a successful probe**, is_dangerous_good,
  **gating_checked_at / hazmat_checked_at (probe stamps) — ONLY on a
  successful probe; a failed probe leaves the stamp where it was**,
  is_catalog_deleted (via applyCatalogDeletedSignal)

  **The stamps are written BY THE SINK, alongside the row, never before it
  exists (2026-10-09).** They used to be written from inside the per-ASIN
  loop, which runs BEFORE `writeResult`'s sink INSERTs a brand-new ASIN — so
  on a first-ever Product Info run the `UPDATE asins SET ... = NOW()` matched
  zero rows and a swallowing `.catch(() => {})` hid it: the probe succeeded,
  the outcome said `updated`, and the stamp never landed. Same ordering bug
  as the CSV-tags race (§11, 456b238): a write sequenced before the INSERT it
  depends on. A failed stamp write now surfaces as that ASIN's `error`
  outcome rather than being swallowed — if the stamp did not land, the ledger
  is claiming something the record does not show.
- `asin_estimates`: lowest_fba_price, buy_box_price, buy_box_fulfillment,
  lowest_price, sellers_fba, sellers_fbm, fba_fee, referral_fee,
  fees_estimate_price, fee_source, bsr, bsr_category, **eligibility_status
  — ONLY on a successful probe** (the gating result — there is no is_gated
  on asins; a failed probe must not overwrite a stored `yes`/`no` with
  `check`, and `check` means "never probed"), error, fetched_at
  — noting that the onboarding INSERT (`insertOnly`, 2026-10-15) fetches
  nothing: the price, fee, catalog and probe columns are written by the
  Refresh job's components (§11) after the row exists

**Analyze MUST NOT write to (user-controlled fields):**
- `estimated_cogs`, `estimated_cogs_source`
- `actual_cogs`, `cogs_source`
- `prep_override`
- `buy_link`, `supplier`
- Tags, notes, `promo_notes`
- `is_wholesale`, `is_oa`
- `status` / `status_reason` (except the named auto-dead writers above)
- On `bulk_list_asins` (§21, 2026-09-04): `buy_link`, `supplier`, `tags`,
  `promo_notes`, `notes` (2026-09-08), `added_at`, `supplier_sku`,
  `estimated_cogs` — the bulk sink never writes, clears, or overwrites them

**`asin_estimates.error` holds genuine failures ONLY (2026-09-09):**
never a synthesized absence message — "no stored price" is a state, not
an error — the onboarding insert fetches no prices (§11). buildResult
synthesizes nothing but genuine Restricted; `writePrice` clears `error`
on every conclusive outcome, so a real Amazon answer always supersedes a
stale string; migration 041 purged the 188 legacy rows (two generations
of synthesized strings that had survived price writes and poisoned Sale
Price cells into "⚠ Error" on rows with good prices).

**Bulk promote (2026-09-09, new-ASIN INSERT only — §21 "Promote to
database"):** a second writer for `buy_link`, `supplier`, `supplier_sku`,
tags, notes, `promo_notes` (alongside the sourcing sync),
`last_reviewed_at` (2026-09-10), and
`estimated_cogs`/`estimated_cogs_source` — INSERT branch only, never an
update to an existing row. `added_at` is insert time (NOW()) everywhere
EXCEPT bulk promote, which carries the bulk row's lead date. Promotion
also seeds the catalog/pricing snapshot and the row's own gating/hazmat
values with the bulk `fetched_at` (the gating/hazmat cache is gone —
decision 3, 2026-10-15; the probe stamps start NULL) — a one-time seed at
row creation, not an ongoing writer; the onboarding job promote enqueues
takes over as owner.

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

All derived state must converge via manual triggers alone. Scheduled passes
only enqueue the same Refresh job on a schedule and are **never
load-bearing for correctness** — the schedule is off locally and was off on
Render until 2026-10-15 (§11 "Scheduled passes"), so a code path that only
converges "when the daily/scheduled pass runs" is a bug, not a design. When a definitive fact is established (an API probe, a human
verdict), every field derived from it is written then and there; a later pass
may re-verify, never first-deliver. (Adopted 2026-08-28; first application:
the §19 manual-`'live'` flag write.)

### Honest labeling

If a metric is named "Actual" but computed from Estimates, that's a bug — fix
the data path or rename the metric. Do not accept misleading labels in the
UI.

(The current state of AsinFlow's Actuals violates this principle. Section 13
captures the gap; it must be addressed.)

### Parked / Dead ≠ excluded from sync (was "Archived ≠ excluded", re-modeled 2026-09-07)

`is_active` conflated two populations: ASINs set aside that may come back
to profitable (a core sourcing pattern) and ASINs gone for good (deleted
by Amazon, IP complaints). Migration 033 replaces it with
`status ∈ {active, parked, dead}` + `status_reason` + `status_changed_at`
(backfill: TRUE → active; FALSE + `archive_reason` 'catalog_deleted' →
dead; other FALSE → parked; `is_active` DROPPED, no shim — a stale reader
fails loudly at tsc/SQL, never silently treats dead as parked).

Parked/Dead is a **view-level hide, not a data-freshness opt-out**. An
explicitly selected ASIN syncs — prices, PO, sales, inventory, Product
Info, listings — regardless of status; with no selection, sync scope
follows the current view (Show parked / Show dead on → included; the UI
sends the visible ASIN list). The unfiltered daily-cron scope is
`status IN ('active','parked')` — parked ASINs are exactly the "may come
back to profitable" population, so the daily job keeps their prices
current (~5 min extra at 525 parked); dead is never touched automatically
(decision 5, 2026-09-07 — supersedes decision 10 of the refresh patch,
which predates the Parked/Dead split). Any future "never sync parked"
behavior must be a deliberate setting, never a hidden predicate. (Root-caused 2026-08-11: `is_active =
TRUE` inside the explicit-selection branches silently dropped selected
archived ASINs; post-sync refreshes also dropped the view scope.)

Writers: manual Park/Unpark (the old Archive action), Mark dead (preset
reasons `ip_complaint` / `not_sourceable` or free text), Revive (dead →
active, clears the reason); automatic → dead: the prices stage's
`invalid_asin` outcome (reason `invalid_asin` — confirmed auto-retire
2026-09-07) and the catalog-404 DA-2 signal (reason `catalog_deleted`,
same as its old auto-archive, now the right bucket; the DA-2 revival
dialog revives from `dead` when `is_catalog_deleted` flips back — the
one-click un-dead for Amazon-resurrected ASINs); automatic → parked: the
sourcing sync's discontinued-on-insert rule (reason `discontinued`).
Parked rows keep the archived styling; dead rows get a muted
"dead · <reason>" tag in the Product cell — no row tints (§7).

### A bulk write states its blast radius before it runs

A batch action reached from a header or toolbar control acts on the
**explicit selection and nothing else**. No selection → the control is
disabled with a tooltip saying so; there is no "apply to everything"
fallback, because the difference between 3 rows and 1,946 is invisible at
the moment of clicking.

When such an action has a side effect beyond the one named on the control —
bulk cart/hold ALSO promoting rows into `asins` (§21) — the count of that
side effect is stated in a confirm dialog before anything runs, and the
dialog appears only when the count is non-zero so it never becomes noise
people click through. Concretely: **bulk cart/hold never promotes without a
selection, and never without the confirm when the promote count is > 0.**

Ordering follows from the same idea: promote first, update the set only for
the ASINs that actually landed. A single-row action can flip optimistically
and revert, because there is exactly one thing to undo. A bulk action can
fail for an arbitrary subset, so there is no coherent revert — the set must
only ever contain what really succeeded.

### Fail-closed rules must name their victim and their exit

A rule that blocks a legitimate action to prevent a worse one must state, in
the spec: **what** it blocks, at **what scope**, for **how long**, and **how
often in practice** — measured against real business patterns (repurchase
frequency, reorder cadence), never all-time totals, which hide a rule that
fires constantly inside a small active set.

The block is scoped to the **smallest unit whose identity is actually
unknown** — a record, not an ASIN, supplier, or account. And it needs a real
exit: "until it ages out" or "revisit if it recurs" is NOT an exit unless a
mechanism exists to clear it.

Origin: `bundle_shipped_unidentified` (§11, 2026-09-02 → retired
2026-09-21). One shipment losing its child keys blocked EVERY future bundle
of that ASIN, permanently, with no clearing mechanism. The unknown was a
single parent order; the block was the whole ASIN, forever. It took three
legitimate orders being silently held to notice, and "revisit only if this
skip recurs" had no owner and no trigger.

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
catalog, AsinFlow surfaces them before processing. (Bulk promote — §21 —
handles its own duplicates by SKIPPING existing rows outright, any status;
the Overwrite option below is a CSV-upload concern and stays here.)

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
- **Born closed = close-after-create (2026-10-23).** Every offer AF creates
  is closed right after it materializes. The create payload carries **no**
  `end_at`: a past `end_at` sent at CREATE is stored by Amazon but **not
  applied** — the listing stays open and SC shows it "Out of stock /
  Replenish inventory" (the 2026-10-22 Add to SC batch, 22 SKUs, all still
  open 20 h later). Instead the first §19 probe that sees the new listing
  (200 with summaries) sends component 22's close PATCH through the same
  helper (`closeAfterCreate`, `listing-hygiene-run.ts`): forbidden-quantity
  guard, a `listing_actions` row with `evidence.reason = born_closed`,
  verified by component 16 like any close, sent once. If the ladder never
  sees the listing, the nightly component 22 closes it (a zero-stock open
  SKU). The Add to SC preview says "Offers are closed right after they're
  created."
  - **Reopen is done in Seller Central directly by the user** (2026-08-03: the
    in-app reopen action was removed as unnecessary). For reference, the API
    mechanism — should it ever be needed again — is a `patchListingsItem`
    `op: "merge"` on `/attributes/purchasable_offer` with `"end_at": null`;
    never `op: "replace"` (wipes the price) and never with price fields in the
    same patch (a high-price error makes Amazon silently ignore the `end_at`).
    Round-trip was verified live on `CAM-HOM-M64-RQR-003` before removal.
  - **The closed test (2026-10-23, `server/listing-closed.ts`
    `isOfferClosed` — the one definition; every reader of `offer_end_at`
    goes through it).** No Amazon source exposes SC's inactive sub-status:
    probe 2026-10-23 — getListingsItem (summaries, attributes, offers,
    fulfillmentAvailability, issues), searchListingsItems, and the listings
    reports (`GET_MERCHANT_LISTINGS_ALL_DATA` Active/Inactive only;
    `_INACTIVE_DATA`, `_DATA`, `_BACK_COMPAT`, FYP, cancelled, FBA MYI
    all/unsuppressed) show SC's Closed and Out of stock alike. What
    `end_at`'s form says instead:
    - a **real close timestamp** — Amazon rewrites the date when a close is
      applied (an SC close: `PRK-HOM-6P4-PIC-001` read
      `2026-10-19T09:31:29Z`) → **closed** when `<= now`;
    - the **literal `2000-01-01`** — Amazon stored the value AF sent.
      Applied when sent by AF's close PATCH (`RHO-BPC-6WB-PLS-002`, PATCHed
      2026-10-20, shown Closed in SC), not when sent at create → **closed
      only if AF has an accepted (or verified) close PATCH on the SKU after
      its latest creation**;
    - `null` → open.
    **BUYABLE always means open** (known on live reads: the fire pre-flights;
    component 16's stored state carries no per-SKU status). Derived from the
    account on 2026-10-23 this reproduced SC's counts within 2 (Active 207 =
    207, Closed 247 vs 249, Approval required 2 = 2 — issue 18299).
  - **AF also closes existing listings (2026-10-18, listing hygiene):**
    component 22 closes a SKU whose FBA buckets are all zero and which the
    closed test says is open, through the same helper (§11); component 16
    stores Amazon's `end_at` as `asin_skus.offer_end_at` verbatim — "closed"
    is always the closed test, never `offer_end_at <= now()` on its own.
  - **AF never reopens.** No code path clears `end_at`, sends it null or
    removes it — not even with stock at FBA. Reopen stays a manual action
    in Seller Central; enforced by test (`listing-hygiene` never-reopen
    guard).

### Always-present offer attributes

Sent on every payload, not gated by category/brand/product:

- `condition_type` — `new_new` (New)
- price (see Price Resolution)
- `max_order_quantity` — **per-ORDER purchase cap, COGS-conditional**
  (2026-09-13): estimated COGS **≤ $20 → 6**, **> $20 → 4**, **unknown → 4**
  (unknown exposure gets the tighter cap; the boundary is inclusive, so
  20.00 → 6 and 20.01 → 4). The COGS is the value the PRICE RESOLVER
  consumed (`COALESCE(estimated_cogs, cogs)`, §2 provenance), threaded with
  the resolved price so the cap can never drift from the number the price
  was built on — and it is a REQUIRED field on `OfferAddInput`
  (`null` = explicitly unknown; an omitted field silently meaning "unknown"
  is the fail-quiet pattern §14 forbids). Schema verified live against the
  PRODUCT productType definition: top-level array, `marketplace_id`
  selector, `value` integer ≥ 1. Preview surfaces the resolved cap per ASIN
  (read back OUT of the assembled payload, so preview == submit).
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

### The one forbidden key: fulfillment `quantity`

`fulfillment_availability[].quantity` ("your current inventory commitment")
flips the SKU to **merchant-fulfilled** — any value, including 0. It is
never sent; FBA quantity is Amazon-owned.

The guard is **key-precise, not substring** (corrected 2026-09-13 when
`max_order_quantity` was added — the old check string-matched "quantity" in
the serialized payload and would have false-positived on a correct
payload). `findForbiddenQuantityPaths` walks the payload's KEYS and flags
any key named exactly `quantity` at ANY depth, returning the offending
paths; `max_order_quantity` is a different key and passes. Enforced twice:
in tests, and as a **pre-flight abort immediately before the live PUT** —
inside the reserve/commit try block, so the registry reservation rolls back
and no listing is created. Test-time-only enforcement is not sufficient for
an irreversible write.

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
(Catalog-404 now auto-marks `status = 'dead'`, reason `catalog_deleted` —
§14, 2026-09-07 — and the DA-2 revival dialog is the one-click un-dead.)

### Price Resolution (v2, 2026-10-07)

Offer-anchored. The anchor comes from a **qualified offer set** of current
competing offers; `CompetitivePriceThreshold` is **never a pricing input**;
every path resolves to a price without manual entry.

Data source is unchanged: `fetchCompetingOffers` / `getItemOffers`
(`GET /products/pricing/v0/items/{Asin}/offers`, ~0.5 rps,
`server/listings-offers-fetch.ts`), landed prices (`ListingPrice +
ShippingPrice`), our own offers filtered out by seller ID. It does NOT reuse
`getPricing`, and lowest FBA is never the anchor. `.99` ceil-rounding is
unchanged.

**Why v2 (B0BS6NVYCN, 2026-09-02):** a listing glutted for months (~50
sellers, ~$20) collapsed to 6 offers; survivors repriced to $37–40, last FBA
Buy Box $39.99 — Buy Box suppressed because Amazon's CPT lagged at ~$21. The
v1 cap chain priced the new offer at **$20.99, $3 below breakeven**. CPT was
measuring the past, not the market. Confirmed on three more (2026-10-04):
B00IJYJKRI (5 offers $21.57–21.95, CPT $5.68, COGS $5.36 → v1 capped to
**$5.59, ROI −102.4%**), B00MN4IRRO (CPT $6.88 vs an $11.00 floor),
B099KRQ1W7 (CPT $12.50 vs $30.98).

#### Qualified offer set

All competing offers (other sellers, New condition, landed price), minus two
exclusion classes. **This set is SHARED with the Repricing Engine's min/max
(§23)** — one definition, both consumers.

1. **Amazon — always excluded.** Amazon is technically FBA but we never
   compete with Amazon.
2. **Feedback count < 15 — always excluded**, regardless of price (no track
   record). Threshold history: 10 (2026-09-03) → 20 (2026-09-15) → **15
   (2026-10-05)**. A missing `SellerFeedbackRating` counts as 0 → excluded.

Disqualified offers are **listed in the preview with reasons**
(`amazon_offer`, `under_15_feedback`), never silently dropped.

**No outlier rule for opening prices** (2026-10-05). The former
"low-credibility outlier" rule is removed and nothing replaces it here: the
anchor is the HIGHEST qualified FBA offer, so excluding low-priced outliers
could never change it. Low-outlier handling lives only in §23's min
calculation (its lowest-offer outlier rule).

**Data limitation (v2 scope):** `getItemOffers` carries per-offer feedback but
NOT stock depth, so "1 review and 5 units" is filterable on feedback only.
Stock-depth-aware filtering (Keepa offer data, cart probing) is a possible v3
— do not fake it from available fields.

#### COGS is required

Every path needs COGS (`COALESCE(estimated_cogs, cogs)`, §2 provenance). When
COGS is null or ≤ 0 the preview row **expands inline for a COGS entry** (same
no-nested-modal pattern as `legend_pending`) and **cannot be submitted until
it is entered**. The entered value is saved as the ASIN's estimated COGS
through the SAME write path as the product row's Est. COGS edit, then the row
resolves normally. Replaces v1's `skip_no_cogs` skip.

#### Anchor resolution

1. **Qualified FBA offers exist** → anchor = **highest qualified FBA landed
   price**; opening price = anchor ceil-rounded to the next `.99`. Then the ROI
   check below. (Err-high is retained — offers are born closed and the
   repricer walks the price down — but bounded by *real offers*, not by CPT
   and not by ×1.30 over a junk outlier.)
2. **No qualified FBA offers, or no offers at all** → price **solved for 60%
   ROI**: bisection over `calculateProfit` targeting `roi === 60`, ceil to
   `.99` (so resulting ROI is always ≥ 60%). If 60% is unreachable within the
   search range, the row is **blocked** with that reason.

**ROI check on the FBA anchor.** After path 1, compute ROI at the anchor
price. If ROI **< 20%** → price = **40% ROI solve** (same bisection, ceil
`.99`) and the row shows the warning **`low_roi_repriced`**: "highest
qualified FBA offer gives X% ROI — priced at 40% ROI." **This is the only
warning the resolver emits.** Path 2 needs no check — it is already ≥ 60%.
Rationale: a starting price above the market beats live-at-a-loss.

#### CPT: shown, never used

`CompetitivePriceThreshold` is still parsed (free, same `getItemOffers` call)
and **shown as a value on every preview row** ("—" when Amazon returns none).
It is **never an input to any price** — not a cap, not a floor, not a trigger —
and produces **no warning or flag**. The Buy Box landed price is likewise not
a pricing input.

*Scope clarification:* CPT relates to Featured Offer (Buy Box)
eligibility/suppression. It is NOT the mechanism behind "potential high
pricing error" listing deactivation, and it is never an input to min/max
prices anywhere in AF.

#### Preview visibility

Per row: price source (`fba_anchor` / `roi_60_solve` / `roi_40_floor`); the
anchor offer's landed price and seller feedback (FBA path); resulting ROI; the
CPT value or "—"; qualified vs disqualified counts with the disqualified
expandable by reason; the inline COGS input when COGS is missing; the
`low_roi_repriced` warning when it applies.

#### Retired from v1 (history below)

The cap chain, the "capped" indicator, `lowRoiAfterCap`, `noPriceReference` /
"no market reference — 18555 risk", the above-CPT advisory,
`priced_above_market`, `no_cogs_floor_unknown`, manual price entry, the
**×1.30** anchor, and the **100% ROI** solve.

### Suppression cap (18555) — HISTORY, retired 2026-10-07

Kept as the record of why the cap existed and why it was removed. **None of
the mechanism below is live.**

Anchoring v1's Rule 1 on the *max* competing offer landed far above the buy
box when a junk high outlier existed. Until 2026-08-02 that was treated as
designed ("high placeholder, repricer owns the real price") — but the `18555`
/ `LISTING_SUPPRESSED` rows it produced (3 of the Aug-02 batch of 21, each
back-solving to 1.3 × an offer 50–100% above the buy box) were pure downside:
a suppressed opening offer sells nothing and pollutes the verification ledger
with terminal conflicts.

The cap chain (shipped 860ee27, 2026-08-02; retired 2026-10-07) applied to
both rules' output: **CPT present** → cap strictly below CPT, floored to
`.x9`; **CPT absent, buy box present** → cap = buy box × **1.5**, floored to
`.x9`; **neither** → no cap, with a visible "no market reference — 18555
risk" flag. `.x9` flooring meant 10-cent steps ending in 9 (`$18.97` →
`$18.89`), not `.99`-dollar steps.

**v1 calibration data (kept):** on the Aug-02 set, ≤ 1.94 × buy box passed
and 1.95–2.5 × tripped 18555; 1.5 was chosen to err high with margin for
Amazon's drifting heuristic.

**Why it was retired:** the cap keyed on CPT, and CPT lags the market badly
enough to price below breakeven (the four cases above). Err-high within the
non-suppressed range is now achieved by anchoring on the highest *qualified*
offer instead — a real, current reference. Historical `18555` rows already in
the ledger keep their `terminal_conflict` surfacing unchanged.

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

- AS3 is present in every SKU, **always — mandatory in every position of the
  format.** It ties a SKU to its ASIN on sight and guarantees two SKUs for
  two different ASINs can never be byte-identical. It is **not** a
  same-product disambiguator: as of 2026-10-07 no two ASINs share a product
  number at all (next bullet), so there is no same-product case left for AS3
  to resolve.
- **Every autogenerated SKU is a NEW product; NNN is never shared across
  ASINs (2026-10-07).** A new ASIN always gets a new NNN — the next free
  number **for its BRAND**, counting both `brand_product_registry` and
  earlier claims in the same Add-to-SC batch, in row order. Two rows can
  never claim the same (brand, NNN): the bump happens at **allocation**, not
  as a resolution step after the fact, so there is nothing to resolve and
  nothing to prompt about.
  - **No code path may assign an existing (brand, NNN) to an ASIN that does
    not already own it** — not in-batch, not against the registry. Any
    (brand, TTL) → NNN lookup is forbidden by this rule: **TTL is a derived
    hint, never a key.**
  - NNN is allocated per BRAND, matching the registry's `UNIQUE (brand_code,
    nnn)`. Monotonic max+1 per brand, no gap-filling, retired numbers never
    reused — unchanged from the original allocator rules, which this only
    re-buckets (it used to allocate per (BRD, DEP), which could hand the
    same (brand, NNN) to two depts).
  - The only surviving reuse is **resurrection** (see SKU Resolution below):
    an ASIN getting back its OWN prior custom SKU. Unchanged.
  - The **X variant suffix is unchanged** — a duplicate offer on the SAME
    ASIN only. The hard error for byte-identical final SKUs stays, and still
    never auto-resolves.

  **Replaces the 2026-09-04 in-batch same-product rule**, under which two
  new-product rows claiming one (brand, NNN) was treated as the documented
  "same product, different ASIN" case: the preview surfaced a per-group
  "Same product listed under N ASINs?" resolution, **Same product** required
  an identical TTL group-wide and let the rows share the NNN, and the
  registry recorded one product for the group via a `reuse_ok` take-over of
  the existing row. **Reason for removal: the inference was wrong every time
  in practice** (2026-10-07) — the rows were different products that happened
  to derive the same TTL, and TTL equality is not product identity. The rule
  is **forward-only**: eight (brand, NNN) pairs are shared across two ASINs
  each in live `asin_skus` data (FUG 001, INF 001, LEM 003, RED 005, ROK 001,
  SPO 001, TOP 001, TOP 002) and are left exactly as they are — no
  renumbering, no migration.
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
- Unresolvable DEP → `legend_pending` (awaits approval). A 404 → hard-fail.
  An ABSENT brand or an ABSENT category is neither — both take the reserved
  code `NUL`, see below. (The former "missing category leaf → hard-fail" was
  retired 2026-10-04; it was the same condition as "empty classifications",
  not a separate check, and `no_category` no longer exists as an outcome.)
- **ABSENT from the catalog → `NUL`, automatically, in EITHER position.**
  `NUL` is the one reserved code meaning "the catalog has no value here":

  - **`BRD = NUL` (2026-09-24)** — `summaries[].brand` absent, null, `""`, or
    whitespace-only **after trimming**. All four are one case, decided at the
    catalog-fetch boundary, which trims to null.
  - **`DEP = NUL` (2026-10-04)** — no non-empty classifications chain for
    `ATVPDKIKX0DER`: our entry absent, the top-level array empty, or our
    entry's chain empty. Decided at the SAME boundary, in `extractTopCategory`,
    which selects the entry by `marketplaceId` (hardened 2026-10-04 — it used
    to read `[0]`, correct only because the request asks for one marketplace)
    and returns null when there is no chain for us.

  Either way: **no approval step, no `legend_pending` for that position, no
  `pending.brand`/`pending.dept` in the outcome, and no `sku_legend` row keyed
  on an empty value.** The two resolve INDEPENDENTLY, so an ASIN can be
  `legend_pending` on brand alone, on department alone, or on neither — and a
  brandless, categoryless ASIN is `NUL-NUL-…`, which is correct, not a bug.

  **`NUL` can only come from a 200.** A 404 (`dead_asin`), a transport error,
  throttling, and any partial/failed response remain hard fails on their own
  outcomes. NUL never masks a fetch that did not work.

  **No fallback for DEP.** Not `salesRanks[].displayName`, not
  `websiteDisplayGroup` — §18 forbids both; reading a different source than
  the one the legend was seeded from caused the legend-mismatch bug, and the
  regression test pinning classifications-over-salesRanks still stands.

  Origin (category): **B008DG32FI** ("Infusion V-fitting for Inlet and Return
  Line, Venturi"). Verified live 2026-10-04: HTTP 200 whose classifications
  entry for our marketplace is an EMPTY array, stable across four consecutive
  fetches, `salesRanks` with no ranks at all, `relationships: []` so there is
  no variation parent to inherit from, and `websiteDisplayGroupName: "Home
  Improvement"` which is deliberately NOT used. Genuinely absent at Amazon,
  not a fetch or parse fault. It now resolves to `INF-NUL-2FI-FIR-001`.

  Neither surface (Add-to-SC preview, Velocity "Create SKU & include")
  shows a brand row for a brandless ASIN — nor a department row for a
  categoryless one, since neither produces a pending entry — and the
  Legend-approvals dialog drops any row whose raw value is blank. The
  preview still renders the assembled SKU, so `NUL` in either position is
  visible there. Self-heal never writes `""` or whitespace to `asins.brand`
  (`NULLIF(TRIM(...), '')` — blank stores as NULL), never writes `NUL` to
  either column, and **skips entirely when the category is absent**:
  `asins.category` stays NULL. `NUL` is a code, never a brand or category
  name.
  If the catalog later starts returning a real brand, normal legend
  resolution applies to NEW SKUs; existing SKUs are reused unchanged per
  the resurrection rules.

  **Replaces the 2026-08-29 manual-code flow**, which surfaced an approval
  row with an EMPTY raw value plus a 3-char code input. Approving it wrote
  `sku_legend(brand, "", HAU)` — and from then on every brandless ASIN
  resolved through that one row, while Approve and Merge on it both failed
  with `"" already in legend with code "HAU"`, unfixable from the UI.
  Origin: B08WX3XDLQ ("Winter Garden Paperback", walmart.com) — a book, so
  the catalog serializes `contributors`/`manufacturer` and omits `brand`
  entirely; verified live 2026-09-24 (`"brand" in summaries[0] === false`).
  It now resolves to `NUL-BOO-DLQ-WGP-001`. The `brandCodes` per-ASIN
  override on the offer-add preview/submit endpoints is retired with the
  flow.

**Self-heal write:** after a successful catalog fetch, the resolver writes
`category` and `brand` (and `title`, `image_url`) back to `asins`,
COALESCE-only (refresh only when the API returns non-null). Catalog-data
ownership per §14 — `getCatalogItem` is an analyze data source. Never touches
COGS, tags, notes, buy_link, supplier, is_active, prep, or estimate fields.

### Brand / Department Legend

Persistent `sku_legend` table maps real-world brand→BRD and category→DEP
codes. The legend is **authoritative**; algorithmic derivation is only a
fallback proposer for codes not yet in the legend — one that **always
proposes a FREE code** — and a derived code is surfaced for approval
(`legend_pending`) before it's committed — never silently applied.

- **Collision walk (2026-10-07).** The proposer never hands up a code that is
  already in use. Brand and department codes are **ONE namespace**: a code is
  taken if any `sku_legend` row holds it, of either type, approved or
  proposed. `NUL` is reserved and therefore always taken. The proposer walks
  deterministically and stops at the **first free code**:

  1. The derivation that was already there — first significant word's first 3
     letters, stopwords stripped, pure-digit tokens dropped.
  2. First 2 letters + the **4th** letter; then first 2 + the 5th; … through
     the end of the name.
  3. If the name has **3+ words**: the initials of the first three words.
  4. First letter + 2nd + each subsequent letter not already tried, then any
     remaining 3-letter **positional combination** of the name's letters
     (ordered index triples, ascending).
  5. Exhausted: first 2 letters + a digit **2–9**; then first letter + two
     digits.

  "Letters" = the name's alphanumerics, uppercased. The walk is a pure
  function, `proposeBrandCode(name, takenCodes)`, and is **deterministic** —
  same name and same taken set always yield the same code. **Uniqueness is
  the only requirement; mnemonic quality is not** — a tier-5 code like `AM7`
  is a correct answer.

  Before this, the derived code was proposed as-is; if it collided, approval
  failed inline and the operator had to invent a free code by hand. The
  **approval flow is otherwise unchanged** — still `legend_pending`, still
  editable, still able to merge or alias into an existing brand. The inline
  collision error **remains** for a **hand-typed** code that collides; it is
  only the proposer that can no longer produce one.

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
- **Reserved codes (never assignable to a real brand or department):**
  - `NUL` — "the catalog has no value here", in **either position**: BRD for
    a brandless ASIN (2026-09-24) and DEP for a categoryless one
    (2026-10-04). Assigned by the resolver, never by approval. `POST
    /api/sku-legend/approve` rejects it for `approve_new`,
    `approve_in_place`, AND `merge`, for **both** legend types (brand and
    dept), with an `invalid_input` error naming the rule — the phase-0 pass
    is type-agnostic by construction. Reserving it is what keeps a real
    brand or department from colliding with an absent-valued SKU. There is
    no `sku_legend` row for `NUL` and nothing resolves to it through the
    legend. The constant is `NO_VALUE_CODE` in `shared/sku-legend`
    (renamed from `NO_BRAND_CODE` 2026-10-04, when it stopped being
    brand-only).
- **The legend never holds an entry with a blank value.** A raw value that is
  empty or whitespace-only is not a value; the same writer rejects it for
  every action (including a blank merge target), and the approvals dialog
  filters blank rows out before they can be actioned. This is enforced at the
  writer, not just the UI — the one row that got in this way
  (`brand "" → HAU`, 2026-09-10) was written through the dialog.

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

**Relist (2026-10-29): exact-SKU reuse, format-agnostic.** `POST
/api/listings/relist` `{items: [{asin, sku}], openOnCreate?, dryRun?}`
re-creates a deleted listing under its ORIGINAL SKU name — including
non-conforming ones (Amazon-random, legacy), which the resurrection filter
above would otherwise regenerate. Origin: seven SKUs deleted in SC with
units still in the Velocity pipeline (2026-10-29 — not by AF: no
`listing_actions` row for any of them); FBA labels carry the FNSKU of the
original SKU, so the recovery listing must be the same SKU, not a new
conforming one. The relist kept all seven FNSKUs.

**Every new offer is born-closed (Maria, 2026-10-29).** Add to SC and
Relist both close the offer right after creation (§19 close-after-create),
unless Maria explicitly says otherwise **for that run**. `openOnCreate` is
that explicit opt-in: default FALSE everywhere — the route, `runRelist`,
`script/relist.ts` (`--open`) — and never set by default in any script,
caller or prompt. An instruction to relist is not an instruction to open.

- Same pipeline as Add to SC (`submitOfferAddBatch` → `offerAddForAsin`):
  inline gating probe, `getDefinitionsProductType` first,
  `LISTING_OFFER_ONLY`, `merchant_suggested_asin`, FBA channel code, no
  quantity key, DG pass-through, price resolver, §19 ledger + probe ladder,
  primary-SKU promotion. `dryRun` runs phase 4 in preview mode (no PUT).
- The requested SKU must be **AF history** — an `asin_skus` row for that
  ASIN (`relist_sku_unknown` otherwise; relist never invents a SKU) — and
  must 404 live (`duplicate_warning` if it still exists). The gated check
  and the format-agnostic SC-presence check are NOT bypassed.
- Exact reuse: no NNN allocation, no registry reservation, no legend.
- **`openOnCreate`** (explicit opt-in only, see above) — recorded on the ledger row
  (`listing_submissions.open_on_create`, migration 069, default FALSE): the
  §19 ladder **skips close-after-create** for that submission, so the offer
  comes up OPEN. Everything else is unchanged: the create payload carries no
  `end_at` either way, component 22 still closes the SKU on its own
  evidence once its buckets read all-zero (an open relist survives the
  nightly pass only while Inbound/Available > 0), and **AF still never
  reopens** — `openOnCreate` skips a close at creation, it does not clear
  `end_at` on anything.

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
   gated for approval. **Gating is checked LIVE for the selection first**
   (scheduler decision 9; inline since 2026-10-16 — `probeGatingForAsins`,
   the same writer component 8 uses, same rate limiter, no jobs row): the
   preview reads the `eligibility_status` written seconds ago and shows
   "Gated as of <gating_checked_at>". A probe that fails keeps the stored
   value and is listed in the preview notes.

   **Why the live check stays — tested 2026-10-16** (`script/probe-gated-submit.ts`,
   one-off diagnostic): B0DK7YJCFF, stored `eligibility_status = 'no'`
   (Listings Restrictions, 2026-10-12), submitted born-closed under
   `ZZTEST-GATED-B0DK7YJCFF-001`. `putListingsItem` answered **2xx,
   `status: ACCEPTED`, submissionId `3004518a632045139a5a29acd841eef3`,
   `issues: []`**. `getListingsItem` at T+10 s, T+60 s and T+5 min: the SKU
   existed (200, `summaries: []` — an A1 shell), the only issue an `18448`
   WARNING about a missing `animal_theme`; no approval or restriction code
   ever appeared. The shell was deleted with `deleteListingsItem`
   (ACCEPTED). So Amazon's write path does not refuse a gated ASIN at
   submit time; the restrictions check is the only thing that says no, and
   a stale daily value would turn into a shell SKU per gated ASIN.
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
   rows stay open; a 200 **with a non-empty summary** for the submitted SKU
   writes `has_live_offer` immediately — A1, 2026-10-10) — nothing manual
   needed after a routine batch. The ACCEPTED response itself writes nothing
   to the flag; the pending ledger row drives the pending icon (§6).

### Source-of-truth ownership

| Field | Owner |
|---|---|
| Offer creation (putListingsItem) | Add-Offer path (only writer) |
| Offer price at creation | Add-Offer path (price resolver) |
| `primary_sku`, `asin_skus.is_primary` | Add-Offer path (promotes the live-offer SKU on creation); inventory-sync may set them only as bootstrap when no primary exists, never overwrite |
| `has_live_offer`, `has_buyable_offer` + both stamps, `current_issues`, `issues_checked_at` | **`writeLiveOfferVerdict` — the one primitive (§18 A2, 2026-10-10).** Called ONLY by probes: the listings reconcile stage (Prices & Stock + Product Info), the §19 post-submit ladder, and the §19 verdict / 48h-stale re-probes. No verdict, submission response, or human determination writes any of these fields. Supersedes the previous owners list, which named `live-offer-sync.ts` (deleted), the sweep's `'live'` transition, and the manual `'live'` verdict (2026-08-28, now a re-probe trigger) |
| `asins.lead_source` (§6) | **USER-CONTROLLED.** The INSERT paths (CSV upload, sourcing sync — Master col G, and the ER leg, which writes `ER` on every ASIN it inserts — bulk promote) and `PUT /api/asins/:asin/lead-source`. Absent from the asins UPSERT's ON CONFLICT SET list, so a re-analyze of an existing ASIN can never overwrite it. Analyze, Product Info and Prices & Stock NEVER write it |
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

- **`in_catalog` is gone** (dropped by migration 052, 2026-10-15 — decision
  11). It had been demoted to an internal discovery latch on 2026-10-10: a
  one-way TRUE-only flag (set by sales-sync on any order and by
  inventory-sync for every ASIN in `getInventorySummaries`, which retained
  tombstones for deleted listings), so it stayed TRUE forever and
  over-reported, and nothing read it. Its writers lost that statement.
- **`has_live_offer` is tri-state, and it answers EXACTLY ONE question
  (2026-10-10, supersedes the 2026-09-21 "two-part definition"):** *does a
  listing record exist in Seller Central right now?* `TRUE` ⇔ a listing
  record for ≥1 of the ASIN's SKUs EXISTS at SC — a `getListingsItem` 200
  with a NON-EMPTY summary (A1), regardless of Active/Inactive status.
  `FALSE` ⇔ every known SKU definitively 404s or returns a shell, AND ASIN
  discovery is empty (the 2026-08-28 rule, unchanged). `NULL` = never
  probed. Fail-closed on transients. `offer_checked_at` records the last
  write.

  **The flag is written ONLY by a probe of SC.** No writer may set it from a
  submission response, a ledger state, or a human verdict. That is the whole
  principle: AF mirrors the SC catalog, and a mirror reflects what it
  observed, not what it expects.

  **The PENDING half is a LEDGER STATE, not a flag value.** "AF submitted an
  offer and Amazon hasn't published it yet" is real and worth showing — it is
  just not the same fact as "SC has a listing", and storing both in one
  boolean is what made the boolean unreliable. The §19 ledger already records
  it precisely (`pending` → `processing` → resolved), so the icon reads
  pendingness from there and liveness from the flag. Two sources, two facts,
  neither pretending to be the other. See §6 Product cell for the three
  resulting icon states.

  **Why the 2026-09-21 two-part definition is superseded.** It wrote
  `has_live_offer = TRUE` the moment Amazon ACCEPTED a submission, so the
  icon could react immediately to a user action — a real UX concern, and the
  pending style did keep the claim truthful at the time. But it made
  **three** non-probe writers legitimate: ACCEPTED-at-submit wrote TRUE, a
  `'failed'` verdict reverted to FALSE, and a manual `'live'` verdict wrote
  TRUE. Once the flag can mean either "observed" or "expected", nothing
  reading it can tell which, and every later bug in this area traced back to
  that ambiguity: B07J2WWWD4's `FALSE` was written by a verdict rather than a
  probe, which is exactly why a single bad probe could overturn it with no
  ledger trace. The UX concern is met in full by the ledger-driven pending
  icon — the user still sees feedback on submit; it just comes from the
  record of the submission rather than from a flag that claims SC has
  something it doesn't.

- **Truth source = `getListingsItem`** (via `checkSkuListingStatus`, the same
  404 primitive as §18 resurrection). Multi-SKU: check `primary_sku` first, then
  other `asin_skus` rows, short-circuit on the first live hit
  (`live-offer-check.ts`).

- **PRESENT REQUIRES A LISTING, NOT A SKU STRING (A1, 2026-10-09).** A 200
  counts as listed **only if `summaries` is NON-EMPTY**. A 200 with
  `summaries: []` is a **SKU shell** — the SKU exists in the seller's
  namespace with no listing behind it — and is treated **exactly like a
  404** for the flag: it contributes nothing, and all-404/all-shell still
  routes through ASIN discovery before `FALSE`.

  **The predicate is `summaries.length > 0`, NEVER `status.length > 0`.** A
  real listing can carry an EMPTY `status` array while it materialises —
  §19's classifier depends on exactly that ("a just-created SKU returns
  200-with-empty-status while materializing, which is 'listed', not 'live
  yet'"). Verified live 2026-10-09 against the full 805-SKU account list:
  **one** row (`ALF-BOO-V8U-RCM-001` / `B01JO20V8U`) has a populated summary
  with `status: []`. Keying A1 on status would mark that genuine listing
  absent.

  Origin: **B07J2WWWD4 / CAI-TOO-WD4-UMC-001** (2026-10-09). The ASIN was
  never listed — its 2026-09-18 submission failed on 13013 + 5886 and the
  verdict wrote the flag `FALSE` — but Amazon left a SKU shell behind:
  `getListingsItem` returns **200** with `summaries: []`, no status, no
  offer, no `fulfillmentAvailability`, while `searchListingsItems` by ASIN
  returns zero items. `sku-listing-fetch.ts` set `present: true` on ANY 200
  without requiring a summary, so `checkAsinLiveOffer` called the shell
  "live" and a later reconcile flipped `FALSE` → `TRUE`. The module header
  already claimed the correct contract ("404 = absent, 200 = present with
  Active/Inactive statuses"); the code never enforced it. A1 makes the code
  match the header.

  **The `asin_skus` row stays.** It is history, and resurrection may reuse
  the shell's own SKU string — Amazon accepts a PUT to an existing SKU, so
  the re-add is a PUT to that same SKU and carries no duplicate risk. For
  the same reason the §18 `already_in_catalog` pre-gate applies A1 too: a
  shell is not a listing, so it must not make an ASIN permanently
  un-addable.

  Shells are a **per-SKU artifact**: the unfiltered account listing (Part B
  phase c) returned zero empty-summary rows across all 805 SKUs, so A1's
  teeth are in the per-SKU `getListingsItem` path where the shell actually
  lives.

  **Counter-case, deliberately unchanged: B081S8MTJ5 / BC-DO62-O14S.** The
  SC UI shows nothing for it; the API returns a full `DISCOVERABLE` listing
  with an FBA offer, `fnSku`, and a populated summary. AF's `TRUE` is
  CORRECT and A1 keeps it. SC-UI absence is not evidence.
- **EVERY FLAG WRITE GOES THROUGH ONE PRIMITIVE, AND EVERY WRITE IS
  LEDGERED (A2, 2026-10-09).** One function writes `has_live_offer` — and
  `has_buyable_offer` **atomically in the same statement** (§23; `BUYABLE`
  in `summaries[].status` remains the buyable flag's sole source, and the
  two flags must never be able to disagree) — alongside
  `offer_checked_at`, `current_issues` and `issues_checked_at`. The same
  call records a **per-ASIN outcome in the invoking run**, one of:

  `listed` · `not_listed` · `flip: x -> y` · `discovery` · `onboarded` ·
  `skipped_transient` · `error: <msg>`

  The listings stage records **every ASIN it probed**, not only the ones
  that changed. **A `FALSE`→`TRUE` flip with no ledger row is impossible by
  construction.**

  Before this the flag had **nine** write sites across five files, and the
  listings stage's `outcomes` recorded flips and discoveries only — so an
  ASIN that was probed and stayed put left no trace at all, and
  `syncLiveOffers` wrote the flag from entry points that touched no ledger.
  That combination is how B07J2WWWD4's wrong `TRUE` arrived with nothing to
  attribute it to.

- **Writers — the COMPLETE list (2026-10-10). Every entry is a probe.**
  - **The listings reconcile stage** (§11 Refresh job) — phases a, b and c,
    scope per A3, outcomes per A2. The daily-pass/rider implementation is
    gone (`live-offer-sync.ts` **deleted** 2026-10-09); the §6 single-ASIN
    `recheck-issues` endpoint now runs the stage scoped to one ASIN.
  - **The Refresh button and onboarding** — the same component (16) over
    their scope; one implementation, no second copy (Product Info is gone,
    2026-10-15).
  - **The §19 post-submit ladder** (T+1/3/10/30/60m) — a probe, so subject
    to A1, writing through the primitive. Restored to being the FIRST writer
    after a submit (§19 Auto verify), which it was until 2026-09-21.
  - **The §19 verdict and stale-promotion re-probes** — a verdict is not a
    writer, it is a TRIGGER for one. See the next bullet.
  - The one-off `script/backfill-has-live-offer.ts` is **deleted**
    (2026-10-09): the stage now covers the full catalog, every status,
    no-SKU ASINs, and ledgers every ASIN — none of which the script could
    do.

  **Phantom writers, corrected 2026-10-09.** The list this replaces opened
  with two writers that no longer existed when it was read: **(1)** a
  "daily staleness pass at 07:00" — there is no cron that calls it — and
  **(1b)** the "inventory-sync trailing rider", which was **removed
  2026-09-06** when the Refresh `listings` stage subsumed it
  (`inventory-sync.ts` says so in place). The only surviving
  `syncLiveOffers` caller was the single-ASIN `recheck-issues` endpoint.
  SPEC described a schedule that had not run for a month; that is recorded
  here rather than quietly dropped.

- **NON-PROBE WRITERS ARE GONE (2026-10-10). A verdict triggers a probe; it
  never writes the flag.** The three that existed are removed outright:

  | was | is now |
  |---|---|
  | ACCEPTED at submit wrote `TRUE` (2026-09-21) | writes **nothing**; the pending ledger row alone drives the pending icon |
  | §19 API `'failed'` verdict reverted to `FALSE` | triggers an **immediate re-probe** of the ASIN (all known SKUs + discovery) |
  | manual `'live'` verdict wrote `TRUE` (2026-08-28) | triggers an **immediate re-probe** |

  Extended to the rest of §19 for the same reason:
  - manual **`'failed'`** / **`'deleted'`** → immediate re-probe (they wrote
    nothing before, which was right, but "wrote nothing" also meant the row
    could sit stale until the next full reconcile);
  - **`processing` → `stale` promotion at 48h** → re-probe on promotion.

  **Why a re-probe rather than a write.** A verdict is a statement about a
  SUBMISSION; the flag is a statement about SELLER CENTRAL. They are usually
  consistent and occasionally not, and when they diverge the API is the
  better witness — a human resolving a row as `'live'` may be right about
  having created the listing and wrong about which SKU or ASIN carries it.
  Re-probing costs one Listings call and makes the two statements agree on
  evidence instead of assertion. It also satisfies §14 manual-trigger
  completeness, which is what motivated the 2026-08-28 manual-`'live'` write
  in the first place: the user still gets an immediate, correct answer — it
  just comes from SC rather than from their click.

  Fail-closed is unchanged throughout: a throttled or 5xx re-probe writes
  nothing, records `skipped_transient`, and the next sync retries. **A
  verdict never forces a flag value just because the probe was inconclusive.**

- **Fail-closed (2026-10-10, supersedes the 2026-09-21 amendment):** a
  definitive 200 **with a non-empty summary** (A1) writes `TRUE`; only
  all-SKUs-404-or-shell writes `FALSE`, and only after the discovery step
  below comes back empty; any transient (429/5xx/timeout) writes nothing,
  records `skipped_transient`, and is retried next run. Never coerced from
  missing data. **An ACCEPTED submit writes NOTHING** — the 2026-09-21
  pending-half write is removed; the ledger row alone drives the pending
  icon.
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

**SCOPE = EVERY ASIN AF KNOWS (A3, 2026-10-09).** All statuses — active,
parked AND **dead** — with or without `asin_skus` rows. Known SKUs are
probed per SKU; no-SKU ASINs go to phase b, which is **no longer
active-only**.

The two scope filters this removes were how B07J2WWWD4's wrong `TRUE`
became *frozen*: `full-scope-pass.ts` selected `status IN ('active',
'parked')` and the deleted `live-offer-sync.ts` selected `in_catalog =
TRUE` (a column since dropped, migration 052). The ASIN was `dead` with
`in_catalog = f`, so it sat outside both and
nothing could ever correct it. A flag AF cannot re-probe is a flag AF
should not be showing — "mirror the SC catalog" has no exceptions for rows
we happen to have given up on.

Cost: roughly (SKU count + no-SKU ASIN count) ÷ 5 rps. Measured
2026-10-09 on the live account, the unfiltered account walk alone was 41
calls in 18.7s — about 456ms per round trip, not the 260ms pacing floor, so
project from observed latency rather than the bucket. A button run is
bounded by its working set.

**SC lag is real but short (A4).** `offer_checked_at` age stays in the
tooltip and nothing codes around the lag — no grace windows, no
"recently submitted so assume listed" branches.
`POST /api/listings/full-scope-pass` remains as a script/dry-run entry
point, **selection-aware** (selected ASINs, else the full catalog — every
status, per A3; it was "full active catalog" until 2026-10-09). Two
sequential phases over one NDJSON progress stream
(`POST /api/listings/full-scope-pass`, body `{asins?}`):

- **Phase a — every ASIN with ≥1 `asin_skus` row, ANY status, ALL flag
  states** (TRUE/FALSE/NULL; `active` + `parked` + `dead` per A3):
  `getListingsItem` per SKU — deliberately NO
  first-live short-circuit, because 8c needs per-SKU liveness. Per
  definitively-probed ASIN it writes `has_live_offer` (any SKU live),
  `offer_checked_at`, the §6 issue snapshot (newest-live SKU's issues; `[]`
  when none live), and applies the **latest-live-wins primary re-point**
  (Primary-SKU ownership above). Any transient SKU probe → the whole ASIN is
  skipped, fail-closed. When ALL SKUs definitively 404, the all-404 →
  discovery rule above runs before `FALSE` is written; discovered ASINs are
  reported per-phase as **discoveries**.
- **Phase b — no-SKU ASINs, ANY status** (the active-only gate was removed
  2026-10-09, A3): `searchListingsItems` by ASIN (the §19
  fallback endpoint, `includedData=summaries,issues`) to discover SC-created
  SKUs. Found → write `asin_skus` rows (bootstrap primary only if none
  exists), `has_live_offer`, issue snapshot. Not found → stays NULL, counted
  **"no listing"** (sourcing leads — expected, the majority).
- **Phase c — ASINs SC has that AF does NOT (2026-10-11, Part B).** The
  other direction of "AF mirrors the SC catalog": phases a and b reconcile
  ASINs AF knows; phase c finds the ones it doesn't.

  **Source: `searchListingsItems` with NO identifiers** — the unfiltered
  account listing, `pageSize=20`, following `pagination.nextToken`. Verified
  live 2026-10-09 against the real account: HTTP 200, `numberOfResults` 805,
  41 calls in 18.7s. **The Reports-API fallback
  (`GET_MERCHANT_LISTINGS_ALL_DATA`) is NOT needed and is not implemented** —
  the spike settled it. With `includedData=summaries` the response carries
  only `{ sku, summaries }`, so the ASIN comes from `summaries[0].asin`.

  **A1 applies:** a row with no summary is a SKU shell, not a listing, and is
  not onboarded. (The account list returned zero such rows across all 805
  SKUs — shells are a per-SKU `getListingsItem` artifact — but the filter is
  the same single rule either way.)

  **A PARTIAL PULL ONBOARDS NOTHING.** Any page failing, or the page cap
  being hit with a `nextToken` still present, makes the whole list
  inconclusive: the run reports **`sc_list_incomplete`** and creates no rows.
  Onboarding from a truncated list would create rows for some ASINs and
  silently omit others — and the omission is invisible, because there is no
  "missing" to notice.

  **When it runs:** EVERY Refresh job regardless of scope, scheduled passes
  included — component 1 (SC-only SKU discovery) runs first in every pass,
  and component 16 carries the discovery callback whether the job came from
  the schedule or the button — "does SC have an ASIN AF lacks" is an
  account-wide question a selection cannot answer.

- **Onboarding a discovered ASIN (phase c).** Through **`onboardNewAsins`** —
  the ONE insert path (§14) — so the row is created and then refreshed by
  one Refresh job exactly like a CSV upload (§11 "Refresh job"; the
  `in_catalog` latch is gone — migration 052). The discovery is attributed
  by `lead_source` / the `SC import` tag; the job's trigger is `onboarding`.
  Then:

  1. `asin_skus` rows for every
     SKU SC returned, primary per the existing rules (`amzn.gr.*` never
     primary). The flag via the **A2 primitive**, outcome **`onboarded`** —
     a verdict, not a guess: the ASIN came from an A1-filtered account list.
     `has_buyable_offer` stays unwritten here; BUYABLE comes from a per-SKU
     probe, which the next reconcile supplies.
  2. **COGS:** if the ASIN has rows in the Orders sheet (the PO mirror), the
     existing PO sync runs **scoped to that ASIN**, so `actual_cogs` /
     `cogs_source='po_sheet'` / `prep_override` land as for any PO'd ASIN. No
     Orders rows → COGS stays **NULL**. No synthetic zero is stored; the UI
     already renders `$0.00` from nothing.
  3. **Buy link / supplier**, first match wins:
     a. **Master sheet** (`SOURCING_SHEET_ID`) ASINs tab **col N** (Buy Link,
        a full URL) → `buy_link` as-is, `supplier` via `extractDomain` — the
        same helper the Buy Link column edit uses. A **targeted read** of the
        tab, deliberately NOT the insert-only sourcing sync, which would try
        to create rows of its own.
     b. Else **Orders sheet col E** (supplier, a bare domain like
        `macys.com`) → `supplier` = the domain, `buy_link` = `https://` +
        domain, after trimming, lowercasing, and stripping any leading
        `http(s)://` or `www.`.
     c. Neither → both NULL.
  4. Tag **`SC import`**; `added_at = NOW()`; `estimated_cogs` untouched.
  5. **Results dialog:** the onboarded ASINs appear under the listings stage
     carrying their detail in the outcome string —
     `onboarded · SKUs <…> · COGS po_sheet|none · link master|orders|none`.
     Kept in the outcome rather than a parallel field so the jobs dialog
     renders it through the existing per-ASIN outcome list. Retry failed
     covers `error:` outcomes here too.

  **INSERT-BRANCH WRITES ONLY.** Buy link, supplier and the tag are written
  on insert and never on conflict — the same precedent as the sourcing sync's
  `promo_notes` and bulk promote's `buy_link`. Phase c only ever sees ASINs
  with no row, so there is nothing to overwrite; the guarantee is structural
  rather than circumstantial. **Discovery never writes tags, notes, COGS or
  buy link to an EXISTING row.**

  **Edge rules.** All-shell ASINs are not onboarded (A1). An ASIN SC has that
  AF holds as **dead** is phase a/b territory (A3) — the flag flips, the
  dialog shows it, and nothing auto-revives: the DA-2 dialog is Maria's call.

- **Pacing:** 260ms between calls, all phases (getListingsItem and
  searchListingsItems share the 5 rps Listings bucket; phases are sequential).
- **Per-phase report:** probed / flips / discovered SKUs / no-listing count /
  re-points ("primary → newest live: old → new") / duration — plus, as of
  2026-10-09 (A2), a **per-ASIN outcome for every ASIN probed**, not only
  the ones that changed. At full-catalog scope that is ~2.5k entries, on the
  order of 100 KB of `jsonb` in the run row; accepted deliberately, because
  "which ASINs did this run actually look at" has to be answerable from the
  ledger alone.
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
rendered as "created/live" — but it IS rendered as **"submitted (pending)"**
on the §6 catalog icon, immediately, so a deliberate user action gets
immediate feedback without overstating what Amazon has actually done. As of
2026-10-10 that render comes from the LEDGER ROW this system creates, not
from a flag write: ACCEPTED no longer touches `has_live_offer` (§18 Writers).
The user-visible behaviour is identical; the difference is that the flag no
longer claims SC has a listing before SC has said so.

A batch audit found ~1-in-8 submissions were silent ghosts (e.g. restricted-generic `5886`, suppressed `13013`), invisible
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
still open. On EVERY probe, a `200` **with a non-empty summary** for the
submitted SKU writes `has_live_offer = TRUE` + `offer_checked_at`
**immediately**,
independent of whether the ledger row moves to `live` or stays `processing`
— a just-created SKU returns 200-with-empty-STATUS while materializing,
which is "listed", not "live yet". (A 200 with no SUMMARY at all is a
different thing entirely: a SKU shell, which is not listed — §18 A1.)

**THE LADDER IS THE FIRST WRITER AGAIN (2026-10-10, reverts the 2026-09-21
demotion to "CONFIRMATION").** ≥1 ACCEPTED writes **nothing** to the flag.
The icon still reacts the instant the submit response lands — it reads
pendingness from the ledger row, which is created by the same submit — and
the ladder's first 200 is what turns the flag TRUE. A `'failed'` verdict no
longer reverts anything; it triggers a re-probe (§18 Writers), and the probe
decides.

This restores "only a probe may write the flag" without giving back the UX
the 2026-09-21 change bought: the user finishing Add to SC sees the pending
icon immediately, because the ledger row exists immediately. What they no
longer see is a flag asserting SC has a listing before SC has said so.

Add to SC is DISABLED for a row whose latest submission is still unresolved
— no double submits while pending; the guard is keyed on the LEDGER, which
is now also the only thing the pending icon reads. A server restart loses
the timers; the Refresh `listings` reconcile catches up, writing exactly the
same verdict from exactly the same probe.

`has_buyable_offer` (§23) is deliberately NOT written at submit time: a
submitted-but-unmaterialized offer is not BUYABLE, and the Repricer must
not count it.

- **Not a cron, not persisted:** timers are in-process only (`unref`ed). A
  server restart before firing simply leaves the rows in the pill; the manual
  sweep is the fallback. Deliberate — this is a follow-up to a user action,
  not a schedule.
- **No new writers:** the scoped sweep carries `verifyPending`'s existing
  semantics — fail-closed probes (throttle/not-yet-found write nothing) and
  the probe-driven flag write, which since 2026-10-10 goes through the §18 A2
  primitive and is keyed on A1 (`listed`, not `found`), so a SKU shell
  cannot write TRUE here either.
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

**The promotion re-probes the ASIN (2026-10-10).** A row reaching 48h is the
moment AF admits it does not know what happened, which is exactly when the
flag is most likely to be stale too — and the human is about to be asked for
a verdict, so they should be looking at a freshly observed flag rather than
one last written two days ago. One Listings call, through the §18 A2
primitive, fail-closed like any other probe.

### Manual verdicts

`POST /api/submissions/{id}/resolve` with `verdict ∈ {live, failed, deleted}`,
allowed on **any non-terminal row** (`pending`/`processing`/`stale`) — not
stale-only; stale is merely when we *prompt*, a human may answer earlier.
Already-resolved rows are rejected (409). Every verdict records `verdict_source`
= `api` (sweep) or `manual` (human).

**EVERY manual verdict RE-PROBES; none writes the flag (2026-10-10,
supersedes the 2026-08-28 manual-`'live'` write).** `live`, `failed` and
`deleted` all trigger an immediate re-probe of the ASIN — all known SKUs,
then discovery if they all come back absent — through the §18 A2 primitive.
The probe writes the flag; the verdict writes the ledger row. Nothing else.

The 2026-08-28 rule had manual `'live'` write `TRUE` directly, to satisfy
§14 manual-trigger completeness: with crons off, "waits for the daily pass"
meant "waits for a manual scan". The re-probe satisfies that requirement
better — the user gets an immediate answer AND it is an observed one. A human
resolving a row as `'live'` can be right that they created a listing and
wrong about which SKU or ASIN carries it; the probe catches that, a direct
write cannot.

Manual `'failed'`/`'deleted'` previously wrote **nothing**, which was the
right call on the evidence (deleting or failing one SKU doesn't mean the ASIN
has no live offer) but left the flag untouched until the next full reconcile.
They now re-probe for the same reason — the human has just told AF something
changed, so this is the cheapest possible moment to go look.

**The verdict never forces a value.** If the re-probe is throttled or 5xx it
writes nothing and records `skipped_transient`; the ledger row still resolves
as the human said. A verdict is a statement about a submission, not about
Seller Central.

**Rationale for the manual flow:** a listing the user deleted in SC is
**API-indistinguishable** from a silent ghost — both read as absent with no
terminal signal. The VA can also delete listings AF never recorded. So the
resolution flow must let a human state "this was deleted," rather than the
system inferring failure.

**`deleted` scope:** touches **only** the ledger row and `asin_skus.is_primary`
(demoted to false), plus the re-probe above, which may move the flag on the
evidence it finds. It **never** writes the component-owned `asins` fields
(`primary_sku` — §14, component 17), which self-correct on the next
Refresh job; deleting one SKU doesn't mean a multi-offer ASIN has no live
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
- **Groups and render order (2026-10-13).** Group order is **EXPLICIT, not
  alphabetical** — alphabetical put `OTHER` before `SEASONAL`, and Other is
  the leftovers bucket, so it belongs last. The order is
  `BLOCKERS → MARK DEAD → SEASONAL → OTHER`, encoded in a `CASE` in
  `GET /api/tags` (authoritative) and mirrored by `GROUP_ORDER` in
  `client/src/lib/use-tag-groups.ts` for the client-side comparators. A group
  not in that list sorts AFTER the named ones, alphabetically, so adding one
  degrades gracefully instead of landing in the middle.

  | group | tags, in `sort_order` |
  |---|---|
  | **BLOCKERS** | a violet ramp, **darkest → lightest in list order**: Waiting for sale `#4C1D95` · OOS (supplier) `#5B21B6` · Cancels orders `#6D28D9` · Cost went up `#7C3AED` · Need more leads from this supplier `#8B5CF6` · Discontinued (supplier) `#A78BFA` · Listing deactivated `#C4B5FD` · Slow mover `#DDD6FE` |
  | **MARK DEAD** | a red ramp, **darkest → brightest**: 5885 / 5886 `#DC2626` · Wrong product `#EF4444` · IP / Brand on the listing `#FF5C5C` |
  | **SEASONAL** | Fall / Q4 `#C2703E` · St. Valentine's Day `#E08FB0` · Spring `#A8D8A8` · Summer `#E3C95A` |
  | **OTHER** | Wholesale `#3B82F6` · SC import `#60A5FA` |

- **ALL TAG COLOURS ARE DISTINCT — this is a rule**, not a coincidence: the
  colour is the only thing distinguishing two chips at a glance on a row, so
  a repeat makes two different tags read as one. The 17 above are distinct.
  Within BLOCKERS and MARK DEAD the shade also carries meaning — the ramp
  runs darkest-first in list order, so severity reads off the colour.

  **ENFORCED since 2026-10-13, no longer just documented.** `POST /api/tags`
  rejects a colour another tag already uses with
  **400 `color already in use by <tag>`**, compared case-insensitively
  (`#ef4444` and `#EF4444` are one colour; values are stored uppercase).

  The picker takes **any `#RRGGBB`**, validated strictly on both sides — the
  ten swatches are a shortcut, not the range. The palette-only rule it
  replaces made this rule unsatisfiable: ten swatches against 17 tags meant
  a new tag could only be given a colour already taken. `TAG_COLORS` remains
  the random fallback when a create supplies no colour.

  The uniqueness check runs AFTER the existing-name early return, so
  re-posting an existing tag's name still returns that tag rather than
  tripping over its own colour.

- **Deleted 2026-10-13:** Easter, Buyable, SET MIN PRICE, For Sourcing (3
  ASINs), St. Patrick's Day, Back to School — and then **Spark Lead, OA Hunt
  and OAL 24/7**, whose meaning moved to **§6 `asins.lead_source`**. Those
  three encoded "where the lead came from" in a structure that cannot
  express "exactly one of these"; the backfill migrated 169 associations
  into the CHECKed column and the tags were dropped. Verified against a
  per-ASIN before/after snapshot: 169 associations removed, **all three of
  them lead tags, zero other tags lost** (984 → 815).

  **17 tags remain**, all grouped, all colours distinct.
- **Deletion cascades:** deleting a tag removes its `asin_tags` associations
  (`ON DELETE CASCADE`); the ASINs themselves are untouched.

### Filter dropdown (2026-10-13)

The Tags column filter is also where tags are managed. It used to be a
read-only list built from the CURRENT RESULT SET, which meant a tag no
visible ASIN carried simply vanished — St. Patrick's Day and Back to School
disappeared from Seasonal whenever nothing matched, which reads as "that tag
doesn't exist" rather than "nothing here has it".

- **Every tag is listed, always**, in the §20 render order above (ungrouped
  first, then each group under its header by `sort_order`), with the match
  count shown — **`(0)` when nothing in the current set carries it**. Same
  list in both `Any of` and `All of` modes. The list is seeded from
  `/api/tags`; counts are overlaid from the result set. A tag present on a
  row but absent from `/api/tags` (a stale set mid-refetch) still shows,
  rather than dropping a count the user can see.
- **Create** — a `+ New tag` row at the bottom: name, colour swatch, and an
  optional group chosen from the existing `tag_group` values (default
  ungrouped). Name is unique case-insensitively on the trimmed value. It
  posts to **the same `POST /api/tags` the row tag picker uses** — ONE
  writer. That endpoint gained optional `color` and `tagGroup` for this;
  called with `{name}` alone it behaves exactly as before (random palette
  colour, ungrouped), so the picker is unaffected. A colour is accepted only
  if it is one of the server's own `TAG_COLORS`.
- **Delete** — a `×` on row hover, then an inline confirmation naming the
  live count: *"Delete 'X'? Removes it from N ASINs."* `DELETE /api/tags/:id`
  **did not exist before 2026-10-13** — tags could only be removed with SQL —
  and was added with this. It returns the affected-ASIN count. The §20
  cascade removes the `asin_tags` rows; the ASINs are untouched.
- **If the deleted tag is part of the ACTIVE filter it is dropped from the
  filter** and the filter re-applied (or cleared, if it was the only
  selection) — otherwise the filter keeps referencing a tag that no longer
  exists and the view silently shows nothing.
- Both actions refetch `/api/tags` and the counts in place. No page reload.


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
`in_database` is TRUE for ANY `asins` row regardless of status — active,
parked, and dead all count (a dead ASIN is still "in your database").

**In-database filter (2026-09-12):** a column filter on the Product
column (where the `in_database` icon renders), three states — All
(default, no filter) / In database / Not in database — through the same
column-filter mechanism as every other bulk filter: filled icon when
active, composes with tags/date/toggles and sort, the filtered count
updates, and Export follows the standard rule (selection if any, else
the filtered rows). Backed ONLY by the existing `in_database` flag — no
new main-DB access. Like the other bulk column filters it is
session-state, not persisted. Promoting a row while "Not in database"
is active correctly drops it from the view on refetch; the selection is
pruned to visible rows so a hidden row is never carried into the next
action.

**§6 Lead Source (2026-10-13)** is the exception to the free-text rule
below: `bulk_list_asins.lead_source` carries the SAME CHECKed enum as
`asins.lead_source`, because it survives the export → upload → promote round
trip and lands in the main catalog. The upload dialog offers a list-wide
"Lead source"; a `lead_source` CSV column OVERRIDES it per row (the file is
more specific than the dropdown). Unrecognised cell → NULL, normalised
before the INSERT so a bad value cannot fail the CHECK mid-upload. Promote
carries it to `asins.lead_source`.

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
  promo_notes, notes (migration 034, 2026-09-08 — bulk-local Spark
  commentary; same pattern as promo_notes), last_reviewed_at (migration
  042, 2026-09-10 — the §6 review stamp, bulk-local: set by the same
  Product-cell link clicks, default-hidden column like main, `reviewed`
  filter, never touched by the pipeline, carried on promotion).
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
| `applyCatalogDeletedSignal` | `is_catalog_deleted`, and `status = 'dead'` + `status_reason = 'catalog_deleted'` on FALSE→TRUE (2026-09-07; was is_active/archive_reason) |
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
  Upload bodies can be large (a 1,962-row list with URLs + notes is ~527 KB
  as JSON): `express.json` runs at `limit: "10mb"` in `server/index.ts`
  (2026-09-07 — the 100 KB default 413'd before the route ran). Create-list
  errors render INSIDE the Save-list dialog and keep it open; `pageError`
  behind an open dialog is invisible and reads as a silent no-op.
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
- Promos (2026-09-04; main path reversed 2026-09-27): CSV `promos` column
  (aliases promos/promo/promo notes) or inline edit → `promo_notes`. The
  main page originally parsed the CSV column and IGNORED it, so that
  `promo_notes` came only from the sourcing sheet. **That asymmetry is
  retired** — the main CSV path now writes promos on the new-ASIN INSERT
  branch, the same insert-only contract as notes and `supplier_sku`. An
  existing ASIN's `promo_notes` is still never rewritten from any upload
  path, which is what keeps the CSV and the sourcing sheet from
  overwriting each other (and manual edits from being clobbered).
- Date Added (2026-09-04; meaning pinned 2026-09-08): on Bulk Calc,
  **Date Added IS the lead date** — the day the ASIN appeared on the
  Spark leads list. It is NOT the upload timestamp (upload time is not
  something this page needs to show), and it stays one column
  (`added_at`), not a separate lead_date. When the CSV mapping includes a
  Date Added column (aliases: date added/dateadded/added/date — safe
  because alias matching is exact on the normalized header), the value is
  written into `added_at` (M/D/YYYY parsed as LOCAL midnight —
  America/New_York in this deployment — never UTC midnight, so 09/02/2026
  renders 09/02/2026; ISO timestamps also accepted, which is what Export
  CSV emits, so export → re-upload round-trips). Resolution chain
  (2026-09-08): explicit Date Added column > Notes
  "Lead date MM/DD/YYYY" regex (both inputs go through the SAME
  parseAddedAt — one parser, two inputs) > NOW(). Every NOW() fallback
  logs one per-row line (raw value + reason) so a silent upload-day stamp
  can't go unnoticed again. Inline date editor on the cell. Snapshot-age
  display uses fetched_at, so a backdated row never looks stale.
  Sortable (asc/desc on the actual timestamp — date-typed columns compare
  via Date.parse, never the formatted string) and filterable via the
  generic date filter type (presets Today / Last 7 days / Last 30 days +
  custom from/to; counts toward the active-filter badge; Export CSV
  respects it through the standard filtered-rows/selected-rows rule).
  Bulk Calc opts `dateAdded` into the date filter type per-page; the main
  page's existing filter behavior is untouched (§21 isolation).
- Mapping-modal serialization (2026-09-08 regression): the modal builds
  its outgoing ColumnMapping FROM the MAPPING_FIELDS list generically —
  never a hand-typed field literal. The 42f0f42 bug: promos/dateAdded were
  in the field list (auto-matched, green check) but dropped by
  handleContinue's literal, optional in the type so tsc stayed silent, and
  every downstream layer nulled gracefully → silent NOW() on all rows. A
  completeness test pins builder-emits-every-field-key, and pins the
  main-path asymmetry below.
- **Main-path asymmetry, narrowed 2026-09-27: promos ARE written,
  dateAdded is not.** `/api/analyze` used to null both. Now:
  - `promoNotes` — **written, insert-only**, the same contract as notes: the
    value lands on the new-ASIN INSERT branch and an existing ASIN's
    `promo_notes` is never touched from this path. Reversed because a CSV
    carrying a discount code per row is the same kind of user-supplied field
    as Notes, and dropping it silently was indistinguishable from the tags
    bug found the same day. The sourcing sheet still owns Col O for the
    ASINs it syncs; the two writers do not collide precisely because the CSV
    value is insert-only.
  - `addedAtRaw` — **still dropped**, and the guard stays explicit. `asins`
    has no backdatable `added_at` column (that is a §21 bulk-only field), so
    there is nothing to write it to. A test pins that the `promoNotes: null`
    strip does NOT come back and that the `addedAtRaw: null` strip does.
- Everything else: **the Refresh job with `target: 'bulk'`** (scheduler
  v1, 2026-10-15 — replaces the page's own pipeline of 2026-09-09, which
  replaced the Product Info core that could never price a bulk-only ASIN).
  Refresh enqueues one job for the list (`POST /api/bulk-lists/:id/refresh`
  → 202 + the job; 409 while one is active; the status route re-attaches
  to it). The runner resolves each list ASIN (`server/scheduler/bulk.ts`):
  **in `asins`** → the main components run against the main tables, then
  the result row is copied main → bulk (`copyMainToBulk`); **not in
  `asins`** → the public components — catalog, hazmat, gating, prices,
  fees — run against `bulk_list_asins` ONLY, ledgered as `bulk:catalog`
  … `bulk:fees` under scope `bulk:<list_id>`. Store components (15–21) are
  skipped for ASINs not in the catalog. **Never bulk → main**; the shared
  passes are pure fetch/parse/outcome functions that take a writer, and a
  test pins that the bulk module writes no main table. The 30-day
  gating/hazmat cache (`bulk_gating_hazmat_cache`, migration 038) and its
  "Refresh all busts the cache" rule are **gone** (decision 3; dropped by
  migration 052): every run probes every row in scope, and a failed probe
  writes nothing and reports `error`. Outcomes are per LEG (migration
  035): `catalog_outcome` (parsed/absent/inconclusive — absent is the DA-2
  404 analogue and renders "Not found") and `price_outcome` (updated /
  no_offers / restricted / throttled / error — the fees result folds in:
  no price ⇒ fees skipped). A price failure never blanks catalog data and
  vice versa; `fetched_at` stamps only conclusive price outcomes.
  **Run lifecycle:** the job continues after client disconnect; progress
  is re-attachable via GET /api/bulk-lists/:id/refresh/status (the page
  polls it on load and while a job is live) and the finished job's
  components build the results dialog. One job per list at a time: a
  second POST is refused with 409 and a visible message. Default scope =
  failed + never-fetched rows; "Refresh all" covers everything; Retry
  failed re-runs exactly the failures. The bulk sink's UPDATE never
  touches any user-controlled field above, so they persist across runs.

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
data path; empty Actuals columns would violate honest labeling, §14).
Sourcing is excluded — no data source on this page. Notes moved OFF this
list 2026-09-08: it is a bulk-local column now (Additional info group,
default visible here like Promos; `bulk_list_asins.notes`, unrelated to
`asins.notes`) — the CSV Notes column carries the Spark commentary, and
the lead-date fallback regex reads the SAME stored value. CSV or inline
edit only (§14 user-controlled); the bulk sink never writes or clears it;
survives Refresh Prices. Truncate-with-hover render like the main Notes
cell. Export CSV carries Tags (comma-joined — re-imports through the same
split), Promos, Date Added, Supplier, and Notes (header "Notes",
alias-recognized — export → re-upload round-trips).

The ASINs page's export feeds this page's upload: its **"Buy Link"** header is
an exact alias of the mapper's `buyLink` field on BOTH matchers — the server's
`COLUMN_NAME_ALIASES` ("buy link") and the modal's `matchPatterns`
(`/buy\s*link/i`) — so ASINs-page export → Bulk Calc upload carries the full
URL with no re-mapping. Its qualified **"Estimated COGS"** / **"Estimated Prep
Cost"** headers round-trip too (§6 Export CSV headers); the matching "Actual"
headers are intentionally inert on import.

No date-range selector: nothing here is range-scoped.

The frozen row-action columns stay: **Buy List and Hold are SHARED with the
main page** — same localStorage sets, same toggle handlers, so carting an
ASIN here shows on the main page's Buy List and vice versa. The **selection
checkbox drives Export CSV** on this page: rows selected → export the
selection; none selected → export all. It also drives the bulk Buy List /
Hold header actions (below) and the toolbar's "Add to database".

#### Bulk Buy List / Hold (2026-10-03)

The cart and clock icons in the frozen column header were decoration; they
are now **buttons that act on the checkbox selection**. Both pages get them
— the component is shared, so the only difference is the promote step.

1. **Selection-only, never "all".** No selection → both buttons disabled,
   tooltip "Select rows first". There is no act-on-everything path: the same
   reasoning as "Add to database", where a 1,946-row action must be
   deliberate (§14).
2. **Toggle semantics, per set.** If EVERY selected ASIN is already in the
   set → remove them all. Otherwise → add every selected ASIN not yet in it,
   and remove none. So a mixed selection always resolves toward "add", and
   the operation is never partly-add-partly-remove. The tooltip states the
   resolved direction and count before the click: "Add 52 to Buy List",
   "Remove 52 from Buy List", "Add 52 to Hold".
3. **Buy and Hold stay mutually exclusive**, exactly as the single-row
   toggle already behaves: adding a selection to Buy List removes those
   ASINs from Hold, and vice versa. Removing from a set never touches the
   other.
4. **Promotion first, then the set** (Bulk Calc only). Selected ASINs not in
   `asins` are promoted through the existing `POST
   /api/bulk-lists/:id/promote {asins}` — same per-ASIN outcomes, same
   one-transaction-per-ASIN rule — and only then is the set updated. An ASIN
   whose promote returns `error` is **not** added to the set;
   `already_in_database` is not an error and proceeds normally. This is the
   opposite order from the single-row cart/hold click, which flips the set
   optimistically and reverts on failure: a bulk action can fail for a
   subset, so there is no single thing to revert, and the set must only ever
   contain ASINs that really landed.
5. **One confirm dialog, only when the promote count is > 0.** "Add 52 to
   Buy List. 30 of these aren't in your database yet and will be added." /
   Confirm / Cancel — shown BEFORE anything runs. Zero to promote → no
   dialog, immediate action. The remove direction never promotes and never
   confirms.

Outcome reporting is one toast: "Added 50 to Buy List · 30 added to database
· 2 failed (see list)", with the failed ASINs listed. Icons flip on refetch
as they do today.

**This is the THIRD explicit user action that reaches the promote endpoint**,
after the toolbar's "Add to database" and the single-row cart/hold click.
The isolation guarantee is unchanged — promotion is still only ever
user-initiated, and still only through `insertPromotedAsin`.

The main ASINs page gets the same two header buttons with the same toggle
semantics and the same shared localStorage sets, minus steps 4 and 5:
everything there is already in `asins`, so there is nothing to promote and
no dialog.

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

### Promote to database (2026-09-09)

**The isolation guarantee gets ONE exception.** Nothing automatic on this
page writes to the main tables — the pipeline, inline edits, list
create/delete, Refresh all stay bulk-only. **Promotion is the one
user-initiated write**, through a dedicated write path
(`insertPromotedAsin` — NOT the bulk sink, NOT the analyze UPSERT), and
it is reachable only from an explicit user action:

1. **Toolbar "Add to database"** — acts on the checkbox selection; none
   selected → disabled (never "all"; a 1,946-row promote must be
   deliberate).
2. **Cart / Hold click on a row whose ASIN is not in `asins`** — promotes
   silently (decision: auto-add), then updates the Buy/Hold set as
   today. Optimistic icon flip; revert + toast on error. Already-in-DB
   ASINs: the click only touches the set. (This fixes the invisibility
   bug: the sets are shared localStorage, but the ASINs page's Buy List
   view inner-joins against `asins` — a bulk-only ASIN carted here was
   silently invisible there.)
3. **Bulk Buy List / Hold from the frozen column header** (2026-10-03) —
   acts on the checkbox selection; none selected → disabled. Promotes the
   not-yet-in-`asins` members of the selection, THEN updates the set,
   behind one confirm dialog whenever the promote count is > 0. Error
   ASINs are excluded from the set. See "Bulk Buy List / Hold" above.

Per promoted ASIN, one transaction: a new `asins` row (status `active`)
plus its `asin_estimates` row, carrying the bulk row's user-controlled
fields (buy link/supplier, supplier SKU, est. COGS + source, notes,
promos, tags — missing tag names created ungrouped, matched
case-insensitively, existing tags never modified; tag creation runs
AFTER the insert commits, in the same per-ASIN unit of work, and a tag
failure makes that ASIN's outcome `error`, never a silent success) and
its snapshot (catalog, both prices, fees, BSR, sellers — seeded with the
bulk `fetched_at`; the row's own gating/hazmat values with NULL probe
stamps, since the cache is gone — decision 3, 2026-10-15; the
onboarding job it enqueues re-probes both — all timestamps passed
EXPLICITLY so no column default fires and Price Age stays honest).
`added_at` = the bulk row's lead date (decision: lead date, not
promotion date). `is_wholesale`/`is_oa` unset (§16: user-set only);
`last_reviewed_at` carries over (2026-09-10).

Duplicates (decision: skip existing): an ASIN already in `asins` — ANY
status, parked/dead included — is never touched; it reports
`already_in_database`. No §17 dialog, no merge.

After promotion the bulk row is NEVER modified; its Product cell flips
to the `in_database` icon on refetch. The bulk row and the `asins` row
are independent copies — edits on one do not flow to the other (the §21
COGS-divergence rule, extended to every field; the "Added" toast says
so). No ledger row — it's a write, not a fetch; one server log line per
promoted ASIN. Endpoint: `POST /api/bulk-lists/:id/promote {asins}` →
per-ASIN `{asin, outcome: added | already_in_database | error}`, one
transaction per ASIN (one failure never rolls back the others). Out of
scope: un-promote (use Park/Mark dead), promoting without a selection,
syncing later bulk edits into the main row.

### Saved lists

Lists persist and are selectable from a dropdown at the top of the page.
Selecting a list renders its stored snapshot.

Prices and fees are a snapshot from the last run, not live. Creating a
list auto-runs the first bulk run; subsequent runs are manual only. The
**"Refresh"** button (renamed from "Refresh Prices" 2026-09-09 — it runs
the full bulk pipeline: prices, fees, catalog, gating, hazmat) re-runs it
for the selected list and overwrites `bulk_list_asins` only. Snapshot age
is shown next to the list name. Lists can be renamed and deleted; delete
cascades.

### Toolbar

Present: Upload CSV, Refresh, Export CSV, Manage Columns, Settings,
list selector, save/rename/delete.

Settings opens the SAME dialog as the ASINs page, backed by the same
storage keys (`fba-analyzer-settings`; Include Inbound Shipping shares
`fba-include-inbound` — one toggle for home, Bulk Calc, AND Analytics
since 2026-09-09, when the analytics-only key was folded in: its value
migrated only if the shared key was unset, shared key wins otherwise;
price source shares `fba-price-source` — persisted now, was session-only
on the ASINs page); **no page-local settings exist**. Display Options
applicability here (2026-09-09):

| Control | On Bulk Calc | Why |
|---|---|---|
| Include Inbound Shipping | applies | same profit math |
| Price source | applies | both prices stored per row (migration 039: sale_price = strict lowest FBA, sale_price_buy_box, sale_price_lowest; price_source column dropped — the fallback label derives from which fields are present; legacy rows carry NULLs until their next Refresh) |
| Show gated | applies | rows carry eligibility_status; toggle off hides gated rows, which also drop from export's filtered set — main semantics |
| Show meltable | applies | rows carry is_meltable; same semantics |
| Show parked / dead | DISABLED | parked/dead are statuses of ASINs in the main catalog; bulk rows don't have them |
| Reset Est. COGS to PO | DISABLED | writes to the main catalog (§21 isolation) |

Disabled controls render with the one-line reason, never hidden: hidden
fields are how the pages drifted. A test pins the component/key sharing
and that the disabled set is exactly {showParked, showDead, resetCogs}.

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
eventually. The frame (schema, 2026 importer, list + expanded view) is
**purely additive**: the sheet remains the source of truth for every
existing integration (PO sync → `actual_cogs`/`prep_override`, Velocity
export, SB COGS export, sourcing-cost export). Nothing repoints to these
tables until the cutover layer, and each repoint gets its own dry-run.

**Sheet sync patch (2026-10-16, `docs/claude_spec-patch-po-sheet-sync.md`,
pre-flight `docs/po-sheet-sync-preflight-2026-10-16.md`).** The one-time
importer became a repeatable sync: the ASINs-page **Sync POs** button now
syncs the whole Orders sheet into these tables (new POs inserted, existing
POs updated) before the per-ASIN COGS sync. **"Sheet wins fully, for now"
(Maria, 2026-10-16):** every field the sheet carries — including the
Status cell's Closed / action-item / Canceled words — is overwritten from
the sheet on every sync, so an AF edit to one of those fields lasts only
until the next sync. Temporary, until the VA moves off the sheet; fields
the sheet does not carry stay AF-owned (see "Sync from the Orders sheet").

**Shipment reconciliation patch (2026-10-17,
`docs/claude_spec-patch-shipment-reconciliation.md`, evidence
`docs/phase2-probe-2026-10-17.md`).** Phase 2 of the expand-by-ASIN work:
At Prep Center, Shipped FBA, Received by Amazon and Shipment IDs are
filled from Velocity and Seller Central by the **Sync Shipments** button
(see "Shipment reconciliation"). Nobody reconciles by hand; the only
review work is the Unmatched panel (data-entry gaps on Velocity's side).

**Expand by ASIN patch (2026-10-16, `docs/claude_spec-patch-po-expand-by-asin.md`,
pre-flight `docs/po-expand-preflight-2026-10-16.md`).** Step 1 of taking
FBA-shipment reconciliation over from the VA: every PO can show its ASIN
rows nested under it with the columns the reconciliation will fill in;
per-ASIN status quantities replace the PO-level status words; PO-level
Status is Open / Closed with an auto-close rule; the free-text status
became multi-select **Action Items**. Pulling the data from SC / Velocity
is Phase 2 (below).

### Tables (migrations 028–029; 056 for the expand-by-ASIN columns; 057 for shipment reconciliation)

- `purchase_orders` — one row per order. `UNIQUE (supplier, order_id)` (order
  IDs collide across suppliers, §10). `source ∈ {manual, sheet_import, extension, email_renewal}` (migration 075).
- `po_asins` — one row per ASIN per order. `UNIQUE (po_id, asin)`. Carries
  qty, `cost_per_unit` (adjusted-COGS snapshot), prep, sold_as /
  units_per_pack, unreimbursed loss, Amazon SKU, notes.
- `po_line_items` — one row per supplier product. FK to its `po_asins` row
  (`ON DELETE SET NULL`). Carries price, per-item discount, qtys
  (`qty_ordered`, `qty_received`, `qty_canceled`, `qty_returned`,
  generated `final_qty` — migration 030, below), `asin_qty_per_product`
  (yield), `adjusted_product_cost` snapshot, Supplier SKU / UPC, notes.
- **Migration 056 (2026-10-16):** `po_asins` gains six ASIN-quantity
  columns, `numeric(10,2) NULL` — `qty_shipped_supplier`, `qty_at_prep`,
  `qty_at_warehouse`, `qty_lost_damaged_us`, `qty_shipped_fba`,
  `qty_received_amazon`; `po_asin_shipments` (as re-keyed by **migration
  057**, 2026-10-17: one row per **Velocity shipment** per ASIN row —
  `velocity_shipment_id text NOT NULL` (or `manual:<uuid>` for a hand
  row), `fba_shipment_ids text[]` (the SC shipments it fanned out to, one
  per FC — D1), `sc_match ∈ none|matched|ambiguous|unmatched`,
  `qty_shipped` / `qty_received numeric(10,2)` in ASIN qty, `shipped_at`,
  `source ∈ velocity|manual`, uuid PK, `UNIQUE (po_asin_id,
  velocity_shipment_id)`) with a trigger keeping `qty_shipped_fba` /
  `qty_received_amazon` equal to the SUM over its rows (NULL with no rows —
  the declarative analogue of the generated `final_qty`); and on
  `purchase_orders`: `closed_at timestamptz NULL`, `closed_by text NULL`
  (`'auto'` | `'sheet'` | a `users.id`), `action_items text[] NOT NULL
  DEFAULT '{}'` CHECK-limited to the seven values below. The old free-text
  `status` column stays for now (D5) but **nothing reads or writes it**;
  it is dropped in a follow-up migration once the §6.4 backfill is
  verified in production.

Migration 021 dropped an older same-named scaffold; 028 is fresh, not a
revival.

**Lookup lists** live in `settings` as JSONB arrays: `po_payment_methods`
(13), `po_cashback_sites` (5), `po_emails` (2), `po_purchasers` (1).
**List order is meaningful: element 0 is the default** (mpeters.cqg@gmail.com;
Maria). The entry form must preserve order; never sort these lists.

### Capture PO data model (migration 075, 2026-10-31; patch `docs/claude_spec-patch-po-ai-prefill.md` §8–§9 as amended)

Everything the Orders sheet still carried that AF lacked, so the sheet can be
retired. Money stays in dollars (no `_cents` twins — Maria 2026-10-31);
NULL = not recorded, never 0 on import. Schema only; the data backfills run
from `npm run backfill:po-model` (dry run by default, `--live` after the
production dry run is reviewed; idempotent — rows already present are
skipped). **No stored COGS / AQ / AR / Y value is ever recomputed.**

- `purchase_orders`: `purchased_by_user_id` (→ `users`, nullable; "Anna" has
  no user and keeps the text with a NULL id), `cashback_status`
  (pending | received | denied | NULL), `cost_formula_version` (NULL =
  sheet-imported / pre-rule, never recomputed; 2 = the §7.1 allocation),
  `source` widened to `sheet_import | manual | extension | email_renewal`.
  The existing `discount`, `tax`, `sh_donations`, `refund_amount`,
  `cashback_site` / `cashback_pct`, `email_used`, `subscription`, `notes`,
  `promo`, `payment_method`, `weighted_gc_discount_pct` stay.
- `po_asins`: `sourcing_cost` (col AR — COGS before the gift-card discount,
  promos applied; what Update COGS in SC sends), `paid_cost` (every
  discount counted; = COGS for imported rows), `cogs_adjustment` +
  `cogs_adjustment_reason` (added onto COGS, e.g. prep materials $3).
  `cost_per_unit` stays COGS (col Y) and feeds `actual_cogs`.
- `asins.sold_as` / `asins.units_per_pack` — the ASIN-level pack fields the
  New PO form reads ("AF knows the ASIN") and its pack override writes. Backfilled
  from the 2026 PO ASIN rows (sheet AX/AY as imported), non-canceled rows:
  every row agrees → set; rows disagree, or no row has a value → left NULL and
  listed in `docs/pack-size-gaps-<date>.csv` (ASIN, title, distinct values
  with PO counts) for Maria to fill in. `asin_field_log` is the History for
  ASIN-level fields (`po_edit_log` is PO-scoped).
- `po_payments` — several per PO: `method` (card | gift_card | store_credit |
  paypal | other), `nickname`, `last4`, `amount` (NULL = not recorded),
  `gift_card_discount_pct`, `raw_text`, `needs_review`, `position`. Σ amount
  should equal the order total (a form warning, never a constraint). Backfilled
  from `payment_method` by `server/po-payments-parse.ts` ("Name (1234)" →
  nickname + last 4; "Name: $amt, Name: $amt" → one row per part; "(through
  PayPal)" → paypal; "Gift cards: 7204, 9283" → one gift card per last 4;
  unreadable text → one `other` row holding it, `needs_review`, listed in
  `docs/payment-review-<date>.csv`). `payment_method` stays until the sheet
  retirement patch drops it.
- `po_promos` — several per PO: `type` (sale | coupon | rewards; NULL =
  awaiting Maria), `description`, `amount` / `percent`, `counts_toward_cogs`
  (§7.2: sale and coupon count, rewards does not, each a toggle), `raw_text`
  (col AK / the captured line, verbatim), `confidence`, `source`
  (manual | capture | backfill). Col AK backfill = one Haiku batch call over
  the distinct values (§8.4 as amended; `npm run backfill:po-promos`).
- `po_line_refunds` — per supplier line: `qty`, `amount`, `refunded_at`,
  `method` / `nickname` / `last4`, `source` (manual | email | sheet),
  `email_message_id`, `note`; a PO-level placeholder has `po_line_item_id`
  NULL and `needs_split`. Backfill of col AF: one line → on it; several lines
  of which exactly one has a returned qty (col R) → that line; otherwise the
  placeholder. The cancellations patch writes here.
- `po_prefill_log` — one row per model call (§5): `kind` (capture | backfill
  | promo_classify), retailer, model, input chars / tokens, output tokens,
  cost estimate, duration, `schema_ok`, error, `po_id` once saved. Nothing
  from the page text is stored.
- `subscriptions` (§27) — `supplier`, `po_asin_id` (the originating PO's
  ASIN row), `asin`, `product_name`, `frequency_weeks`, `next_order_date`,
  `status` (active | paused | canceled), `last_po_id`, `created_from`
  (capture | manual | email | sheet), `notes`. Backfill: one row per
  (supplier, ASIN) over the POs flagged `subscription`, newest PO; frequency
  parsed from the notes ("Every 12 weeks", "Every 3 months" → 12, "Monthly"
  → 4; unknown → NULL for Maria), canceled when the note says so,
  `next_order_date` = order date + frequency while active.
- `po_line_action_items.item` gains **Confirm order details** (§6.7),
  **Subscription renews** and **Review renewal PO** (§27).

### Costs (patch `docs/claude_spec-patch-po-ai-prefill.md` §7 as corrected 2026-10-31; formula v2, `shared/po-cost.ts`)

Three costs per ASIN row, for POs created by the New PO form (and the
capture) from 2026-10-31 — **historical rows keep the sheet's col Y / col
AR verbatim and are never recomputed** (`purchase_orders.cost_formula_version`
IS NULL; Maria 2026-10-31):

- Per product line the **paid price AQ** is the unit price actually paid
  (an item-level sale or coupon is already in it). The order-level
  **Discount** is allocated pro rata over the subtotal. A promo whose
  `counts_toward_cogs` is false (**rewards**, by default; sale and coupon
  count, each a toggle, §7.2) is **added back**: its amount is taken out of
  the discount before allocating. **Tax and shipping are never allocated
  into cost; cashback never counts.** A non-counting promo with no amount
  cannot be added back and counts until one is entered (form warning).
- **Sourcing cost** (`po_asins.sourcing_cost`, col AR) = Σ(AQ × product qty)
  ÷ ASIN qty — COGS before the gift-card discount. **This is what Update
  COGS in SC submits** (the gift-card discount is financing, not product
  cost); a row with no sourcing cost yet falls back to `actual_cogs` and the
  export counts it (`sourcingFallback`). Dry run before the switch:
  `tsx script/sourcing-cost-switch-dryrun.ts` — per ASIN before / after,
  the count that changes, min / median / max delta.
- **COGS** (`po_asins.cost_per_unit`, col Y) = Sourcing × (1 − weighted
  gift-card %) **+ the per-ASIN adjustment** (`cogs_adjustment` with a
  required reason, e.g. "prep materials $3"). Feeds `actual_cogs`
  (`runSheetsSync`), the Aura push (+ prep) and repricing, as before. A
  cost / unit typed by hand on the form wins and is logged as
  `cost_per_unit` in History.
- **Paid cost** (`po_asins.paid_cost`) = the same allocation with every
  discount counted, × (1 − GC %). Unused today (the sales / profit
  dashboard). Equal to COGS on imported rows.
- The line's `adjusted_product_cost` (col X) = AQ × (1 − GC %).
- **Recompute** (`server/po-costs.ts` `recomputePoCosts`): the PO editor
  re-runs the rule for a v2 PO when a promo's `counts_toward_cogs` flips,
  a promo / line / header money field changes or an adjustment is edited;
  an ASIN row whose cost / unit was ever typed by hand keeps its COGS while
  its Sourcing / Paid cost still follow; every change is logged. An
  imported PO is skipped.

### Capture PO — `/api/pos/prefill` and the AI config (patch po-ai-prefill §4.5, §5; 2026-10-31)

- **AI config** lives in `server/config/ai.ts`: model `claude-haiku-5-5`
  (Haiku-class by decision), `max_tokens`, effort low, the price used for
  the per-call estimate. `ANTHROPIC_API_KEY` (Render env var; optional)
  switches every AI feature on; without it `POST /api/pos/prefill` answers
  503 "AI prefill is off" and the extension shows that — never a silent
  fallback. One call per capture; the promo backfill is one batch call.
- **`POST /api/pos/prefill`** (session required, like every `/api` route):
  body `{ retailerHost, capturedAt?, pages: [{step, url, title, text,
  fields}] }`, already scrubbed by the extension (§11 "Capture PO"). One
  `messages.parse` call with a zod output format (`PrefillSchema`:
  retailer, order id / date, lines with product name / SKU / qty / retailer
  units per pack / unit price paid / line total / ASIN guess, subtotal /
  discount / tax / shipping / total, promos typed by the same rules as the
  backfill (`PROMO_RULES`, michaels.com exception included), payments
  (method / nickname / last 4 / amount), ship-to street, subscription,
  purchased email, confidence notes). A schema failure or API error is the
  **raw-text fallback**: the form opens with only the supplier and the
  captured text in its drawer. Then, with no AI: supplier from the hostname
  (AF's supplier is the domain; exact → alias → same registrable domain →
  else the hostname, flagged new), `ships_to` / prep from the ship-to
  street through the same settings the tracking router uses (§4.4), ASIN
  candidates per line (§6.4 — history first, stone; else the model's guess,
  amber), totals cross-checks (lines vs subtotal, payments vs total) and
  the model's notes → warnings. The result is a `PoFormState` partial plus
  the §6.1 markers, parked under a **10-minute in-memory key** (not a
  table, not a draft) — the response is `{ id, url: "/pos/new?prefill=<id>",
  schema_ok, warnings, lines, supplier }`; `GET /api/pos/prefill/:id`
  returns the payload (404 once expired).
- **`po_prefill_log`**: one row per call (user, kind capture | backfill,
  retailer, model, input chars / tokens, output tokens, cost estimate,
  duration, schema ok, error); `po_id` is set when the prefilled form is
  saved (`POST /api/pos` reads `prefill.id`). Nothing from the page text
  is stored.
- **Promo backfill**: `npm run backfill:po-promos` (dry run by default; the
  one classification call runs either way and is logged with kind
  `backfill`; `--live` inserts) — the distinct col AK texts, paired with
  the supplier for the michaels.com rule; high confidence applied, low
  confidence stored with type NULL and listed in
  `docs/promo-classification-review-<date>.csv`.

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
- `qty_canceled` is NULLable with NO default. **NULL = not tracked.**
  Since 2026-10-17 (row-level Status) the sheet sync sets
  `qty_canceled = qty_ordered` on **the line whose own row** says
  Canceled — never PO-wide; the "Mark canceled" action on an ASIN row
  sets it on every line of that ASIN. (2026-10-16 to 10-17: the first
  row's Canceled was applied to every line of the PO.) The entry form writes
  explicit values (its 0 default lives in the form, not the column).
- **Canceled / Returned on the ASIN row are DERIVED** (pre-flight decision
  1): Σ(line qty × `asin_qty_per_product`) over the ASIN's lines, NULL when
  any contributing line is untracked. No stored copies on `po_asins`; the
  product level stays the truth.
- **Bundles divide by N (Maria 2026-10-17, row-level Status P2):** the
  stored yield of each bundle component is its standalone yield (1.00, or
  the pack count), so for `sold_as = 'bundle'` the derived Canceled /
  Returned is Σ(line qty × yield) ÷ `po_asins.unique_products` (Col S).
  Fully canceled Kinder's B0G6R55GNQ (2 × 12 × 1.00) derives 12, not 24;
  1 unit of one product in a 3-product bundle derives 1/3. Multi-packs and
  non-bundle multi-listing groups keep the plain sum. One SQL definition,
  `derivedFromLines` in `server/po-queries.ts`.
- `final_qty` is GENERATED ALWAYS STORED:
  `qty_ordered − qty_canceled − qty_returned` — plain arithmetic, **no
  COALESCE**. NULL propagates by design: historical rows render Final as a
  muted em-dash ("not tracked"); app-entered rows compute real values.
  Explicit 0 renders muted, never as an em-dash.

**Cutover exclusion rule** (recorded now, applied at the cutover layer —
no code implements it yet): a line is excluded from profit calculations
when `final_qty = 0`, OR when `final_qty IS NULL` (not tracked) AND
`qty_canceled IS NOT NULL AND qty_canceled >= qty_ordered`. The old
status-text fallback (`status ILIKE '%canceled%'`) is gone with the
status column (§6.3, 2026-10-16): the §6.4 backfill wrote
`qty_canceled = qty_ordered` on every line of a sheet-canceled PO, so the
generated `final_qty` is 0 there and the first clause covers them.
Evidence recorded at the switch (local, 1,168 lines): old rule 38 rows,
new rule 0 before the backfill and 38 after — delta 0, explained entirely
by `qty_canceled` having been untracked. A partially-canceled line with
`final_qty > 0` is INCLUDED.

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

Both cases render identically in the ASINs table: one row with an expander
revealing component line items.

### Expand by ASIN (POs page, 2026-10-16)

- Toolbar **Expand All** (becomes **Collapse All**) applies to the current
  filtered list; a per-PO **chevron** in its own cell is the only expand
  target — clicking anywhere else on the row still opens the PO.
- Nested rows are the PO's `po_asins` rows, indented, in `po_asins` order,
  through the same component as the detail ASINs tab (one column model,
  below). The nested column header appears **once**, under the first
  expanded PO on the page; fixed column widths keep every later expanded
  PO aligned with it. Sorting/filtering stays at PO level.
- Loading: the list is paginated 25/page, so the page's ASIN rows ride the
  list payload through the same loader as the detail route
  (`server/po-queries.ts`) — one extra query per page, no fetch on expand.
- Persistence: `localStorage` `fba-po-expanded` `{ all, ids }` (the ASINs
  page's per-browser mechanism); default all collapsed; collapsing one PO
  under Expand All turns the flag off and keeps the others open.

### Column model — ASINs table (nested rows and the detail ASINs tab)

`client/src/components/po-asin-rows.tsx`, order and names fixed
(`PO_ASIN_COLUMNS`):

| # | Column | Source |
|---|---|---|
| 1 | ASIN | link |
| 2 | Title | |
| 3 | Amazon SKU | |
| 4 | **Ordered** | `po_asins.qty` — the ASIN (sellable-pack) qty, Σ sheet Col N (P1) |
| 5–9 | Cost/Unit · Total Cost · Prep · Sold As · Units/Pack | |
| 10 | **Individual Units Ordered** | Ordered × Units/Pack (D4) |
| 11 | Canceled | derived from the lines (above) |
| 12 | Returned | derived from the lines |
| 13 | Shipped by Supplier | `qty_shipped_supplier` — hand-entered (supplier tracking numbers now arrive by email, §26; quantities from them are a later step) |
| 14 | At Prep Center | `qty_at_prep` — Velocity (Phase 2); may be fractional |
| 15 | At CQG Warehouse | `qty_at_warehouse` — hand-entered |
| 16 | Lost/damaged by us | `qty_lost_damaged_us` — hand-entered |
| 17 | Shipped FBA | `qty_shipped_fba` = Σ `po_asin_shipments.qty_shipped` (trigger) |
| 18 | Received by Amazon | `qty_received_amazon` = Σ `po_asin_shipments.qty_received` (trigger) |
| 19 | Shipment IDs | chip "N shipments · qty" → per-shipment list; manual add/remove allowed (source `manual`) |

All quantities are ASIN quantities, `numeric(10,2)`; **NULL = not
tracked** (em-dash, never 0 by default); fractional values are legal
(7 units of a 6-pack = 1.17) and show 2 dp only when non-integer. There is
no derived "Received" column (D1): At Prep Center and At CQG Warehouse are
separate. Unreimb. Loss is gone from the table (DB column untouched).
Cells 13, 15 and 16 edit inline (click, Enter/blur saves, empty = NULL);
every quantity or shipment change re-runs the auto-close rule.

**Products tab** (§4.3): Ordered · Received · Canceled · Returned ·
**At Prep Center · At CQG Warehouse · Lost/damaged by us** · Final. The
three new ones are the ASIN quantities in product units through the
line's yield (product qty = ASIN qty ÷ `asin_qty_per_product`) for 1:1
lines; a bundle component line shows a dash. Shipment columns are
ASIN-level only.

### Status: Open / Closed (2026-10-16)

- Column 1 of the POs table ("Status"): a green check when Closed, an
  open-order outline when Open; click toggles with a confirm. A manual
  close/reopen records the user in `closed_by`. The PO Details header
  carries the same toggle.
- **Auto-close (D2)** — `server/po-close.ts`, re-evaluated after every
  quantity edit, shipment change and action-items change: close with
  `closed_by = 'auto'` when BOTH (a) every `po_asins` row has Shipped FBA
  ≥ Ordered − Canceled − Returned − Lost/damaged by us (NULLs read as 0)
  and at least one row has Shipped FBA > 0, and (b) **no product line of
  the PO carries an action item** (row-level Status, 2026-10-17; was the
  PO-level array). Auto never reopens a PO closed by hand or by the sheet backfill;
  an auto-closed PO reopens when (a) or (b) stops holding; a manual
  reopen stays Open until the rule next becomes true after a change.
- Filter Open / Closed / All; **default Open only** (D3). The backfill
  (§6.4) closed 679 sheet-"Closed" POs with `closed_by = 'sheet'`, so the
  default view opened on the 94 others.

### Action Items (replaces the free-text status, 2026-10-16; per product since 2026-10-17)

**PO table v2 (patch `docs/claude_spec-patch-po-table-v2.md`, 2026-10-29) —
the current model; the paragraphs below are the history it builds on.**
- **Storage:** one row per open item per product line in
  `po_line_action_items` (migration 074): `po_line_item_id`, `item`,
  `source` (`manual` | `sheet` | `auto`), `reason`, `set_at`, `cleared_at`,
  `cleared_by`. Open = `cleared_at IS NULL`; a unique partial index allows
  one open row per (line, item). Clearing stamps the row, never deletes it.
  Migration 074 backfilled it in the same transaction from
  `po_line_items.action_items` (source `sheet`) and from Review Velocity
  (source `auto`), one History row per PO (`action_items_moved`).
  `po_line_items.action_items` and `purchase_orders.action_items` are
  **dead** — nothing reads or writes them; they are scheduled for removal.
- **Labels are sentence case:** Need to return · Missing / damaged from
  supplier · Confirm refund / replacement · ATTN: Velocity · See comments ·
  SHIP · Received - FBM, then the auto items Extra units shipped · Review
  Velocity · Pack size missing · Pack size mismatch · Receiving mismatch.
  The old title-case spellings are accepted on input (`LEGACY_ACTION_ITEMS`:
  the editors, the `action=` filter, sheet intake) and mapped.
- **Stored vs derived:** the seven manual items and Review Velocity are
  stored. Extra units shipped (Shipped FBA > Ordered on the ASIN row, red
  chip), Pack size missing / mismatch and Receiving mismatch stay derived
  and are never stored.
- **Rollup:** a line's items show on its own product row; the ASIN row
  shows the union of its lines (plus the derived items); the PO row shows
  the union over every line. The PO chip carries a **·N** badge when only
  N of the PO's lines have the item, and its hover names the lines and
  ASINs plus any auto reason (`action_item_lines` on the list payload).
  Two chips at most, then **+N**; a chip too long for the column ends in an
  ellipsis with the full label on hover.
- **Editing:** the editor on a product row sets that line
  (`PATCH /api/pos/lines/:id/action-items`); on an ASIN row, every line of
  that ASIN (`PATCH /api/pos/asin-rows/:id/action-items`); on the PO row,
  every product line of the PO (`PATCH /api/pos/:id/action-items`). When
  the scope has more than one line the editor asks **"Add / Remove "X"
  to / from all N lines?" → Apply to all N lines** before writing. An
  added item goes onto every line in scope; a removed item is cleared on
  every line in scope (`cleared_by = 'manual'`); one History row per line
  that changed. Review Velocity is never offered and is dropped if echoed.
- **Filter:** `action=` is any-of over the PO's open line items (one line
  of one ASIN is enough), OR'd with the derived items' conditions.
- **Auto-close:** an open stored item on any line, or a blocking derived
  item, keeps the PO open; clearing the last one lets the rule close it;
  a new item on any line reopens an auto-closed PO.

**Row-level Status (patch `docs/claude_spec-patch-row-level-status.md`,
pre-flight `docs/row-level-status-preflight-2026-10-17.md`, 2026-10-17):**
a sheet row is a product, so action items live on
`po_line_items.action_items` (migration 058, same CHECK). The sheet sync
maps each row's Status onto its own line (full replace per line). The
ASIN row shows the union of its lines and edits write through — an item
added on the ASIN goes onto every line, an item removed comes off every
line (`PATCH /api/pos/asin-rows/:id/action-items`); a product row edits
its own line (`PATCH /api/pos/lines/:id/action-items`). The POs-page
column and the PO Details header show the union over all lines,
read-only; the filter is any-of over lines. `purchase_orders.action_items`
is no longer read or written (kept one release, dropped with `status`).
The new last ASIN-table column is **Action Items**. The paragraph below
describes the 2026-10-16 PO-level model it replaces.

`purchase_orders.action_items text[]`, multi-select, values and display
order: **Need to Return · Missing / Damaged from Supplier · Confirm
Refund / Replacement · ATTN: Velocity · See Comments · SHIP · Received -
FBM** (the last two only meaningful when the PO ships from the house). **Review Velocity** (2026-10-21) is
auto-managed and appears after them — derived from PO tracking, never
stored or hand-set (§26). **Pack size missing** and **Pack size mismatch**
(2026-10-29) are derived the same way, from `po_asins`: missing while
`sold_as` is NULL **and** the row has a live line (ordered > 0, not fully
canceled, `final_qty` not 0 — 2026-10-29: a qty-0 or canceled line needs no
pack size) **and the PO is Open** (Maria 2026-10-29: a closed PO keeps its
NULL silently); mismatch while a non-bundle row's
`velocity_units_per_pack` differs from its `units_per_pack`. Both block
auto-close (and reopen an auto-closed PO) like any action item, and clear
when the row is fixed. **Receiving mismatch** (2026-10-29) is derived on
any ASIN row where `qty_received_amazon` is known and ≠ `qty_shipped_fba`
(over or under). It is **display-only**: Received by Amazon is never a
source of truth — Shipped FBA is the number of record — so it does not
block auto-close (`PO_CLOSE_ACTION_ITEMS_SQL` leaves it out), and nothing
(quantities, matching, the On Order pipeline) derives from received.
**Extra units shipped** (Maria 2026-10-29) is derived on any ASIN row whose
`qty_shipped_fba` is over `qty` (Ordered) — from Sync Shipments or a
confirmed manual link — as a **red** chip so it stands out. It blocks
auto-close and clears by itself when the row reconciles. Clearing it by
hand needs a note (`POST /api/pos/asin-rows/:id/extra-units/clear`): the note
is stored on the row (`extra_units_note`, migration 073, shown on the chip's
hover), logged in PO History (`extra_units_cleared`), and the shipped value
at that moment is kept, so the item returns only if more units ship past
it. The Unmatched shipments link (candidate button or picker) refuses a link
that would put Shipped FBA past Ordered (`409`, code `overshoot`) until it
is confirmed with a note; the note goes on the row and into History
(`extra_units_shipped`). Dismissing unmatched lines takes an optional note
(`shipment_unmatched.dismiss_note`), shown in the Dismissed list.
Rendered as tinted chips in the (renamed) **Action Items** column with an
inline multi-select editor on the POs table and on PO Details; the list
filter is any-of over them (`action=`), beside the Open/Closed filter.
Removed from PO level: Canceled, Returned, Received, Ordered — quantities
on the ASINs/Products tables now; "Ordered" is implied by the open-order
icon. `PATCH /api/pos/:id/action-items` validates against the list and
re-runs the auto-close rule.

**§6.4 one-time value migration** (`script/migrate-po-status.ts`,
dry-run by default, `--live` writes, idempotent, STOPs on an unmapped
value): action-item strings → `action_items`; "Closed" → `closed_at =
updated_at`, `closed_by = 'sheet'` (decision 3); "Canceled" →
`qty_canceled = qty_ordered` on the PO's lines; "Received" and "Received
Partial" (decision 2) and "Returned" → nothing, counted; "Ordered" →
nothing. Local run 2026-10-16: 773 POs — 679 Closed, 49 Ordered, 34 SHIP,
24 Canceled, 10 See Comments, 8 Missing / Damaged, 5 ATTN: Velocity,
4 Received Partial, 4 Received, 3 Received - FBM, 3 Returned, 2 Confirm
Refund — no unmapped; wrote `action_items` on 56 POs, closed 679, set
`qty_canceled` on 38 lines; left 8 Received/Partial and 3 Returned POs
untouched. Production runs the same script after the deploy.

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

The importer is a frozen one-off as of 2026-10-16 (it ran once, 773 POs);
its assembly is ported verbatim into the sync below, which is the live
path. Do not extend the script.

### Sync from the Orders sheet (`server/po-sheet-sync.ts`, 2026-10-16)

> **Intake-only since 2026-10-18** (§22 "AF owns POs"): Sync POs inserts
> every sheet PO not in AF and not tombstoned — the Insert, Canceled-POs
> (new-PO half), history and fail-closed rules below still apply to that
> insert — and **never writes an existing PO**. The Update, Deletes and
> auto-close-interaction bullets below describe the sheet-wins era and no
> longer run; the drift they would have applied is counted
> (`counts.sheetDiffers`, listed with kind `drift`) and reported in the
> toast as "M existing differ from the sheet (AF owns them — not applied)".

`syncPoSheet({ sheetId, dryRun })` — called by `POST /api/sheets/sync`
(the ASINs-page **Sync POs** button) ahead of the per-ASIN COGS sync
(§11 `runSheetsSync`); the two run sequentially and the toast reports
both. If the PO sync throws, the per-ASIN sync still runs and the result
carries `poSync.error`. Inline, never a job (rule C). `?dryRun=true`
returns the plan with nothing written.

- **Scope:** the whole Orders sheet (`Sheet1!A1:AZ1` + `A2:AZ`), 2026
  rows only (the importer's classifier); never the ASINs-page selection.
  Match key = the importer's `(supplier, order_id)`; `po_asins` by
  `(po, asin)`; lines by `(po_asin, position)`.
- **Insert:** a PO not in AF is inserted exactly as the importer did
  (`source = 'sheet_import'`, Amazon SKU from `asins.primary_sku` at
  insert time, `item_discount = 0`).
- **Col P (2026-10-29):** every live run also replaces
  `po_sheet_fba_shipments` (per supplier, order, ASIN, row position, FBA
  id, qty) from Col P in one multi-row insert (column arrays through
  `unnest`) — a shipment-matching signal for §26 component A,
  read even for POs it does not insert. Col M (supplier-received, product
  units) is still stored on the line at insert but is no longer shown:
  the POs list and PO Details dropped "Units Received" (it was never
  maintained and means nothing on a Velocity-shipped PO).
- **Update (sheet wins):** every header field the importer reads, every
  line field (product, supplier SKU, price, Col L ordered, Col M received,
  Col R returned, Col N ASIN qty, Col T yield, Col X/Y costs, prep,
  sold_as / units_per_pack, loss qty/amount, Col S → `po_asins.unique_products`;
  a blank Col AX on a 2026 row is NULL — not filled in, never read as
  individual (2026-10-29); pre-2026 rows keep the history reading),
  and the Status cell **per row** (row-level Status, 2026-10-17 — it used
  to read the first row of each PO only): each row's action items → that
  line's `action_items` (full replace); a row's Canceled → that line's
  `qty_canceled = qty_ordered`, otherwise NULL; a row saying Returned with
  a blank Col R leaves `qty_returned` as stored (counted `returnedNoQty`);
  the PO is Closed only when **every** row's Status contains Closed →
  `closed_at` (kept if already closed, else now()) and `closed_by =
  'sheet'`; otherwise `closed_at` / `closed_by` NULL **regardless of a
  previous 'auto' or user close**. `purchase_orders.action_items` is not
  written.
  `po_asins.qty` is recomputed from Col N. Unchanged POs are not touched
  (`updated_at` moves only on a real change).
- **Canceled POs (Maria, 2026-10-16):** the VA zeroes Col L / Col N on a
  canceled order. A PO already in AF keeps its stored ordered quantities
  (`qty_ordered`, `qty`) and gets `qty_canceled = qty_ordered`; counted
  `canceledKeptOrderedQty`. A new PO that arrives already zeroed is
  inserted as-is (0 / 0) and counted `canceledNoOrderedQty`.
- **Deletes, only on a complete read (§3.7):** a line past the sheet's
  line count for its ASIN is deleted; a `po_asins` row whose (PO, ASIN)
  left the sheet is deleted (its lines first — the line FK is SET NULL)
  **only if it has no `po_asin_shipments` rows**, otherwise kept and
  reported `keptWithShipments`. A PO missing from the sheet is **never**
  deleted — reported "in AF, not in sheet" (a re-keyed sheet row, e.g.
  `…_1`, inserts under the new key and leaves the old row for a manual
  delete).
- **AF-owned, never written:** `po_asins.qty_shipped_supplier`,
  `qty_at_prep`, `qty_at_warehouse`, `qty_lost_damaged_us`,
  `qty_shipped_fba`, `qty_received_amazon`, `po_asin_shipments`,
  `po_asins.notes`, `po_asins.sku` after insert, `po_line_items.notes`,
  `item_discount` — anything the sheet does not carry.
- **Fail-closed:** a header mismatch, an empty read, a mixed-Col-S PO or
  an **unmapped Status token** writes nothing; the result carries `stop`.
  "Shipped FBA" maps to nothing (a state word AF tracks as
  `qty_shipped_fba`); any other new token stops the sync until the map
  learns it.
- **Auto-close interaction (accepted temporary state):** the auto-close
  rule still runs on quantity / shipment / action-item edits; the next
  sync overwrites its result with the sheet's Closed state (and reopens an
  auto-closed PO the sheet does not call Closed).
- **Report (§3.9):** counts — sheet POs, inserted, updated, unchanged,
  lines deleted, `po_asins` deleted, kept with shipments, canceled kept,
  canceled 0/0 new, in AF not in sheet, unmapped tokens, mixed Col S —
  plus 10 sample diffs of changed existing POs and the full diff list.
  The dry run and the live run return the same shape; the dev-server log
  prints the counts under `[sheets]`.

### PO history: pre-2026 POs (patch `docs/claude_spec-patch-po-history-import.md`, 2026-10-18)

Profiling report `docs/po-history-import-profile-2026-10-18.md`. Sync POs
no longer filters by year: every sheet row is considered and existing POs
are skipped as before. A PO dated before 2026-01-01 is inserted through the
same path with these history rules (Maria 2026-10-18):

- **Closed** at its order date with `closed_by = 'import'` — shown as
  "Imported (history)"; the sheet's row Status never reopens it. No
  shipment rows; On Order already ignores POs before the reconciliation
  start.
- **Prep NULL** (not recorded): Col AS did not exist before 2026, so a
  blank is never read as $0.
- **Pack size**: Col AX / AY did not exist either. A single-product ASIN
  whose yield is 1/n (0.5, 0.33, 0.25…) becomes an n-pack (`multi-pack`,
  units/pack n); everything else individual ×1. First import: 287 n-packs,
  1,935 individual.
- Action items are imported as recorded (48 history POs carry some).

Status map additions, all years: **"Lost / Damaged by Us"** →
`po_asins.qty_lost_damaged_us` = Σ Col V × yield over the rows carrying the
token (written only when a row carries it, never cleared); **"Partial
Return"** → treated as Returned (qty from Col R where present).

**Bad cells skip one PO, never the read:** an unparseable cell (percent
"%", int "5, 1", money) or an ASIN cell that is not one ASIN ("Shipping
Supplies", "NA", two ASINs in one cell, "B01CY3N2AU_Do Not Use for COGS";
before 2026 any non-ASIN value, for 2026 rows only values longer than 10)
skips that PO, listed with its sheet row and reason (`skippedBadCells`).
Rows without an ASIN and rows with a blank Order ID are listed
(`skippedRows`). Once the cell is fixed in the sheet, a normal Sync POs
inserts the PO. A cashback-% cell holding only "%" means no cashback
(site and percent NULL), not a bad cell. First import (local,
2026-10-18): 1,369 history POs inserted, 22 POs skipped for a bad cell,
135 rows skipped — all listed in `docs/po-history-skips-2026-10-18.csv`
(supplier, order_id, sheet row, column, cell value, reason).

**Cost evidence for the AF-owned switch (§3):** for the 751 catalog ASINs
whose actual COGS came only from pre-2026 sheet rows, all now have an AF PO
ASIN row and the sheet reader's cost equals the cost/unit on that ASIN's
newest non-canceled AF row: **751 / 751, 0 mismatches**. B000GGJCOI: shop.thriftywhite.com 911520, 2025-12-28,
$5.86.

**Velocity order 10507736 = AF PO `10548557_10507736`** (leadersrpmshop.com,
2026-06-21): the real order ID is 10548557; Velocity holds the typo
10507736 and cannot be edited after shipping. The AF PO was renamed in
place (migration 060; same ids and shipment rows), the sheet row reads
`10548557_10507736`, and its two shipment rows are pinned
`assigned_by = 'manual'` with Velocity Order # 10507736, so the 2025 order
10507736 (imported as its own PO) never captures them.

**Manual shipment assignments** (`po_asin_shipments.assigned_by`,
`velocity_order_number`, migration 060 — pulled forward from the
AF-owned patch §5.2): Sync Shipments resolves a Velocity line through a
manual pin (Velocity shipment + Velocity Order # + ASIN) before anything
else — the row keeps its PO ASIN row and only its quantities refresh; At
Prep follows the pin (`linesPinned`).

### Shipment reconciliation (`server/shipment-sync-velocity.ts`, `server/shipment-sync-sc.ts`, 2026-10-17)

**Sync Shipments** (POs page, D3): a direct call (`POST
/api/pos/sync-shipments`, `?dryRun=true` for the plan) that runs component
A then component B and re-runs the auto-close rule for every touched PO.
Velocity + SP-API inbound reads are not refresh work, so there is no lane
(rule C); an hourly pass is a scheduler-rework item. Both outcomes come
back in one toast; if A fails, B still runs against what is stored.

**Facts the design rests on (probe 2026-10-17, `docs/phase2-probe-2026-10-17.md`):**
Velocity outbound = `GET /shipments` + `GET /shipments/:id`, every
shipment retained (terminal status `shipped`), no date filter, **`offset`
is a page index** (docs-wrong; fixed in `listInboundOrders({ page })`,
D5); each line carries its own Order # equal to `purchase_orders.order_id`
and its retailer equal to the supplier; `quantity_shipped` and every other
Velocity quantity are **individual units**; the public API has **no Amazon
FBA shipment id** (the dashboard reads a session-only admin endpoint). SC
Fulfillment Inbound **v0** is the working source (`getShipments` /
`getShipmentItems`, 837 shipments back to 2024-09-04), in **sellable
packs** — AF's unit. v2024-03-20 is not empty (corrected 2026-10-29): the
2026-10-17 probe saw only `listInboundPlans`' ACTIVE list (abandoned
drafts); `status=SHIPPED` returns 212 plans back to 2024-09-04, and
`getShipment` / `listTransportationOptions` / `listShipmentBoxes` return
carrier, quote cost and box weights for closed shipments. One Velocity
shipment fans out to N SC shipments named `FBA STA (MM/DD/YYYY HH:MM)-<FC>`,
ship-from Velocity Prep, the name timestamp in **UTC** a few minutes
before Velocity's `shipped_at`.

**Component A — Velocity → `po_asin_shipments`, `qty_at_prep`, `shipment_unmatched` (§3):**
- Lists every shipment (coverage tripwire), fetches the detail for new /
  changed ones (the rest replay from `velocity_shipments.raw`), pulls
  `/inbound` + `/inventory`.
- Each line resolves to a `po_asins` row: exact (Order #, retailer, ASIN)
  (retailer case-insensitive) → (Order #, ASIN) alone when unique in AF
  (retailer spelling drift, counted `linesMatchedOrderOnly`) → a
  picker-resolved `shipment_unmatched` row. A bundle parent (no Order #)
  borrows its children's order numbers from the list legs or
  `velocity_bundle_identity`; several child orders → `no_order`.
- Row = `qty_shipped = quantity_shipped ÷ po_asins.units_per_pack`,
  rounded to 2 dp (fractions legal — Equal Exchange 60 ÷ 6 = 10),
  `shipped_at` = the Eastern date, `source = 'velocity'`; lines sharing
  one (ASIN row, Velocity shipment) sum.
- **Pack size (2026-10-29).** The divisor is always AF's
  `units_per_pack`, and nothing is capped at Ordered. Velocity's own pack
  size for the row (individual → 1, multi-pack → its `units_per_pack`;
  bundles not compared), from every line that resolves to it — shipment
  lines and the `/inbound` + `/inventory` legs — is stored in
  `po_asins.velocity_units_per_pack` (migration 070). A row whose
  `sold_as` is NULL (blank Col AX, §22 intake) takes `sold_as` /
  `units_per_pack` from Velocity before any ÷ when all its Velocity lines
  agree, logged in `po_edit_log` with user NULL; otherwise it stays NULL.
  Origin: 33 lines on 25 POs imported individual ×1 from a blank Col AX
  while Velocity had them as multi-packs — Velocity's component units ÷ 1
  linked e.g. 46 "shipped" against 24 ordered (PO 126768935, Anchor
  Hocking 2-pack).
- **Col P (2026-10-29).** Sync POs reads the Orders sheet's Col P (FBA
  Shipment ID, "FBA19H4BCJP4 (4), FBA19H4BK2W6 (4)"; `[ ]` notes stripped,
  ids inside them ignored; bare id → qty NULL) into
  `po_sheet_fba_shipments` (migration 071), a full replace on every live
  run — a matching signal, not PO data, so intake-only still holds. A line
  that would be `no_order` whose Velocity shipment's `sc_shipment_ids`
  meet Col P for exactly one PO ASIN row of the same ASIN is placed there
  (`linesMatchedColP`); several rows → stays `no_order` with
  `shipment_unmatched.candidates` (jsonb), shown as one-click links in the
  picker (`linesColPAmbiguous`). Origin: PO 126768935 Heath 3-pack, a
  Velocity order with no Order # shipped in six FBA shipments (72
  component units = 24 packs). Extended to `po_not_found` lines by the PO
  matching patch below, with a units-fit test.
- **PO matching (2026-10-29, `docs/claude_spec-patch-po-matching.md`).**
  Past the two legacy keys, in order. *Main pass:* the Velocity retailer
  through `supplier_aliases` (migration 072; lowercased retailer → AF
  supplier, source `seed` | `manual`; a blank retailer matches any
  supplier) on the exact key (`alias`); the **normalized** order #
  (`server/order-number.ts`: a free-text prefix such as "Confirmation #"
  dropped, uppercase, `[A-Z0-9]` only; each id of a two-id AF order_id)
  + ASIN, exactly one row (`normalized`); Col P for a no-Order # line.
  *Units pass*, once every other placement is known, oldest Velocity
  order first, one decision per Velocity order (split shipments sum):
  Col P for a line whose Order # AF lacks — the row must also **fit** the
  units (ASIN qty × pack − units already placed ≥ the line's units); the
  **base** order # (without `_N` / `-N`, 1–2 digits) + ASIN, exactly one
  row that fits (`base_id`); the **candidate rule** — same ASIN, supplier
  via alias (any when blank, none when unresolved), PO date within ±30
  days of the Velocity order date (`line.date`), units fit; ranked by
  |Δdays| then the tightest fit; exactly one → linked (`candidate`).
  **Nothing is ever placed past Ordered by these rules** (the production
  dry run caught Col P alone placing CAR118805142_1 at 10 of 5). Every
  units-pass link is recorded like a picker link
  (`shipment_unmatched.resolved_po_asin_id`, `match_reason` col_p /
  base_id / candidate_unique) plus one `po_edit_log` row (entity
  `shipment`, field `link`, user NULL), so later runs keep it.
- Not resolvable → `shipment_unmatched` (`no_order` | `po_not_found`), one
  row per line, updated on re-sync, with its ranked `candidates` (Col P
  rows, or the candidate rule's top 5 with Δdays and units left) or a
  `nearest_miss` sentence (the order # is in AF without this ASIN / no AF
  PO has the ASIN / the retailer is not mapped / only other suppliers /
  nearest PO N days away / PO X has R units left / base PO fully shipped
  / the Col P row has no room); stamped `resolved_at` (with `match_reason`)
  when it later resolves by rule or through the picker
  (`resolved_po_asin_id` is honoured by every later run).
- **One-time backfill** (`npm run backfill:shipment-matching`, dry run by
  default): proposes alias seeds, dry-runs component A with them in
  memory, reports every link and every line left; `--live` writes the
  seeds, then A, B, A (pack size / At Prep for the new links), and
  auto-close. Production 2026-10-29: 5 seeds (Carters, Monin, the Tetley /
  WorldPantry string, Walmart, Webstraunt Store); 53 lines linked (50 Col
  P, 1 normalized, 2 candidate); the panel 62 → 9; walmart.com
  200015597445090 auto-closed.
- `qty_at_prep` (D6): one live line per Velocity order (inbound >
  inventory > newest shipment), Σ `quantity_remaining` ÷ units_per_pack
  per ASIN row; 0 once fully shipped; NULL when no Velocity line
  references the key.
- One transaction; dry run writes nothing; a Velocity read error aborts
  before BEGIN. Never writes `fba_shipment_ids`, `sc_match`, `qty_received`.

**Component B — Seller Central → FBA ids + Received by Amazon (§4):**
- v0 `getShipments` from the earliest Velocity shipment − 1 day (all
  statuses), ship-from Velocity only, cached in `sc_inbound_shipments`;
  per-SKU items (`SellerSKU`, FNSKU, `QuantityShipped`, `QuantityReceived`)
  in `sc_inbound_items`, refetched only for non-terminal or changed
  shipments (§4.5; rate table `fbaInbound.*` 2 req/s, burst 30).
- Match (§4.2, D4): SC shipments grouped by the STA name timestamp
  (CANCELLED / DELETED excluded); a Velocity shipment takes the unclaimed
  group closest to its `shipped_at` within **15 minutes** (the probe's
  Δ 2–8 min; not "same minute in ET" as the patch first said); fallback =
  same UTC day + best SKU-set overlap; an exact tie → `ambiguous`
  (Unmatched panel); none → `unmatched`. Written on
  `velocity_shipments.sc_shipment_ids` / `sc_match` and on every row of
  the shipment (`fba_shipment_ids`, `sc_match`). When Velocity exposes its
  `confirmed-shipments` endpoint under the API key, it fills
  `sc_shipment_ids` directly and this match becomes the fallback.
- Received (§4.3, D2): Σ `QuantityReceived` per SellerSKU over the group →
  per ASIN through the Velocity lines' `amazon_sku` (asin_skus /
  primary_sku as fallback) → allocated **oldest PO first** across the rows
  sharing that ASIN in the Velocity shipment: each row fills up to its
  `qty_shipped`, the last (newest) row takes the remainder, so the total
  written **equals SC's number — never capped** (Maria 2026-10-17); an
  over-receipt reads "received 11 of 10" in the chip and is counted in
  the toast ("over-received N"). The one estimate in the design: units
  are mixed in the shipment, so which PO is short or over is not knowable.
  0 when matched but not yet received, NULL while unmatched. The rollup
  trigger fills `qty_received_amazon`; the auto-close rule reads Shipped
  FBA only. Received is information only (Maria 2026-10-29): a difference
  shows as the derived **Receiving mismatch** item and is never corrected
  into any quantity.
- SC `QuantityShipped` is never compared or flagged (§4.4): Velocity says
  what left the warehouse, SC what Amazon received; the gap is read off
  the two columns. No review queue beyond the Unmatched panel.

**UI (§5):** the Shipment IDs chip lists `fba_shipment_ids` per row
grouped by Velocity ship date ("FBA19T81WC… (5)"); a Velocity row whose
`sc_match` is not `matched` shows "Velocity <date> · SC <state>" with a
warning glyph; "received 7 of 10" per row; manual rows (home-shipped POs:
`manual:<uuid>`, FBA ids typed as a list) are removable, Velocity rows are
not (the next sync would recreate them). **Unmatched panel** (badge count,
hidden when empty): only `no_order` / `po_not_found` lines no rule could
place, and the exact-tie `ambiguous` case. Nothing else lands there by
design (Maria 2026-10-17: the point of the patch is to remove manual
reconciliation). PO matching (2026-10-29): each line shows its ranked
candidates as one-click "Link to <order #>" buttons (Col P, or "Δd · N
left"), else its nearest miss; the free-text "Link to PO ASIN" picker
stays as override; an unmapped Velocity retailer gets "Map → supplier"
(`POST /api/supplier-aliases`, source `manual`); ticked lines → "Dismiss
selected (N)" (`dismissed_at`; hidden, listed under "Dismissed (N)",
never deleted). The badge and the POs page count only visible lines.

**Backfill (§6), local 2026-10-17:** 57 Velocity shipments, 822 lines →
752 placed (19 order-only), 11 `no_order`, 59 `po_not_found` (PrepBusiness
-era `INSH-…` orders, re-keyed `…_1` POs, free-text order numbers);
`qty_at_prep` on 723 ASIN rows; SC: 272 shipments listed, 249 ship-from
Velocity, 3,542 item rows; 57 of 57 Velocity shipments matched (56 by
minute, 1 by overlap), 0 ambiguous; 752 rows got FBA ids + received (13
over-received, stored as reported); 14 POs auto-closed. Shipments before Velocity's API history are not
reconstructed (those POs are Closed from the sheet).

### UI rules

- Route `/purchase-orders`: list (25/page, `order_date DESC`) → expanded view
  (three tabs: PO Details · ASINs · Products). Read-only in the frame; **+
  New PO renders disabled** until the entry form ships. The Upload to
  Velocity toolbar action (§11) is unchanged and stays on this page.
- **Sort and resize (PO table v2, 2026-10-29):** Status, Action Items
  (open-item count), PO Date, Order ID, Supplier, Order Total, ASINs and
  Units Ordered sort by a header click — one key at a time, asc → desc →
  off (off = PO Date newest first), with a caret; `GET /api/pos` takes
  `sort` / `dir` over a whitelist (`PO_SORT_KEYS`) and always ends on
  `p.id`, and a sort change returns to page 1. Invoice and Notes do not
  sort. Every list column resizes by dragging its header edge, through
  the ASINs table's shared hook (`useColumnWidths` + `ResizeHandle`,
  `client/src/hooks/use-column-widths.tsx`) under the key
  `af-po-col-widths`; **Reset widths** appears once a width is stored.
  Action Items defaults to 160 px. Widths are per browser (localStorage),
  the same as the Buy List; both move into a user-scoped table with the
  queued Buy-List-to-DB patch.
- Search spans order_id, ASIN, and product name in one box. Supplier and
  Action Items filters are **searchable multi-selects** (OR within a facet,
  AND across facets), beside the Open / Closed / All select (default Open).
  Column 1 is the Open/Closed toggle, column 2 the expand chevron, then
  **Action Items** as tinted chips — SHIP indigo, Received - FBM green,
  Need to Return orange, the attention items amber. Tinted text/chip only
  — never saturated badge fills (§7). (Until 2026-10-16 this column was the
  sheet's free-text status, imported verbatim; see "Action Items".)
- **SKU labels are never ambiguous:** column headers read **"Amazon SKU"**
  (ours, ASIN-level; amber "No SKU — create offer first" warning when NULL)
  and **"Supplier SKU / UPC"** (theirs, product-level). Component rows under
  an expander show a muted dash for Amazon SKU.
- **All money renders neutral** — no red/green on any money field (Discount
  and Refund included). `$0.00` renders muted. NULL money renders a muted
  em-dash, never `$0.00` — including rollups over all-NULL sets (a canceled
  order's COGS Total is unknown, not zero). Amber is reserved for warnings.
- Invoice file name renders in the Meta card with a copy icon.

### AF owns POs (patch `docs/claude_spec-patch-po-af-owned.md`, 2026-10-18)

AF is the system of record for every PO once it exists; the Orders sheet
only supplies new POs (Sync POs' intake, above) until the AI-prefill intake
replaces it. Migration 061 adds `po_edit_log`, `deleted_pos` and
`purchase_orders.entry_seq`.

- **"Newest" PO** everywhere = `order_date DESC, entry_seq DESC NULLS
  LAST, created_at DESC` (`NEWEST_PO_ORDER`). `entry_seq` for an imported
  PO = its first sheet row counted from the bottom (the sheet runs
  newest-first, so a higher row is newer — staples.com 9929903576 → 1005,
  9929903025 → 999, both 2025-05-01); for an AF-created PO = creation time
  in ms. Backfilled by `script/backfill-po-entry-seq.ts` (dry by default,
  `--live`, idempotent); set by the intake on insert.
- **Readers** of PO data use the AF tables (§11 banner).
- **Editing (§3 of the patch).** PO detail: "Edit PO" drawer — supplier,
  order # (warning: "order # is how shipments are matched from Velocity;
  changing it re-matches on the next Sync Shipments"; `_1`-style suffixes
  are intentional), order date, subtotal, tax, S&H + donations, discount,
  refund, order total, payment method, weighted GC %, cashback site / %,
  promo, purchased by, notes; (supplier, order #) stays unique (409).
  Products tab: inline name, supplier SKU, price, qty ordered / received /
  canceled / returned (≤ ordered), yield, notes, ASIN re-map, Add product,
  remove. ASIN rows (detail tab and the POs page's nested rows): sold as,
  units / pack (1 for individual), cost / unit, prep inline, plus the
  existing manual quantities, action items and Cancel ASIN. Derived values
  (Ordered, Individual Units, Canceled / Returned at ASIN level, Shipped
  FBA, Received by Amazon, At Prep) stay read-only; Ordered is recomputed
  from the lines (Σ qty × yield; a bundle's sets = its scarcest component)
  when a line's qty, yield or ASIN changes. An ASIN row is created from the
  catalog when a line maps to a new ASIN and removed with its last line.
  Routes: `PATCH /api/pos/:id`, `POST /api/pos/:id/lines`, `PATCH|DELETE
  /api/pos/lines/:id`, `PATCH /api/pos/asin-rows/:id`; one transaction each.
- **Edit log.** Every writer — the routes above, action items, Cancel ASIN,
  the Closed toggle, the manual quantities, manual shipments, New PO,
  Cancel / Delete PO, Reassign — writes one `po_edit_log` row per changed
  field (`entity` po / line / asin / shipment, old → new as text, the
  user). History tab on PO detail (`GET /api/pos/:id/history`). Every edit
  re-runs the auto-close rule for its PO.
- **New PO form — Capture PO patch (`docs/claude_spec-patch-po-ai-prefill.md`
  §6, 2026-10-31).** Also reachable as a page, `/pos/new` (`?prefill=<id>`
  opens it filled from a capture, §4.5). Order fields: supplier, order #,
  date, **Purchased by** (a user; the logged-in one by default; `GET
  /api/pos/purchasers`), Ships to, **Email used** (settings `po_emails`
  suggested), subtotal, **Discount, Tax, Shipping** (separate), order
  total, weighted GC %, cashback site / % / **status**, **Subscription**
  (yes · every N weeks), PO notes. **Lines as bought** (§6.3): product
  name, retailer SKU, price, qty, **retailer units / pack**, per-line
  notes; the ASIN row beneath each — **ASIN qty = qty × retailer units ÷
  ASIN units per pack**, shown as the math and editable (typing it pins the
  yield; "reset" returns to the math); a bundle = several lines → one
  ASIN; a split = "Add ASIN to this line" (the same line again with its own
  qty / ASIN). **ASIN picker** (§6.4, `GET /api/pos/asin-suggest`,
  `server/asin-suggest.ts`): before typing, ASINs on past PO lines from the
  same supplier whose product name matches (exact normalized, then token
  overlap ≥ 0.5, newest first) → AF title-word matches → the model's guess
  (amber); typing searches ASIN, title, SKU, brand. AF's title / SKU / pack
  fields win when AF knows the ASIN (stone); "Not in AF — Add to AF"
  (`POST /api/pos/add-asin`) inserts it and runs the onboarding refresh.
  **Pack override** (§6.5): changing a known ASIN's sold as / units per pack
  asks once — *This PO only* (default) or *Update ASIN in AF* (`pack_updates`
  → `applyAsinPackUpdate`, `server/asin-pack.ts`, also `POST
  /api/asins/:asin/pack`: writes `asins` with an `asin_field_log` row, moves
  every open PO's row to the new size with its lines' yields scaled so the
  units stay, recomputes Ordered and a v2 PO's costs; "Pack size mismatch"
  then shows on any open PO whose Velocity order was created with the old
  size; closed POs untouched). **ASIN rows** show Sourcing cost, COGS / unit
  (override wins), Paid cost and the **COGS adjustment** (amount + required
  reason). **Promos** (type, description, amount / %, *counts toward COGS*
  toggle — rewards off by default) and **Payments** (method, nickname, last
  4, amount, GC % for gift cards; Σ vs the order total is a warning) are
  blocks on the form. **Markers** (§6.1): amber ring = from the model,
  stone ring = from AF, none = typed; editing clears the marker; the banner
  names the supplier, pages and time, lists the prefill's warnings, and
  can show the captured text (the raw-text fallback). Save writes
  `po_payments` / `po_promos`, `email_used`, `purchased_by_user_id`,
  `cashback_status`, `subscription`, line notes, `source = extension` when
  prefilled (`manual` otherwise), then applies the chosen pack updates.
- **New PO form (§4, 2026-10-18 — the base).** "+ New PO" on the POs page. State =
  `shared/po-form.ts` `PoFormState`, a plain JSON shape (every value a
  string as typed) so the AI prefill can fill it. `checkPoForm` runs live
  and again on the server: supplier, order #, real date; (supplier, order
  #) unique; every product mapped to a 10-character ASIN (typeahead `GET
  /api/pos/asin-lookup` over `asins`), whole qty ≥ 1, yield > 0; products
  of one ASIN agree on sold as / units per pack / prep; pack math divisible
  (Σ qty × yield whole; a bundle's components give the same whole number
  of sets); live subtotal (Σ price × qty) and order total; a typed subtotal
  that differs warns. `POST /api/pos` creates PO + ASIN rows (title, primary
  SKU from the catalog) + lines, `source = 'manual'`, Open, `entry_seq` =
  now. **Cost / unit** is prefilled per ASIN from price × (order total ÷
  subtotal) × (1 − weighted GC %) — the rule that reproduces 74% of the
  imported 2026 cost / unit to the cent (the rest were adjusted by hand in
  the sheet) — and is editable per ASIN; lines carry it as
  `adjusted_product_cost`.
- **Delete / cancel (§5.1, §5.3, §5.4).** A PO, ASIN row or product with any
  `po_asin_shipments` row can be neither deleted nor canceled: "N units
  shipped to FBA in <FBA ids>. Reassign the shipment to another PO first."
  (`GET /api/pos/:id/guards`; buttons disabled with the message). Delete
  confirm names the PO, its products / ASINs and "N units still at Velocity
  for this PO" when At Prep > 0 (allowed); it writes the `deleted_pos`
  tombstone so the intake never re-imports it. Cancel PO = every product
  `qty_canceled = qty_ordered`.
- **Reassign shipment (§5.2).** "Reassign…" on a shipment in the Shipment
  IDs chip: pick another PO's row with the same ASIN (search by order #),
  units ≤ shipped; received moves pro rata until component B re-allocates.
  Both rows become `assigned_by = 'manual'` with `velocity_order_number`
  (the Velocity line identity, from the stored shipment detail), merged
  into an existing row of the same shipment on the target; logged on both
  POs; auto-close re-runs on both. Component A keeps every manual row where
  it is: one pinned row → its quantity / ship date refresh; a line split by
  hand across rows → compared, reported as `manualSplitDrift`, never
  rewritten; an auto plan landing on a manual row is skipped
  (`manualRowsKept`).
- **Cost formula** lives in one function, `shared/po-cost.ts`
  (`allocateAsinCosts`, `COST_FORMULA_VERSION`), measured by
  `shared/po-cost.test.ts` against the imported 2026 cost / unit
  (`shared/__fixtures__/po-cost-2026.json`, regenerated by
  `script/export-po-cost-fixture.ts`). v1 (price × order total ÷ subtotal ×
  (1 − GC %)) reproduced 1,166 / 1,582 (73.7 %). **v2 (2026-10-31) is the
  agreed rule for new POs, not a reproduction of the sheet** (§22 "Costs";
  the sheet's X formula varies per order, probe doc) and measures 1,019 /
  1,582 (64.4 %) — the test pins that count so a change is noticed.
- **Calculator in money fields.** Every cost / money field — New PO header
  money, product price and prep, cost / unit; the PO edit drawer's money
  fields; the price, cost / unit and prep cells — accepts an arithmetic
  expression (+ − × ÷, parentheses, decimals) and evaluates it on blur /
  Enter to the cent (`shared/money-expr.ts`, a parser, no eval). The
  expression stays as the tooltip; division by zero or an unparseable
  expression keeps the text, marks the field and leaves it editable.
- **Decimal quantities (migration 062).** Every PO quantity is
  numeric(10,2): line qty ordered / received / returned / canceled /
  final, ASIN Ordered and unreimbursed loss qty (the ASIN-level and
  shipment quantities already were). The intake keeps a quantity cell's
  decimals; the editor and the New PO form accept them (the form's pack-math
  rule still requires a whole number of ASIN units); the API returns numbers
  and the UI shows 2 places only when non-integer. The 2026 rows the integer
  columns had rounded were corrected once from the sheet
  (`script/reimport-po-fractional-qty.ts`: only where AF still held the
  rounded integer; each correction logged). Upload to Velocity keeps its
  whole-unit / pack-math rules — 2.5 packs is still an invalid_pack_math
  skip.
- **Rows with no Order ID** are skipped by the intake silently: not
  counted, not noted, in no report or toast.
- **Route order fix.** `GET /api/pos/:id` hands non-UUID ids on, so the
  fixed `/api/pos/unmatched` (the Unmatched panel — it 500'd before) and
  `/api/pos/asin-lookup` are reachable.

### Source-of-truth ownership (additions to §14)

| Field | Owner |
|---|---|
| `purchase_orders` / `po_asins` / `po_line_items` (every field) | **AF** (2026-10-18, "AF owns POs" above) — the PO module UI and the auto-close rule. The Orders sheet only inserts POs that are not in AF and not tombstoned; it never writes an existing one (drift counted, not applied) |
| `po_line_items.action_items`, `qty_canceled`; `purchase_orders.closed_at`, `closed_by` | **AF**: the ASIN / product Action Items editors, Cancel ASIN / Cancel PO / the product qty-canceled cell, the Closed toggle, the auto-close rule. The intake sets them once, on insert, from the row-level Status mapping. `closed_by = 'sheet'` remains on history only. `purchase_orders.action_items` is deprecated, written by nothing. **Since PO table v2 (2026-10-29, migration 074) the items live in `po_line_action_items`; `po_line_items.action_items` is dead too** |
| **`po_asins.qty_at_prep`** | **Shipment sync (component A)** — Σ Velocity `quantity_remaining` ÷ units_per_pack; NULL when no Velocity line references the key (D6). Overwritten every Sync Shipments; not hand-editable. |
| **`po_asins.qty_shipped_supplier`, `qty_at_warehouse`, `qty_lost_damaged_us`** | **AF-owned**: the inline quantity editor today; email tracking (§26) records tracking numbers, not quantities, so far. Never the importer, never a sync. |
| **`purchase_orders.ships_to`**, **`po_tracking`** | **AF-owned** (§26): Ships to on the PO / New PO form; set from Col AS prep by Sync POs on insert, and moved by it when Col AS prep changes on an existing PO (the §14 prep exception, 2026-10-29); tracking rows from the Gmail ingest, the Tracking tab (add, Move to PO…) and the unmatched queue. |
| **`po_asins.qty_shipped_fba`, `qty_received_amazon`** | **Trigger-maintained** from `po_asin_shipments` — Shipped FBA from Velocity rows (component A), Received by Amazon from the SC allocation (component B); manual rows add to both. |
| `po_asin_shipments` (`source = 'velocity'`), `velocity_shipments`, `sc_inbound_*` | **Shipment sync-owned**: component A writes the row and `qty_shipped` / `shipped_at`; component B writes `fba_shipment_ids`, `sc_match`, `qty_received`. Hand edits only through the Unmatched picker. A `po_asins` row with shipment rows survives leaving the sheet. |
| `po_asin_shipments` (`source = 'manual'`) | AF-owned: hand-entered rows from the Shipment IDs chip (home-shipped POs); the only rows the chip can delete. |
| `shipment_unmatched` | Component A writes and resolves; the Unmatched picker sets `resolved_po_asin_id`. |
| `po_asins.notes`, `po_asins.sku` (after insert), `po_line_items.notes`, `item_discount` | AF-owned: the sheet does not carry them; the sync never writes them |
| `settings.po_*` lookup lists | Migrations (seed/append) + entry form (layer 1) |

The PO module writes nothing outside its own tables. `asin_estimates`
(`actual_cogs`, `prep_override`) is written by `runSheetsSync`, which reads
the AF PO tables since 2026-10-18 (§11 banner).

The ASINs page's On Order / At Prep columns read
these tables live (§6 "On-order columns derived from POs", 2026-10-17) —
the first consumer of the PO module outside the POs page.

### Deferred (agreed order)

1. Entry form — **plain New PO form shipped 2026-10-18** ("AF owns POs");
   still open: managed dropdowns, bundle merge prompt, AI prefill
2. Edit — **shipped 2026-10-18**; still open: the COGS formula engine
   (recompute cost / unit and adjusted product cost from header money on
   edit; per-item discount math)
3. Invoice file upload (indicator → stored file)
4. POs-by-ASIN cross-PO view
5. Cutover — **readers repointed 2026-10-18** ("AF owns POs"); still open:
   retire the mirror once the intake moves off the sheet; POs sub-nav
6. Later: gift-card ledger, subscription alerts, Velocity bundles, %-type
   product discounts, §15 FIFO/lots, pre-2026 import
0. Cleanup migration dropping `asin_estimates.ordered_qty` (unwritten and
   unread since 2026-10-17) together with `purchase_orders.status` (D5 of
   the expand-by-ASIN patch).
7. **Phase 2 — reconciliation data feeds: SHIPPED 2026-10-17** (see
   "Shipment reconciliation" above). Still deferred from it: an hourly
   Sync Shipments pass (scheduler rework), Velocity's
   `confirmed-shipments` under the API key (Maria asked Velocity), email
   tracking-number parsing → Shipped by Supplier, a Shipments nav page.

---

## 23. Repricer tab — zero-sales view (Phase 1b)

*Shipped 2026-09-15. Phase 1b of the repricing engine: activate the Repricer
nav item with ONE read-only view. No pricing writes, no Aura, no
recommendations — those are later phases.*

### The population is "SC-ACTIVE LISTINGS", strictly

This view shows only ASINs whose listing is **ACTIVE IN SELLER CENTRAL** —
a listing carrying a **BUYABLE** offer. Deliberately NOT:

- AF's catalog status bucket (`status = 'active'` is a separate hygiene
  condition, applied on top — see below);
- `has_live_offer`, which by design means "a listing record EXISTS at SC"
  and therefore also counts Inactive/DISCOVERABLE-only listings (§18 one
  definition). Correct for the catalog icon, WRONG here.

Closed, out-of-stock, and pricing-issue listings are all excluded —
including **born-closed offers whose inventory has checked in but which
have not been reopened** (§18 born-closed): those were effectively out of
stock until reopening and do not belong on this list. There is no special
handling for recently reopened listings: the moment a listing is BUYABLE
and the other conditions hold it appears, not before.

### `has_buyable_offer` (migration 043)

- `asins.has_buyable_offer` — tri-state like `has_live_offer`
  (**NULL = never checked**, never conflated with FALSE) +
  `asins.buyable_checked_at`.
- **Written by the SAME definitive `getListingsItem` probes that own
  `has_live_offer`**, nowhere else: the Refresh job's listings component
  (16: full-scope pass phases a + b, including the all-404 discovery path) and
  the §19 verify-sweep's flag write. Definition: **TRUE ⇔ ≥1 of the ASIN's
  SKUs has `summaries[].status` containing `BUYABLE`** — and that remains
  its SOLE source.
- **Owned by the §18 A2 primitive (2026-10-09).** Both flags are written by
  that one function, in one statement, so "always written together" is now
  structural rather than a convention each call site has to remember. A1
  applies first: a shell (200, `summaries: []`) yields neither flag.
- Same single-owner and fail-closed rules as `has_live_offer`: a transient
  probe writes nothing (neither flag), and the two flags are always written
  in the same statement so they can never disagree about the same probe.
  Manual verdicts never write it.
- **No new API calls.** `summaries[].status` is already in the responses
  these paths parse (`checkSkuListingStatus`, `discoverAsinListings`,
  `probeListingState` — all request `includedData=summaries`).

### The page

Route `/repricer`, rendering the full ASINs table — the same `ResultsTable`
/ `ColumnManager` components and column semantics as the main page —
**pre-filtered on the BACKEND** (`GET /api/repricer/zero-sales`) to rows
meeting ALL of:

1. `has_buyable_offer = TRUE` (SC-Active, per above).
2. **At-FBA stock > 0**: `available_fba` from the LATEST inventory snapshot
   per ASIN. On Order (PO-derived, §6) is explicitly EXCLUDED —
   units on order are not at FBA and cannot sell.
3. **Zero sales in the SELECTED range** (2026-09-16 — was a fixed
   trailing 7 days): `SUM(sales_daily.units_sold) = 0` for order dates
   within `[from, to]` INCLUSIVE, chosen by the user on the page, on the
   same date basis `sales_daily` is keyed by (real order dates from the
   all-orders flat file — never stock diffs, §11). An ASIN with no
   `sales_daily` rows at all in the range sums to zero and qualifies.
   **Default on load: the trailing 7 calendar days inclusive of today** —
   byte-identical to the shipped fixed window, so the page reads the same
   until a range is chosen. (Note this is NOT the shared `last_7_days`
   preset, which is `[today-7, yesterday]`; the §23 default is
   `[today-6, today]`.)
4. Catalog hygiene: `status = 'active'` — parked/dead never appear here.

**Only the sales condition is range-scoped.** `has_buyable_offer = TRUE`
and latest-snapshot `available_fba > 0` are always evaluated AS-OF-NOW,
never as-of the range. The view therefore means: **"currently stocked,
currently SC-Active ASINs with zero sales during the selected period."**
The page's subtitle says exactly that, so the asymmetry is visible rather
than inferred.

**Range control: PAGE-LOCAL state.** It reuses the shared
`DateRangePicker` component for look and behavior (it is fully controlled
— no context coupling) but keeps its own state and **never reads or
mutates the global date range** other pages share. Switching to the
Repricer tab and picking a range must not change what the ASINs page's
Actuals show. This is why §23 stays out of the shared date-picker route
list (§8).

**Data-coverage guard (decision: CLAMP, 2026-09-16).** `sales_daily`
starts at a finite earliest order date. A range reaching before it would
let MISSING data masquerade as "no sales" — the one failure mode that
silently overstates the view's core claim. So the backend **clamps the
effective range to the coverage start** and returns both the requested
and the effective range; the page shows the effective range always, plus
a prominent clamp notice naming the coverage date when they differ.
Clamping (not merely warning) is deliberate: a warning would leave rows
on screen that were evaluated over days we have no data for. Every
returned row is always evaluated against a period we actually cover. If
coverage is empty entirely, the view returns no rows and says so rather
than returning everything.

Column config uses a **parameterized storage key** (`fba-repricer-column-
config`, §21 precedent) so it never clobbers the main table's saved config.
CSV export of the filtered set via the existing export pattern — it
reflects the selected range, because it exports exactly the rows on
screen. The page is **read-only**: no writers besides the
`has_buyable_offer` rider above.

### Data-as-of, and the unprobed count

Every input to this view is as fresh as the last Refresh job — hourly once
the schedule is on (§11 "Scheduled passes"), otherwise the last button
run — and stale data must be VISIBLE, never mistaken for a dead ASIN. The page shows, from the `refresh_runs` ledger plus the
data itself:

- **Sales through** — the newest ingested `sales_daily.sale_date`, plus the
  last `sales` stage run time. A gap here silently manufactures
  "zero sales". (The coverage guard above handles the other end of the
  same problem: a range starting before the earliest order date.)
- **Inventory as of** — the newest `inventory_snapshots.snapshot_at`.
- **Listings checked** — the newest `buyable_checked_at` and the count of
  in-scope ASINs still lacking one.
- **"Not yet checked: N"** — ASINs that pass every other condition but have
  `has_buyable_offer IS NULL`. They are EXCLUDED from the rows (fail-closed:
  never-probed is not evidence of BUYABLE) but counted in plain sight, so an
  unprobed ASIN is never silently invisible. N drops to 0 once a full
  listings stage has run.

### Deliberately out of scope (Phase 1b)

- Any "was in stock ≥ N days ago" condition — deferred until cloud hosting
  (the local box can't guarantee the daily snapshot history it needs).
- Days-since-last-sale column, min/max price columns, Aura API anything —
  later phases of the repricing engine.

**Qualified offer set (forward reference, 2026-10-07).** This section states
no qualified-set rules of its own — min/max are out of scope above. When the
repricing engine's min/max phases land they consume the SAME qualified offer
set defined in §18 "Price Resolution (v2)": FBA, New, landed price, **feedback
count ≥ 15**, **Amazon always excluded**, and **no low-credibility
junk-outlier filter** (removed 2026-10-05). The engine's own **lowest-offer
outlier rule** is additional and unchanged — it belongs to the min
calculation only, and §18 deliberately has no outlier rule because its anchor
is the HIGHEST qualified offer. Design detail lives in
`docs/claude_spec-patch-repricing-engine-v1.md` (v1.6) until that phase is
folded in. No repricer min/max code exists yet (verified 2026-10-07), so
there is nothing implemented to align.

---

## 24. Deployment

Written 2026-10-13 alongside the cloud pre-flight commits (health route,
Node pin, build-time packages moved to `dependencies`). Nothing here is
deployed yet; this section records the target and the contract the repo
now satisfies.

### Target

- **Render**, Hobby workspace.
- **Web service**: Standard instance, Node runtime. The server binds
  `0.0.0.0` on `process.env.PORT` (`server/index.ts`); Render assigns the
  port.
- **Database**: Render Postgres, Basic-256mb plan. The app connects over the
  **internal** URL by default, which needs no SSL.
- **Node**: `22.x`, pinned in `package.json` `engines` and matched to the
  local v22.19.0.

### Build and start

| Step | Command | Notes |
|---|---|---|
| Install | Render's default `npm install` | Every package the build imports is in `dependencies` (tsx, vite, esbuild, typescript, @vitejs/plugin-react, autoprefixer, tailwindcss, postcss, @tailwindcss/typography, the Replit runtime-error plugin), so a production-only install still builds. Verified with `npm ci --omit=dev && npm run build` in a clean copy. |
| Build | `npm run build` | `tsx script/build.ts`: Vite builds the client into `dist/public`, esbuild bundles the server into `dist/index.cjs` with `NODE_ENV` baked in as `production`. `dist/` is gitignored and never committed. |
| Start | `npm start` | `NODE_ENV=production node dist/index.cjs`. The script sets `NODE_ENV` itself; do **not** set `NODE_ENV` in the Render environment. |
| Health check | `GET /health` | Unauthenticated. `200 {"ok":true}` only when `SELECT 1 FROM asins LIMIT 1` succeeds; `503 {"ok":false}` otherwise, with the pg error written to the server log only. Registered before the SPA catch-all, which answers 200 for any unknown path and would otherwise mask a dead database. |

### Environment variables

Names and purpose only. Values live in Render's environment settings, never
in the repo. Locally the same names come from `.env` via `dotenv/config`;
dotenv never overrides a variable already set in the environment, so the
platform's values always win.

| Variable | Secret | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | pg Pool connection string (`server/db.ts`). Use the Render **internal** URL. |
| `SP_API_CLIENT_ID` | yes | LWA client id for SP-API token exchange. |
| `SP_API_CLIENT_SECRET` | yes | LWA client secret. |
| `SP_API_REFRESH_TOKEN` | yes | LWA refresh token. |
| `SP_API_SELLER_ID` | no | Seller id for Listings, restrictions, submissions and the full-scope pass. |
| `GOOGLE_CREDENTIALS_PATH` | no (points at a secret) | Path to the service-account JSON. On Render this is a **secret file** (`google-credentials.json` uploaded in the service's Secret Files) and the variable holds that file's mount path. Gates every Sheets route. |
| `GOOGLE_SHEET_ID` | no | Orders / PO tracker sheet. |
| `SOURCING_SHEET_ID` | no | Sourcing leads sheet. |
| `ER_LEADS_SHEET_ID` | no | "SAS Leads Sheet \| ER" — the second Sync Sourcing source (tab `Leads`). Unset → the ER leg is skipped with a warning. |
| `ER_LEADS_MIN_DATE` | no | ER leg date floor, `YYYY-MM-DD`; default `2026-10-20`. A fixed floor, not a high-water mark. |
| `AURA_API_KEY` | yes | Aura repricer API, HTTP Basic username. |
| `VELOCITY_API_KEY` | yes | Velocity prep-service API. |
| `VELOCITY_WAREHOUSE_ID` | no | Velocity warehouse. |
| `VELOCITY_MIN_ORDER_DATE` | no | Floor date for Velocity record creation. |
| `TZ` | no | **Required: `America/New_York`.** Every date derivation in the syncs, exports and crons uses host-local time (`ymd()`, `todayLocal()`, the sales-window bounds). Render's default is UTC, which would shift day boundaries. |
| `PORT` | no | Set by Render; the code defaults to 5000 when absent. |
| `CORS_ALLOWED_ORIGIN` | no | Optional extra allowed origin beside `chrome-extension://*`. |
| `ENABLE_CRONS` | no | `true` switches on the scheduled passes (§11 "Scheduled passes": 00:00 ET with the daily block, hourly 04–23 ET). Set it on Render **after** the scheduler patch's final commit deploys (2026-10-15); unset = no schedule, manual Refresh only. See below. |
| `SESSION_SECRET` | yes | Signs the `af.sid` session cookie (§25). **Required in production: the server refuses to start without it.** Generate with `openssl rand -hex 32`. Locally it must be in `.env` too, because `npm start` sets `NODE_ENV=production` itself; `npm run dev` falls back to a logged, insecure dev value. Add it to Render **before** the first auth commit deploys. |

`APP_PASSWORD` is gone (auth v1, 2026-10-14): `POST /api/verify-password`
was removed with it. Login is §25.

Not read by the server: `NODE_ENV` (set by `npm start`), `SP_API_MARKETPLACE_ID`
and `REPL_ID` (scripts and `vite.config.ts` only).

### Scheduled passes (`ENABLE_CRONS=true`)

The scheduler rework landed 2026-10-15 (§11 "Refresh job"): one durable
queue, one runner, one schedule with an explicit timezone, and the queue
is the lock. The three old crons and the objections to them (no in-flight
guard, host-local firing, a cron listings stage that could not onboard SC
discoveries) are gone. `ENABLE_CRONS=true` is set on Render after the
patch's final commit deploys; the first production pass is the next hourly
slot (04–23 ET) and Maria checks the jobs dialog after it. Leave it unset
locally. The runner itself is always on wherever `SP_API_SELLER_ID` is set.

### Postgres SSL

No code change is needed. The internal Render URL needs no SSL. If the
**external** URL is ever used (a local `psql`, a one-off script), enable SSL
through the driver's own switches rather than code:

- append `?sslmode=require` to `DATABASE_URL` (pg-connection-string maps it to
  `ssl: { rejectUnauthorized: false }`), or
- set `PGSSLMODE=require` in the environment (`ssl: true`, full verification;
  `PGSSLMODE=no-verify` relaxes it).

`server/db.ts` passes `DATABASE_URL` straight to `pg.Pool` and sets no `ssl`
option of its own.

### Migrations

Rewritten 2026-10-15 (patch `docs/claude_spec-patch-migration-runner.md`).
A schema change reaches Render the same way code does: on deploy.

**Rule.** On startup, before anything else touches the database, the server
applies every unapplied file in `database/migrations/` in numeric order,
each in its own transaction, and records it. Nothing is ever applied twice.
Nothing serves until the ledger matches the files on disk.

- **Runner:** `server/migrate.ts`, `runMigrations(pool)`, called first in
  `server/index.ts` — before `ensureExtensionTables`, the session store and
  `listen`. `npm run dev` and `npm start` both run it.
- **Ledger:** `schema_migrations(version, filename, applied_at, checksum)`,
  created by the runner itself if absent. `version` is the `NNN` prefix;
  the baseline is version 0. `checksum` is informational: a file that
  changed after it was applied is **logged as a warning**, never re-run.
- **Discovery:** files matching `NNN_*.sql`, sorted numerically. Gaps
  (005–007, 009) are historical. Two files with the same prefix refuse the
  whole run before anything is applied.
- **Apply loop:** `BEGIN`, the file as one statement batch, the ledger row,
  `COMMIT`. Any error → `ROLLBACK`, `migration NNN_name.sql failed: <pg
  error>`, process exit 1 **before listen**. Render's health check then
  fails the deploy and keeps the previous instance up — the same posture as
  a missing `SESSION_SECRET`.
- **A file must not carry its own `BEGIN`/`COMMIT`.** Twelve historical
  files (≤ 050) do, and never execute through the runner; a new one that
  does is refused by name. A file that must run outside a transaction
  (`CREATE INDEX CONCURRENTLY`) opts out with a first line
  `-- migrate: no-transaction`. None exist today.
- **Advisory lock** `7342001` for the whole run, so two instances starting
  at once (zero-downtime deploys overlap) cannot race. `RESET ALL` before
  the client returns to the pool, since the baseline is a `pg_dump` and
  sets session parameters.
- **Logging** under tag `migrate`: `ledger: N applied, M pending`, one line
  per file applied with elapsed ms, `schema current` when nothing is
  pending.

**First run on a database that pre-dates the runner** (ledger empty,
`asins` exists — local and Render as of 2026-10-15): the runner records the
baseline as version 0 and every file ≤ `LAST_MANUAL_MIGRATION = 50` as
applied, **executing none of them**, then applies 051 and up. 051 is
comment-only; its line in the log is the proof the runner works on that
database. Result on both: **48 applied, 0 pending** (baseline + 46 files ≤
050 + 051).

**First run on an EMPTY database** (no `asins`): the runner applies
`database/schema_baseline_2026-10-15.sql` first, records it as version 0
and files ≤ 050 as contained in it, then applies 051 and up. This is the
one-command setup for a new clone: `createdb asinflow`, set
`DATABASE_URL`, `npm run migrate`, `tsx script/create-admin.ts`.

**Why a baseline (decision B, 2026-10-15).** The original base file plus
001..050 did **not** rebuild the live schema: 002 and 016 reference
`asins.is_hazmat` and 041 references `asin_estimates.error`, none created
by any file; `asin_estimates` live has a different shape from the v1.1
file; `asin_estimates_history` and seven `asins` columns were added by
hand and never captured. The baseline is a `pg_dump --schema-only` of
local with only pg_dump's `\restrict` lines and `search_path` reset
removed; its header lists the discrepancies. Trialled in a scratch
database: 48 applied, column-level schema identical to local. The old
file lives at `database/archive/asinflow_schema_v1.1.sql` as history and
must not be run. Cut a new baseline only deliberately; forward changes are
`NNN_*.sql` files.

**Tooling.** `npm run migrate` applies and exits (Render's Shell tab, a
first local setup). `npm run migrate:status` prints applied / pending /
checksum mismatches, read-only, exit 2 when anything is pending.

**Procedure for a schema change:** add `database/migrations/0NN_*.sql`,
restart the dev server, confirm `npm run migrate:status` shows it applied,
commit. Migrations run only from committed code (CLAUDE.md). `psql -f` is
no longer part of the procedure.

### Initial data load

The first deploy did **not** build the database from migrations (done
2026-10-15, before the runner existed). It copied the local database, which
carries every migration plus the data. A fresh database no longer needs this
for schema — the runner's baseline path builds it — but this remains the
way to copy **data** between environments:

```
pg_dump --format=custom --no-owner --no-privileges asinflow > asinflow.dump
pg_restore --no-owner --no-privileges --dbname "<render external DATABASE_URL>" asinflow.dump
```

The restore goes over the **external** URL from the local machine, with SSL
per the section above. After the restore, `GET /health` on the web service
must return 200 before any sync is triggered. Later migrations reach Render
on deploy, applied by the runner before the server listens (see
"Migrations" above); nothing is run by hand there.

The restored database already carries `users` with the local admin row and
the `sessions` table (migration 049, §25), so **no bootstrap runs on
Render**. Only if the restore is skipped does `tsx script/create-admin.ts`
run there, from the service's Shell tab; it refuses when any user exists.

### Verification checklist for the first deploy

1. `GET /health` → `200 {"ok":true}`.
2. The site shows the login page; `GET /api/credentials-status` without a
   cookie → 401. Log in as the restored admin (§25); the top nav shows the
   display name.
3. `GET /api/credentials-status` with the session → `{"configured":true}`.
4. ASINs page loads with the expected catalog count (2,579 rows as of
   2026-10-13; the count is in the scorecards).
5. A **selection-scoped** Refresh on two or three ASINs completes (jobs
   dialog: status `done`, 21 components) and writes `refresh_runs` rows
   with trigger `manual` and the job's `job_id`.
6. Server log shows `runner lock 7342002 acquired` and, until the flag is
   set, `Scheduled crons disabled (ENABLE_CRONS != 'true')`; after it,
   `schedule registered (America/New_York)` with the next pass time.

---

## 25. Authentication (v1)

Implemented 2026-10-14 from `docs/claude_spec-patch-auth-v1.md` (decisions
confirmed the same day). Prerequisite for loading real data into the Render
deployment (§24): before this, every `/api` route was open to anyone who
reached the host, which does not meet Amazon's Data Protection Policy for
SP-API applications.

### Rule

**Every request to AsinFlow is either authenticated by a valid session or
answered with 401 (API) / the login page (UI). `GET /health` is the only
exception.**

### Decisions

1. **Session length:** 30 days with "Remember me"; browser-session (cookie
   expires on close) when unticked. The server-side row lives at most 30
   days either way.
2. **Lockout:** 5 consecutive failed attempts lock the account for 15
   minutes. While locked, every attempt is refused **without a bcrypt
   compare** and does not extend the lock. Success resets the counter.
   Per account, not per IP.
3. **First account:** `tsx script/create-admin.ts`, once, against an empty
   `users` table. It refuses when any user exists. No sign-up page, no
   default password anywhere.
4. **Further accounts:** Settings → Users (admin only; commit 3). No
   self-service sign-up.
5. **Roles:** `admin` and `member`. Both see the full app. The only
   role-gated surface is Settings → Users. VA restrictions are a later patch
   that builds on the `role` column and nothing else.
6. **Chrome extension:** treated as dead. Its routes (`GET /api/settings`,
   `GET /api/asins/check/:asin`, `POST /api/import-asin`) get the same auth
   as everything else; the `chrome-extension://*` CORS allowance is removed.
   The ledger shows zero `extension`-trigger runs, ever. `CORS_ALLOWED_ORIGIN`
   stays.
7. **Scope:** auth gates `/api/*`. The SPA shell is served regardless; the
   client renders the login page when `GET /api/auth/me` returns 401.

### Data model (migration `049_auth_v1.sql`)

`users` is **replaced**, not extended — the Replit-era table was never read by
the running server. Columns: `id`, `email` (unique; lowercased in code),
`display_name`, `password_hash` (bcrypt cost 12), `role` (`admin` |
`member`, default `member`), `is_active` (FALSE = disabled: cannot log in,
sessions revoked), `failed_logins`, `locked_until` (NULL = not locked),
`last_login_at`, `created_at`, `updated_at`.

`sessions` (`sid`, `sess` jsonb, `expire`, indexed on `expire`) is the
`connect-pg-simple` store shape; its own sweeper prunes expired rows.

No user-id column is added to any existing table. Ledger attribution of
syncs to users is a later concern; `refresh_runs.trigger` stays as is.

### Server (`server/auth.ts`, wired in `server/index.ts`)

Middleware order: **health → session → auth routes → `requireAuth` on
`/api` → `registerRoutes` → static.** In production `app.set("trust proxy",
1)` so `req.ip` is the client and the `secure` cookie is set behind Render's
proxy.

- **Session:** `express-session` + `connect-pg-simple` on the existing
  `pg.Pool`. Cookie `af.sid`, `httpOnly`, `sameSite=lax`, `secure` in
  production, `maxAge` 30 days only when the login carried `remember: true`.
  Secret from `SESSION_SECRET` (§24): required in production, logged dev
  fallback otherwise. **Because the production cookie is `Secure`, a local
  `npm start` over plain `http://127.0.0.1` serves the login page but can
  never keep a session** — express-session refuses to set a Secure cookie
  on a non-TLS connection. Local login checks use `npm run dev`; on Render
  TLS terminates at the proxy and `trust proxy` makes the cookie flow.
- `POST /api/auth/login` `{ email, password, remember }` → 200 `{ user: { id,
  email, displayName, role } }`, or **401 `{ error: "invalid_credentials" }`
  for unknown email, wrong password, disabled and locked alike** — the body
  never says which; the server log (tag `auth`, with email and IP, never the
  password) does. Success regenerates the session id, resets `failed_logins`
  and `locked_until`, stamps `last_login_at`.
- `POST /api/auth/logout` → destroys the session, clears the cookie, 204.
- `GET /api/auth/me` → 200 with a **fresh** read of the user, or 401. A row
  that is gone or disabled ends the session on the spot. The client calls
  this once on load.
- **`requireAuth`** → 401 `{ error: "unauthenticated" }`.
  **`requireRole('admin')`** → 403 `{ error: "forbidden" }` (used by the
  admin routes in commit 3).
- **Rate limit:** `POST /api/auth/login` is capped at 20 requests per 15
  minutes per IP (`express-rate-limit`), on top of the per-account lockout.
- **Removed:** `POST /api/verify-password` and the `APP_PASSWORD` read;
  `server/create-user.ts`; `passport`, `passport-local`, `memorystore` and
  the passport types from `package.json`; the `chrome-extension://*` CORS
  origin. `server/auth.ts` was rewritten in place (the bcrypt helpers were
  the only part worth keeping).

### Tests (`server/auth.test.ts`)

Login success / wrong password / unknown email / disabled; the 5th failure
locks and the 6th is refused without a compare and without extending the
lock; `requireAuth` 401s on `/api/asins`, `/api/settings`, `/api/refresh`;
`/health` and the SPA shell stay 200 without a session; login sets `af.sid`
with and without the 30-day `Expires`; logout revokes; a member gets 403 on
an admin route; `/me` ends the session of a disabled row; `create-admin`
refuses when a user exists and rejects a short password.

### Client (commit 2, 2026-10-14)

- **Gate.** `AuthProvider` (`client/src/contexts/auth-context.tsx`) calls
  `GET /api/auth/me` once on load. `App.tsx` renders a blank page while that
  is in flight, the login page on 401, and the app on 200. State moves
  through one pure reducer (`client/src/lib/auth.ts`): loading →
  authenticated | anonymous; authenticated → anonymous on `unauthorized` or
  `logout`.
- **401 interceptor — option A.** The client has no single fetch wrapper
  (67 raw `fetch()` sites across 15 files; `apiRequest` in `queryClient.ts`
  has zero callers), so the provider wraps `window.fetch` **once**. A 401
  from any same-origin `/api/*` response other than `/api/auth/*` dispatches
  `unauthorized`, and the login page replaces the app. Covers raw fetches,
  `fetchLongSync` and the NDJSON streams alike; installs idempotently.
- **Login page** (`login-screen.tsx`, replaced): email, password with a
  show/hide toggle, "Remember me for 30 days", submit. Every credential
  rejection shows the one line **"Email or password is incorrect."**; a 429
  from the rate limiter shows its own line. Warm stone via the theme tokens.
- **User menu.** The top nav's settings gear is per-page and absent on some
  routes, so the account control is its own menu on every route: display
  name button → email, role, **Log out** (`POST /api/auth/logout`, then
  `logout`).
- Same-origin fetches carry the cookie by default; nothing sends
  `credentials: "include"` to another origin.

### Admin: Settings → Users (commit 3, 2026-10-14)

The only way to create further accounts (decision 4); the bootstrap script
refuses once any user exists. **No delete anywhere — deactivate only.**

- **Routes** (`server/admin-users.ts`, mounted in `index.ts` after
  `requireAuth`, scoped `requireRole('admin')` on `/api/admin`; a member
  gets 403, anonymous 401):
  - `GET /api/admin/users` → `{ users: [{ id, email, displayName, role,
    isActive, lastLoginAt, createdAt }] }`. `password_hash` is never
    selected, by construction.
  - `POST /api/admin/users` `{ email, displayName, password, role }` → 201.
    400 on a bad email, blank name, password under 8, or unknown role; 409
    `email_taken` on a duplicate (pre-check plus the unique-violation
    catch).
  - `PATCH /api/admin/users/:id` `{ displayName?, role?, isActive?,
    password? }` → 200. **An admin cannot deactivate or demote their own
    account** (400 `cannot_modify_self`); a rename or password change on
    self is fine. **`isActive=false` deletes that user's `sessions` rows**
    (`sess->>'userId'`), so they are signed out everywhere at once, and
    `GET /api/auth/me` ends any session that slips through. 404 on an
    unknown id.
- **UI.** Settings dialog gains a **Users** section for admins only
  (hidden for members; the server is the real gate) with a "Manage users"
  button opening the Users dialog: table (name, email, role, active, last
  login; the signed-in admin's row is marked "you"), **Add user** (name,
  email, password, role — the password is handed over directly, nothing
  is emailed), per-row **Edit** (name, role, active toggle, reset
  password). On the admin's own row the role select and the active toggle
  are disabled with a one-line reason, matching the server rule.
- Client validation mirrors the server (`client/src/lib/admin-users-api.ts`):
  email with `@`, non-empty name, password ≥ 8. Server error codes render
  as one line each.
- Tests: `server/admin-users.test.ts` (member 403 on every admin route,
  list has no hashes, create/duplicate/validation, self-guard 400,
  deactivation revokes sessions, 404) and `client/src/lib/admin-users.test.ts`
  (validation, API mapping, admin-only gating and no-delete source checks).

### Out of scope (explicitly)

VA-restricted view and per-route permission enforcement beyond the admin
page (on hold); password reset by email (no outbound email yet); MFA;
ledger attribution of syncs to users; Chrome extension authentication
(rebuild).

## 26. PO tracking (supplier tracking numbers → Velocity)

Patch `docs/claude_spec-patch-po-tracking-velocity.md` (approved
2026-10-21). Supplier shipping emails arriving at
`orders@coastalqualitygoods.com` are read, their carrier + tracking number +
retailer order # attached to the AF PO, and pushed to the matching Velocity
inbound orders so Velocity can check POs in accurately. Tracking only
matters while the PO is in Velocity's Inbound (`unit_status` pending /
partially_received).

### Data (migration 066)

`po_tracking` — one row per `(carrier, tracking_number)` (UNIQUE): `po_id`
(NULL = unmatched), `carrier` (UPS / FEDEX / USPS / DHL / AMAZON / ONTRAC /
LASERSHIP / OTHER), `tracking_number`, `retailer_order_id` (as printed),
`supplier_guess`, `sender_domain`, `ship_to_street` (normalized "<number>
<first street word>"), `shipped_at` (email date), `items_json` ([{name,
qty}] when the email lists them per shipment), `gmail_message_id` /
`gmail_thread_id` / `email_subject`, `source` (regex | ai | manual),
`status` (unmatched | matched | pushed | push_failed | held),
`match_reason` (why unmatched), `review_reason` (why it raises "Review
Velocity"), `push_error`, `pushed_at`, `pushed_velocity_ids`,
`suppressed_at`, `reassigned_from_po_id` / `reassigned_at`.
`purchase_orders.ships_to` ('velocity' | 'home', default 'velocity').
Settings: `tracking.velocity_street` ("805 grandy"),
`tracking.home_streets` (["65 rivercrest"]),
`tracking.supplier_domain_map`, `tracking.carrier_map`,
`tracking.gmail_watermark` ({last_scanned_at}).

### Gmail ingestion (`server/gmail-client.ts`, `tracking-parse.ts`, `tracking-ingest.ts`)

- **Auth (D2):** the `asinflow-sheets` service account (the same
  `GOOGLE_CREDENTIALS_PATH` key file as the Sheets reader) with domain-wide
  delegation, a JWT with `subject = orders@coastalqualitygoods.com`
  (`GMAIL_SUBJECT` overrides), scope `gmail.readonly`. The key's
  `client_email` / `private_key` are passed explicitly — `JWT({keyFile})`
  leaves the issuer null ("invalid_grant: Invalid issuer: null").
  `npm run gmail:check` lists the 5 newest subjects (delegation verified
  2026-10-21).
- **Body:** text/plain unless it is a short preview (< 300 chars — Macy's
  plain part is one line), then plus the HTML converted to text.
- **Query:** `-category:promotions after:<watermark − 24 h>`; the
  watermark advances to the run's start; dedup absorbs the overlap.
- **Candidate** = a carrier-pattern match or shipped-type language;
  others are skipped.
- **Tracking extraction**, in this order: carrier-site URL parameters
  (`trknbr=`, `trackNums=`, `tracknum=`, …); then tokens in the text.
  UPS `1Z…`, Amazon `TBA…`, LaserShip `1LS…` count anywhere (also inside a
  URL, case-insensitive — Narvar prints `1z…`); OnTrac `C\d{14}`, USPS
  `[A-Z]{2}\d{9}US` and every all-digit number only with a tracking label
  or a carrier word in the 60 / 80 characters before it, never inside a
  URL, never after a UPC / SKU / item / phone / order / reference label,
  never equal to the email's own order #. All-digit by length: 20–22
  starting with 9 → USPS, 12 / 15 / 20 / 22 / 34 → FedEx, the nearest
  carrier word overriding. USPS IMpb `420` + ZIP prefixes are stripped.
- **Order #:** "Order #/number/no./ID" tokens, subject first (when the
  subject has exactly one it wins); a lower-case run-on after the digits is
  cut (Target: "#102003876318342are"). Several distinct → no order on the
  rows, `match_reason = unpaired`.
- **Ship-to:** the first street after a "Delivers to / Ship to / Shipping
  address / Delivery address" label, normalized.
- **Items:** "Qty: N" lines between one tracking number and the next, the
  longest name-like line among the four above (Macy's prints a full and a
  truncated name).
- **Forwards** from our own mailboxes (coastalqualitygoods.com, gmail.com)
  are attributed to the original `From:` domain.
- **Tracking links** (`server/tracking-links.ts`, Maria 2026-10-21): a
  per-domain extractor for retailers that print no number, only a link.
  **Michaels** — the "Tracking Information" link is a click tracker
  (`…michaels.com/ls/click?upn=…`) that redirects to
  `https://www.michaels.com/track?id=<tracking>&order=…&lastName=…&email=…`;
  the number is `id`. The link must start within 400 characters after the
  label (it is read whole — real ones run ~750 chars); the redirect is
  followed by `Location` headers only — HEAD with `redirect: manual`, GET
  if HEAD is refused, the body never read, ≤ 5 hops, `&amp;` unescaped —
  until the final URL matches; the carrier comes from the number's shape
  (`carrierForNumber`). It runs when the body yields no number; a real
  number replaces (deletes) that order's placeholder, and every ingest
  re-reads existing placeholders of an extractor domain
  (`resolveLinkPlaceholders`). Local run 2026-10-21: all 4 Michaels
  placeholders resolved (e.g. order 3500109099878917 → UPS
  1Z09482W0312114120) and matched.
- **Generic tracking links** (2026-10-22, any sender): for an email that
  would otherwise queue a placeholder, the candidate links are the HTML's
  anchors whose text — then whose URL — says "track" (`trackAnchors`;
  `htmlToText` drops hrefs, which is why most were invisible), then text
  URLs after a "track" label or containing "track", ≤ 6 per email. Each
  is followed the same way (Location only, body never read, ≤ 5 hops)
  until a URL in the chain carries a number the carrier-URL parser reads:
  a carrier-site parameter, a distinctive shape, or Narvar's
  `tracking.narvar.com/<store>/tracking/<carrier>?t=<number>`. The routine
  ingest re-reads placeholders shipped within 30 days;
  `npm run backfill:tracking -- --stage links [--live]` reads all.
  Production 2026-10-22: of 53 `ai_disabled` placeholders, 11 resolved
  (SupplyHouse 5, Summit Racing 2, Narvar — Dick's, Merle Norman — 2,
  King Arthur 1, LIXIL 1); 42 have no number reachable: 19 emails carry no
  track link at all (Sephora, LG, gift-card outlet, Lowe's…), the rest
  land on a retailer order page that needs a login or JavaScript (Shopify
  stores, Walgreens, Ace, Zara, Ubiquiti, Duluth's dead links).
- **No tracking in a shipped email** and no extractor: one placeholder row
  per (sender domain, order #) — carrier OTHER, `tracking_number =
  email:<domain>:<order#>`, `match_reason = ai_disabled` (until the AI
  fallback reads it); never pushed. Only a shipped-type *subject* queues
  one.
- **Return pickup / return label emails** (2026-10-22; `isReturnEmail`:
  "return" in the subject, or a specific body phrase such as "return
  pickup" — a shipped email's "free returns" footer does not count) are
  `kind = return`: their numbers are the package going back, so the rows
  are queued `unmatched` with `match_reason = return`, never matched or
  pushed, and stay visible in the unmatched queue for the cancellations
  patch to consume. Rows ingested before this
  (`npm run tracking:flag-returns [-- --dismiss <n,…>] [--live]`) leave
  their PO the same way; one already pushed is reported, not touched.
- **Dedup:** a repeat email for the same number refreshes
  `gmail_message_id` / `shipped_at` only while the row is unmatched.
- Fixtures: 17 real orders@ emails, people and numbers scrubbed
  (`server/__fixtures__/tracking-emails/`).

### Matching (`server/tracking-match.ts`) and the unmatched queue

- **Supplier** from the sender domain: `tracking.supplier_domain_map` wins;
  otherwise an obvious pair — the registrable domain is a supplier name
  (`oe.target.com` → `target.com`), or exactly one supplier shares it
  (`equalexchange.coop` ↔ `shop.equalexchange.coop`), or for a hosted
  notification platform (Narvar, Shopify email, ShipStation, ParcelPanel,
  AfterShip, Veeqo) the first label + ".com" is
  (`tractorsupply.narvar.com` → `tractorsupply.com`). A live run writes the
  obvious pairs it used into the map (the editable record, Settings).
  Unknown → `unmatched / unknown_sender`; mapping the domain once re-opens
  its rows and re-matches.
- **PO:** `supplier = guess` and `base(order_id) = retailer order #`,
  punctuation-insensitive (Walmart / JCPenney print hyphens AF does not
  store); base drops a trailing `_N` (D4); an order_id holding two ids
  ("115449859 / 115450009") matches either. 0 → `no_po` (re-tried every
  run), 1 → `matched`, >1 → `ambiguous`. The email's number is also tried
  without a trailing `-N` shipment suffix (WorldPantry `70633076-1`).
- **Platform senders** (2026-10-22; `tracking.platform_senders`, migration
  068 — registrable domains: Narvar, Shopify email, ShipStation,
  ParcelPanel, AfterShip, Veeqo, Zendesk, WorldPantry). With no map entry
  and no first-label supplier, the store is read from the **subject**
  ("your Los Poblanos order", "order with Tetley and WorldPantry.com") and
  matched by name to exactly one supplier's domain label (`lospoblanos` ↔
  `shop.lospoblanos.com`; a 5+-letter prefix: `tetley` ↔
  `shop.tetleyusa.com`) → `matched`, `match_reason = retailer_name`. Only
  the subject is read (the body is not stored). A platform domain is
  never seeded into the map.
- **Order-#-unique** (2026-10-22): when the sender resolves to **no**
  supplier, the order # is compared digits-only (also without a trailing
  `-N` / `_N`; 5+ digits) against every AF PO; exactly one → `matched`,
  `match_reason = order_id_unique`, the supplier taken from that PO; zero
  or several → still `unknown_sender`. A sender that resolves keeps its
  supplier — its `no_po` is never attached to another store's PO by number
  alone. Production 2026-10-22: of 44 `unknown_sender` rows, 28 cleared by
  this and 6 by `retailer_name`.
- **Shared with shipment sync A** (2026-10-29, PO matching patch §7): the
  order-# handling (punctuation, a free-text prefix, `_N`, a retailer's
  `-N`, two-id AF order_ids) is `server/order-number.ts`; a platform
  email's subject name resolves through `supplier_aliases` before the
  name match. Production dry run: no change to the 78-row queue.
- **Never moved by the sync:** `source = manual` or `reassigned_at` set;
  dismissed rows, `ai_disabled` placeholders and `return` rows are not
  re-matched.
- **Routes** (`server/tracking-routes.ts`, behind requireAuth): `GET
  /api/tracking/unmatched` (the queue, with reason, and per row up to 3
  `suggestions` — the guessed supplier's PO, then digits-only order # hits
  across suppliers, `suggestPos`), `POST
  /api/tracking/domain-map {domain, supplier}` (supplier must be a known PO
  supplier; null removes), `POST /api/tracking/:id/attach {po_id}` (manual —
  not for placeholders), `POST /api/tracking/:id/dismiss`.

- **Queue dialog** (POs toolbar, "Unmatched tracking (N)", 2026-10-22):
  one-click **Attach to <order #>** per suggestion, "other PO…" for a
  free-text order # override, per-row dismiss, checkboxes with **Dismiss
  selected (N)** (one dismiss call per row); fixed column widths so Reason
  no longer wraps letter by letter (the old `overflow-wrap: anywhere` on
  the dialog).

### Routing rules and "Review Velocity" (`server/tracking-route-rules.ts`)

Per matched row, on every run (the push component evaluates it — it reads
Velocity). **In Velocity** (2026-10-21, stop b) = the PO appears anywhere
in Velocity — inbound, inventory or shipments (`fetchAllKnownOrders`,
coverage tripwires: a partial read throws, nothing is evaluated). Pushes
target only inbound pending / partially_received orders, so a PO is
**inbound** (push — the "yes" rows), **known** (Velocity already received
or shipped it: no push, no warning — counted `received_by_velocity`), or
**absent** (the "no" rows: Velocity has never seen it).
A **fully-shipped bundle** counts as known (2026-10-22): the shipments leg
returns its parent with `order_number` empty and no children (PO
200015523189765 → parent `c0835a42`), so the PO's number is restored from
`velocity_bundle_identity` — the same hydration Upload to Velocity uses
(§11 Part C.2, `knownOrderNumbersHydrated`). A shipped parent with no
identity record stays absent.

| PO in Velocity | email ship-to | `ships_to` | result |
|---|---|---|---|
| yes | Velocity street | home | **`held`** + review "Home PO in Velocity; address mismatch" (hold rule) |
| yes | home street, none, unknown | home | **no push**, review "Home PO in Velocity" |
| yes | home street | velocity | **`held`** + review "address mismatch" (hold rule) |
| yes | none, or Velocity street | velocity | push |
| yes | unknown street | velocity | push + review "address mismatch" |
| no | home street, or none | home | `held`, no review (none: 2026-10-22) |
| no | Velocity street | any | review "not in Velocity" |
| no | none | velocity | review "not in Velocity" |
| no | any | velocity | review "not in Velocity" |
| no | unknown street | any | review "unknown address" |

**Ships-to gate and hold rule (Maria 2026-10-29, after 482270182 — ten
UPS numbers addressed to 65 Rivercrest were pushed to a Velocity order):**
a Home PO is **never pushed**, even when Velocity has an inbound order for
it; the order there is the mistake, so the row only raises Review Velocity.
And when the email names the **other** known address than `ships_to` — the
home street on a Velocity PO, or the Velocity street on a Home PO — the row
is **held** on the PO (`status = 'held'`, kept for re-evaluation every run)
with a review reason, never pushed. An unknown street on a Velocity PO
still pushes with "address mismatch" (the address may be a supplier's
warehouse). Production dry run before the rule shipped: 10 past pushes
(1 PO, 482270182) would have been held; 0 of the 84 rows on POs with an
inbound Velocity order that day routed differently.

A PO fully canceled or returned in AF → review "shipped but canceled",
never pushed. A failed push → `push_failed`, review = the Velocity error.
When several apply every reason is kept (`review_reason`, "; "-joined).

**"Review Velocity"** is an **auto-managed** action item. **Since PO table
v2 (2026-10-29) it is stored** in `po_line_action_items` on every product
line of the PO (`source = 'auto'`, `reason` = the open review reasons),
mirrored by `reconcileReviewVelocity` (`server/line-action-items.ts`) after
the tracking push, Move to PO (old and new PO) and the manual clear: open
while any of the PO's tracking rows has a `review_reason` and no
`suppressed_at`, re-reasoned when the reasons change, cleared
`cleared_by = 'auto'` when the condition goes away or `'manual'` after the
manual clear. The editors never offer it and drop it if echoed. Because it
is stored, the POs column, PO Details, the `action=` filter and the
auto-close rule read it like any other item — an open review keeps the PO
from auto-closing. The reasons
ride the list / detail payload as `review_velocity_reasons` (the hover).
It clears itself when the condition goes away (the next evaluation nulls
`review_reason`). **Manual clear** — `POST /api/pos/:id/review-velocity/clear`
— sets `suppressed_at` on the rows that exist at that moment only; a new
tracking row for the PO re-evaluates and may raise it again.

### Velocity push (`server/tracking-push.ts`)

Tracking-only (D1): never creates a Velocity order, never changes a
quantity, item or status; nothing but tracking numbers leaves AF.
- **Targets** for a PO = every `GET /inbound` order whose trimmed
  `order_number` (bundle parents: their children's) equals the PO's
  `order_id`, `status = inbound`, `unit_status` pending /
  partially_received. Pushed to **every** target (each Velocity order is
  one ASIN row of the PO; the receivers see the same package for all).
  A **bundle is a target like any order** — the number goes on the
  **parent** (2026-10-22, probe below).
- **Append-only, no echo (2026-10-22):** `PUT /inbound/bulk`
  `{order_ids: [<order>], tracking_numbers: [<numbers it lacks>]}`
  (`appendTrackingBulk`), one call per target order. Nothing else is sent,
  so nothing else can be rewritten. Never removes an entry. Carrier is
  auto-detected by Velocity; `tracking.carrier_map` is display only.
- **Idempotent:** every target has the number → row `pushed`, no call;
  partial coverage → only the missing orders; `pushed_velocity_ids`
  records where it is. Velocity itself drops a number the order already
  has (probe: re-sending one present number with one new one left exactly
  the two, no duplicate). An error → `push_failed`, `push_error` and the
  review reason carry the Velocity error; the other targets still get
  theirs.
- **Dry run** (`POST /api/tracking/sync {dryRun: true}`): reads Gmail and
  Velocity, writes nothing; per PO the target orders, numbers to add,
  numbers already present.
- **The single PUT** (`PUT /inbound/:order_id`) is full-replace in
  practice (it nulled an omitted `date`, 2026-07-30) despite the docs
  saying it changes only the fields sent; it needs the echo-merge and is
  no longer used for tracking. The reconcile execute route keeps its own
  echo; `buildTrackingPutBody` survives only for
  `npm run velocity:tracking-probe`. Its element shape is **plain
  strings** (probe 2026-10-21, order `be85fad3`, PO 4798028553: an object
  `{carrier, tracking_number}` is refused with HTTP 400 "unhashable type:
  'dict'").
- **Bundle probe (2026-10-22)**, throwaway order TEST-BUNDLE-001 (parent
  `fd6e328c`, ASIN B0ZZTEST01, qty 2 / 2 per pack; children `a5fb978b`
  and `c7cf3ebf`, qty 1 each, retailer TEST). Read back after each path:
  the inbound list (parent + children), `GET` of the parent and of each
  child — 101 fields compared. (c) bulk append on the parent, (a) single
  echo-merge PUT on the parent, (b) single echo-merge PUT on a child: each
  changed **only the trackings of the order it addressed** — the parent's
  for (c) and (a), that child's alone for (b); children count,
  quantities, `units_per_pack`, `bundle_order_id` links and every other
  field unchanged, no stray rows. A bundle's quantity rule: parent
  `quantity` = total component units and must divide by `units_per_pack`
  (create refused "Units per pack must be divisible by the total quantity
  ordered" for 1 / 2). `GET /inbound/:id` on a parent carries no
  `bundle_children` (only the list does). Velocity has no DELETE: the
  test order is removed by hand in the Velocity UI.
- **`tracking_status`** is null on every inbound tracking (96 of 96,
  2026-10-22, hand-entered ones included); the docs describe no values and
  no tracking-events or webhook endpoint. `GET /inbound/:id` returns
  trackings as `{tracking_number}` only; the list adds `carrier` and
  `tracking_status`.

### UI (`client/src/components/po-tracking.tsx`)

- **PO → Tracking tab:** carrier, tracking # (link to the carrier's
  page), order # as printed, shipped date, ship-to street, status chip,
  review reason (struck through once cleared), when it was pushed and to
  how many Velocity orders (ids on hover), items, "moved from <order #>",
  **Move to PO…** (by order #), **Add tracking** (carrier + number, source
  manual). A "Review Velocity" banner lists the open reasons with
  **Clear**. Routes: `GET /api/pos/:id/tracking`, `POST
  /api/pos/:id/tracking {carrier, tracking_number}`, `POST
  /api/tracking/:id/move {po_id}` — both re-run routing and the push for
  the PO they land on (§10: moving 4800667218's package onto 4798028553
  pushes it to 4798028553's Velocity orders when they are in Inbound).
  A move never removes a number already pushed to the old PO's orders
  (the push never removes entries).
- **POs toolbar:** **Sync tracking** (ingest → match → push; a "dry run"
  link opens the plan, nothing written) and **Unmatched tracking (N)**
  (hidden when empty) → the queue: reason, sender, order #, number (or "no
  number in the email" for a placeholder), subject; **Map** the sender
  domain to a supplier (for `unknown_sender`), **Attach** to a PO by order
  #, **dismiss**.
- **Ships to** (Velocity | Home): PO Details card, the Edit PO drawer
  (`HEADER_FIELDS.ships_to`), the New PO form (default Velocity).
- **Review Velocity** chip: shown after the manual items on the POs column
  and PO Details, the open reasons on hover; never offered in the
  Action Items editor.

### AI fallback (§4 D3) — not built (2026-10-21)

`ANTHROPIC_API_KEY` is not configured locally or on Render, so per the
patch the fallback is skipped (`server/tracking-ai.ts`,
`aiFallbackAvailable() = false`): a shipped-type email that neither the
regex nor a tracking-link extractor can read is queued as unmatched,
`match_reason = ai_disabled` (one placeholder per sender domain + order #;
the unmatched queue shows "no number in the email"). Building it later:
plain text → `{carrier, tracking_number, retailer_order_id, ship_to,
items[]}`, `source = 'ai'`, only for those placeholders. The 2026-10-21
local backfill dry run had 53 such rows.

### `ships_to` from prep cost (2026-10-22)

`npm run backfill:ships-to [-- --live]` (`server/ships-to-backfill.ts`)
replaces migration 066's blanket 'velocity': **prep cost only** — any ASIN
row of the PO with `po_asins.prep_cost > 0` (Maria enters $1 for Velocity)
→ `velocity`; every row 0 / NULL, or no ASIN rows → `home`. Each change
writes a `po_edit_log` row. The Velocity start date is **not a rule** —
a sanity check only: a PO dated before `tracking.velocity_start_date`
(migration 067: the first PO with prep > 0, **2026-04-07** on production,
stored once — not recomputed) that comes out `velocity` is reported as a
data error and left as computed. It is separate from
`VELOCITY_MIN_ORDER_DATE` (env, 7/30/2026), which stays the Upload to
Velocity **creation floor** (`getVelocityMinOrderDate`, both upload routes)
and the On Order reconciliation-start fallback (`envReconStart`); widening
it to 4/7 would have offered 35 extra creates (Apr 7 – Jul 28 POs Velocity
never had) and 141 skips (production, 2026-10-22), so it is not moved. The New PO form derives its
Ships to default the same way (`shipsToFromForm`: any product with prep >
0 → Velocity), editable; the server uses the rule when the form sends none.
**Sync POs intake (2026-10-29)** sets it on insert by the same rule from
Col AS (`maxSheetPrep`); it used to fall to the column default 'velocity'.
When Col AS later changes on an existing PO, Sync POs applies the prep and
ships_to follows (§14 ownership exception).
Local data 2026-10-22: prep > 0 starts in April 2026 (75 April POs), so
the local `VELOCITY_MIN_ORDER_DATE = 7/30/2026` flags 269 pre-cutoff
POs, a May 1 cutoff 75.
