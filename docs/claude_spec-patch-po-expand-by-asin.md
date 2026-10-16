# Spec patch — PO module: Expand by ASIN view, column model, Action Items + Closed

Date: 2026-10-15
Status: IMPLEMENTED 2026-10-16 — commits 1–8 (pre-flight `f04bebb`, migration
056 `0becb5c`, column model `00fa7b4`, Expand by ASIN `8cc0682`, Closed
`a544fbd`, Action Items + §6.4 `9f2d5d2`, Products tab `7e8d329`, docs).
Decisions taken during implementation (pre-flight, 2026-10-16): Canceled /
Returned are DERIVED on the ASIN row from `po_line_items` (no stored
copies); "Received Partial" → nothing (as Received); "Closed" →
`closed_at = updated_at`, `closed_by = 'sheet'`; `po_asin_shipments.po_asin_id`
is uuid (po_asins.id is uuid); Shipped FBA / Received by Amazon are
trigger-maintained; the §6.4 value migration is `script/migrate-po-status.ts`
(dry-run default, `--live`), run on Render after deploy; §6.3 is SPEC text
only (no code implements the rule; delta counts recorded); the importer is
INSERT-only so "excluded from ON CONFLICT DO UPDATE SET" is moot; the five
modules reading the Orders sheet's Status cell directly are out of scope.
Previously: APPROVED 2026-10-15 (approval model: patch, not commits)
Target: `docs/SPEC.md` (PO module section) + code.

## 0. Why

