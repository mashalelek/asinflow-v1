# Phase 2 probe — shipment reconciliation data feeds (read-only, 2026-10-17)

Scope: `docs/claude_spec-patch-po-expand-by-asin.md` §9 Phase 2. Every call
below was a GET (Velocity) or an SP-API GET; no DB writes, no code changes.
Local DB at `ca5e2d3` (1,062 POs after the sheet sync). Findings only — no
proposals.

## A. Velocity API

### A1. What the integration knows today

| Item | Value |
|---|---|
| Base URL | `https://api.velocityprepservices.com/api/v1` (`server/velocity-api.ts:12`) |
| Auth | `Authorization: ApiKey ${VELOCITY_API_KEY}` + `X-Warehouse-Id: ${VELOCITY_WAREHOUSE_ID}` on every call (`velocityFetch`, `:71–100`); 429 → wait Retry-After (else 5 s), retry once |
| Docs | `https://docs.velocityprepservices.com/` — pages `/introduction-docs`, `/api-keys`, `/warehouses-docs`, `/inbound-docs`, `/inventory-docs`, `/outbound-docs` (the last is the Shipments API). No OpenAPI file; no copy in the repo |
| Endpoints used | `GET /inbound` (paginated, `listInboundOrders`), `GET /inbound/:order_id` (bundle identity, reconcile), `POST /inbound` multipart `bulk=true` (`submitBulkCsv`) and per-order (`createBundleOrder`), `PUT /inbound/:order_id` (`updateInboundOrder`), `GET /inventory` (`fetchAllInventoryOrders`), `GET /shipments?limit=-1` + `GET /shipments/:id` (`fetchAllKnownOrders`), `GET /warehouses` (setup only) |
| Fields read | `order_id`, `order_number`, `asin`, `date` (MM/DD/YYYY), `sold_as`, `status`, `item_name`, `quantity`, `bundle_children[]`, `bundle_order_id`; from shipment lines `quantity_shipped`, `units_per_pack`, `amazon_sku`, `created_at` (`shipmentOrdersFrom`, `:315–347`) |
| Docs-wrong notes already recorded | SPEC §11: `/inbound` serves only active-inbound orders, received-not-shipped orders live in `/inventory`, fully shipped orders only in shipment details; shipment details omit `bundle_children`; `/inventory?limit=-1` includes `quantity_remaining = 0` rows; shipment `shipped_at` is RFC-1123 while `date` is MM/DD/YYYY (`scripts/velocity-dwell.ts` header) |

### A2. Outbound / shipment endpoints

Probed paths: `/outbound`, `/outbound-shipments`, `/fba-shipments`,
`/outbound?limit=2` → HTTP 404 (HTML, not JSON). The outbound API **is**
`GET /shipments` and `GET /shipments/:shipment_id` (docs page
`/outbound-docs`), already used by `fetchAllKnownOrders`.

**List** (`data.shipments[]`, `data.results{current_page, showing_from,
showing_to, total_results}`): 57 shipments, all `status = "shipped"`,
`shipped_at` 2026-05-20 → 2026-10-15, all `fulfillment_type = "fba"`,
`shipping_mode = "spd"`, `shipping_method = "warehouse"`. Row fields:
`shipment_id` (UUID), `status`, `stage`, `name` (free text, 16 of 57
non-empty, e.g. "velocity optimized 7/16"), `created_at`, `shipped_at`
(RFC-1123 GMT), `latest_ship_date`, `destinations[] {fc, city, state}`,
`total_quantity_shipped`, `trackings[] {carrier, tracking_number, …}`,
`invoice_id`, `full_name`, `notes`, `tags`, `client_paused`,
`ship_damaged`, `scanned_trackings`, `shipping_information_set`,
`fbm_status`, `pick_session_id`, `user_id`.

**Detail** (`data`): `orders[]` (the lines), `boxes[]`, `services[]`,
`trackings[]` (fuller), `attachments[]`, `unit_services_summary[]`,
`seller_central_linked` (true), `wfs_linked` (true), `stage`, `results`
(line count). No `shipped_at`, no destinations on the detail — those are
on the list row only.

