# SPEC Patch — Orders-sheet retirement

*Drafted 2026-11-12 with Maria. Amends SPEC §11 (Aura, SB export, PO
mirror), §14 (ownership), §22 (PO intake), §26. The Orders sheet stopped
being a PO record on 2026-10-23 (last PO entered there); Capture PO and
the AF form are the two intakes. This patch removes every remaining AF
read of the sheet, one at a time, each with its AF-side replacement
proven first.*

> **Status: DONE 2026-11-13.** Probe 2026-11-13 (read-only); commit 1 `6234fde`; the Actual COGS clearing `a278169`;
> commit 3 `456acf5` (migration 110); commit 4 = the docs. Commit 2 was not needed (D2 amended, D3 already true).
> Still open, one separate step: the D8 unplug (remove the share, delete the sheet config). The Missing Orders tab is dropped (Maria 2026-11-13): not a to-do.

## 1. Decisions (Maria 2026-11-12)

- **D1 — Sync POs goes off entirely:** intake (nothing left to pick up)
  and the prep-drift apply (the one sheet-owned field after intake; its
  whole record is two changes, one of them wrong). Prep and ships_to are
  set on the PO in AF only.
- **D2 — AMENDED 2026-11-13: Export SB COGS is unchanged.** The probe showed it has read AF's PO tables
  (`loadAfPoRows`) since 2026-10-18 and emits SellerBoard's dated per-PO cost periods for 2026 (`cogs + prep` per PO
  row, same-day merges, the fractional-pack collapse) — not one value per ASIN. Its latest period equals
  `actual_cogs + prep_override` for 868 of 888 ASINs; the 18 differences are the collapse / merge rules and two
  newest-PO rows with 0 expected units (`docs/orders-sheet-probe-sb-cogs-diff-2026-11-13.csv`). It keeps its periods.
- **D3 — Push to Aura reads AF only** — already true: its "PO sheet read" has been `syncAsinCostsFromPos` over AF's
  PO tables since 2026-10-18 (probe 2026-11-13); only the comments said sheet.
- **D4 — Col P backup signal dropped** from the shipment matcher: Velocity
  order links (migration 099) cover the no-order-# case.
- **D5 — §11 PO mirror sheet dropped.** The probe found the mirror IS `GOOGLE_SHEET_ID` (the `IMPORTRANGE` copy
  "AsinFlow - Purchase Orders"), not a second spreadsheet: it went with `readPoSheet` in commit 3.
- **D6 — RESOLVED 2026-11-13: the hourly component stays, as the backstop;
  it reads AF, not the sheet.** The probe showed that `asin_estimates.
  actual_cogs` has exactly two writers — `runSheetsSync` (component 9 every
  hour over the whole map; Sync POs, onboarding phase c and Push to Aura
  scoped) and the COGS reset route — and that since 2026-10-18 both read
  `loadAfAsinCostMap` (AF's PO tables: the newest non-canceled PO ASIN row
  by order date, then entry sequence, then created_at), never the sheet. A
  new PO's cost reached the ASIN only at the next hourly pass (B077Z6W2P5,
  PO 200015299727186 created 12:24 UTC, $0.00 with the amber triangle until
  the 13:00 pass). Commit 1 therefore became "Actual COGS on PO save": the
  same scoped sync runs in the request after every PO write; the hourly
  component is kept as the backstop. Historical COGS stay frozen (a PO
  whose cost does not change is not rewritten to a different value).
- **D7 — Missing Orders tab: dropped (Maria 2026-11-13).** Not imported, not read, not a to-do. Dead
  Pile and the other tabs: out of scope.
- **D8 — Read access stays.** The service account keeps its read scope on
  the sheet until everything is tested; the full unplug (remove the share,
  delete the sheet config) is a later, separate step. No code path reads
  the sheet after this patch; the access is only a safety net.
- Not in this patch: the P1 refund-classification cleanup
  (`order_total_nets_refund`) stays on the to-do; Col AU invoice names for
  sheet-era POs are not written back.

## 2. Readers to remove (probe confirms the list)

