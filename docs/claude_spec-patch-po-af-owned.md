# Spec patch — AF owns POs: sheet is intake-only, POs editable in AF, New PO form

> **P1 blocker resolved (2026-10-18):** the pre-2026 PO history is now in AF (`claude_spec-patch-po-history-import.md`). For all 751 cost ASINs the sheet reader's cost equals the newest non-canceled AF PO ASIN row (751 / 751, 0 mismatches). `po_asin_shipments.assigned_by` (§5.2) already exists (migration 060). Resume at commit 2 once the import is live on production.

Date: 2026-10-17
Status: APPROVED 2026-10-17 (Maria's decisions in §7; stop only on the pre-flight conditions in §1)
Supersedes: "sheet wins fully" in `claude_spec-patch-po-sheet-sync.md` (D2) and the sheet-side Closed/action-item/cancel mapping for existing POs in `claude_spec-patch-row-level-status.md` §2.3.

## 0. Why

AF now knows more about every PO than the Orders sheet does (shipments, FBA receipts, At Prep, per-product action items). But Sync POs still overwrites existing POs from the sheet, which (a) makes AF edits pointless and (b) makes Closed flip between Sync Shipments (auto-close) and Sync POs (reopen from sheet rows). From this patch on, AF is the system of record for every PO after it exists; the sheet only supplies new POs until the AI-prefill intake replaces it.

## 1. Pre-flight (commit 1, report; no code)

P1. **Every code path that still reads the Orders sheet** (fetchSheetRows or any Sheets API read of the Orders/PO mirror): file:line, what it reads, what it does with it. Known/suspected: Sync POs (PO sync + per-ASIN COGS half), Upload to Velocity (`buildVelocityRecords`, `buildVelocityPlan`), Push to Aura's per-selection sheet read, Export SB COGS, Update COGS in SC, the five Status-cell readers, sourcing-cost exports. For each: does it depend on a field that becomes editable in AF (§3)? **Stop and report** if any such reader cannot be switched to the AF PO tables with the data AF already stores (e.g. it needs a sheet column AF doesn't import).
P2. Fields the importer reads vs. what AF stores: list sheet columns AF does not import today that any reader in P1 uses.
P3. Every place `closed_by = 'sheet'` or the sheet-wins update path is referenced.
P4. Count of POs where the sheet currently differs from AF on fields AF will now own (so Maria knows what freezes at today's AF state).

## 2. Sheet becomes intake-only

2.1 Sync POs inserts every sheet PO (supplier, order_id) not in AF and not tombstoned (§5.3), exactly as today's insert path (row-level Status mapping included for the initial state). It **never updates an existing PO** — no header, line, ASIN-row, action-item, cancel or Closed writes to POs already in AF.
2.2 The dry-run/report keeps a read-only "sheet differs from AF" count per run (informational, no writes), so drift is visible while the VA still uses the sheet.
2.3 Closed is AF-only from here: auto-close rule + manual toggle. `closed_by='sheet'` stays on historical rows; nothing new writes it.
2.4 Every reader found in P1 that depends on PO data switches to the AF PO tables (`purchase_orders`, `po_line_items`, `po_asins`), in particular: Upload to Velocity (create/update candidates from AF POs; same Velocity rules — creation floor, self-prep exclusion, live-SKU join, pack math, dedup), the per-ASIN COGS half of Sync POs, Push to Aura, Export SB COGS, Update COGS in SC. Same outputs as today for unchanged data — verify with a before/after diff on each (counts + 10 samples), not by inspection.

## 3. Editable in AF

PO detail page and nested rows on the POs page (inline where the column exists, a PO edit drawer for header fields):
- **Header:** supplier, order # (warning: "order # is how shipments are matched from Velocity; changing it re-matches on the next Sync Shipments"), order date, subtotal, tax, shipping/donations, discount, refund amount, order total, payment method, cashback fields, purchased by, notes.
- **Products (lines):** add / remove / edit product name, supplier SKU, price, qty ordered, qty received, qty returned, qty canceled, ASIN mapping and yield (ASIN qty per product), action items.
- **ASIN rows:** add / remove (only via their lines), sold as, units/pack, cost/unit, prep, At CQG Warehouse, Lost/damaged by us, Shipped by Supplier, action items (write-through to lines, per the row-level patch), Cancel ASIN (cancels all its lines).
- Derived values (Ordered, Individual Units Ordered, Canceled/Returned at ASIN level, Shipped FBA, Received by Amazon, At Prep Center) stay read-only.
- Every edit re-runs the auto-close rule for that PO.
- Edits are recorded in a `po_edit_log (po_id, user_id, field, old, new, at)` — one row per changed field. Shown as a History tab on PO detail.

## 4. New PO form

"+ New PO" on the POs page (the existing button) opens a form: supplier, order #, order date, header money fields, and a product grid (product name, supplier SKU, price, qty, ASIN — typeahead against AF's asins table — yield, sold as, units/pack, prep). Validation: (supplier, order #) unique, every product mapped to an ASIN, pack math divisible, totals shown live (subtotal = Σ price × qty). Save creates the PO + lines + ASIN rows exactly as the importer would. The form is the base the AI-prefill patch will populate later — keep its state a plain JSON shape so prefill can fill it.

## 5. Delete, cancel, reassign

5.1 **Blocked while a FBA shipment exists.** A PO (or a line / ASIN row) with any `po_asin_shipments` row (shipped to FBA) can be neither deleted nor canceled. The UI disables the action with: "N units shipped to FBA in <FBA ids>. Reassign the shipment to another PO first."
5.2 **Reassign shipment.** On an ASIN row's Shipment IDs chip: "Reassign…" → pick a target PO ASIN row with the same ASIN (search by order #); moves the `po_asin_shipments` row(s) (choose which shipment and how many units, ≤ shipped). Set `po_asin_shipments.assigned_by = 'manual'` (new column, default 'auto') plus the Velocity line identity (velocity shipment id + order # + ASIN). **Sync Shipments must not move or overwrite a manual assignment**: when it derives a row for a Velocity line that has a manual assignment, it keeps the manual target and only refreshes quantities. Logged in `po_edit_log` on both POs. Rollups and auto-close re-run on both POs.
5.3 **Delete** (no FBA shipment): confirm dialog naming the PO and its line count; deletes the PO, lines and ASIN rows; writes a tombstone `deleted_pos (supplier, order_id, deleted_by, deleted_at)` so Sync POs never re-imports it. A deleted PO that still has units At Prep at Velocity: allowed (Maria's rule blocks only FBA shipments), but the confirm dialog says "N units still at Velocity for this PO".
5.4 **Cancel** (no FBA shipment): Cancel PO = cancel all lines (qty_canceled = qty_ordered); Cancel ASIN / Cancel product per the row-level patch.

## 6. Commits

1. Pre-flight (§1).
2. Migration: `po_edit_log`, `deleted_pos`, `po_asin_shipments.assigned_by`.
3. Sync POs intake-only (§2.1–2.3) + drift count.
4. Reader switches (§2.4), one commit per reader, each with its before/after diff in the commit message.
5. Edit UI + API (§3) with edit log.
6. New PO form (§4).
7. Delete / cancel guards, Reassign shipment, Sync Shipments respects manual assignments (§5).
8. SPEC §11, §14 (ownership: all PO data AF-owned; sheet = intake of new POs only), §22; supersession notes in the two earlier patches.
Gates per commit; dry run then live locally; one report before pushing, including: a manual close that survives Sync POs + Sync Shipments; a form-created PO appearing as a create candidate in Upload to Velocity (dry run, do not send); a reassigned shipment surviving Sync Shipments; a delete blocked by an FBA shipment; a deleted PO not re-imported. After deploy: production dry run of Sync POs and the switched readers, report, then live.

## 7. Decisions (Maria 2026-10-17)

- Intake: every new PO regardless of its Status cell; Status ignored after insert.
- Order # and supplier editable in AF with a warning. `_1`-style suffixes are intentional, not typos.
- Plain New PO form now; AI prefill next.
- Delete with confirm. A PO with any shipment to FBA can be neither deleted nor canceled until that shipment is reassigned to another PO.
