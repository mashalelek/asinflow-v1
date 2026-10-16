# PO Expand-by-ASIN patch — pre-flight findings (commit 1)

Patch: `docs/claude_spec-patch-po-expand-by-asin.md` §2 (P1–P6). Evidence
gathered 2026-10-16 against the local database (773 POs, 1,156 `po_asins`,
1,168 `po_line_items`) and the code at `6979f33`.

## P1 — Qty and Qty (units): which columns, which sheet columns

**Result: as expected. Qty = ASIN (sellable-pack) qty; Qty (units) = Qty × Units/Pack. No stop.**

| ASINs-tab column | Source | Sheet column it was imported from |
|---|---|---|
| Qty | `po_asins.qty` | **Col N "Total ASIN Qty per Order"** — `script/import-po-2026.ts:259–301`: `qty = SUM(Col N)` across the ASIN's rows, cross-checked against `SUM(Col L qty_ordered × Col T asin_qty_per_product)`; mismatches are reported, never silent |
| Qty (units) | computed at render, `client/src/pages/purchase-orders.tsx:543`: `a.units_per_pack * a.qty` | Units/Pack = Col AY (`units_per_pack`); SPEC §22 calls this the "Velocity quantity" |
| Units/Pack | `po_asins.units_per_pack` | Col AY |
| (Products tab) Qty ordered | `po_line_items.qty_ordered` | **Col L** — supplier product qty |

Column indexes: `server/po-import-classify.ts:16–24` (`qtyOrdered: 11` = L,
`qtyReceived: 12` = M, `asinQtyTotal: 13` = N, `qtyReturned: 17` = R,
`asinQtyPerProduct: 19` = T, `unitsPerPack: 50` = AY). The COGS/ordered-qty
sync reads a different ASIN-qty column, Col U (`server/google-sheets.ts:10`),
which is also ASIN qty; Col L is product qty, as Maria believed.

Real multi-pack PO (`po_asins` joined to `po_line_items`):

| PO | ASIN name | `po_asins.qty` (Qty) | units_per_pack | Qty (units) | line `qty_ordered` (Col L) | yield (Col T) |
|---|---|---|---|---|---|---|
| 102003663034827 | RED HEART Super Saver 3-Pack yarn, LIGHT | **5** | 3 | **15** | 15 | 0.33 |
| 8900110620911621 | RED HEART Super Saver 3-Pack Yarn, Hunter | 10 | 3 | 30 | 30 | 0.33 |
| 2430337 | 5 Packs Gamegenic Matte Board Game Sleeves | 10 | 5 | 50 | 50 | 0.20 |

5 sellable 3-packs = 15 individual skeins; the supplier line ordered 15. The
direction is unambiguous. (A case-pack example — Sweet Baby Ray's, `qty` 6,
units_per_pack 2, one supplier line of 1 case, yield 6 — gives Qty (units)
12 bottles while the product line is 1 case; "individual units" there means
retail units, not supplier packages. Consistent with D4.)

Distribution: 1,108 ASIN rows are `individual` / units_per_pack 1; 48
`multi-pack` (2–6); 2 `bundle`.

## P2 — `po_line_items` ↔ `po_asins`

`po_line_items.po_asin_id` → `po_asins.id` (`ON DELETE SET NULL`). Today:
1,146 ASIN rows have exactly 1 product line, 8 have 2, 2 have 3 (bundles);
0 orphan lines. So the mapping is **N:1 product lines → ASIN row**, 1:1 in
99% of rows. The conversion between the two levels is the line's
`asin_qty_per_product` (Col T, "yield"): ASIN qty = Σ(line `qty_ordered` ×
yield). **Units/Pack lives on `po_asins`** (ASIN level only).

**Finding for §4 (needs a decision — see "Decisions" below):** the patch
lists Canceled → `qty_canceled` and Returned → `qty_returned` as "existing"
columns of the ASINs table. They exist on **`po_line_items`** (product
level, migration 030), not on `po_asins`. `qty_canceled` is NULL on all
1,168 lines (never tracked); `qty_returned` is 0 on all lines; `final_qty`
is therefore NULL everywhere and never 0.

## P3 — How the PO list loads

Server-side pagination, **25 per page** (`server/routes.ts:4286`,
`GET /api/pos`, `LIMIT/OFFSET`), ordered by order_date desc. 773 POs → 31
pages. The list payload already computes `asin_count` and `units_ordered`
per PO with subqueries (`routes.ts:4300–4310`); `po_asins` rows are not in
it. The detail route `GET /api/pos/:id` (`routes.ts:4347`) returns the PO +
its `po_asins` (with computed `total_cost`) + line items.

→ §3.3 choice: **include the page's `po_asins` rows in the list payload**
(25 POs × ~1.5 rows = ~40 rows per page; one extra query per page). Expand
All on a page needs no further fetch. Report of the choice in §3.3.

## P4 — Every consumer of `purchase_orders.status`

Readers of the **database column**:

1. `GET /api/pos` status filter — token containment, `p.status ILIKE '%tok%'` OR'd (`server/routes.ts:4304`).
2. `GET /api/pos` facet source `statusTokens` — `unnest(string_to_array(status, ','))` (`routes.ts:4334`).
3. POs page chips (`client/src/pages/purchase-orders.tsx:236–243`), the Status facet (`:213`), PO detail header chips (`:385,418`) and the detail "Status" field (`:453`).
4. `script/import-po-2026.ts:336,422` — the importer writes `status` (`t(c[COL.status]) || "Ordered"`). There is **no recurring PO sync** writing `purchase_orders`: `runSheetsSync` (`server/google-sheets.ts`) writes `asin_estimates` COGS / `ordered_qty` only. The "PO sync from the Orders sheet" in §6.3 is the one-time importer.
5. `server/route-inventory.test.ts` pins the two routes exist (not the column).

