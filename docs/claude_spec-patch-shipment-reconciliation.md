# Spec patch — Shipment reconciliation: Velocity + Seller Central → PO ASIN rows

Date: 2026-10-17
Status: APPROVED 2026-10-17 (decisions D1–D6 answered, §8)
Depends on: `claude_spec-patch-po-expand-by-asin.md` (shipped 2026-10-16), `claude_spec-patch-po-sheet-sync.md` (shipped 2026-10-17)
Evidence: `docs/phase2-probe-2026-10-17.md`

## 0. Why

Fill At Prep Center, Shipped FBA, Received by Amazon and Shipment IDs on every PO ASIN row from the two systems that already hold the data, so the auto-close rule works and nobody reconciles by hand. Home-shipped POs (≈1%) stay manual (shipment rows can be entered by hand, per the previous patch).

## 1. What the probe established (do not re-verify)

- Velocity outbound = `GET /shipments` + `GET /shipments/:id`. All 57 shipments since May 2026 are retained (terminal status `shipped`); no date filter; `offset` is a **page index** (docs are wrong) — today's callers pass a row offset, correct only for page 0.
- Each Velocity line carries its own Order # equal to `purchase_orders.order_id` exactly; join key (Order #, retailer, ASIN) matched 29/29 on the probed shipment.
- Velocity `quantity_shipped` is **individual units**; ASIN qty = units ÷ `po_asins.units_per_pack`.
- Velocity's **public** API holds no Amazon FBA shipment ID. The dashboard gets them from `GET /api/v1/admin/fba/shipments/:id/confirmed-shipments` (session-auth only: FBA IDs, FC, boxes, tracking, per-FBA-shipment box contents ASIN/SKU/qty). Maria will ask Velocity to expose it under the API key; until then the link comes from SC (§4.2). The two sources yield the same mapping and feed the same tables.
- Velocity `/inbound` (and `/inventory`) lines carry `quantity_received`, `quantity_remaining`, `quantity_damaged`, `quantity_missing`, `unit_status` (undocumented) in component units.
- SC: Fulfillment Inbound **v0** `getShipments` / `getShipmentItems` is the working source (837 shipments back to 2024-09-04); v2024-03-20 only shows empty draft plans. SC quantities are **sellable packs** (= AF's unit). One Velocity shipment = N SC shipments (one per FC), named like "FBA STA (10/15/2026 18:01)", ship-from Velocity Prep.
- `po_asin_shipments` is empty on both DBs; the rollup trigger sums whatever unit the rows carry → rows must be written in ASIN qty.

## 2. Data model changes (migration 057)

`po_asin_shipments` is re-keyed on the Velocity shipment, since that is the unit that joins to a PO:

```
po_asin_shipments
  id                    uuid PK
  po_asin_id            uuid NOT NULL → po_asins(id) ON DELETE CASCADE
  velocity_shipment_id  text NOT NULL            -- was nullable
  fba_shipment_ids      text[] NOT NULL DEFAULT '{}'   -- the SC shipments this Velocity shipment fanned out to (D1)
  qty_shipped           numeric(10,2) NOT NULL   -- ASIN qty
  qty_received          numeric(10,2) NULL       -- ASIN qty received by Amazon, allocated (§4.3)
  shipped_at            date NULL
  source                text NOT NULL            -- 'velocity' | 'manual'
  sc_match              text NOT NULL DEFAULT 'none'  -- 'none' | 'matched' | 'ambiguous' | 'unmatched'
  created_at, updated_at
  UNIQUE (po_asin_id, velocity_shipment_id)
```
Drop the old `fba_shipment_id` column and its UNIQUE. Manual rows use `velocity_shipment_id = 'manual:<uuid>'`.

New tables:
- `velocity_shipments (id text PK, shipped_at date, status, raw jsonb, sc_shipment_ids text[], sc_match text, synced_at)` — one row per Velocity shipment; the match to SC lives here, not per line.
- `shipment_unmatched (id, velocity_shipment_id, line jsonb, reason text, created_at, resolved_at NULL)` — Velocity lines with no Order #, or (Order #, retailer, ASIN) not found in AF.

`po_asins.qty_at_prep` is written directly (no rollup table): ASIN qty = Σ `quantity_remaining` over Velocity inbound lines for that (Order #, retailer, ASIN) ÷ units_per_pack.

## 3. Velocity sync (component A)

3.1 Pull all `/shipments` (fix the offset bug first — §7 commit 2), then `/shipments/:id` for any shipment not yet in `velocity_shipments` or whose `updated_at`/status changed. Pull `/inbound` fully.
3.2 For each shipment line: resolve (Order #, retailer, ASIN) → `po_asins` row. Found → upsert `po_asin_shipments` with `qty_shipped = quantity_shipped ÷ units_per_pack`, `shipped_at`, `source='velocity'`. Not found or no Order # → `shipment_unmatched` row (one per line; re-sync updates rather than duplicates).
3.3 At Prep Center: for every `po_asins` row, `qty_at_prep` = Σ `quantity_remaining` ÷ units_per_pack over matching inbound lines; 0 when matched inbound lines exist with nothing remaining; NULL when no inbound line references that (Order #, retailer, ASIN) at all.
3.4 Fractional results are legal (previous patch §4.1). Round to 2 dp.
3.5 Fail-closed: a Velocity read error aborts the run with nothing written. The coverage tripwire stays.

## 4. Seller Central sync (component B)

4.1 Pull SC v0 `getShipments` (all statuses, from `VELOCITY_MIN_ORDER_DATE` or the earliest Velocity shipment date) + `getShipmentItems` per shipment. Cache in `sc_inbound_shipments (shipment_id PK, name, status, ship_from, created_at, raw jsonb)` and `sc_inbound_items (shipment_id, seller_sku, asin, qty_shipped, qty_received)`.
4.2 Match Velocity → SC by Velocity's own naming: Velocity names every FBA shipment `FBA STA (M/D/YYYY HH:MM)-<FC>` with its ship timestamp, so group SC shipments (ship-from Velocity Prep) by that parsed timestamp and match the group to the Velocity shipment whose shipped_at (converted to ET) is the same minute. Exclude SC shipments with status CANCELLED/DELETED from the group. Exactly one group → `matched`, `fba_shipment_ids` written on every line of that Velocity shipment. If the minute match fails (renamed shipment, clock skew), fall back to same day + SKU-set overlap and pick the best overlap; only an exact tie (same day, identical SKU sets, two Velocity shipments) → `ambiguous`, surfaced in the Unmatched panel. None → `unmatched`.
When Velocity opens `confirmed-shipments` on the API key, the same `velocity_shipments.sc_shipment_ids` is filled from it directly and SC is used only for received quantities; §4.2 matching becomes the fallback.
4.3 Received by Amazon: SC `QuantityReceived` is per SKU per SC shipment, in packs. Σ over the matched SC shipments gives received-per-SKU for the Velocity shipment. When one SKU/ASIN in that Velocity shipment spans several POs (the Twilight case: 1 + 9), allocate across the `po_asin_shipments` rows **oldest PO first** (D2), capped at each row's `qty_shipped`. Write `qty_received`; the rollup fills `po_asins.qty_received_amazon`.
4.4 Shipped FBA stays Velocity-sourced (packs = units ÷ units_per_pack). SC `QuantityShipped` is **not** compared or flagged: Velocity says what left the warehouse, SC says what Amazon received, and the difference is the normal receiving gap Maria reads off the two columns. No review work is generated from quantity differences (decided 2026-10-17).
4.5 SC v0 rate limits: respect the existing retry pattern (5 / 1000 ms); `getShipmentItems` is one call per shipment, so cache and only refetch shipments whose status is not CLOSED/CANCELLED/DELETED.

## 5. UI

5.1 ASINs table (nested rows + PO detail): Shipment IDs chip now lists `fba_shipment_ids` per shipment row ("FBA15ABC… (3)"), grouped by Velocity shipment date; a Velocity shipment with `sc_match != matched` shows the Velocity date and a warning glyph instead. Partial receipts show "received 7 of 10" in the chip tooltip.
5.2 POs page: a **Sync Shipments** button (D3) running A then B, direct call (not on a lane — it's Velocity + SP-API inbound; D3 decides). Toast: shipments pulled, lines matched / unmatched, SC shipments matched / ambiguous / unmatched, received updated.
5.3 A new **Unmatched** panel (POs page, badge count, hidden when empty): only Velocity lines with a missing or unknown Order # (`shipment_unmatched`, reason `no_order` / `po_not_found`) with a "Link to PO ASIN" picker, and the rare exact-tie `ambiguous` case of §4.2. Nothing else lands there by design.
5.4 Auto-close (previous patch §5) runs after every sync for every touched PO.

## 6. Backfill

First run processes all 57 Velocity shipments and the SC shipments since the earliest of them. Shipments before Velocity's API history (PrepBusiness era) are not reconstructed — those POs are already Closed from the sheet. Dry run first (counts per §5.2 + 10 sample lines), locally then production.

## 7. Commits

1. Pre-flight: none needed — probe is the evidence. Commit 1 = migration 057 + schema baseline + `velocity_shipments`, `shipment_unmatched`, `sc_inbound_*`.
2. Velocity client: offset-as-page fix (+ test), `/shipments/:id`, `/inbound` quantity fields typed.
3. Component A (Velocity → po_asin_shipments, qty_at_prep, unmatched), dry run, fail-closed, tests with the probed shipment as fixture.
4. Component B (SC v0 pull + cache, content match, received allocation, discrepancy rows), dry run, tests.
5. Sync Shipments button + toast + Unmatched panel + Shipment IDs chip rework.
6. SPEC §22 (PO module) reconciliation section; §14 ownership (all shipment-derived columns are sync-owned; manual edits only through the Unmatched picker or manual shipment rows); CLAUDE.md note on Velocity offset semantics.
Gates per commit as usual; dry run + live locally, one report; after deploy, dry run on production, then live, then report.

## 8. Decisions (2026-10-17)

- D1. FBA IDs stored as an array per Velocity shipment; the chip shows all of them, grouped by Velocity ship date.
- D2. Received-by-Amazon allocation when one ASIN in one shipment spans several POs and Amazon receives short: oldest PO first. Maria: units get mixed in the shipment, so which PO is short is not knowable; this is the one estimate in the design and it is accepted.
- D3. Manual **Sync Shipments** button now; an hourly pass is a scheduler-rework item later.
- D4. Ambiguity resolved automatically (minute match → best SKU overlap); only an exact tie goes to the panel.
- D5. Velocity offset bug fixed in commit 2.
- D6. `qty_at_prep` NULL until an inbound line exists for the (Order #, retailer, ASIN), then the remaining count, 0 once fully shipped.
- Principle (Maria 2026-10-17): the point of this patch is to remove manual reconciliation — no quantity-mismatch flags, no review queue beyond data-entry gaps on Velocity's side.