| Reader | Today | After |
|---|---|---|
| Sync POs intake (ASINs toolbar only — it was never scheduled) | inserted new sheet POs (last on production 2026-10-24, order date 2026-10-23); read `A1:AZ1` + `A2:AZ` — **no Col BA read ever existed** (the range ends at AZ) | removed (commit 3) |
| Prep-drift apply (Option 2, 2026-10-29) | copied a changed Col AS onto existing POs — one row ever on production (havalon.com B00D79EODK, 2026-11-12) | removed (commit 3) |
| Hourly COGS component (9) | has read AF's PO tables since 2026-10-18 (probe, 2026-11-13) | kept as the backstop (D6); renamed "Actual COGS from AF POs", key `09_po_sheet` kept for the ledger |
| Export SB COGS | AF's PO rows (`loadAfPoRows`) since 2026-10-18 | unchanged (D2 amended) |
| Push to Aura | AF (`syncAsinCostsFromPos`) since 2026-10-18 | unchanged (D3 already true) |
| Col P matcher signal (`po_sheet_fba_shipments`, 071) | backup for Velocity lines with no order #; 50 recorded `col_p` links, two lines placed only by it today | removed, table dropped (migration 110) after the two lines got Velocity order links and the Col P-hidden dry run placed 1072/1072 |
| §11 PO mirror sheet | `GOOGLE_SHEET_ID` itself (the IMPORTRANGE copy) | gone with `readPoSheet`; documented as history in §11 |
| Anything else the probe finds | the never-read settings key `google_sheet_id`; ten one-off scripts (`sync-pos`, `diag-orders-for-aura`, `po-cogs-review`, `backfill-po-model`, `import-po-2026`, `backfill-pack-size`, `reimport-po-fractional-qty`, `verify-sheet-rows`, `verify-velocity-export`, `backfill-po-entry-seq`); tests mocked the sheet (no fixture file) | key deleted by migration 110; scripts, `server/po-sheet-sync.ts`, `po-import-classify.ts`, `po-cogs-review.ts` and their tests deleted (commit 3) |

## 3. Commits

0. **Probe (read-only, second session OK).** Every read of the Orders
   sheet in server code, scripts, scheduler components and settings: file,
   function, what it reads (columns), what it writes to AF, when it runs.
   For each: last time it actually changed anything on production (job
   ledger / History), so we know it's dead. What feeds `asins.actual_cogs`
   today, end to end (sheet component? PO save? "Reset Est. COGS to PO"?
   CSV upload?). What Export SB COGS reads today and a side-by-side of its
   current output vs `actual_cogs + prep` for every ASIN with a difference
   (CSV). Report, stop.
1. **Actual COGS on PO save (shipped 2026-11-13; replaces "ASIN COGS
   follows PO edits").** When a PO is created (New PO, Capture PO), edited
   (header, cost, prep, qty, lines added / removed, ASIN changed, payments /
   promos / refunds) or canceled / uncanceled (Cancel PO, a row's cancel,
   any claim change — a canceled claim decides which PO is the newest
   non-canceled one), the scoped cost sync runs in the same request after
   the PO transaction commits, for the PO's ASINs before AND after the
   write (`withCostSync` in `server/routes.ts`; the module is
   `server/asin-po-costs.ts`, `syncAsinCostsFromPos` /
   `syncAsinCostsAfterPoWrite`). A sync failure is logged and never fails
   the save — component 9 writes the same thing within the hour. The rule
   was checked: `loadAfAsinCostMap` already orders by order date, then
   entry sequence, then created_at (`NEWEST_PO_ORDER`), so no ASIN changed
   and no dry run was needed. `runSheetsSync` → `syncAsinCostsFromPos`;
   `cogs_source` / `estimated_cogs_source` `'po_sheet'` → `'af_po'`
   (migration 109, the CHECK constraints and every stored row). Tests on
   the real schema, rolled back: create, edit cost (a manual Est. COGS
   stays), cancel the latest PO (falls back to the previous PO's cost), a
   backdated PO does not win; the route wiring is asserted by label.
2. ~~Export SB COGS from AF (D2); Push to Aura from AF (D3).~~ Not needed (D2 amended, D3 already true). In its
   place, 2026-11-13 (`a278169`): **Actual COGS cleared when every PO ASIN row for the ASIN is fully canceled**
   (`clearCostsOfFullyCanceledAsins`, the 32-ASIN dry run `docs/actual-cogs-clear-dry-run-2026-11-13.csv`), in the
   after-save sync and the hourly backstop; Est. COGS stays; every reader handles the null.
3. **Done 2026-11-13 (`456acf5`).** Sync POs off: intake, prep drift, button, `POST /api/sheets/sync`,
   `script/sync-pos.ts` (there were no scheduler entries); Col P signal off, `po_sheet_fba_shipments` dropped
   (migration 110); the dead `google_sheet_id` settings key deleted; the ten sheet scripts and their tests removed;
   `GOOGLE_SHEET_ID` and the sheet client (`server/sheet-read.ts`, `server/google-sheets.ts`) left in place,
   unreferenced (D8).
4. **Done 2026-11-13.** SPEC §11 / §14 / §22 / §26, CLAUDE.md: the sheet is history-only; the "sheet is intake"
   wording is gone.

Stops: after 0 (done), and for anything the probe finds that this patch
doesn't cover (1's dry run was not needed: the rule already used order
date).