**Line fields** (62 keys; the ones that matter): `order_id` (Velocity
order UUID), `order_number` (the supplier order #, as entered), `asin`,
`amazon_sku`, `fnsku`, `upc`, `item_name`, `retailer` (= supplier),
`date` (order date MM/DD/YYYY), `sold_as` (`individual` / `multi-pack` /
`bundle`), `units_per_pack` (null for individual), `quantity`,
`quantity_received`, `quantity_shipped`, `quantity_remaining`,
`quantity_damaged`, `quantity_missing`, `quantity_removed`, `status`
(`outbound` 741 / `inventory` 69 / `inbound` 12 across all 822 lines),
`unit_status` (`fully_received` 810 / `partially_received` 12),
`check_ins[] {check_in_id, created_at (ISO UTC), quantity_checked_in,
locations[], received_order_id}`, `fba_data {hazmat, oversized,
expiration?}`, `bundle_order_id`, `prepbusiness_inbound_shipment_id`,
`prepbusiness_inbound_item_id`, `created_at`, `warehouse_id`.

**Amazon FBA shipment ID: not present anywhere.** A regex scan of all 57
detail payloads (822 lines) for `FBA[0-9A-Z]{9}` found 0 matches. The
only "shipment id" on a line, `prepbusiness_inbound_shipment_id`, is set
on 52 lines with 28 distinct values like `1037946` — PrepBusiness-era
internal ids whose orders carry `order_number` of the form
`INSH-051226-1037946-13766689` (May 2026 migration), not Amazon ids.
`seller_central_linked: true` exposes nothing further. The docs confirm:
no FBA-id field is documented.

**Received-vs-shipped per line:** yes — `quantity_received` (checked in at
Velocity), `quantity_shipped` (this shipment's part), `quantity_remaining`
(still at Velocity after this shipment), `unit_status`. For a shipped
order `status` is `outbound` when fully shipped, `inventory` when units
remain, `inbound` when not fully received.

### A3. The 2026-10-15 shipment `73917fcd-bc7b-4790-9513-b44dd5fe16f7`

List row: `shipped_at "Thu, 15 Oct 2026 18:03:37 GMT"`,
`total_quantity_shipped 340`, 5 destinations RMN3 / GYR3 / LGB8 / IND9 /
MDW2, 5 UPS trackings, `name ""`. Detail: 29 order lines, one box type ×5.

| Line | `order_number` | `retailer` | `sold_as` | `units_per_pack` | `quantity` | `quantity_received` | `quantity_shipped` | `quantity_remaining` | `status` |
|---|---|---|---|---|---|---|---|---|---|
| Equal Exchange B004WZ4CLW (`EQL-NUL-CLW-OPE-001`) | `SHOP533384` | shop.equalexchange.coop | multi-pack | 6 | 60 | 60 | **60** | 0 | outbound |
| Twilight 0349125937 (`ATO-BOO-937-TDC-001`) | `102003843107733` | target.com | individual | null | 3 | 3 | **1** | 2 | inventory |
| Twilight 0349125937 (same SKU) | `102003840691113` | target.com | individual | null | 9 | 9 | **9** | 0 | outbound |

**Quantity Shipped is in individual (component) units.** AF holds
`po_asins.qty = 10`, `units_per_pack = 6` for SHOP533384 / B004WZ4CLW;
Velocity reports 60 = 10 × 6. Same on the other two multi-packs in this
shipment: Lenox `WB5741517959` Velocity 30 vs AF 10 × 3; Caron
`200015297647874` Velocity 45 vs AF 15 × 3. Seller Central reports the
same three as 10 / 10 / 15 (A7). So: Velocity = individual units; SC and
AF = sellable packs; conversion is `quantity_shipped ÷ units_per_pack`
(null → 1).

**Each line carries its own `order_number`**, and it is exactly
`purchase_orders.order_id` (string-equal, no padding or prefix). Join test
on `(order_number = order_id, retailer = supplier, asin)`:

| Result | Lines |
|---|---|
| Matched a `po_asins` row | **29 / 29** |
| PO found, ASIN missing | 0 |
| Order # found under another supplier | 0 |
| No PO | 0 |

`po_by_number` (order_id alone, ignoring supplier) was 1 for every line —
no ambiguity on this shipment. Three order numbers appear on more than
one line (`6461301` ×4 ASINs, `4400107766538757` ×2, and the two Twilight
lines are two different POs for one ASIN), each resolving to its own
`po_asins` row.

### A4. Pagination, filters, rate limits, completed shipments

- **`offset` is a page index, not an item offset.** `limit=10&offset=1`
  returns rows 11–20 (`current_page 2, showing_from 11`);
  `limit=10&offset=10` returns 0 rows (`showing_from 101`). Same on
  `/inventory` (`limit=50&offset=50` → `showing_from 2501`, 0 rows).
  Verified row-for-row against `limit=-1`: `offset=1` equals
  `all[10..20]`, not `all[1..11]`. The docs call it "items to skip" —
  docs-wrong. Today's callers (`fetchAllInboundOrders`,
  `fetchAllInventoryOrders`, `listAll` in the dwell script) pass
  `offset = page × 200`, which is only correct for page 0; with more than
  200 rows the second request would ask for page 201, come back empty,
  and the coverage tripwire would throw (fail-closed, not silent). Current
  volumes: 68 inbound, 123 inventory, 57 shipments — all single-page.
- `limit=-1` returns everything (57 / 123 / 68 rows, `total_results`
  equal).
- **Filters:** `statuses` accepts `working, requested, picking, picked,
  shipped` (`?statuses=pending|closed|received|completed` → 0 rows, not an
  error). `fulfillment_types`, `shipment_id`, `sort_key`, `sort_order`
  documented. **No date filter exists**: `from`, `shipped_from`,
  `date_from`, `start_date` were all ignored (still 57 rows).
- **Rate limits:** none documented ("be reasonable"); no rate headers in
  any response; 78 GETs in one run and 15 back-to-back GETs in 1.6 s
  produced no 429.
- **Completed shipments are retained:** the only terminal status is
  `shipped`, and all 57 shipments since 2026-05-20 are still listed — no
  "closed" gap like `/inbound`'s. A line inside a shipped shipment keeps
  its live order status (`outbound` / `inventory` / `inbound`), so the
  same order can appear in several shipments (`B076YKY47B` ships 1 then 4
  from two POs here).

### A5. Inbound side — per-line received quantity

Yes. `GET /inbound` (68 rows, `status = inbound`), `GET /inventory` (123
rows: `inventory` 104, `inbound` 19) and `GET /inbound/:order_id` all
carry `quantity`, `quantity_received`, `quantity_remaining`,
`quantity_damaged`, `quantity_missing`, `quantity_removed`, `unit_status`
(the docs list none of these as response fields — docs-wrong). List rows
also carry `check_ins[]`; `/inbound/:order_id` does not, and has no
`quantity_shipped`. Example (`/inventory`, partially received):
`200015279183885` B076YKY47B `quantity 12, quantity_received 3,
quantity_shipped 1 (shipment leg), quantity_remaining 2, unit_status
partially_received`. "At Prep Center" = `quantity_remaining` in component
units (= received − shipped − removed).

## B. Seller Central (SP-API)

### B6. Fulfillment Inbound v2024-03-20 role

Yes. `GET /inbound/fba/2024-03-20/inboundPlans?pageSize=5&sortBy=LAST_UPDATED_TIME&sortOrder=DESC`
→ HTTP 200 with 5 plans and a `pagination.nextToken`. (`status=SHIPPING`
→ 400 `InvalidInput … enum value set: [ACTIVE, SHIPPED, VOIDED]`.)

But the data is empty: all **83** plans (paged, created 2024-05-27 →
2026-09-19) are `status ACTIVE`; `getInboundPlan` on the newest returns
`shipments: []`, `packingOptions: []`, `placementOptions: []`, and
`listInboundPlanItems` returns `items: []`. These are abandoned Send-to-
Amazon drafts from the seller account, not Velocity's shipments.
`getShipment` / `listShipmentItems` could not be exercised (no shipment
exists on any plan). Rate-limit table note: `[sp-api-limit] no rate table
entry for /inbound/fba/2024-03-20/inboundPlans` and for
`/fba/inbound/v0/shipments` — both sent unpaced today.

### B7. One recent FBA shipment, and the Velocity match

Velocity's 2026-10-15 18:03 shipment to five FCs corresponds to **five**
SC shipments named `FBA STA (10/15/2026 18:01)-<FC>`, ship-from "Velocity
Prep, 805 Grandy Ave, La Grande OR 97850", all `IN_TRANSIT`,
`LabelPrepType SELLER_LABEL`, `BoxContentsSource INTERACTIVE`:

| `ShipmentId` | FC |
|---|---|
| `FBA19T7ZQ9JQ` | IND9 |
| `FBA19T7TWVK4` | MDW2 |
| `FBA19T7XBNZC` | GYR3 |
| `FBA19T81WCMB` | RMN3 |
| `FBA19T7Y1DV1` | LGB8 |

`GET /fba/inbound/v0/shipments/{id}/items` (the `ShipmentId=` query form
rejects with "Either the ShipmentId or a pair of LastUpdatedAfter…"; the
path form works) over the five: 135 item rows, **27 distinct `SellerSKU`,
`QuantityShipped` Σ 240, `QuantityReceived` Σ 0** (in transit). Per-SKU
comparison with the Velocity lines (29 lines, 27 SKUs after summing the
two Twilight and two Golden Rewards lines, Σ 340 individual units):

| Outcome | SKUs |
|---|---|
| Equal | 24 |
| Differ | 3 — the multi-packs: `EQL-NUL-CLW-OPE-001` 60 vs 10, `LEN-TOO-2QF-GGT-001` 30 vs 10, `CRN-ART-J2A-SSY-005` 45 vs 15 |
| Only in SC / only in Velocity | 0 / 0 |

So Velocity ↔ SC matching is by (ship-from Velocity, name timestamp ≈
`shipped_at`, FC set) at shipment level and by `amazon_sku` =
`SellerSKU` at line level — Velocity never reports the FBA id itself.
Velocity's other 10/15 shipment (`97c1d401…`, MEM2, 19:21, 30 units) is
`FBA19T84285M` "(10/15/2026 19:16)-MEM2". A receiving shipment shows the
received field populating: `FBA19S910R31` (10/07, LGB8, `RECEIVING`) has
36+ items with `QuantityReceived` = `QuantityShipped` on the first page
(`2G-YQBI-8DUI` 14/14, `ACE-HEA-8P2-AKB-001` 2/2, …).

v0 `ShipmentData` carries only `ShipmentId, ShipmentName, ShipFromAddress,
DestinationFulfillmentCenterId, ShipmentStatus, LabelPrepType,
BoxContentsSource` — no timestamps; the date lives in the name
(`FBA STA (MM/DD/YYYY HH:MM)` — within 2 minutes of Velocity's
`shipped_at` in UTC).

### B8. How far back, and whether v0 is needed

`GET /fba/inbound/v0/shipments` with `QueryType=DATE_RANGE`,
`LastUpdatedAfter 2020-01-01` (identical result for 2024-01-01): **837
shipments** over 18 pages (`NextToken`), statuses CLOSED 740, CANCELLED
68, IN_TRANSIT 11, RECEIVING 15, DELIVERED 3. 713 carry a dated STA name:
oldest **2024-09-04**, by year 2024: 5, 2025: 323, 2026: 385; 124 have
free names ("Shipment #2"). Ship-from names: Velocity Prep / Velocity Prep
La Grande, Maria Peters, Coastal Quality Goods, Seattle WA, Lexington NE.
A delta query `LastUpdatedAfter 2026-10-16` returned 3 shipments (all
CLOSED, i.e. status changes surface through LastUpdated).

**v0 is needed for everything, not only history:** v2024-03-20 exposes no
shipment for this account (B6), while v0 lists all 837 and gives per-SKU
shipped / received. Whether 2024-09-04 is the account's first FBA
shipment or a rolling window cannot be told from the API alone.

## C. Our side

### C9. `po_asin_shipments` and the rollup

`SELECT count(*) FROM po_asin_shipments` → **0** (local and production,
checked 2026-10-17). Columns: `id serial`, `po_asin_id uuid NOT NULL
REFERENCES po_asins(id) ON DELETE CASCADE`, `fba_shipment_id text NOT
NULL`, `velocity_shipment_id text`, `qty_shipped numeric NOT NULL`,
`qty_received numeric`, `shipped_at date`, `source text NOT NULL`,
`created_at`, `updated_at`; `UNIQUE (po_asin_id, fba_shipment_id)`.

Trigger `po_asin_shipments_rollup_trg` AFTER INSERT OR DELETE OR UPDATE
FOR EACH ROW → `po_asin_shipments_rollup()`: recomputes
`po_asins.qty_shipped_fba = SUM(qty_shipped)` and `qty_received_amazon =
SUM(qty_received)` for the affected `po_asin_id` (both ids when
`po_asin_id` changes). Note the sums are over whatever unit the rows
carry; `po_asins.qty` is sellable packs.

### C10. Join of the probed shipment to `po_asins`

All 29 lines join by `(order_number → purchase_orders.order_id, retailer →
supplier, asin → po_asins.asin)`; unmatched bucket: **0**. Sellable-pack
quantities after `÷ units_per_pack`: 24 lines equal AF's `po_asins.qty`
in full (fully shipped) and 5 are partial (`102003843107733` 1 of 3,
`200015279183885` 1 of 12, `200015295664067` 4 of 9, `2026282610914334` 5
of 8, `2465154869` 5 of 10, `4400107766538757` B08BR4NC22 15 of 20,
`6461301` B00GS5KM9A 15 of 50 and B008DG32FI 5 of 10, `824701` 10 of 12,
`833416` 5 of 6) — the remainder is `quantity_remaining` at Velocity.

## Docs-wrong additions (for SPEC §11 when the patch is written)

1. `offset` on every Velocity list endpoint is a page index (A4).
2. Velocity list rows expose `quantity_received`, `quantity_remaining`,
   `quantity_damaged`, `quantity_missing`, `quantity_removed`,
   `unit_status`, `check_ins[]`; none is documented (A5).
3. The Shipments docs list 7 line fields; the API returns 62, including
   `order_number`, `retailer`, `quantity_received`, `quantity_remaining`,
   `fnsku`, `status`, `check_ins` (A2).
4. No date filter on `/shipments`; unknown query params are ignored, not
   rejected (A4).
5. `GET /fba/inbound/v0/shipmentItems?ShipmentId=` is rejected; the
   per-shipment path form `/shipments/{id}/items` is the one that works
   (B7).

## Addendum 2026-10-17 — where the FBA shipment IDs live (follow-up probe)

Velocity's web UI shows, for shipment `73917fcd…`, an "All Shipments
Overview" tab with one FBA shipment per FC (`FBA19T81WCMB` RMN3,
`FBA19T7XBNZC` GYR3, `FBA19T7Y1DV1` LGB8, …), box dimensions / weight and
a UPS tracking per box. The public API does not expose any of it:

