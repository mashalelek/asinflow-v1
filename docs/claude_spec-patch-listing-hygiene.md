# SPEC Patch — Listing hygiene: auto-close OOS SKUs, auto-delete long-dead SKUs

*Drafted 2026-10-18 with Maria. All decisions confirmed the same day. Builds on
the scheduler (`claude/spec-patch-scheduler-v1.md`: components 1–21, two-lane
runner) and the SC mirror (`claude/spec-patch-live-offer-mirrors-sc.md`: the
flag is written only by probes). Amends SPEC §11 (component table), §14
(ownership), §18 (born-closed / reopen). **Replaces the backlog line "Delete in
SC from AF via `deleteListingsItem` — Maria: not now."***

## Why

Seller Central accumulates SKUs that have nothing to sell: open listings with
zero stock, and closed listings whose last units sold months ago or that were
created as leads and never bought. Today these get cleaned up by hand, if at
all. AF already sees every bucket of FBA inventory hourly and every listing's
state hourly, so it can do the cleanup itself — narrowly, per SKU, fail-closed,
and **never in the reopen direction**.

## Rules (confirmed 2026-10-18)

1. **Evaluated per SKU.** Pipeline data that only exists per ASIN (POs, Velocity)
   applies to every SKU of that ASIN. `amzn.gr.*` SKUs are excluded entirely.
2. **Close — hourly, automatic.** A SKU with a listing in SC that is not already
   closed is closed when ALL of these FBA buckets are zero:
   **Available** (fulfillable), **Inbound** (working + shipped + receiving),
   **FC Transfer** (reserved › pending transshipment), **FC Processing**
   (reserved › FC processing), **Reserved** (reserved › pending customer order).
   - **Unfulfillable and Researching do NOT block close.**
   - **Stages before FBA do NOT affect close** — on order, at prep, at
     warehouse, open POs, Velocity: none of them are read by the close decision.
     (Maria 2026-10-18: units arriving to a closed listing strand; that is
     acceptable — she recreates/reopens.)
   - `futureSupplyQuantity` (pre-order supply) is treated as Available — blocks
     close. Expected to be 0 for this account; listed so nothing is silently
     ignored.
3. **Delete — daily (00:00 pass only), automatic after a reviewed dry run.**
   A SKU is deleted when ALL of:
   - its listing is **closed now** (rule 2, or closed any other way);
   - **every** FBA bucket is zero — including Unfulfillable and Researching;
   - **nothing in the pipeline for the ASIN**: `asin_po_pipeline(asin)` On
     Order = 0 and At Prep = 0 (`server/asin-po-pipeline.ts`, computed live
     from the PO tables — NOT `asin_estimates.ordered_qty`, which is no longer
     written; corrected 2026-10-18) and no Velocity units on hand (live read
     of `/inbound` + `/inventory`, `quantity_remaining > 0`). **No open-PO
     blocker** (Maria 2026-10-19): an open PO with nothing left to arrive
     (stale action items, everything canceled or lost) would hold deletes
     with no visible cause and no exit (SPEC §14); units shipped but not yet
     received are already caught by the inbound buckets;
   - the **OOS clock** has run (rule 4).
4. **OOS clock.**
   - **Ever-stocked SKU:** days since the last day it had units anywhere at FBA
     — `max(ledger_last_stocked_date, inventory_last_nonzero_at)` — **> 60**.
     `ledger_last_stocked_date` comes from Amazon's Inventory Ledger report
     (component 23); `inventory_last_nonzero_at` from component 15's hourly
     snapshot, so a lagging ledger can never make a stocked SKU look old.
   - **Never-stocked SKU** (born-closed lead: no ledger history in the 18-month
     window and never nonzero in component 15): days since the listing's
     `createdDate` (from `getListingsItem` summaries) **> 14**.
   - A SKU stocked longer ago than the ledger's 18-month reach falls into the
     never-stocked branch; it is far past 60 days, so the outcome is the same.
   - "Closed for > 60 days" is satisfied by this clock: going forward AF closes a
     SKU the hour it hits zero, so the dates coincide; for SKUs closed before
     this patch, the ledger is the only reliable record of when they emptied.
