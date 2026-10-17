# Spec patch — Sync POs: repeatable Orders-sheet → PO sync (sheet wins)

> **Superseded in part (2026-10-17):** the PO-level Status mapping of §3.2–§3.3 (first row of each PO applied to the whole PO) is replaced by per-row mapping — see `claude_spec-patch-row-level-status.md` §2.1–2.3.

Date: 2026-10-16
Status: APPROVED 2026-10-16 (approval model: patch, not commits)
Depends on: `claude_spec-patch-po-expand-by-asin.md` (deployed 2026-10-16)

## 0. Why

PO rows were imported once (last PO date 2026-08-24) by an INSERT-only importer. Maria wants the Orders sheet synced into the PO module every time the ASINs-page **Sync POs** button runs — new POs added and existing POs updated. The Orders sheet is the source of truth for everything it carries until the VA moves off it ("sheet wins fully, for now" — 2026-10-16). Fields the sheet does not carry stay AF-owned.

## 1. Decisions (2026-10-16)

- D1. Existing POs are **updated**, not skipped.
- D2. For every field the sheet carries, the sheet wins — including the Status cell (Closed / action-item tokens / Canceled / Returned). AF edits to those fields last only until the next sync. Temporary; revisit when migrating off the sheet.
- D3. The ASINs-page **Sync POs** button runs the PO sync first, then the existing per-ASIN sync. No new button.

## 2. Pre-flight (commit 1, report before coding)

P1. What the ASINs-page Sync POs button does end to end — route, sheet/tab read, `asins` columns written, whether it touches `purchase_orders` / `po_line_items` / `po_asins`.
P2. The one-time importer: entry point, sheet tab + columns read, match key for "PO exists", what it skips, how it handles the Status cell and Col L / Col M / Col N on insert, and how it builds `po_asins` from lines.
P3. Any other code reading PO-row data live from the sheet (the five Status-cell readers) — file:line. They stay untouched unless one duplicates what this sync now stores.
P4. Dry-run count: sheet PO rows the sync would insert today, and existing POs whose sheet row differs from AF.
P5. Whether `po_asins.id` is referenced by `po_asin_shipments` (yes — uuid FK, from the previous patch): confirm, because §3.4 forbids delete-and-reinsert of `po_asins`.

## 3. Sync rules

3.1 Scope: the whole Orders sheet (every PO row), not the ASINs-page selection. Match key = the importer's existing key (P2); if the key is not unique in the sheet, STOP and report.

3.2 Insert: new POs exactly as the importer does today, including the §6.4 Status-cell mapping from the expand-by-ASIN patch (Closed → `closed_at`/`closed_by='sheet'`; action-item tokens → `action_items`; Canceled → `qty_canceled = ordered_qty`; Returned → `qty_returned`; Received / Received Partial / Ordered → nothing; unmapped token → STOP and report).

3.3 Update (sheet-owned fields): for an existing PO, overwrite from the sheet every header field the importer reads (supplier, dates, order total, notes, …) and every line field (product, Col L qty, cost, Col M received, Col N ASIN qty, yield/units-per-pack, …), plus the Status-cell mapping of 3.2 applied as a full replace:
  - `action_items` = tokens from the sheet (empty array if none).
  - `closed_at`/`closed_by`: sheet says Closed → set (keep existing `closed_at` if already closed, else `now()`), `closed_by='sheet'`; sheet does not say Closed → `closed_at = NULL`, `closed_by = NULL` — regardless of a previous 'auto' or user close (D2).
  - `qty_canceled` / `qty_returned` per 3.2; sheet no longer says Canceled/Returned → set back to NULL.
  - `po_asins.qty` recomputed from Col N sums.

3.4 `po_asins` rows are matched by (PO, ASIN) and updated in place — never deleted and reinserted, because `po_asin_shipments` references their ids. A (PO, ASIN) that disappears from the sheet: delete only if it has no shipment rows; otherwise keep, and report it.

3.5 Lines (`po_line_items`) missing from the sheet for an existing PO are deleted. A PO missing from the sheet entirely is **not** deleted — reported as "in AF, not in sheet".

3.6 AF-owned, never written by the sync: `qty_shipped_supplier`, `qty_at_prep`, `qty_at_warehouse`, `qty_lost_damaged_us`, `qty_shipped_fba`, `qty_received_amazon`, `po_asin_shipments`, and anything else the sheet does not carry. SPEC §14 ownership list updated to say so.

3.7 Fail-closed (SPEC §14 manual-trigger completeness): if the sheet read is incomplete or errors, write nothing. Deletions in 3.4/3.5 happen only on a complete read.

3.8 Auto-close rule interaction: the rule from the previous patch still runs on qty/shipment/action-item edits; the next sync overwrites its result with the sheet's. Document this in SPEC as the accepted temporary state.

3.9 Dry run: `?dryRun=true` returns counts — inserted, updated, unchanged, lines deleted, `po_asins` kept-with-shipments, POs in AF not in sheet, unmapped tokens — plus 10 sample diffs. The live run returns the same counts in the toast/report.

## 4. Button

The ASINs-page Sync POs runs the PO sync (3.x) then the existing per-ASIN sync (P1), sequentially; if the PO sync fails, the per-ASIN sync still runs and the result shows both outcomes. Queue: leave as today (noted in scheduler v1 that Sync POs bypasses the queue); not changed here.

## 5. Commits

1. Pre-flight report (no code) — P1–P5.
2. PO sync service: insert + update + deletes per §3, dry run, fail-closed.
3. Button wiring (§4) + result reporting.
4. SPEC: §22 (PO module) sync section, §14 ownership, "sheet wins for now" note.
Gate per commit: `npm run check`, `npm run check:tests`, route-registration and NUL tests; restart dev server after sync code. Run the dry run locally and report its counts; run live locally; then one report before pushing. After deploy, run the dry run on production and report before the first live production sync.