- **Docs re-read** (`/outbound-docs`, `/outbound` user guide): the only
  shipment resources documented are `GET /shipments` and
  `GET /shipments/:shipment_id`. No overview / plan / fba / boxes /
  packing / labels / tracking sub-resource is documented anywhere on the
  site; the user guide describes the detail page as items, destination,
  shipping method, tracking numbers and notes.
- **Sub-resource probes** on `/shipments/73917fcd…/{overview, plan, plans,
  fba, fba-shipments, fba_shipments, amazon, amazon-shipments,
  amazon_shipments, boxes, packages, packing, packing-list, tracking,
  trackings, label, pallets, destinations, contents, items, orders, units,
  box-contents, shipment-plan, sc, seller-central, seller_central,
  inbound-shipments, fba-plan, summary, details, export, invoice,
  pick-session, all}` → HTTP 404 (HTML). One exists:
  `GET /shipments/:id/labels` → 400 `"This shipment doesn't have any
  labels attached yet."` for all 57 shipments (0 of 57 return 200), so it
  carries nothing today. Top-level `/fba-shipments`, `/amazon-shipments`,
  `/amazon/shipments`, `/shipment-plans`, `/plans`, `/boxes`, `/packages`,
  `/trackings`, `/pick-sessions` → 404. `?include=`, `?expand=`, `?view=`
  on the detail are ignored (same 11 keys).