5. **Reopen is never automatic.** No code path in AF clears `end_at` or
   otherwise reopens a listing — not even with stock at FBA. Reopen stays a
   manual action in Seller Central (§18, unchanged). Enforced by test.

## Mechanism

### Close

`patchListingsItem` (`PATCH /listings/2021-08-01/items/{sellerId}/{sku}`),
`op: "merge"` on `/attributes/purchasable_offer` setting `end_at` to the same
past date born-closed uses (`BORN_CLOSED_END_AT = "2000-01-01"`), mirroring the
verified reopen shape in §18 (merge, never `replace` — replace wipes the price;
no price fields in the same patch). `productType` from the SKU's existing
listing. Build the value through the same helper `buildOfferOnlyPayload` uses
for born-closed, so the two `end_at` writers cannot diverge. The §18
key-precise `findForbiddenQuantityPaths` guard runs as a pre-flight abort
before every PATCH.

### Delete

`deleteListingsItem` (`DELETE /listings/2021-08-01/items/{sellerId}/{sku}?marketplaceIds=…`).
Asynchronous: the response is `ACCEPTED` / `INVALID` + `submissionId` — same
"accepted ≠ done" contract as Add to SC. Verified by the next probe (404 or
empty summaries per A1).

Recovery is already built: `asin_skus` keeps the row, and §18 resurrection
reuses the most recent conforming SKU when it 404s — exactly the "relist under
the same SKU" recovery Amazon's stranded-inventory flow needs.

### Rate limiting

