# Spec patch — PO table v2: per-line action items, sortable + resizable columns

Status: DRAFT 2026-10-29 — decisions taken with Maria 2026-10-22/23; no open decisions. Depends on nothing; the cancellations patch (§27) depends on this one's per-line action items (it sets "Confirm Refund / Replacement" on a line).
Repo path: `docs/claude_spec-patch-po-table-v2.md`. Touches SPEC §22 (PO module), §26 (Review Velocity), §27 when it lands.

## 1. Goal

1. **Action items live on the product line, not the PO.** Maria 2026-10-23: *per-line everything*. The hierarchy is PO → ASIN row (`po_asins`) → product line(s) (`po_line_items`; a bundle or multipack ASIN row has several). Items are **stored on the product line**. The **ASIN row** shows the union of its product lines' items, and setting an item on the ASIN row applies it to all its product lines (Maria 2026-10-29: items also live on the ASIN line, since every product belongs to an ASIN). The **PO row** shows the union of its ASIN rows. A PO-wide item (SHIP, See Comments, ATTN: Velocity, Received - FBM, the auto "Review Velocity") is applied to every product line of the PO; there is no PO-level scope. The Action Items filter matches a PO when **any** product line has the item; auto-close requires no open item on **any** product line.
2. **Columns:** click a header to sort (asc/desc, deterministic tiebreaker `id`), drag to resize, widths persisted per user; Action Items column narrower by default.

## 2. Reconcile first (Claude Code, commit 0, report only)

Before the migration, report exactly how action items are stored today: the column(s) on `purchase_orders` (multi-select), whether `po_line_items` / `po_asins` already carry any per-line item from the row-level sheet Status work (2026-10-17/18), how the Orders-sheet Status token maps at intake, where "Review Velocity" (§26) and the auto-close rule (`po-close.ts`) read items, and which UI components render the chips/filter. Amend §3–§5 below to the real names if they differ, then proceed.

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

- **Backfill:** every item currently on a PO is copied to every line of that PO (`source = 'sheet'` for sheet-imported POs, `'manual'` otherwise), one edit-log row per PO. Count reported before/after; nothing is dropped.
- The PO-level column is kept for one release but **nothing reads it** after this patch; a follow-up migration drops it once §27 has shipped on top.
- Intake (Sync POs, new POs only): the sheet Status token maps to items on the **line** that row represents — which is what the row-level sheet Status work already computes; it now writes the line row instead of (or in addition to) the PO.
- §26 "Review Velocity": set on every line of the PO (`source = 'auto'`, reason carried), cleared on every line when the condition clears; manual clear suppresses per the existing `suppressed_at` rule. The per-tracking-row "address mismatch" reason still lands on all lines (tracking is per PO).
- Auto-close (`po-close.ts`): "no open action items" = no row in `po_line_action_items` with `cleared_at IS NULL` on any line of the PO.

## 4. API

- `GET /api/pos` list: each PO carries `action_items: [{item, line_count, sources}]` = union over open line items; filter param unchanged in shape, semantics = any line.
- Expand-by-ASIN rows carry their own lines' open items.
- `PUT /api/pos/:id/action-items` (existing bulk set on the PO) → applies to all product lines (set/clear per item, manual).
- New `PUT /api/po-asins/:id/action-items` → applies to all product lines of that ASIN row.
- New `PUT /api/po-lines/:id/action-items` for a single product line.
- Expand-by-ASIN rows carry `action_items` as the union of their product lines (same shape as the PO rollup).
- Sort: `?sort=<column>&dir=asc|desc`; whitelist of sortable columns (PO date, order ID, supplier, status, order total, line/ASIN counts, open action-item count); every ORDER BY ends with `, p.id DESC`. Default unchanged (PO date desc).

## 5. UI

- **PO row chips:** union, deduped, ordered by the existing item order; hover shows which lines (ASIN + product) carry each item and the auto reason. A chip with a count badge when fewer than all lines have it (e.g. "Need to Return ·2").
- **ASIN rows (expanded view):** each ASIN row shows the union of its product lines' items with the same multi-select; setting there = set on all of that ASIN's product lines (confirm when > 1 product line). Single-product ASIN rows (the common case) behave as one cell.
- **Product-line rows (nested under the ASIN row, bundles/multipacks):** each has its own Action Items cell. Setting on the PO row = set on all product lines (confirm dialog when the PO has > 1 line: "Apply to all N lines").
- **Filter:** unchanged control; matches any line. Count chip reflects POs, not lines.
- **Sortable headers:** click toggles asc → desc → off; caret shown; one sort key at a time. Server-side sort (the list is paginated).
- **Resizable columns:** reuse the ASINs table column manager / resize mechanism (Claude Code checks what exists — same component, no second implementation); widths persisted per user (`user_prefs` or wherever the ASINs table keeps them); "Reset widths" in the column menu. Default widths: Action Items ≈ 60% of today's, chips wrap to two lines at most then "+N".
- Action Items chip colors keep the quiet palette (Maria 2026-10-22: no bright red/orange overpowering the table).

## 6. SPEC

- §22: action items are per product line; rollup, filter and auto-close semantics; sort/resize behavior; PO-level column deprecated.
- §26: Review Velocity writes/clears per line.
- §27 (cancellations, when it lands): "Confirm Refund / Replacement" is set on the confirmed line only.

## 7. Commits (single-concern, gated)

0. Reconcile report (§2) — no code; amend this doc.
1. Migration + backfill script (dry run → counts → live, edit-log rows); readers switched to `po_line_action_items` (list rollup, filter, auto-close, Review Velocity set/clear, intake mapping). Tests: rollup, any-line filter, auto-close with one open line, Review Velocity on all lines.
2. APIs: per-line endpoint, PO-level endpoint applies to all lines, sort params with whitelist + tiebreaker.
3. UI: line-level cells, PO chips with counts/hover, apply-to-all confirm.
4. UI: sortable headers.
5. UI: resizable columns via the shared mechanism, persisted widths, narrower Action Items default.
6. SPEC §22/§26; CLAUDE.md note that the PO-level action-items column is dead and scheduled for removal.

Stops: after commit 1's production backfill dry run (counts per item before/after), and for anything the patch doesn't cover.
