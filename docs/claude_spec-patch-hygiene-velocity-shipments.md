# SPEC Patch — Listing hygiene: the Velocity pipeline check includes units in Velocity shipments not yet at FBA

*Drafted 2026-10-31 with Maria, from the job-324 incident. Amends the listing
hygiene patch (`claude_spec-patch-listing-hygiene.md`, rule 3 and rule 4) and
SPEC §11 component 24. Decision: fix the rule, then relist (Maria 2026-10-31,
option 1). No change to component 22.*

## Why

On 2026-10-30 05:45 UTC the scheduled 00:00 ET pass (job 324) deleted 11
closed listings whose units were sitting in ONE Velocity shipment in status
`working` (stage `validate_items`, created 2026-10-28, 164 units, 33 ASINs):
ARI-GRO-QPQ-TAP-002, CRN-ART-61V-BBS-004, SPR-HEA-RW3-AES-006,
KAY-BPC-SCP-VCR-002, ZAR-BPC-9MW-WRW-004, SAN-BPC-J9W-VAE-002, QM-UL2V-D9HN,
AX-DB16-LN8Z, HB-BHNQ-3CI5, ZAR-BPC-84B-VCC-003, NAB-GRO-5VB-SCV-003 — 76
units. Velocity then could not create the FBA shipment for them ("MSKUs
invalid", Jonathan, Discord 2026-10-30).

Every input the rule reads was zero and the rule behaved as written:

- **FBA buckets**: all 0. The FBA shipment does not exist while the Velocity
  shipment is `working`, so `inbound_working/shipped/receiving` cannot show
  the units. Rule 3's note "units shipped but not yet received are already
  caught by the inbound buckets" is true only AFTER Velocity has created the
  FBA shipment.
- **Velocity on hand**: `velocityOnHandByAsin` sums `quantity_remaining` over
  `/inbound` ∪ `/inventory`. An order line that has been picked into a
  shipment has `quantity_remaining = 0` (status `outbound`), so the units
  vanish from "on hand" the moment they are packed, before FBA knows them.
- **OOS clock**: the eight AF-created SKUs passed the never-stocked branch
  (39–89 days > 14); the three relisted on 2026-10-29 passed the ever-stocked
  branch on their OLD ledger history (115–165 days > 60) twelve hours after
  the relist.

The gap is the window **Velocity packed → FBA shipment created**. It is
exactly the window in which a deleted MSKU breaks the shipment.

## Rules (amendments)

**3. Delete — pipeline check (amended 2026-10-31).** "No Velocity units"
means BOTH of:

- **on hand**: Σ `quantity_remaining` > 0 over `/inbound` ∪ `/inventory`
  (unchanged), and
- **in a Velocity shipment that has not shipped**: Σ `quantity_shipped` over
  the order lines of every shipment in `GET /shipments` whose `status` is not
  `shipped` (today the only such status is `working`; any unknown status
  counts, so a new Velocity state can only hold a delete, never allow one).
  One count per (shipment_id, order_id); per ASIN, summed over the SKU's
  ASINs like on-hand. Bundle lines use the parent `quantity` (same reading as
  `shipmentOrdersFrom`).

Either sum > 0 → `skip_pipeline:velocity` (outcome name unchanged). Evidence
gains `pipeline.velocity_in_shipments` next to `velocity_on_hand`, plus the
shipment ids read, so the dialog shows WHICH shipment held the SKU.

Coverage stays fail-closed: the shipment list goes through `listAllShipments`
(the `total_results` tripwire), each non-shipped shipment's detail through
`getShipmentDetail` (throws without an `orders` array). Any leg failing →
the whole run is `velocity_unavailable`, exactly as today. Cost: one list
call plus one detail call per non-shipped shipment (1 today).

**4. OOS clock — a relisted SKU starts over (amended 2026-10-31, the
"bandage", kept as a second guard).** The ever-stocked branch measures from
`max(ledger_last_stocked_date, inventory_last_nonzero_at, listing createdDate)`.
For a SKU that has never been relisted the listing predates every stock
date, so nothing changes; for a relisted SKU the new `createdDate` is the
latest date and the 60-day clock restarts at the relist. Evidence `clock`
gains `created_considered: true|false`.

**Not changed:** component 22 (close) reads no pipeline and keeps closing
OOS listings, relisted or not — Maria reopens by hand when stock lands.
The amzn_gr delete rule reads neither Velocity nor the clock and is
unaffected. The 2026-10-19 "no open-PO blocker" stands.

## Mechanism

- `server/velocity-api.ts`: `fetchUnshippedShipmentLines()` — `listAllShipments()`,
  filter `status !== "shipped"`, `getShipmentDetail()` each, return
  `shipmentOrdersFrom()` lines tagged with `__shipment_id` and the shipment
  status. Pure helper `velocityInShipmentsByAsin(lines)` in
  `server/listing-hygiene.ts` beside `velocityOnHandByAsin`.
- `ScDeps.velocity` keeps returning the on-hand orders; a new
  `ScDeps.velocityShipments` returns the unshipped lines. `deleteRunBlocker`
  reads both inside the same try (one failure → `velocity_unavailable`).
- `SkuFacts.velocityInShipments: number | null`; `evaluateDelete` tests
  `(velocityOnHand ?? 0) + (velocityInShipments ?? 0) > 0` after the same
  null → `velocity_unavailable` guard on both.
- `oosClock`: include `f.listing.createdAt` in the ever-stocked max.
- Tests: `velocityInShipmentsByAsin` (status filter, dedupe, bundle quantity);
  `evaluateDelete` with on-hand 0 and in-shipments > 0 → `skip_pipeline:velocity`;
  null in-shipments → `velocity_unavailable`; `runHygiene('delete')` with the
  shipments leg throwing → every SKU `velocity_unavailable`, zero deletes;
  `oosClock` relisted SKU (ledger 2026-07-07, created 2026-10-29, now
  2026-10-30) → `ever_stocked`, days 1, pass false.
- SPEC §11 component 24 bullet and the listing hygiene patch rule 3/4 text
  carry the amendment; SPEC §11's job-324 note records the incident.

## Verification before relist

1. Gate: `npm run check`, `npm run check:tests`, `npm test` (baseline 4× TS1252).
2. After deploy: one manual component-24 job on production with
   `params.dry_run = true`; its ledger row must show the 11 SKUs as
   `skip_pipeline:velocity` with `velocity_in_shipments > 0` and the working
   shipment id in evidence. **Nothing is relisted until that row is seen.**
3. Relist the 10 (B0H4NW15VB stays out, gated) with `script/relist.ts --live`
   against production, born-closed (no `--open`, Maria 2026-10-31); the §19
   ladder verifies; a final `getListingsItem` probe per SKU closes the report.

## Commits

1. Code + tests: `velocity-api` `fetchUnshippedShipmentLines`; `listing-hygiene`
   `velocityInShipmentsByAsin`, `SkuFacts.velocityInShipments` /
   `velocityShipmentIds`, the `evaluateDelete` test and evidence fields,
   `oosClock` createdDate term, `ScDeps.velocityShipments`;
   `listing-hygiene-run` `deleteRunBlocker` reads both legs in one try; the
   hygiene panel shows both Velocity numbers and the shipment ids.
2. Docs: SPEC §11 component 24 + the job-324 origin; listing hygiene patch
   2026-10-31 amendment; this patch filed.