Both operations share the Listings bucket (5 rps / burst 10). Add `PATCH` and
`DELETE` to the limiter's path→bucket table and route them through the single
choke point in `spapi-auth.ts` (add `spApiPatch` / `spApiDelete` there if they
don't exist). Never call either outside that layer.

## Data

Migration: next free number (058 as of 2026-10-17).

### Component 15 — store every bucket, per SKU (no new API calls)

`getInventorySummaries` with `details=true` already returns every bucket per
`sellerSku`. New table, owner = component 15 only:

```sql
CREATE TABLE sku_fba_inventory (
  sku                    TEXT PRIMARY KEY,
  asin                   TEXT NOT NULL,
  fnsku                  TEXT,
  fulfillable            INTEGER NOT NULL,
  inbound_working        INTEGER NOT NULL,
  inbound_shipped        INTEGER NOT NULL,
  inbound_receiving      INTEGER NOT NULL,
  reserved_customer      INTEGER NOT NULL,   -- pendingCustomerOrderQuantity
  reserved_fc_transfer   INTEGER NOT NULL,   -- pendingTransshipmentQuantity
  reserved_fc_processing INTEGER NOT NULL,   -- fcProcessingQuantity
  unfulfillable          INTEGER NOT NULL,
  researching            INTEGER NOT NULL,
  future_supply          INTEGER NOT NULL,
  last_nonzero_at        TIMESTAMPTZ,        -- any bucket > 0; only moves forward
  observed_at            TIMESTAMPTZ NOT NULL,
  job_id                 BIGINT
);
```

Upsert one row per SKU per pass. `inventory_snapshots` (per ASIN) is untouched —
the backlog decision on its history stands. A SKU absent from a **complete**
paginated response is written as all-zero with `observed_at` = now (absence from
a complete pull is conclusive). An incomplete pull (any page failed) writes
nothing and marks the component result `incomplete`.

### Component 16 — listing state per SKU (no new API calls)

Add `attributes` to the probe's `includedData` (same call, larger payload).
Owner = component 16 only, on `asin_skus`:

- `listing_created_at` — `summaries[].createdDate`
- `offer_end_at` — `attributes.purchasable_offer[].end_at` (US marketplace)
- `listing_checked_at`

A SKU is **closed** when `offer_end_at <= now()`. **Amazon rewrites
`end_at` on close** (spike 2026-10-18/19: born-closed SKUs sent `2000-01-01`
read back `2026-10-13T12:29:10Z` / `2026-10-15T01:55:12Z`; Maria's
SC-closed `PRK-HOM-6P4-PIC-001` reads `2026-10-19T09:31:29Z`; open offers
read `{value: null}`), so `offer_end_at` means **"closed now" only, never
"closed since"** — nothing may compute a duration from it. **Spike first:** probe one
born-closed SKU and one Maria-closed SKU and confirm `end_at` serializes on GET
in this shape before anything reads it. If it doesn't, STOP and report — do not
infer closed from the absence of `BUYABLE` (OOS listings also lack it).

### Component 23 — Inventory Ledger (new, daily)

`GET_LEDGER_SUMMARY_VIEW_DATA`, `aggregatedByTimePeriod = DAILY`,
`aggregateByLocation = COUNTRY`. Rows carry Date, FNSKU, ASIN, MSKU,
Disposition, Ending Warehouse Balance. Owner = component 23 only:

```sql
CREATE TABLE sku_ledger_state (
  sku                       TEXT PRIMARY KEY,   -- MSKU; no FK (SKUs AF hasn't onboarded are kept)
  last_stocked_date         DATE,               -- latest Date with Σ(ending balance, all dispositions) > 0
  ledger_window_start       DATE NOT NULL,      -- earliest date this table has ever covered
  checked_at                TIMESTAMPTZ NOT NULL
);
```

- **Backfill:** one-time manual one-component job (the sales-backfill pattern:
  `params.ledger_window {from, to}`), 18 months back, in **92-day chunks**
  (spike 2026-10-18: 31 and 92 days accepted, ~20 s each; 548 days refused
  with `QuotaExceeded` — this report type's createReport quota is tighter
  than the general bucket). Requests are spaced; on `QuotaExceeded` the
  component waits and retries **the same chunk** — a chunk is never skipped.
- **Parsing:** a proper quoted-TSV reader (fields are double-quoted; titles
  contain quotes and broke 16 of 8,572 rows under split-on-tab). Row grain is
  Date × MSKU × Disposition (FNSKU 1:1 with MSKU, Location always `US`); a
  SKU appears only on days it held or moved units, so absence = zero.
- **Nightly:** last 7 days (overlap on purpose). `last_stocked_date` only moves
  forward.
- **Fail-closed tripwire:** Amazon's DAILY summary has a known empty-report
  failure (selling-partner-api-models #2526). If a report returns zero rows
  while component 15 shows any SKU with fulfillable > 0 inside its window, the
  run is `inconclusive`: write nothing. Victim: that night's deletes (component
  24 skips everything as `ledger_unavailable`). Exit: the next night's run.

### Action ledger

```sql
CREATE TABLE listing_actions (
  id             BIGSERIAL PRIMARY KEY,
  sku            TEXT NOT NULL,
  asin           TEXT NOT NULL,
  action         TEXT NOT NULL CHECK (action IN ('close','delete')),
  job_id         BIGINT,
  dry_run        BOOLEAN NOT NULL,
  evidence       JSONB NOT NULL,   -- buckets, blockers checked, clock dates, thresholds
  status         TEXT NOT NULL CHECK (status IN
                   ('would_fire','held','accepted','invalid','error','verified','not_effective')),
  submission_id  TEXT,
  issues         JSONB,
  fired_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  verified_at    TIMESTAMPTZ
);
```

Every evaluated candidate that fires (or would) gets a row with the full
evidence snapshot. Verification is done by component 16 on the next pass:
close → `offer_end_at <= now()`; delete → listing absent (404 / empty
summaries). Still not effective after two passes → `not_effective`, surfaced in
the jobs dialog. `has_live_offer` / `has_buyable_offer` follow the probe as
always — this table never writes them.

## Components 22–24 (appended to the sequence)

| # | Component | Tier | Call | Runs in |
|---|---|---|---|---|
| 22 | Close OOS listings | hourly | `patchListingsItem` per SKU | scheduled passes only |
| 23 | Inventory Ledger | daily | `GET_LEDGER_SUMMARY_VIEW_DATA` | 00:00 pass (+ backfill job) |
| 24 | Delete long-dead listings | daily | `deleteListingsItem` per SKU + Velocity read | 00:00 pass only |

Order dependencies: 22 needs this pass's 15 (complete) and 16; 24 needs this
pass's 15, 16 and tonight's 23 (the PO pipeline is read live, not from 9). Appending after 21 satisfies all of them.
Keepa, previously reserved as "22+", moves to 25+.

**22 and 24 never run in manual / onboarding / bulk jobs.** A Refresh click
must not have SC writes as a side effect. Their own manual entry points are
below. (§14 manual-trigger completeness is about derived state converging;
these are actions, and they have their own manual trigger.)

### Per-SKU outcomes

Close (22): `closed` · `would_close` (dry run) · `skip_has_stock:<bucket>` ·
`skip_already_closed` · `skip_no_listing` · `skip_pending_submission` (newest
§19 row for the SKU in {pending, processing, stale}) · `skip_no_fresh_inventory`
(15 incomplete or SKU not observed this pass) · `skip_probe_transient` (16 was
transient for the ASIN this pass) · `skip_amzn_gr` · `held` (breaker) ·
`invalid` / `error`.

Delete (24): `deleted` · `would_delete` · `skip_not_closed` ·
`skip_has_stock:<bucket>` · `skip_pipeline:on_order|at_prep|velocity` ·
`skip_clock:<days>/<threshold>` · `ledger_unavailable` · `velocity_unavailable`
(any leg failed — fail-closed, the whole run skips) · `held` · `invalid` /
`error`.

Every SKU in scope gets an outcome — no `{}` meaning "no exceptions".

### Circuit breakers

A bug in a bucket parser must not close the stocked catalog or delete half of
SC in one night. Per run: more than **25** closes, or more than **25** deletes
→ write nothing, record every candidate as `held`. Victim: that run's actions.
Exit: **Release** in the jobs dialog (or `POST /api/listing-hygiene/release
{job_id, action}`), which **re-evaluates each held SKU live at release time**
and fires only those that still qualify (the 2026-09-24 Velocity rule: an
approval is a snapshot, not a mandate). Thresholds live in `settings`
(`hygiene_close_breaker`, `hygiene_delete_breaker`). The first live run is
expected to trip both — that is the intended review point for the backlog.

### Live gates

- `LISTING_CLOSE_LIVE` and `LISTING_DELETE_LIVE` env vars, default unset →
  components 22/24 run in dry-run mode (outcomes `would_*`, ledger rows with
  `dry_run = true`, zero SC writes). Set separately, close first.
- Manual: `POST /api/listing-hygiene/run {action, dryRun}` (admin) enqueues a
  one-component lane-M job for 22 or 24 over the full scheduled scope — the
  sales-backfill pattern.

## UI

- **Jobs dialog:** components 22 and 24 show counts per outcome, expandable
  lists with the evidence per SKU, and **Release (N)** when held.
- **Completion toast › Changes:** adds "listings closed (N)" and "listings
  deleted (N)" alongside the gating/suppression flips (decision 16 lists what
  appears there; this extends it with the two actions, still no price counts).
