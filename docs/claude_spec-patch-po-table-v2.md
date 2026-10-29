# Spec patch — PO table v2: per-line action items, sortable + resizable columns

Status: DRAFT 2026-10-29 — decisions taken with Maria 2026-10-22/23; no open decisions. Depends on nothing; the cancellations patch (§27) depends on this one's per-line action items (it sets "Confirm Refund / Replacement" on a line).
Repo path: `docs/claude_spec-patch-po-table-v2.md`. Touches SPEC §22 (PO module), §26 (Review Velocity), §27 when it lands.

## 1. Goal

1. **Action items live on the product line, not the PO.** Maria 2026-10-23: *per-line everything*. The hierarchy is PO → ASIN row (`po_asins`) → product line(s) (`po_line_items`; a bundle or multipack ASIN row has several). Items are **stored on the product line**. The **ASIN row** shows the union of its product lines' items, and setting an item on the ASIN row applies it to all its product lines (Maria 2026-10-29: items also live on the ASIN line, since every product belongs to an ASIN). The **PO row** shows the union of its ASIN rows. A PO-wide item (SHIP, See Comments, ATTN: Velocity, Received - FBM, the auto "Review Velocity") is applied to every product line of the PO; there is no PO-level scope. The Action Items filter matches a PO when **any** product line has the item; auto-close requires no open item on **any** product line.
2. **Columns:** click a header to sort (asc/desc, deterministic tiebreaker `id`), drag to resize, widths persisted per user; Action Items column narrower by default.

## 2. Reconcile first (Claude Code, commit 0, report only)

Before the migration, report exactly how action items are stored today: the column(s) on `purchase_orders` (multi-select), whether `po_line_items` / `po_asins` already carry any per-line item from the row-level sheet Status work (2026-10-17/18), how the Orders-sheet Status token maps at intake, where "Review Velocity" (§26) and the auto-close rule (`po-close.ts`) read items, and which UI components render the chips/filter. Amend §3–§5 below to the real names if they differ, then proceed.

### 2.1 Reconcile result (2026-10-29, amended in place below)

- **Items are already per line.** Migration 058 (2026-10-17) added `po_line_items.action_items text[]` (CHECK on the 7 manual labels, GIN index); the sheet sync writes it per row, `PATCH /api/pos/asin-rows/:id/action-items` (write-through to every line) and `PATCH /api/pos/lines/:id/action-items` edit it; the ASIN row shows the union (`ASIN_ACTION_ITEMS_SQL`), the PO the union over all lines (`PO_ACTION_ITEMS_SQL`), the filter is any-line (`l.action_items && $n`), auto-close reads `PO_CLOSE_ACTION_ITEMS_SQL`. `purchase_orders.action_items` is deprecated since 058, not written, and on prod a strict subset: 0 PO-column items missing from the PO's lines. Prod: 250 line items over 6 labels; 0 `po_edit_log` rows for action items (never edited by hand); every PO is `source = 'sheet_import'`.
- **Derived items (not stored):** "Review Velocity" from `po_tracking` (`review_reason IS NOT NULL AND suppressed_at IS NULL`, prod: 11 rows on 2 POs; written by `tracking-push.ts`, cleared by hand in `tracking-routes.ts` via `suppressed_at`, reset on Move to PO); "Pack size missing", "Pack size mismatch", "Receiving mismatch" and today's "Extra units shipped" (migration 073) from `po_asins`.
- **Intake:** `po-sheet-sync.ts` maps the Status token per row (`mapSheetStatus`, `po-status-map.ts`) to that line's items; since 2026-10-18 only on new POs (existing POs are a read-only drift report). The New PO form (`po-create.ts`) inserts lines with items.
- **UI:** `ActionItemChips` / `ActionItemsEditor` / `actionChipClass` in `client/src/components/po-asin-rows.tsx` (PO row, PO Details, ASIN row, product line); filter `FacetMultiSelect` on `purchase-orders.tsx`, values from `GET /api/pos` `actionItems`.
- **Resize:** the ASINs table (`results-table.tsx`) keeps widths in `localStorage` (`fba-col-widths`, per browser, not per user) with a local `ResizeHandle`; `grouped-table.tsx` has a copy. This patch extracts that into one shared hook and uses it on the ASINs and POs tables.

## 3. Data model

Migration NNN:

```
po_line_action_items
  id               bigserial PK
  po_line_item_id  FK po_line_items ON DELETE CASCADE
  item             text NOT NULL      -- same vocabulary as today's PO-level multi-select
  source           text NOT NULL      -- 'manual' | 'sheet' | 'auto'   (auto = Review Velocity, Confirm Refund from §27, future)
  reason           text               -- auto items: why (e.g. 'not in Velocity')
  set_at           timestamptz NOT NULL DEFAULT now()
  cleared_at       timestamptz        -- NULL = open
  cleared_by       text               -- 'manual' | 'auto'
  UNIQUE (po_line_item_id, item) WHERE cleared_at IS NULL
```