- **Full nested key inventory** of `GET /shipments/:id` (every path,
  arrays descended): top level `attachments[]`, `boxes[] {box_id, name,
  length, width, height, quantity, price_per_unit}` (one box type ×5, no
  weight, no per-box contents, no FC), `has_tracking`, `orders[]` (64
  keys, none shipment-related beyond `quantity_shipped`,
  `shipping_labels[]` = empty, `trackings[]` = empty), `results`,
  `seller_central_linked`, `services[]`, `stage`, `trackings[]` (31 keys
  per tracking: `tracking_number`, `carrier`, `tracking_id`, `packages`
  = null, `label_url` = null, cost / provider / rate fields all null,
  `source "manual"`), `unit_services_summary[]`, `wfs_linked`. Raw-text
  search of the detail for `FBA[0-9A-Z]{9}`, for any of the five FC codes,
  and for `amazon_shipment|fba_id|shipment_name|plan|packing|
  box_contents|weight|dimension|lbs` → 0 matches each. The list row adds
  only `destinations[] {fc, city, state}` and `total_quantity_shipped`.
- **Invoices** (`GET /invoices`, `GET /invoices/:id` — found by probing,
  undocumented): billing lines only (`shipments_billed[] {fulfillment_type,
  items[]}`, unit / box / service charges); no shipment or FBA ids.