- Product cell / catalog icon: unchanged. A closed listing is still listed (§18
  icon semantics); a deleted one becomes "+" via the probe.

## First-write protocol (hard stops — production writes)

1. Spikes, read-only: `end_at` on GET (component 16); ledger chunk size and one
   real DAILY report (component 23); `details=true` bucket shape (component 15)
   for one SKU with known unfulfillable units.
2. Dry run of 22 and 24 over the full scope; report counts per outcome and the
   full `would_close` / `would_delete` lists. **Maria reviews.**
3. One close on a SKU Maria names; GET back `end_at`; Maria confirms Closed in SC
   and reopens it herself.
4. One delete on a SKU Maria names; next probe confirms 404.
5. Set `LISTING_CLOSE_LIVE`; observe one pass. Then `LISTING_DELETE_LIVE`;
   observe one 00:00 pass.

## Tests

- Close predicate: each blocking bucket alone blocks; unfulfillable alone and
  researching alone do not; On Order / At Prep / open PO / Velocity are never read by 22.
- Delete predicate: every bucket blocks (incl. unfulfillable, researching); each
  pipeline source alone blocks (on_order, at_prep, Velocity); an open PO with nothing left to arrive does not; 60-day boundary (60 = no, 61 = yes) and 14-day
  boundary for never-stocked; `max(ledger, inventory)` clock.
