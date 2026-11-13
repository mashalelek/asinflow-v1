# SPEC Patch — Orders-sheet retirement

*Drafted 2026-11-12 with Maria. Amends SPEC §11 (Aura, SB export, PO
mirror), §14 (ownership), §22 (PO intake), §26. The Orders sheet stopped
being a PO record on 2026-10-23 (last PO entered there); Capture PO and
the AF form are the two intakes. This patch removes every remaining AF
read of the sheet, one at a time, each with its AF-side replacement
proven first.*

> **Status: DRAFT 2026-11-12, for Maria's approval.** Probe (commit 0) can
> run read-only in a second Claude Code session while claims commit 5 is
> in flight.

## 1. Decisions (Maria 2026-11-12)

- **D1 — Sync POs goes off entirely:** intake (nothing left to pick up)
  and the prep-drift apply (the one sheet-owned field after intake; its
  whole record is two changes, one of them wrong). Prep and ships_to are
  set on the PO in AF only.
- **D2 — Export SB COGS = ASIN Actual COGS + prep, from AF. Period.** Not
  what the export reads from the sheet today; that is irrelevant. Same two
  fields Push to Aura already sends (`actual_cogs + prep_override`).
- **D3 — Push to Aura reads AF only** (its PO-sheet read for the selection
  goes).
- **D4 — Col P backup signal dropped** from the shipment matcher: Velocity
  order links (migration 099) cover the no-order-# case.
- **D5 — §11 PO mirror sheet dropped.**
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
- **D7 — Missing Orders tab: untouched.** Not imported, not read. Dead
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
| Sync POs intake (ASINs toolbar + scheduled) | inserts new sheet POs; reads Col BA at intake | removed; button gone |
| Prep-drift apply (Option 2, 2026-10-29) | copies a changed Col AS onto existing POs | removed |
| Hourly COGS component (9) | has read AF's PO tables since 2026-10-18 (probe, 2026-11-13) | kept as the backstop (D6); renamed "Actual COGS from AF POs", key `09_po_sheet` kept for the ledger |
| Export SB COGS | sheet column(s) | AF: ASIN Actual COGS + prep |
| Push to Aura | reads the PO sheet for the selection | AF only |
| Col P matcher signal (`po_sheet_fba_shipments`, 071) | backup for Velocity lines with no order # | removed; table dropped after a last check that no unmatched line still needs it |
| §11 PO mirror sheet | IMPORTRANGE mirror | removed from code and docs |
| Anything else the probe finds (settings keys, scripts, tests reading the sheet fixture) | | listed, then removed |

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
2. Export SB COGS from AF (D2); the before/after CSV from the probe
   re-run; Push to Aura from AF (D3).
3. Sync POs off: intake, prep drift, button, scheduler entries; Col P
   signal off; mirror sheet off; sheet settings keys and the sheet client
   left in place but unreferenced (D8).
4. SPEC §11 / §14 / §22 / §26, CLAUDE.md: the sheet is history-only; the
   "sheet is intake" wording goes.

Stops: after 0 (done), and for anything the probe finds that this patch
doesn't cover (1's dry run was not needed: the rule already used order
date).
