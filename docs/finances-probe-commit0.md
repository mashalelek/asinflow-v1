# Finances API patch — commit 0 probe (read-only, 2026-11-20)

Spec: `docs/claude_spec-patch-finances-api.md` §10 commit 0. Answer keys:
`docs/claude_finances-sb-fixture.md`. Nothing written to any database; the
only Amazon calls were GETs plus six `createReport` requests (customer
returns ×2, removal order detail ×1, storage fee charges ×3), read through
the repo's rate-limited helpers. Production reads with `--prod`.

## Verdict

Every fixture line the spec assigns to a report reproduces inside the
acceptance tolerance, with one conflict to name: **the per-ASIN storage
figure in acceptance row 8 (−10.33 ± $1) is SellerBoard's amortized value;
under Maria's "not amortized" decision and §4's rule the panel will show
−23.30 for B0756KB8N1 on Oct 19 – Nov 17.** Everything else is a go; the
patch continues with the spec's rule and row 8's storage check is reported
as "by decision".

## (a) Customer returns report → Value of returned items, Sellable returns

Report `GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA` (two requests, 60 days
each). Columns: return-date, order-id, sku, asin, fnsku, product-name,
quantity, fulfillment-center-id, detailed-disposition (SELLABLE /
CUSTOMER_DAMAGED / DEFECTIVE / …), reason, status, license-plate-number.

Rule: **day = return-date (Pacific; the UTC day gives the same totals on
both windows); Sellable returns = Σ quantity where disposition = SELLABLE ÷
Σ quantity; Value of returned items = Σ SELLABLE quantity × (COGS + prep)
at the cost period of the return day.**

| Window | Returned | Sellable | % | SB % | Value | SB | Δ |
|---|---:|---:|---:|---:|---:|---:|---:|
| Aug 1 – 31 | 32 | 22 | 68.75 | 68.75 | 260.91 | 260.63 | +0.28 (0.1 %) |
| Oct 19 – Nov 17 | 74 | 57 | 77.03 | 77.33 | 953.96 | 956.31 | −2.35 (0.2 %) |

Within the 5 % tolerance (row 5). The October window is one returned unit
short of SB (SB ≈ 58 / 75): a return SB has that the report did not list
yet on 2026-11-20, or one SB dates into the window by a different clock.
The value uses the PO's own prep here (the fixture's basis); the patch
values it with COGS at the period plus the Settings prep rule.

## (b) Removal order detail report → Disposal of sellable products

Report `GET_FBA_FULFILLMENT_REMOVAL_ORDER_DETAIL_DATA` (Jul 1 – Sep 30).
Columns: request-date, order-id, order-source, order-type (Return /
Disposal / Liquidations), order-status, last-updated-date, sku, fnsku,
disposition, requested / cancelled / disposed / shipped / in-process
quantity, removal-fee.

Rule: **order-type = Disposal, disposition = Sellable, disposed-quantity ×
(COGS + prep) at the cost period, counted on the last-updated-date
(completion) day.** August: removal order 2608211DBH, SKU 61-6ERA-X148 =
B001TLKXNS, 1 unit, PO 2026-03-16 cost 10.66, prep 0 → **−10.66 exactly**
(request 08-21, completed 08-28; the Finances `FBADisposal` row of 08-28,
−0.84, carries the same order id). The other disposal in the file
(2609281DH2, B077H4Q6SV, completed 10-05) is outside both fixture windows.
The −3.95 "Disposal Fee" Finances row of 08-16 names a customer order, not
a removal order, and has no row in this report — it is a returned unit
Amazon disposed, and SB lists its fee under removal (fixture diff).

## (c) Storage fee report → per-ASIN storage

Report `GET_FBA_STORAGE_FEE_CHARGES_DATA`, one request per month
(dataStartTime = the month). Columns include asin, fnsku,
fulfillment_center, month_of_charge, average_quantity_on_hand,
estimated_monthly_storage_fee (one row per fnsku × FC).

| Report month | Σ estimated_monthly_storage_fee | Finances `FBAStorageBilling` row | B0756KB8N1 rows / Σ |
|---|---:|---|---:|
| 2026-07 | 51.47 | 2026-08-07, −51.47 | 5 / 0.49 |
| 2026-09 | 107.16 | 2026-10-07 (outside both windows) | 26 / 1.42 |
| 2026-10 | 445.73 | 2026-11-07, −445.73 | 23 / **23.30** |