- Fail-closed: incomplete 15 → zero closes; empty ledger with stocked SKUs →
  inconclusive, zero deletes; any Velocity leg failing → zero deletes.
- Breakers hold at 26; release re-evaluates and drops a SKU that gained stock.
- **Never-reopen guard:** no source file sends `end_at` null or removes it; the
  only `end_at` writer is the shared helper with the fixed past date.
- 22/24 are absent from manual, onboarding and bulk job component lists.
- Limiter maps PATCH and DELETE listings paths to the Listings bucket.

## SPEC edits

- §11 scheduler component table: 15 (per-SKU buckets, `details=true`), 16
  (`attributes` in includedData, three new columns), new 22–24, Keepa → 25+.
- §14 ownership: `sku_fba_inventory` → 15; `asin_skus.listing_created_at` /
  `offer_end_at` / `listing_checked_at` → 16; `sku_ledger_state` → 23;
  `listing_actions` → 22/24 (verification by 16).
- §18 born-closed: AF now also closes existing listings (rule 2); reopen
  stays manual and AF never reopens (rule 5).
- `claude/backlog.md`: the "Delete in SC" line points here.

## Amendments

- **2026-10-20 (Maria): component 22 (close) runs daily, not hourly.** It
  moves into the daily block: it runs only in the 00:00 ET pass, after
  this pass's 15 and 16 and before 23 and 24, and never in an hourly pass.
  Rules, breaker, live gate and the manual entry points (`POST
  /api/listing-hygiene/run`, `/release`) are unchanged — they list 22
  explicitly and run whatever its tier. Read "Close — hourly" in rule 2,
  the component table's "hourly" tier for 22, and "observe one pass" in
  the first-write protocol as the 00:00 pass. A SKU that sells out now
  waits up to a day to be closed.
- **2026-10-20: `skip_action_pending` counts any recent accepted action
  on the SKU, close or delete** (a deleting listing reads back open for
  minutes; commit e80c123).
