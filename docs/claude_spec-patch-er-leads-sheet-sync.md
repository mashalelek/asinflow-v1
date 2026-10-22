# SPEC Patch — ER leads sheet as a second source for Sync Sourcing

*Drafted 2026-10-21 with Maria. Amends §11 (Google Sheets sourcing sheet), §14 (field ownership), the Lead Source rules (tags-regroup-and-lead-source patch).*

> **Status: APPROVED 2026-10-21** (D1–D3 answered by Maria). Pre-flight run by Claude Code 2026-10-22 (see below); implementation prompt handed over.

## Request (Maria, 2026-10-21)

Add the sheet **"SAS Leads Sheet | ER"**
(`https://docs.google.com/spreadsheets/d/12daJUqkYALr9YMCVpPS_KQupRXX6fNA_m59CYcyP0Wk/edit?gid=0`)
to **Sync Sourcing**. Import every lead that is not in AF yet, with
**Date (col B) ≥ 2026-10-20** and **Approved (col A) = Yes**. Every ASIN that
comes from this sheet gets **Lead Source = ER**.

## What the sheet looks like

Sheet title: `SAS Leads Sheet | ER`. Tab: **`Leads`** (`gid=0`; confirmed by
Claude Code pre-flight 2026-10-22 — other tabs ASINS, Maybe Later, Sheet8,
PTO, Sheet12, 2024, Storefronts are NOT read). Tab name hardcoded in the ER
client like the other two sheet clients (§11 rule: tab name hardcoded per
file so clients never cross). One header row; data starts at row 2. Dates
observed as ISO `YYYY-MM-DD`. Approved values observed: `Yes`, `No`,
`See comments`.

Pre-flight 2026-10-22: service account `asinflow-sheets@amazon-fba-463600.iam.gserviceaccount.com`
reads the sheet; row 1 has 39 cells and matches the table below exactly.

Columns (39, A–AM):

| Col | Index | Header | Use |
|---|---|---|---|
| A | 0 | Approved | filter: `.trim().toLowerCase() === "yes"` |
| B | 1 | Date | filter: parsed date ≥ floor; also the lead date |
| C | 2 | ASIN | match key, `.trim()` |
| D | 3 | Brand | ignored (Product Info owns catalog) |
| E | 4 | Product Name | ignored |
| F | 5 | *(no header — category)* | ignored |
| G | 6 | Amazon URL | ignored |
| H | 7 | Buy Link | `asins.buy_link`; supplier derived via `extractDomain` (same as Master col N) |
| I | 8 | Coupons/Gift Cards | `asins.promo_notes`, INSERT branch only (same as Master col O) |
| J | 9 | Profit | ignored (AF computes) |
| K | 10 | R.O.I. | ignored |
| L | 11 | Sales Rank (Current) | ignored |
| M | 12 | Cost Price | `asin_estimates.estimated_cogs` via `parseMoney`, `estimated_cogs_source = 'csv'`; unparseable → NULL (`cogs = 0`, Master rule). **Per-ASIN COGS as-is** — the sheet's "×2 / ×4" comments are to be ignored (Maria 2026-10-21) |
| N | 13 | Reserved for Last Purchased COGS | ignored |
| O | 14 | Buy Box (Current) | ignored |
| P | 15 | Buy Box (Average Last 90 Days) | ignored |
| Q | 16 | Sale Price | ignored |
| R | 17 | Sale Price (25% ROI) | ignored |
| S | 18 | Breakeven | ignored |
| T | 19 | Max Cost | ignored |
| U | 20 | Profit Margin | ignored |
| V | 21 | Estimated Sales | ignored |
| W | 22 | Sales Rank (Current) Top % | ignored |
| X | 23 | FBA Seller Count | ignored |
| Y | 24 | FBM Seller Count | ignored |
| Z | 25 | FBA Fee | ignored |
| AA | 26 | Referral Fee | ignored |
| AB | 27 | Referral Percent | ignored |
| AC | 28 | Inbound Shipping | ignored |
| AD | 29 | Total Fees | ignored |
| AE | 30 | Package Width (mm) | ignored (Product Info owns) |
| AF | 31 | Package Length (mm) | ignored |
| AG | 32 | Package Height (mm) | ignored |
| AH | 33 | Weight (grams) | ignored |
| AI | 34 | Cost with Shipping | ignored |
| AJ | 35 | Emelie | VA notes → `asins.notes` with `VA: ` prefix (mirrors Master col AP) |
| AK | 36 | Buyable? (Emelie) | ignored |
| AL | 37 | Loom - Maria | ignored (Loom links) |
| AM | 38 | Maria | My notes → `asins.notes` bare (mirrors Master col AS) |