The report's month total equals the Finances row to the cent, so SB's
−51.42 for August is SB's own rounding, and the per-ASIN split of a
Finances storage row is the report of the month before its posting day,
counted on that posting day (§4). **Conflict:** acceptance row 8 expects
B0756KB8N1's storage within $1 of −10.33 for Oct 19 – Nov 17. That is the
amortized figure (SB spreads October's 23.30 over October's days: 13 ⁄ 31 ×
23.30 = 9.77, plus an estimate for Nov 1 – 17). With "not amortized" the
window holds the whole November 7 posting: **−23.30**. The patch follows
the decision; the row is reported as a known difference, not a bug.

## (d) Inbound transportation → −95.66 on B0756KB8N1

Every `FBAPostInboundTransportation` row names its FBA shipment in
`ORDER_ID` (FBA19…); the row has no items. Of the 39 rows posted in the
window (−1,217.90), 29 shipments are in `sc_inbound_shipments` and 10
(−275.01, the Nov 14 postings) are not yet — their contents were read live
from `GET /fba/inbound/v0/shipments/{id}/items` for the fit. Six shipments
carry the ASIN (2 units each).

| Weighting over the shipment's items | B0756KB8N1 share | SB |
|---|---:|---:|
| units (qty_shipped) | −13.88 | |
| **weight (qty_shipped × asins.weight_lb)** | **−95.73** | −95.66 |
| volume (dims) | 0 (dims missing on most ASINs) | |
| equal per shipment | −17.73 | |

**Weighting = weight.** Fixed for commit 4. Consequence: the shipment
contents must be in AF for every shipment a fee row names — the ingest
reads the ten missing ones through the same endpoint (`shipment-sync-sc.ts`
already pages that API) when a fee row's shipment is unknown.

## (e) Settings: where prep and the hazmat surcharge live today

- **Database** `settings (key varchar PK, value jsonb, updated_at)`, read by
  `GET /api/settings` (every key, `parseFloat`) and `server/profit-settings.ts`.
  Production today: `prep_cost 1`, `hazmat_prep_surcharge 0`,
  `hazmat_ship_surcharge 0`, `inbound_shipping_per_lb 0.5`,
  `low_inventory_surcharge 0.26`, `additional_fees 0`, `min_roi 15`,
  `min_margin 10`, `include_inbound_shipping true`; legacy duplicates
  `hazmat_prep 0`, `hazmat_shipping 0` (unread). No key exists for storage
  fee, min profit / unit or the three max-COGS thresholds.
- **Browser** `localStorage["fba-analyzer-settings"]` (`client/src/lib/settings.ts`,
  type `Settings` in `shared/schema.ts`): inboundShippingCost, prepCost,
  storageFee, lowInventorySurcharge, hazmatShipSurcharge,
  hazmatPrepSurcharge, minRoiThreshold, minMarginThreshold,
  minProfitUnitThreshold, maxCogsMinMarginPct, maxCogsMinRoiPct,
  maxCogsMinProfitUnit. Read by home, Bulk Calc, Repricer, Analytics and the
  Settings dialog; **no client code reads `/api/settings`**, so the $1.20
  prep and $1.00 hazmat surcharge the acceptance table calls "today" exist
  only in Maria's browser.
- **Migration 122:** one key per `Settings` field (snake_case), seeded with
  the DB's current value where one exists and the browser default
  otherwise, plus `prep_cost = 1.20` and `hazmat_prep_surcharge = 1.00`
  (the values the acceptance table states; the dialog can change them). A
  `PUT /api/settings` saves them; the client loads them once per page and
  drops the localStorage copy.

## Keys the ingest will use (from the raw transactions)

- Shipment rows carry `ORDER_ID`, `SHIPMENT_ID` (and `OBFUSCATED_SHIPMENT_ID`),
  `SETTLEMENT_ID`; a RELEASED row names its `DEFERRED_TRANSACTION_ID`, a
  DEFERRED_RELEASED row its `RELEASE_TRANSACTION_ID`. Natural key per fee
  row: (order id, shipment id, SKU).
- Refund rows carry `ORDER_ID` and `REFUND_ID`: key (order id, refund id, SKU).
- ServiceFee rows: `ORDER_ID` = the FBA shipment (inbound fees), the removal
  order (removal / disposal) or the customer order (customer-return fee);
  storage and subscription rows have none.
- `FBAInventoryReimbursement` rows: ASIN / SKU / quantity in the item
  context; `description` is the reason.
- `Transfer` rows: `SETTLEMENT_ID`, `FINANCIAL_EVENT_GROUP_ID`.