Readers of the **Orders-sheet Status cell directly** (not the DB column —
they stay as they are, and are listed so nothing is missed):

6. `server/google-sheets.ts:54–55` ordered-qty sync — excludes canceled AND closed rows.
7. `server/sellerboard-cogs.ts:185` SellerBoard COGS export — excludes canceled only.
8. `server/velocity-export.ts:192` Velocity upload eligibility — excludes canceled.
9. `server/sourcing-cost.ts:151` Update COGS in SC — excludes canceled.
10. `server/velocity-reconcile.ts:159–160,219` — sheet row canceled → Velocity delete candidate.

The Aura/COGS chain reads `asin_estimates`, never PO status. **The profit
exclusion rule** (`final_qty = 0 OR (final_qty IS NULL AND status ILIKE
'%canceled%')`) exists only as SPEC §22 text ("recorded now, applied at the
cutover layer"); no code implements it today, so the §6.3 switch changes
the spec and the one query that will implement it, not a live consumer.

## §6.3 delta (local; Render pending — see Decisions)

Evaluated on `po_line_items` joined to `purchase_orders`:

| rule | rows excluded |
|---|---|
| old: `final_qty = 0 OR (final_qty IS NULL AND status ILIKE '%canceled%')` | **38** (the 38 lines of the 24 canceled POs) |
| new, before the §6.4 backfill: `final_qty = 0 OR (final_qty IS NULL AND qty_canceled IS NOT NULL AND qty_canceled >= qty_ordered)` | **0** |
| new, after the backfill sets `qty_canceled = qty_ordered` on those 38 lines | **38** |

Delta after the backfill: 0 — explained entirely by `qty_canceled` being
untracked today. Note the generated `final_qty = qty_ordered − qty_canceled
− qty_returned` becomes **0** on those lines once backfilled, so they are
excluded by the first clause from then on.

## P5 — Orders-sheet Status values (via the PO mirror, token-split)

| token | POs |
|---|---|
| Closed | 679 |
| Ordered | 49 |
| SHIP | 34 |
| Canceled | 24 |
| See Comments | 10 |
| Missing / Damaged from Supplier | 8 |
| ATTN: Velocity | 5 |
| **Received Partial** | **4** |
| Received | 4 |
| Received - FBM | 3 |
| Returned | 3 |
| Confirm Refund / Replacement | 2 |

Against §6.1/§6.4: Need to Return (0 today), Missing / Damaged, Confirm
Refund / Replacement, ATTN: Velocity, See Comments, SHIP, Received - FBM
map to `action_items`. Ordered → nothing. Canceled → `qty_canceled =
qty_ordered` on the 38 lines. **Unmapped: "Received Partial" (4 POs)**, and
**"Closed" (679)** is not addressed by §6.4 at all. Received (4): per D6
leave NULL and report. Returned (3): the sheet carries no returned qty for
them (lines show `qty_returned` 0; two officedepot lines already have
`qty_ordered` 0) — nothing to write without a quantity.

## P6 — Persisted UI state to reuse (§3.4)

The ASINs page keeps per-browser state in `localStorage` through small
helpers: column config (`client/src/lib/columns.ts:16,66`,
`fba-column-config`), active view preset (`client/src/components/view-presets.tsx:10`,
`fba-active-preset`), filters, sort, page size, toggles (`fba-*` keys). View
presets themselves are rows in `view_presets` (DB). The PO page persists
nothing today (`purchase-orders.tsx` has no `localStorage` use).
→ §3.4 choice: a `fba-po-expanded` localStorage entry `{ all: boolean,
ids: string[] }`, same helper pattern; per browser, which is what
"per user" means on the ASINs page today.

## Decisions needed before commit 2

1. **ASIN-level Canceled / Returned (§4 cols 11–12).** Proposal: keep the
   stored truth at product level (`po_line_items.qty_canceled` /
   `qty_returned`, existing) and derive the ASIN-row values at read time as
   Σ(line qty × yield), NULL if any line is NULL. §6.3 and §6.4 operate at
   line level. The six NEW quantities (cols 13–18) are stored on `po_asins`
   as ASIN qty; the Products tab (§4.3) shows At Prep Center / At CQG
   Warehouse / Lost-damaged converted through the yield for 1:1 lines and
   "—" for bundle component lines. Alternative: add stored
   `qty_canceled`/`qty_returned` to `po_asins` too (two sources of one fact).
2. **"Received Partial" (4 POs)** is unmapped. Proposal: treat as Received
   per D6 — nothing written, count reported. (Their lines already carry
   `qty_received` from Col M, e.g. 8/10.)
3. **"Closed" (679 POs)** has no §6.4 mapping. Proposal: `closed_at =
   updated_at`, `closed_by = 'sheet'` (a third value beside 'auto' and a
   user id), so the POs page's default Open view shows the 94 non-closed POs
   and nothing auto-reopens them (auto only reopens `closed_by = 'auto'`).
4. **Render delta for §6.3** needs the external DATABASE_URL again (not
   kept), or Maria runs the same three counts there.