The VA reconciles FBA shipments against POs by hand in the Orders sheet. AF will take this over: Seller Central (what Amazon received) → Velocity (which shipment line came from which retailer Order #) → AF PO. This patch is **step 1 only**: give the POs page a view where every PO can show its ASIN rows nested under it, with the columns the reconciliation will fill in. Pulling the data from SC/Velocity is a separate patch (Phase 2, §9).

## 1. Scope

In:
1. "Expand by ASIN" on the POs page — Expand All toggle + per-PO chevron; nested `po_asins` rows under each PO row; expanded state persists across reloads.
2. Column renames and additions on the nested rows and on the PO detail ASINs tab (same component or same column model).
3. Per-ASIN / per-product status quantities replace PO-level status values: Ordered, Canceled, Returned, Received, Lost/damaged by us become columns on the ASINs and Products tables.
4. PO-level **Closed** flag (col 1 of the POs table, green checkmark) — set automatically when every ASIN is fully shipped FBA, also settable by hand.
5. PO-level **Status** column becomes **Action Items**, multi-select.
6. Remove Unreimb. Loss from the ASINs table (DB column stays).
7. SPEC.md updated with the new column model and the status/action-items model.

Out (Phase 2 patch): SC Fulfillment Inbound sync, Velocity outbound lookup, email tracking-number parsing, home-shipped (non-Velocity) POs, the Shipments nav page.

## 2. Pre-flight checks (Claude Code runs these first and reports before coding)

Maria does not want guesses. Confirm each with evidence (file:line, SQL output, one real multi-pack PO):

P1. Which `po_asins` columns feed the ASINs-tab columns **Qty** and **Qty (units)**, and which Orders-sheet columns the PO sync maps each from (Maria believes col L = product qty, col N or U = ASIN qty). Show one multi-pack PO (e.g. the Equal Exchange 6-pack) with both numbers so the direction is unambiguous. Expected: Qty = ASIN (sellable-pack) qty, Qty (units) = individual physical units = Qty × Units/Pack. If it's the other way round, STOP and report.
P2. Relationship between `po_line_items` (Products tab) and `po_asins` (ASINs tab): how a product row maps to an ASIN row (1:1, 1:N via bundles?), and where Units/Pack lives.
P3. How the PO list is loaded today (all rows vs paginated/virtualized) and its row count. Determines whether Expand All loads nested rows eagerly or per expanded PO.
P4. Where `purchase_orders.status` is read: list every consumer (list chips, filters, profit exclusion rule "`final_qty = 0` OR (`final_qty IS NULL` AND status contains 'canceled')", PO sync from the Orders sheet, Velocity upload filters, Aura/COGS cron, SellerBoard export). Each consumer must be migrated in §6.
P5. What the Orders sheet Status column currently contains (distinct values + counts) via the PO mirror sheet, so the migration in §6.4 maps every value.
P6. Existing view-preset / persisted-UI-state mechanism on the ASINs page, to reuse for expanded state (§3.4).

## 3. Expand by ASIN view (POs page)

3.1 Controls
- Toolbar toggle **Expand All** (becomes **Collapse All** when on). Applies to the currently filtered list only.
- Per-PO chevron in its own cell (left of the PO row content; after the Closed column of §5). Chevron is the only expand target. Clicking anywhere else on the PO row still opens the PO detail page.

3.2 Nested rows
- One nested row per `po_asins` row of that PO, rendered directly under the PO row, visually indented, same column model as the PO detail ASINs tab (§4). Column headers for nested rows appear once as a sub-header under the first expanded PO (or a sticky sub-header) — Claude Code picks whichever the table component supports; report the choice.
- Sorting/filtering stays at PO level; nested rows keep `po_asins` default order (as the ASINs tab).

3.3 Data
- Nested rows come from `po_asins` (not `po_line_items`).
- Loading strategy per P3: if the list is unpaginated and small (hundreds), include `po_asins` in the list payload; if large, fetch per PO on expand and batch-fetch on Expand All. Report which.

3.4 Persistence
- Expanded set and the Expand All flag persist across reloads, per user, using the same mechanism as ASINs-page view state (P6). Default: all collapsed.

## 4. Column model — ASINs table (nested rows and PO detail ASINs tab)

Order and names:

| # | Column | Source | Notes |
|---|--------|--------|-------|
| 1 | ASIN | existing | link as today |
| 2 | Title | existing | |
| 3 | Amazon SKU | existing | |
| 4 | **Ordered** | existing Qty (ASIN qty) | renamed; matches Products table naming |
| 5 | Cost/Unit | existing | |
| 6 | Total Cost | existing | |
| 7 | Prep | existing | |
| 8 | Sold As | existing | |
| 9 | Units/Pack | existing | |
| 10 | **Individual Units Ordered** | existing Qty (units) | renamed; = Ordered × Units/Pack per P1 |
| 11 | Canceled | `qty_canceled` (existing, nullable) | NULL = not tracked, render "—" |
| 12 | Returned | `qty_returned` (existing) | |
| 13 | **Shipped by Supplier** | new `qty_shipped_supplier` numeric NULL | ASIN qty; Phase 2 fills from email tracking |
| 14 | **At Prep Center** | new `qty_at_prep` numeric(10,2) NULL | ASIN qty; pulled from Velocity (Phase 2); may be fractional (bundles/multipacks) — see §4.1 |
| 15 | **At CQG Warehouse** | new `qty_at_warehouse` numeric(10,2) NULL | manual; what is received at the house |
| 16 | **Lost/damaged by us** | new `qty_lost_damaged_us` numeric(10,2) NULL | manual |
| 17 | **Shipped FBA** | new `qty_shipped_fba` numeric(10,2) NULL | sum over shipments; Phase 2 fills |
| 18 | **Received by Amazon** | new `qty_received_amazon` numeric(10,2) NULL | ASIN qty; Phase 2 fills from SC |
| 19 | **Shipment IDs** | new table `po_asin_shipments` | dropdown chip: "FBA… (qty)" per shipment; total shown in Shipped FBA |

There is no separate "Received" column: the Orders-sheet "Received" state is represented by At Prep Center / At CQG Warehouse (decided D1, 2026-10-15).

Removed from this table: Unreimb. Loss (DB column untouched).

4.1 Quantity semantics
- All new qty columns are **ASIN (sellable-pack) quantities**, numeric(10,2), NULL = not tracked (tri-state discipline — never default to 0).
- Fractional values are legal for At Prep Center / At CQG Warehouse / Shipped FBA / Received by Amazon when the retailer ships individual units of a multipack/bundle ASIN (e.g. 7 units of a 6-pack = 1.17). Display 2 decimals only when non-integer.
- Phase 2 must convert Velocity "Quantity Shipped" (which may be in individual units — verify in Phase 2) to ASIN qty via Units/Pack before writing.

4.2 Shipments table (new)
```
po_asin_shipments (
  id            serial PK,
  po_asin_id    int NOT NULL REFERENCES po_asins(id) ON DELETE CASCADE,
  fba_shipment_id text NOT NULL,          -- Amazon FBA shipment ID (FBA…)
  velocity_shipment_id text NULL,         -- Velocity UUID when known
  qty_shipped   numeric(10,2) NOT NULL,   -- ASIN qty
  qty_received  numeric(10,2) NULL,       -- ASIN qty received by Amazon for this shipment
  shipped_at    date NULL,
  source        text NOT NULL,            -- 'velocity' | 'sc' | 'manual'
  created_at, updated_at,
  UNIQUE (po_asin_id, fba_shipment_id)
)
```
`qty_shipped_fba` and `qty_received_amazon` on `po_asins` are maintained as the SUM over this table (trigger or application-side recompute — Claude Code picks, consistent with how `final_qty` is done; report). Manual entry of a shipment row is allowed in the UI (for the 1% home-shipped POs until the Shipments module exists).

4.3 Products table (PO detail Products tab, `po_line_items`)
Same status columns added where they apply to a product row: Ordered (existing), Canceled, Returned, At Prep Center, At CQG Warehouse, Lost/damaged by us. Shipment columns stay ASIN-level only. Mapping of product qty ↔ ASIN qty per P2.

## 5. PO-level: Status (Open / Closed)

- The new PO-level **Status** column has exactly two values: Open, Closed. It replaces the old free-text status as the meaning of "Status" on the POs page and PO Details.
- New columns `purchase_orders.closed_at timestamptz NULL`, `closed_by text NULL` ('auto' | user id). NULL = Open.
- POs table column 1 (header "Status"): green checkmark when Closed; an "open order" outline icon when Open. Click toggles with confirm; manual close/reopen sets `closed_by` to the user.
- Auto-close rule (D2, decided 2026-10-15): set `closed_at = now(), closed_by='auto'` when BOTH hold:
  (a) every `po_asins` row satisfies `Shipped FBA >= Ordered − COALESCE(Canceled,0) − COALESCE(Returned,0) − COALESCE(Lost/damaged by us,0)` and at least one row has Shipped FBA > 0 (every unit accounted for), and
  (b) `action_items` is empty — any open action item (See Comments, Confirm Refund / Replacement, …) keeps the PO Open.
  Evaluated whenever `po_asin_shipments` changes (Phase 2), a qty column is edited, or `action_items` changes.
- Auto never reopens a PO that was closed manually; a PO auto-closed is reopened automatically if a later edit makes (a) or (b) false (closed_by='auto' only). Manually unchecking Closed makes it Open (`closed_at = NULL`) and it stays Open until the rule next becomes true after a change.
- Filter: Status filter = Open / Closed / All; default view = Open only (D3).

## 6. PO-level: Status → Action Items

6.1 Model
- `purchase_orders.status` is replaced by `purchase_orders.action_items text[] NOT NULL DEFAULT '{}'` (multi-select) plus the Open/Closed Status of §5. Old `status` column is kept (D5) but **no code reads or writes it** after this patch — every consumer found in P4 is switched to `action_items` / `closed_at`; it is dropped in a follow-up migration once §6.4 is verified in production.
- Allowed values (enum table or CHECK), display order:
  1. Need to Return
  2. Missing / Damaged from Supplier
  3. Confirm Refund / Replacement
  4. ATTN: Velocity
  5. See Comments
  6. SHIP — only meaningful when the PO ships from the house (manual)
  7. Received - FBM — only when the PO ships from the house (manual)
- Rendered as colored chips in the (renamed) **Action Items** column; multi-select editor inline on the POs table and on PO Details.

6.2 Removed from PO level: Canceled, Returned, Received, Ordered — these are now quantities on the ASINs/Products tables (§4, §4.3). "Ordered" as a state is implied by the open-order icon in §5.

6.3 Consumers to migrate (from P4), at minimum:
- Status filter dropdown → Action Items filter (any-of) + Open/Closed filter.
- Profit exclusion rule: `final_qty = 0 OR (final_qty IS NULL AND status ILIKE '%canceled%')` → `final_qty = 0 OR (final_qty IS NULL AND qty_canceled IS NOT NULL AND qty_canceled >= ordered_qty)`. Report the row-count delta between old and new rule on both DBs before switching (fail-closed: if the delta is unexplained, stop).
- PO sync from the Orders sheet: Status column → `action_items` (split on commas/newlines, map via §6.4); the four removed values → per-ASIN quantities ONLY where the sheet carries a qty; otherwise leave NULL and report counts. SPEC §14 field ownership: `action_items`, `closed_at`, and all new qty columns are **AF-owned** → excluded from `ON CONFLICT DO UPDATE SET` after the one-time backfill.
- Velocity upload eligibility, Aura/COGS cron, SellerBoard export, anything else P4 finds.

6.4 One-time migration of existing values
- Build the mapping from P5's distinct values. Expected: action-item strings → `action_items`; "Canceled" → `qty_canceled = ordered_qty` where `qty_canceled IS NULL` (PO-wide cancel) — per-ASIN partial cancels are not inferrable, leave as-is; "Returned" → `qty_returned`; "Received" → `qty_at_prep` is NOT inferrable (don't guess; leave NULL, report count); "Ordered" → nothing. Any unmapped value → STOP and report.
- Dry-run first (`?dryRun=true` pattern): print per-value counts and 10 sample rows before writing.

