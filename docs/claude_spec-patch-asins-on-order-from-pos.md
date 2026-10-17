# Spec patch — ASINs page: on-order quantities derived from POs

Date: 2026-10-17
Status: APPROVED 2026-10-17 (decisions in §6 are Maria's defaults; stop only on pre-flight surprises)
Depends on: shipment reconciliation (`claude_spec-patch-shipment-reconciliation.md`, head 8da162a)

## 0. Why

Since 2026-10-17 AF knows, per PO ASIN row, what was ordered, canceled, returned, lost, what sits at Velocity, what shipped to FBA and what Amazon received. The ASINs page still shows a single "Ordered" number copied from the Orders sheet (`asin_estimates.ordered_qty`, written by the per-ASIN half of Sync POs), which never decreases when units ship. Maria expected the ASINs page to reflect shipments; it must derive its on-order picture from `po_asins` and stop reading the sheet's number.

## 1. Pre-flight (commit 1, report in the final report; stop only on a surprise)

P1. Exactly how the ASINs-page "Ordered" column (and any inbound/on-order figure elsewhere: Analytics, Bulk Calc, exports, SB COGS export, Aura push, restock logic) is computed today — column, writer, every reader with file:line.
P2. What `asin_estimates.ordered_qty` is used for beyond display (any formula, e.g. days-of-stock, restock priority, profit) — list each.
P3. Whether the FBA Inventory sync already exposes Amazon's own inbound counts (`inboundWorkingQuantity`, `inboundShippedQuantity`, `inboundReceivingQuantity` from `getInventorySummaries` with `details=true`) and whether AF stores them. These are Amazon's view of the same thing as "Inbound FBA" below.
P4. Join path `asins` ↔ `po_asins` (by ASIN; confirm no per-SKU split is needed).

## 2. Definitions (all in ASIN / sellable-pack units, from `po_asins`, OPEN POs only — clean-up 2026-10-17)

For each ASIN, summing over its `po_asins` rows whose PO is Open:

- **Expected** = Ordered − COALESCE(Canceled,0) − COALESCE(Returned,0) − COALESCE(Lost/damaged by us,0). Units that should eventually reach Amazon.
- **On Order** = Σ max(Expected − COALESCE(Shipped FBA,0), 0). Bought, not yet shipped to FBA. Includes units still at the supplier, at Velocity and at the house.
- **At Prep Center** = Σ COALESCE(At Prep Center,0). Subset of On Order.

Shipped-not-received units are Amazon's own number, **Sent to FBA** (`inventory_snapshots.inbound_shipped + inbound_receiving`), unchanged. The first cut's Inbound FBA and Pipeline columns were removed in the same-day clean-up (one number per meaning; Amazon's inbound already covers the shipped-not-received part and feeds Stock).

NULL semantics: a row with Shipped FBA NULL (never reconciled) counts its full Expected as On Order. That is right for POs after May 2026 (all reconciled); for older closed POs it would overstate, so rows whose PO is Closed are excluded (D1).

## 3. Changes

3.1 Server: `asin_po_pipeline(asin) → {on_order, at_prep, open_po_count}` computed live from `po_asins` + `purchase_orders` (no new stored column; the PO tables are the source). Index on `po_asins(asin)` exists.
3.2 ASINs page: the "Ordered" column is replaced by **On Order** (visible by default); new column **At Prep** (hidden by default); tooltips naming the formula. Column manager / view presets / export CSV headers follow the shared column defs. Clicking On Order opens the POs page filtered to that ASIN's open POs (`/purchase-orders?asin=`). Stock tooltip lines: Available (FBA), Reserved, Sent to FBA, On Order (POs) — nothing else. "Sent to FBA" keeps its label.
3.3 Every reader found in P2 that used `ordered_qty` as "units coming" switches to On Order: Stock total = available + reserved + Sent to FBA + On Order; FBA Stock = Stock − On Order; Days Left inherits; `inventory_snapshots.ordered_qty` records On Order at snapshot time; the history modal shows On Order (POs).
3.4 Sync POs (per-ASIN half) stops writing `asin_estimates.ordered_qty`; column left in place, unread, dropped in a later cleanup migration. SPEC §14 ownership: on-order figures are derived from PO tables, never synced from the sheet.
3.5 Amazon's inbound counts are already stored (P3) and shown as Sent to FBA — no relabel, no new SP-API stage.
3.6 Bulk Calc excludes the Stock group (no change); Analytics reads the same column ids.

## 4. Commits

1. Pre-flight report (P1–P4), no code.
2. `asin_po_pipeline` query + tests (fixture: an ASIN with one closed pre-May PO, one open PO partly shipped, one over-received row).
3. ASINs page columns, column manager, presets, export; POs-page link.
4. Reader migration (§3.3) + Sync POs stops writing `ordered_qty` (§3.4).
5. Bulk Calc / Analytics swap (§3.6) + Amazon Inbound if available (§3.5).
6. SPEC §6 (ASINs columns), §14, §22; CLAUDE.md untouched.
Gates per commit; one report before pushing; after deploy, spot-check three ASINs on production (one fully shipped, one partly, one unreconciled old PO) and report their five numbers.

## 5. Out of scope

Sheet ownership flip, PO editing in AF, new-PO form — next patch (`claude_spec-patch-po-af-owned.md`, to be written).

## 6. Decisions (Maria 2026-10-17 defaults)

- D1. Closed POs are excluded from On Order / At Prep (a closed PO has nothing left to ship by definition; this also neutralises pre-May POs with no shipment rows).
- D2. "Ordered" column is renamed On Order rather than kept alongside — one number, one meaning.
- D3. No stored column; computed live. Revisit only if the ASINs page query gets slow (2,579 ASINs × ~1,600 po_asins rows is small).