- **2026-10-21 (Maria), after the first live 00:00 pass** (#123: 24 closed,
  162 deletes held, then released through #136 before the CSV review —
  the Release button sat off-screen in a dialog widened to 1,737 px, and
  #137 / #138 were enqueued a second later for the same hold):
  - **Breakers:** `hygiene_close_breaker` = 50, `hygiene_delete_breaker` =
    25 (migration 065; code defaults per action).
  - **Jobs dialog layout:** job rows never widen the dialog; Release is
    visible without horizontal scroll.
  - **Release confirmation:** every Release opens an in-app confirm —
    "Delete N listings in Seller Central? Each is re-checked live first."
    ("Close N listings…" for closes). Nothing is queued until confirmed.
  - **One release per job + action:** a release while one is queued,
    running or done for the same job + action is refused (409, shown inline
    in the confirm); a failed or cancelled release may be retried. The
    check and the enqueue share one transaction under an advisory lock.
  - **"Action required":** whenever a close or delete hold is unreleased,
    an amber control in the top nav on every AF page reads e.g. "Action
    required: 30 deletes held for review"; clicking it opens the held list
    with Release (and the confirm). One pending hold per action — the
    newest job that held any; a later night's hold supersedes the earlier
    one (which is then refused as `superseded`, 409), and a released hold
    clears it. A finished pass that tripped a breaker also toasts "Daily
    pass held N closes / N deletes — review needed".
- **2026-10-21 (Maria): amzn.gr.* SKUs are no longer excluded from
  component 24** (Amazon Grade & Resell; rule 1 now applies to 22 only).
  Component 24 deletes one in the 00:00 pass when every FBA bucket is 0
  (Unfulfillable and Researching included) — no closed-state requirement,
  no 60/14-day clock, no PO / Velocity pipeline check (so a run-wide ledger
  or Velocity outage does not block it). Kept: never closed by 22
  (`skip_amzn_gr`), never primary, the same delete breaker (25, counted
  together with the regular deletes), the action-pending guard, the
  fail-closed inventory freshness gate. Evidence `rule: "amzn_gr"`;
  outcomes `would_delete:amzn_gr` / `deleted:amzn_gr`. The listing-exists
  check now runs before the amzn.gr rule in 22 and 24, so an amzn.gr SKU
  with no listing reports `skip_no_listing` (16 of the 17 in pass #123).

- **2026-10-23 (Maria): born-closed becomes close-after-create.** The
  sub-status probe (2026-10-23) found no Amazon field — Listings API,
  searchListingsItems or any listings report — that tells SC's "Closed"
  from "Out of stock"; and a past `end_at` sent at CREATE is stored by
  Amazon but not applied (the listing stays open, "Out of stock"), while
  the same value sent by the component-22 PATCH does close it. So:
  1. Add to SC no longer sends `end_at` in the create payload.
  2. Close-after-create: on the first §19 probe that sees the new listing
     (200 with summaries), AF sends the component-22 close PATCH through
     the same helper — forbidden-quantity guard, a `listing_actions` row
     with reason `born_closed`, verified as usual, sent once. If the ladder
     never sees the listing, the nightly component 22 closes it.
  3. The closed test, everywhere `offer_end_at` is read as "closed": closed
     when `end_at` is a real close timestamp, OR it is the literal
     `2000-01-01` AND AF has an accepted close PATCH on that SKU after its
     latest creation; otherwise not closed. BUYABLE always means open.
  4. SPEC §18: born-closed = close-after-create; the "verified live
     2026-08-01/02" claim is removed; no Amazon source exposes SC's inactive
     sub-status (probe 2026-10-23). Add-to-SC preview note: "Offers are
     closed right after they're created."
  No SC confirmation step (Maria).

- **2026-10-24 (Maria): scope = every SKU with a listing in Seller Central,
  whatever the ASIN's AF status** (active, parked or dead). Components 22
  and 24 evaluate the dead ASINs whose SKUs have an SC listing (per the last
  listing probe) alongside the scheduled scope (active + parked); component
  16 probes the same dead ASINs every full-scope pass so 22/24 never act on
  stale listing data for them (component 15's SKU buckets are account-wide
  already). A dead ASIN with no SC listing stays out; dead ASINs stay out of
  every other component. Trigger: LIN-GRO-4SQ-CBS-001 (B00032C4SQ) was marked
  dead 5 minutes before the 2026-10-23 manual close run and was left open.

- **2026-10-31 (Maria): rule 3 — the Velocity pipeline check also counts
  units packed into a Velocity shipment that has not shipped; rule 4 — a
  relisted SKU's ever-stocked clock restarts at the relist.** Job 324
  (2026-10-30 05:45 UTC) deleted 11 closed SKUs — 76 units — that sat in one
  Velocity shipment in status `working`: packed lines carry
  `quantity_remaining = 0` (so "on hand" was 0) and the FBA shipment does
  not exist yet (so every inbound bucket was 0); rule 3's note "units
  shipped but not yet received are caught by the inbound buckets" holds only
  after Velocity has created the FBA shipment, which then failed on the
  deleted MSKUs. Now: Σ line quantity over the detail of every
  `GET /shipments` row with `status ≠ shipped` (any unknown status counts),
  one count per shipment × order, per ASIN like on-hand; either > 0 →
  `skip_pipeline:velocity`; the shipments leg is read in the same try as
  on-hand, so a failure of either is `velocity_unavailable` for the run.
  Evidence: `pipeline.velocity_in_shipments`, `pipeline.velocity_shipment_ids`.
  Clock: `max(ledger_last_stocked_date, inventory_last_nonzero_at, listing
  createdDate)` — only a relisted SKU has a listing younger than its stock
  dates, so nothing changes for the rest; evidence `clock.created_considered`.
  Component 22 is unchanged. Patch: `claude_spec-patch-hygiene-velocity-shipments.md`.

## Out of scope

- Showing the new buckets in the Stock hover (easy follow-up; display only).
- Parking/marking dead an ASIN whose last SKU is deleted — status is untouched.
- ~~Re-defining `ordered_qty`~~ — resolved 2026-10-18: rule 3 reads
  `asin_po_pipeline` On Order / At Prep instead.