- **Per-SKU breakdown per FBA shipment (RMN3 vs GYR3 vs LGB8): not
  available from Velocity.** Lines carry `quantity_shipped` for the whole
  Velocity shipment, not per destination; the five trackings are not tied
  to boxes, FCs or lines (`packages: null`). The per-FC split is available
  from Seller Central: `GET /fba/inbound/v0/shipments/{FBA id}/items`
  gives `SellerSKU` / `QuantityShipped` / `QuantityReceived` per FBA
  shipment (B7 above: 135 item rows across the five).

**Step 3 could not be run from here:** the Claude Chrome extension is not
connected in this session. What to capture in the browser (DevTools →
Network, filter XHR/Fetch, then open the shipment and click the "All
Shipments Overview" tab):

1. The request URL and method the tab fires (likely a host other than
   `api.velocityprepservices.com/api/v1`, e.g. an `/internal/`, `/v2/`,
   `/app/` or `/graphql` path, or a path under the shipment id such as
   `…/shipments/73917fcd…/amazon` or `…/fba_shipments?shipment_id=`).
2. Its request headers: whether it authenticates with the same `ApiKey`
   + `X-Warehouse-Id` pair or with a browser session cookie / bearer
   token (decides whether the API key can call it).
3. The response JSON: the key names that hold `FBA19T81WCMB` etc., the
   FC, box dimensions / weight, and the tracking per box; and whether each
   FBA shipment carries its own SKU / quantity lines.
4. Any other XHR on the same page load whose response contains the string
   `FBA19T` (search the Network panel responses), in case the ids arrive
   with the page's initial shipment payload under a different endpoint.