Notes combination identical to the Master rule: `{AM}\nVA: {AJ}`, each line
only if non-empty, both empty → `NULL`, written on the INSERT branch.

## Behavior

1. **Second source inside Sync Sourcing.** The job reads the Master `ASINs`
   tab as today, then the ER sheet. One run, one stream, one results dialog;
   the report shows counts **per sheet** (read / filtered out / already in AF
   / inserted / failed) so an ER-side problem is visible on its own.
2. **Row filter (ER sheet only):** keep a row iff Approved is `Yes` (exact
   after trim + lowercase — `See comments` and `No` are out) **and** Date
   parses **and** Date ≥ `ER_LEADS_MIN_DATE` (`2026-10-20`). Rows with an
   unparseable or blank Date are skipped and listed in the run report (never
   silently treated as "old" or "new"). A row whose Approved later flips from
   `No` to `Yes` is picked up on the next run, as long as its Date clears the
   floor.
3. **Insert-only, same contract as the Master sheet.** ASIN already in
   `asins` (any status, incl. parked/dead/archived) → skipped, untouched. New
   ASIN → shared new-ASIN onboarding (`onboardNewAsins`: Product Info →
   prices → fees), ledgered in `refresh_runs` with trigger `sourcing`.
   Multiple rows for one ASIN collapse first-non-empty-wins, top of sheet
   canonical (Master rule).
4. **Lead Source = `ER`** on every ASIN inserted from this sheet. No col-G
   normalization, no aliases, no precedence logic — the sheet *is* the ER
   source. Existing ASINs are never relabelled.
5. **`added_at` = col B Date** (lead date), consistent with the pinned
   meaning "Date Added IS the lead date" (bulk-promote patch), not the
   sync timestamp.
6. **No archive rule.** The ER sheet has no status column; the Master
   "discontinued → `is_active = false`" rule does not apply here.
7. **Fail-closed on the read.** A thrown read of either sheet aborts that
   sheet's leg and reports it; the other sheet's leg still runs. An empty
   read of the ER sheet (0 raw rows) is reported as a warning, not treated
   as "nothing new" — a creds/share failure must be visible. Header drift
   (row 1 ≠ the 39-column table above) aborts the ER leg with the diff in
   the report — never guess a column.
8. **Config:** `ER_LEADS_SHEET_ID` env var (mirrors `SOURCING_SHEET_ID`);
   `ER_LEADS_MIN_DATE` env var, default `2026-10-20`, a **fixed floor** (not
   a moving high-water mark — older rows are already in AF from the ER
   backfill; insert-only dedup handles reruns). Missing sheet ID → the ER
   leg is skipped with a logged warning, the Master leg runs.
9. **Dry run:** `?dryRun=true` on the existing route reports what the ER
   leg *would* insert (ASIN, date, buy link, COGS, lead source) without
   writing — run once before the first live run.
10. **Scheduling:** unchanged. Sync Sourcing stays on-demand (scheduler
    v1 cadence list); the ER leg runs whenever Sync Sourcing runs.

## §14 ownership table additions

`lead_source` gains a second INSERT-path writer (ER sheet leg) alongside
the Master leg, uploads and inline edit. `promo_notes` / `notes` /
`buy_link` / `estimated_cogs` get the ER leg as a writer on the INSERT
branch only — same asymmetric pattern as the Master leg.

## Decisions (answered 2026-10-21)

- **D1 — Job:** Sync Sourcing.
- **D2 — Est. COGS:** col M Cost Price, taken as per-ASIN COGS as-is.
- **D3 — Date floor:** fixed at 2026-10-20.

## Maria's actions (done 2026-10-21)

- Sheet shared with the `asinflow-sheets` service account.
- `ER_LEADS_SHEET_ID=12daJUqkYALr9YMCVpPS_KQupRXX6fNA_m59CYcyP0Wk` added to
  local `.env` and the Render service `asinflow-cqg`.
