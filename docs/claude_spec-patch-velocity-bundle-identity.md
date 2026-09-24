# SPEC Patch — Velocity Bundle Identity (replaces ASIN-wide shipped-bundle suppression)

*Drafted 2026-09-21 with Maria after the Velocity upload skipped 8 bundle
groups across 4 ASINs with `bundle_shipped_unidentified` — including three
new orders (134524, 135707, 200015497641702/B0GWG5S64Q) blocked by shipments
from August. Decisions confirmed unless marked **default**. Fold into
SPEC.md §11 in the implementation session (doc first, then code).*

**Retires:** the "Shipped-bundle identity gap (2026-09-02)" suppression rule
and the `bundle_shipped_unidentified` skip reason. The spec's own revisit
condition ("revisit only if this skip recurs in practice") has fired.

---

## Evidence this patch rests on (read-only research, 2026-09-21)

- A fully-shipped bundle exists only as `GET /shipments/:id` rows. Those rows
  carry the **parent `order_id`**, `date`, `quantity` (bundle total),
  `quantity_shipped`, `amazon_sku`, `item_name` — but `order_number` is null
  and `bundle_children` is **absent**.
- `order_number` (Maria's PO / sheet order ID) never lives on the parent —
  only on children. Children are visible nested in `bundle_children` **only
  while the parent is on `/inbound` or `/inventory`**. Children never appear
  as top-level list rows; there is no documented way to enumerate children
  from a parent once it leaves the list legs.
- A child `order_id` is independently addressable: `GET /inbound/:child_id`
  returns its `order_number` and a `bundle_order_id` back-pointer — even
  after the parent ships.
- **Split shipments:** every shipment row of one bundle carries the same
  parent `order_id`; `quantity` is the bundle total and constant per parent;
  `quantity_shipped` is the per-shipment part (c0835a42: 2+6+2+10 = 20).
- Units are total component units on both sides (Velocity `quantity`; sheet
  Σ Col L × Col T). 14 units at `units_per_pack` 2 = 7 bundles.
- **Velocity `date` is not reliable for dashboard-entered bundles:** 2 of 5
  legacy bundles are dated one day after the sheet order (c0835a42,
  074e6255) — consistent with the dashboard defaulting to the UTC date on
  late-evening entry (hypothesis). AF-created bundles send the sheet date
  explicitly.
- Nothing captures identity today: `createBundleOrder`'s response is
  discarded, and there is no automated read-back after a create.
- **Existing bug:** `unionKnownOrders` keys child-less shipment rows as
  `("", ASIN)`, so all shipped bundles of one ASIN collapse to a single
  entry (both B0GNHTYGPF parents → one), and the surviving pseudo-row takes
  `quantity` from that one row's `quantity_shipped` (reported 2, true 20).

---

## Part A — Identity table (new migration; next free number, confirm at implementation)

`velocity_bundle_identity`:

| column | type | notes |
|---|---|---|
| `velocity_order_id` | TEXT PK | parent `order_id` (UUID) |
| `asin` | TEXT NOT NULL | parent ASIN, uppercased |
| `child_order_numbers` | TEXT[] NOT NULL | distinct child `order_number`s (sheet order IDs) — the match input |
| `child_order_ids` | TEXT[] NULL | child `order_id`s when observed; NULL for manual rows |
| `source` | TEXT NOT NULL CHECK IN (`observed`,`manual_seed`,`manual_map`) | |
| `first_seen_at` / `last_seen_at` | TIMESTAMPTZ NOT NULL | |

**Why this is not a gatekeeper ledger** (§11 "Velocity is the truth; no local
gatekeeper ledger" stays in force): the table does not record what AF sent
and never causes a create or a skip on its own. A row only matters when
Velocity itself returns that parent `order_id` on a shipment row; it restores
a key Velocity stops serializing. A parent deleted in Velocity simply never
appears again and its row is inert. Update the §11 dedup heading text to say
this explicitly.

Rows are never deleted by code (insert/upsert only).

---

## Part B — Recording

1. **Every `fetchAllKnownOrders` call** (plan and execute): for every
   `/inbound` or `/inventory` row with `sold_as = bundle` and non-empty
   `bundle_children`, upsert its row (`source = observed`). While a parent is
   list-visible, Velocity is the truth: children arrays are overwritten with
   what was observed; log when they changed.
2. **After each successful bundle create** in execute: one fresh `GET
   /inbound` read, and record the new parent. A failed capture is reported
   in the results (amber, not a failure of the create) — the next run
   captures it as long as the bundle is still list-visible.
3. **default:** with `dryRun=1`, recording is computed and reported ("would
   record N") but not written.
4. A recording write failure is surfaced in the report; the plan still
   completes (in-batch hydration covers everything currently list-visible).

---

## Part C — Reading (shipment rows) — includes the union-collapse fix

1. Bundle shipment rows are grouped **by parent `order_id`** — one known
   order per parent, never keyed `("", ASIN)`. Quantity = parent
   `quantity` (bundle total), never `quantity_shipped`.
2. Hydration order for a child-less shipment bundle: (a) in-batch list legs
   by `order_id` (existing behavior); (b) `velocity_bundle_identity` by
   `order_id`. A hydrated parent gets its child order numbers and flows
   through the existing child-derived match keys → classified matched
   (counted under "shipped").
3. A child-less shipment bundle with no record is **unplaced** → Part D.
4. Flat-order shipment rows: unchanged (out of scope).

---

## Part D — Fallback for unplaced shipped bundles (rare by design)

Only bundles that were never list-visible to AF can be unplaced: in practice,
a bundle entered directly in the Velocity dashboard that fully ships before
the next upload run.

For each unplaced parent, **candidate** sheet bundle groups (in the selected
date range) are those with ALL of:
- same ASIN;
- derived total units = parent `quantity`;
- sheet order date within **±1 calendar day** of the Velocity `date` (parsed
  dates; Velocity serializes zero-padded MM/DD/YYYY, sheet is M/D/YYYY).

Candidates are held with new skip reason **`bundle_unplaced_candidate`**.
Every other group of that ASIN proceeds normally. An unplaced parent with no
candidates holds nothing (its original is outside the range or already
matched) and is listed as info only.

**Mapping action (Upload to Velocity dialog, SKIPPED section):** a
`bundle_unplaced_candidate` row expands inline (same no-nested-modal pattern
as `no_live_sku` / `legend_pending`) showing the unplaced Velocity bundle(s)
— order date, units, item name, SKU, Velocity created date — with:
- **"This order is that bundle"** → writes a `manual_map` row (parent
  `order_id` → this group's order number); the row moves to the shipped
  count; any other candidates held only by that parent are released into
  NEW ORDERS pre-ticked. No full re-fetch.
- **"Map to a different order #"** → text input for the true original's
  order number (for when none of the candidates is it); writes the
  `manual_map` row and releases all candidates held by that parent.

No negative ("not this one") records are kept.

---

## Part E — Seed the five legacy bundles (in the migration, `source = manual_seed`)

Confirmed by Maria 2026-09-21:

| velocity_order_id | asin | child_order_numbers | units (bundles) |
|---|---|---|---|
| 03bb63ec-20d7-40a9-9794-28cfdd98ee62 | B0GNHTYGPF | {200015210238647} | 14 (7) |
| c0835a42-62bf-4926-91dc-97ba664bf4fa | B0GNHTYGPF | {200015523189765} | 20 (10) |
| 48f9a158-80a1-4056-aec0-d5420ee60594 | B0GWG5S64Q | {200015210238647} | 10 (5) |
| 074e6255-8a1b-47a4-8023-e4e4dab6dcec | B0DWXWHXP1 | {130097} | 10 (5) |
| 80d43b58-65d0-43d0-9302-0959737fd7ee | B0DKT4NDFZ | {127552} | 10 (5) |

`child_order_ids` NULL for all five.

---

## Part F — SPEC edits

- §11 skip taxonomy: strike `bundle_shipped_unidentified` (RETIRED
  2026-09-21, link here); add `bundle_unplaced_candidate`.
- §11 "Shipped-bundle identity gap": rewrite as the identity-record rule
  (Parts A–D), keeping the evidence list above and the 2026-09-02 history.
- §11 dedup: shipment-leg bundle rows keyed by parent `order_id`, quantity =
  parent `quantity` (Part C.1), replacing the `quantity_shipped` note for
  bundles.
- §11 "no local gatekeeper ledger": add the Part A clarification.

---

## Acceptance

**Tests:**
- c0835a42's four shipment rows → one known order, quantity 20.
- Two parents of one ASIN (03bb63ec, c0835a42) stay distinct.
- Hydration from the table → matched; no record → unplaced.
- Fallback window: −1 / 0 / +1 day → candidate; ±2 → not; unit mismatch → not.
- Mapping releases the other candidates of that parent only.
- Observed children overwrite a stale row while list-visible.
- Post-create capture failure reports amber and does not fail the create.

**Dry-run, range 1/1/2026 → 9/21/2026, after the seed:**
- The five originals (200015210238647 ×2 ASINs, 200015523189765, 130097,
  127552) → matched, counted under shipped.
- 134524, 135707, 200015497641702/B0GWG5S64Q → NEW ORDERS bundle creates.
- Zero `bundle_unplaced_candidate`, zero `bundle_shipped_unidentified`.
- Report shows "would record" for B0G6R55GNQ (d86eb6ef… →
  200015497641702).

**Live:** render the three bundle-create payloads and STOP for Maria's
approval before any POST. After send: confirm the three new parents are
recorded and B0G6R55GNQ is recorded.

---

## Part G — §14 principle (doc-only; separate commit)

**Fail-closed rules must name their victim and their exit.** Any rule that
blocks a legitimate action to prevent a worse one states, in the spec: what
it blocks, at what scope, for how long, and how often in practice (checked
against real business patterns, e.g. repurchase frequency, not all-time
totals). The block is scoped to the smallest unit whose identity is actually
unknown (a record, not an ASIN/supplier/account). "Until it ages out" or
"revisit if it recurs" is not an exit unless a mechanism exists to clear it.
Origin: `bundle_shipped_unidentified` (2026-09-02 → retired 2026-09-21)
blocked every future bundle of an ASIN, permanently, after one shipment.