## 7. Commits (single-concern, in order; gate each; no per-commit approval — stop only on a real decision)

1. Pre-flight report (no code) — P1–P6 findings.
2. Migration: new `po_asins` qty columns + `po_asin_shipments` + `purchase_orders.closed_at/closed_by/action_items`; schema baseline + migration runner ledger updated.
3. Column renames + remove Unreimb. Loss from ASINs table (nested + detail tab share the column model).
4. Expand by ASIN on POs page (toggle, chevron, nested rows, persistence).
5. Closed column (col 1) + auto-close rule + Open/Closed filter.
6. Action Items column (chips, multi-select editor, filter) + consumer migration (§6.3) + one-time value migration (§6.4) with dry-run report.
7. Products table status columns (§4.3).
8. SPEC.md: PO module section rewritten to this column model; §14 ownership list extended; CLAUDE.md unchanged.
Gate per commit: `npm run check`, `npm run check:tests`, route-registration and NUL tests, dev server restart after sync/cron code. Show diffs and gate results in the output; do not wait for approval between commits. One report before pushing.

## 8. Decisions (all answered 2026-10-15)

- D1. No derived Received column. At Prep Center (from Velocity) and At CQG Warehouse (manual) are separate columns.
- D2. Auto-close = every unit accounted for AND no open action items (§5).
- D3. POs page defaults to Open only; manually unchecking Closed makes a PO Open again.
- D4. Column 10 = **Individual Units Ordered**.
- D5. Keep old `status` column for now; all code switched to the new Status (Open/Closed) + Action Items; drop later.
- Status of "Received" in §6.4: "Received" in the sheet maps to neither new column automatically (At Prep Center is Velocity-sourced, At CQG Warehouse is manual) — leave NULL, report count.

## 9. Phase 2 (next patch, not this one) — reconciliation data feeds

- SC: Fulfillment Inbound API (v2024-03-20) — list inbound shipments + items → `fba_shipment_id`, per-SKU shipped/received qty.
- Velocity: probe the API for an outbound-shipments endpoint that returns the FBA shipment ID and per-line Order # + ASIN + qty (existing integration only uses `GET /inbound`). Lines with no Order # → unmatched bucket, flagged in UI (Velocity should have an order number for every line). Confirm whether Quantity Shipped is in individual units or ASIN qty (§4.1).
- Match: (Order # → `purchase_orders.order_id`, ASIN) → `po_asins` → upsert `po_asin_shipments` → recompute Shipped FBA / Received by Amazon → auto-close (§5).
- Amazon receiving losses (SC received < shipped) are expected and simply show as Shipped FBA vs Received by Amazon — no flag needed.
- Email tracking-number parsing → Shipped by Supplier.
- Home-shipped POs + Shipments nav page.