- **Labels (Maria 2026-10-29): sentence case** — Need to return, Missing / damaged from supplier, Confirm refund / replacement, ATTN: Velocity, See comments, SHIP, Received - FBM, Review Velocity. The new table stores the new labels (CHECK); the backfill maps old → new, and `normalizeActionItems` accepts the old spelling and maps it.
- **Backfill (amended):** from `po_line_items.action_items` (the current truth — a superset of the PO column), one row per (line, item), `source = 'sheet'` (every PO is a sheet import; no hand edits exist), plus "Review Velocity" on every line of each PO whose condition holds (`source = 'auto'`, reason = the open reasons). One edit-log row per PO. **It runs inside migration 074** rather than as a separate live script: the readers switch in the same deploy, and a gap between deploy and a script would show no items and let auto-close (hourly pass) close POs that have open items. `npm run backfill:line-action-items` is the read-only dry run (counts per item before/after) and the post-deploy check.
- `purchase_orders.action_items` and `po_line_items.action_items` are kept for one release, **neither read nor written**; a follow-up migration drops both once §27 has shipped on top.
- Intake (Sync POs, new POs only; New PO form): the line's mapped items are inserted as `po_line_action_items` rows (`source = 'sheet'` / `'manual'`). The drift report for existing POs compares against the table.
- §26 "Review Velocity": `reconcileReviewVelocity(poIds)` mirrors the `po_tracking` condition onto every line of the PO (`source = 'auto'`, reason = the open reasons), clearing (`cleared_by = 'auto'`) when it clears; the hand clear keeps setting `suppressed_at` and the rows clear with `cleared_by = 'manual'`. Called after every `po_tracking` write that can change it (push, Move to PO, clear).
- **Stay derived, never stored:** Extra units shipped (red chip — Maria 2026-10-29, the one exception to the quiet palette), Pack size missing, Pack size mismatch, Receiving mismatch (display-only, does not block auto-close).
- Auto-close (`po-close.ts`): "no open action items" = no row with `cleared_at IS NULL` on any line of the PO, and none of the derived items that block (Extra units shipped, the pack-size pair).

## 4. API

- `GET /api/pos` list: each PO keeps `action_items: string[]` (the union, display order — what the chips and filter already use) and adds `action_item_lines: {[item]: {lines, of, where[], reasons[]}}` for the count badge and hover; filter param unchanged in shape, semantics = any line.
- Expand-by-ASIN rows and product lines carry their own open items (`action_items`), ASIN rows as the union of their lines.
- Real routes (amended — the patch's `PUT /api/pos/:id/action-items` never existed): **new** `PATCH /api/pos/:id/action-items` → all product lines of the PO; existing `PATCH /api/pos/asin-rows/:id/action-items` → all product lines of that ASIN row; existing `PATCH /api/pos/lines/:id/action-items` → one line. All take the desired union `{action_items}`; items added go onto every line in scope, items removed are cleared (`cleared_by = 'manual'`) on every line in scope; derived and auto items are ignored.
- Sort: `?sort=<column>&dir=asc|desc`; whitelist of sortable columns (PO date, order ID, supplier, status, order total, line/ASIN counts, open action-item count); every ORDER BY ends with `, p.id DESC`. Default unchanged (PO date desc).

## 5. UI

- **PO row chips:** union, deduped, ordered by the existing item order; hover shows which lines (ASIN + product) carry each item and the auto reason. A chip with a count badge when fewer than all lines have it (e.g. "Need to Return ·2").
- **ASIN rows (expanded view):** each ASIN row shows the union of its product lines' items with the same multi-select; setting there = set on all of that ASIN's product lines (confirm when > 1 product line). Single-product ASIN rows (the common case) behave as one cell.
- **Product-line rows (nested under the ASIN row, bundles/multipacks):** each has its own Action Items cell. Setting on the PO row = set on all product lines (confirm dialog when the PO has > 1 line: "Apply to all N lines").
- **Filter:** unchanged control; matches any line. Count chip reflects POs, not lines.
- **Sortable headers:** click toggles asc → desc → off; caret shown; one sort key at a time. Server-side sort (the list is paginated).
- **Resizable columns:** the ASINs table's mechanism extracted into one shared hook (`useColumnWidths` + `ResizeHandle`, `client/src/hooks/use-column-widths.tsx`) used by the ASINs table and the POs table — no second implementation; widths persist where the ASINs table keeps them (localStorage, per browser — amended from "per user"; the POs table under its own key). "Reset widths" on the POs table. **Storage note (Maria 2026-10-29):** column widths are stored per browser (localStorage), the same as the Buy List; both move into a user-scoped table in the queued Buy-List-to-DB patch. Default widths: Action Items ≈ 60% of today's, chips wrap to two lines at most then "+N".
- Action Items chip colors keep the quiet palette (Maria 2026-10-22: no bright red/orange overpowering the table) — except Extra units shipped, which stays red (Maria 2026-10-29).

## 6. SPEC

- §22: action items are per product line; rollup, filter and auto-close semantics; sort/resize behavior; PO-level column deprecated.
- §26: Review Velocity writes/clears per line.
- §27 (cancellations, when it lands): "Confirm Refund / Replacement" is set on the confirmed line only.

## 7. Commits (single-concern, gated)

0. Reconcile report (§2) — no code; amend this doc.
1. Migration 074 with the backfill in it + the read-only dry-run/check script (dry run on prod → counts → go → the deploy applies it; edit-log rows); readers switched to `po_line_action_items` (list rollup, filter, auto-close, Review Velocity set/clear, intake mapping). Tests: rollup, any-line filter, auto-close with one open line, Review Velocity on all lines.
2. APIs: per-line endpoint, PO-level endpoint applies to all lines, sort params with whitelist + tiebreaker.
3. UI: line-level cells, PO chips with counts/hover, apply-to-all confirm.
4. UI: sortable headers.
5. UI: resizable columns via the shared mechanism, persisted widths, narrower Action Items default.
6. SPEC §22/§26; CLAUDE.md note that the PO-level action-items column is dead and scheduled for removal.

Stops: after commit 1's production backfill dry run (counts per item before/after), and for anything the patch doesn't cover.
