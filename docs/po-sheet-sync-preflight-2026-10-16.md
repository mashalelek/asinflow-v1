# PO sheet sync patch — pre-flight findings (commit 1)

Patch: `docs/claude_spec-patch-po-sheet-sync.md` §2 (P1–P5). Evidence
gathered 2026-10-16 against the local database (773 POs, 1,156 `po_asins`,
1,168 `po_line_items`, 0 `po_asin_shipments`) and the code at `6587e89`.
The mirror sheet (`GOOGLE_SHEET_ID`, tab `Sheet1`) was read twice, read-only:
once through the importer's own dry run, once through a dry-run diff built
for commit 2.

**Two STOP items, both for Maria (details in P4):**

1. **Unmapped Status token** — `fleetfarm.com MW7400517` (row 596) now reads
   `"Shipped FBA, Confirm Refund / Replacement"`. "Shipped FBA" is not in
   `mapSheetStatus`. Patch §3.2 says STOP.
2. **Not a patch STOP, but a data effect the patch does not name:** on
   Canceled POs the VA zeroes Col L/N and moves the order total into Refund
   Amount. "Sheet wins" (D2) therefore sets `qty_ordered = 0`, `qty = 0`,
   `qty_canceled = 0` on those lines — the ordered quantity is lost and the
   derived Canceled column reads 0, not the ordered amount. Six POs today.

Everything else: no stop. Match key unique (§3.1), FK confirmed (P5).

## P1 — What the ASINs-page Sync POs button does today

| Step | Where |
|---|---|
| Button "Sync POs" (working set = selection, else the filtered view) | `client/src/pages/home.tsx:1557`; handler `handleSyncSheet` at `:803–816` |
| Client call | `fetchLongSync("/api/sheets/sync", { asins: ws })` (`home.tsx:807`); toast "Synced PO data — Updated N ASINs, skipped M[, cleared K stale qty]"; then `fetchAsins` reload |
| Route | `POST /api/sheets/sync` (`server/routes.ts:1828`) — guards: DB up, `GOOGLE_CREDENTIALS_PATH` exists; body `{ asins }` → optional filter set; `respondLongSync` NDJSON heartbeat stream |
| Work | `runSheetsSync(asinFilter)` (`server/routes.ts:944`) → `fetchSheetDataWithMeta(sheetId)` (`server/google-sheets.ts:44`) reads **`Sheet1!A2:AZ`** — the same tab and range the importer reads |
| Sheet columns read | `server/google-sheets.ts:9–16`: Status D (3), Supplier E (4), ASIN H (7), Shipped O (14), Qty U (20), COGS Y (24), Prep AS (44). Rows with Status containing "canceled" are excluded; "closed" rows are counted but their qty is not "on order" |
| Rows written | **`asin_estimates` only**: `actual_cogs`, `cogs_source='po_sheet'`, `prep_override`, `ordered_qty` (`routes.ts:1002`); then the ordered-qty clearing pass sets `ordered_qty = 0` for ASINs that left the sheet (`routes.ts:1033`), fail-closed on `rawRowsRead = 0` |
| PO tables | **Never touched.** No reference to `purchase_orders`, `po_asins` or `po_line_items` anywhere on this path |
| Queue | Off the queue by rule C (SPEC §11, 2026-10-16): an inline call, no `jobs` row |

The same function is component 9 of the scheduled pass and the inline
PO-sheet read inside Push to Aura (`server/aura-sync-chain.ts`). None of
those three callers changes under this patch; only the button's route gains
the PO sync in front of it (§4).

## P2 — The one-time importer

`script/import-po-2026.ts` (committed `b36eef4`, 2026-08-21; live run
2026-08-21, `updated_at` of every PO row). Dry-run by default, `--live` to
write.

| Aspect | Finding |
|---|---|
| Entry point | `main()` at `:113`, guarded so importing the file never runs it (`:471–477`) |
| Sheet read | header `Sheet1!A1:AZ1` + cells `Sheet1!A2:AZ` through `getSheetValues` (`server/sheet-read.ts:8`) — `:128–133`; header sanity against 10 expected captions (`HEADER_EXPECT`, `:52–58`) |
| Columns | `COL` map in `server/po-import-classify.ts:15–25` — B order_id, C order_date, D status, E supplier, F sku/upc, G product, H ASIN, I ASIN name, K price, **L qty ordered, M qty received, N total ASIN qty**, R qty returned, S unique products per ASIN, T ASIN qty per product, V/W loss qty/amount, X adjusted product cost, **Y COGS**, AB–AG money header, AI–AP payment/promo/cashback/purchased-by/subscription/notes, AS prep, AT email, AX sold_as, AY units_per_pack |
| Row classification | `classifyRows` (`po-import-classify.ts:52–76`): drops all-blank rows, the totals row, **every row whose Order Date year ≠ 2026** (`:63`), rows with a blank Order ID, rows with no ASIN. Today: 4,050 raw rows = 1 totals + 2,433 non-2026 + 1,616 imported, remainder 0 |
| Grouping / match key | rows grouped on **`(supplier, order_id)`** with one supplier alias (`"shop.tetleyusa.com / WorldPantry.com"` → `shop.tetleyusa.com`), `:145–160`. "PO exists" = that key is already in `purchase_orders` (`:356–369`), which carries `UNIQUE (supplier, order_id)`. Existing POs are **skipped**, never updated |
| Order-level cells | first row of the group wins; every disagreement is reported (`:162–181`). Today 208 disagreements, 102 of them on the Status cell (a later row of the same PO says "Closed"/"SHIP" while the first says otherwise) |
| Status cell (D) | `mapSheetStatus(status ‖ "Ordered")` at `:340`: action-item tokens → `action_items`; Closed → `closed_at = now(), closed_by = 'sheet'`; Canceled → `qty_canceled = qty_ordered` on every line (`:450`); Returned / Received / Received Partial / Ordered → nothing. **Unmapped token → the PO is skipped and reported** (`:341`) |
| Col L / M / N on insert | L → `po_line_items.qty_ordered` (blank → NULL); M → `qty_received` (blank → NULL, never 0); N → `po_asins.qty` |
| `po_asins` from lines | one row per (PO, ASIN) (`:235–331`). Single row or bundle group (Col S ≥ 2): `qty` = Col N take-first, `cost_per_unit` = Col Y verbatim. S = 1 same-ASIN group: `qty = Σ Col N`, cross-checked against Σ(L × T), cost verbatim if all rows agree else Col-N-weighted average in integer cents. Mixed S inside one ASIN group → whole PO skipped. `sku` = `asins.primary_sku` at insert time; prep = Col AS (blank → 0); sold_as / units_per_pack = AX / AY |
| Insert SQL | `purchase_orders` (`:426–437`, `source = 'sheet_import'`, never `status`), `po_asins` (`:440–444`), `po_line_items` (`:446–453`, `item_discount = 0`, `final_qty` generated) — one transaction |

Cleanup map (ported unchanged into the sync): payment "Gift card" →
"Gift cards", "Visa 7927" → "Chase (7927)", single-token case-normalisation
to the seeded spelling; cashback "Topcashback" → "TopCashback", "-" /
"Coupons" → NULL; order 130097 drops its stray Weighted GC %; blank Email
used → `orders@coastalqualitygoods.com`; Rcpt TRUE → `invoice_attached`.

## P3 — Other live readers of PO-row data from the sheet

All five read the **Status cell only** for a "canceled" / "closed"
substring, from the same `Sheet1!A2:AZ` range, and none of them reads or
writes a PO table. They stay untouched (Maria, 2026-10-16: out of scope).

| File:line | What it does with the Status cell |
|---|---|
| `server/google-sheets.ts:53–55` | COGS/ordered-qty sync: skip canceled rows; closed rows not "on order" |
| `server/sellerboard-cogs.ts:179–185` | Export SB COGS: skip canceled rows |
| `server/velocity-export.ts:191` | Velocity CSV: skip canceled rows |
| `server/sourcing-cost.ts:151` | Sourcing-cost export: skip canceled rows |
| `server/velocity-reconcile.ts:159–160, 217–219` | Velocity reconcile: canceled flips, "sheet_status" in diffs |

None duplicates what the sync now stores: they consume the sheet's
row-level canceled flag for exports that run against the sheet, not the PO
module. The PO-module equivalent (`qty_canceled` on the lines, derived on
the ASIN row) is written only by the §6.4 backfill and, after this patch,
the sync.

## P4 — Dry-run counts

### Match-key uniqueness (§3.1) — no stop

`(supplier, order_id)` groups the sheet into **1,062** PO keys; a key is
unique by construction (rows with the same key are one PO). `purchase_orders`
has 773 rows, all unique on the same key (constraint
`purchase_orders_supplier_order_id_key`).

### Status tokens — STOP

Every token the importer met on 2026-08-21 maps. One new token appeared
since: **"Shipped FBA"** on `fleetfarm.com MW7400517` (existing PO, row
596, cell `"Shipped FBA, Confirm Refund / Replacement"`, L 39 / M 10 / N
13). The importer's dry run skips that PO; the sync's dry run reports it
and writes nothing while it exists (fail-closed, §3.7). Decision needed:

- **Recommended:** map "Shipped FBA" → nothing (a state word, like
  Received — AF already tracks it as `po_asins.qty_shipped_fba`), counted
  in the report.
- Alternative: an eighth action item (needs the migration-056 CHECK
  widened), or ask the VA to stop using it.

### Counts (local DB, mirror sheet, 2026-10-16)

| Count | Value |
|---|---|
| Sheet PO keys (2026 rows) | 1,062 |
| New POs the sync would insert (none in AF) | **290** — all dated after 2026-08-24, the last imported PO date (0 AF rows are dated later) |
| Existing POs whose sheet row differs from AF | **84** |
| Existing POs unchanged | 688 |
| Lines deleted (§3.5) | 3 |
| `po_asins` rows deleted (§3.4, no shipments) | 3 |
| `po_asins` kept with shipments | 0 (table is empty) |
| POs in AF, not in sheet | **1** — `target.com 102003663034827` |
| Unmapped tokens | 1 (above) |
| Mixed Col S POs | 0 |

The importer's own dry run agrees: 290 would-insert, 771 skipped-existing
(it does not count the fleetfarm PO it skips), 441 `po_asins`, 450 lines,
cross-check mismatches 0, mixed-S 0.

### What the 84 updates are (field-level, 220 changes)

| Change | POs / lines |
|---|---|
| `closed`: open → closed (sheet) | 56 POs (32 of them change nothing else) |
| `closed`: closed (sheet) → open | 1 — `yankeecandle.com HFUS09001835764` (Status now "SHIP") |
| `action_items` replaced | 20 POs (5 gain an item, 11 drop all items, 4 change set) |
| `qty_received` (Col M) | 25 lines |
| `qty_ordered` (Col L) / `po_asins.qty` (Col N) | 14 / 14 |
| `cost_per_unit` / `adjusted_product_cost` | 10 / 11 (e.g. carters.com — a price correction) |
| `qty_canceled` | 10 lines — **all to 0** (see STOP item 2) |
| `order_total` / `refund_amount` | 8 / 7 (canceled POs: total moved to refund) |
| `subscription`, `promo`, `email_used`, loss qty/amount, prep, units/pack, tax, subtotal, discount, invoice_attached | 7, 5, 3, 5/5, 3, 2, 1, 1, 1, 1 |
| ASIN row replaced (one ASIN deleted, another inserted) | 2 POs — `michaels.com 8900110620911621`, `walmart.com 200015022377538` (the VA corrected the ASIN) |
| ASIN row deleted outright | 1 — `pyramydair.com 115449859` B0D8LBY448 |

Sample diffs (first 10 changed existing POs) are in the dry-run output;
the first two:

```
pyramydair.com 115449859: closed: open → closed (sheet); B0D8LBY448: ASIN row deleted (not in sheet; 1 line(s))
carters.com CAR118908837: discount: 61.00 → 0.00; promo: NULL → Sale; closed: open → closed (sheet); B0FBGXTSC8.cost_per_unit: 12.41 → 15.52; …
```

### The PO in AF but not in the sheet

`target.com 102003663034827` (2026-08-17, ASIN B07N6V4B12, qty 5) was
re-keyed in the sheet: row 461 now reads Order ID **`102003663034827_1`**,
Closed, ASIN **B095FGHXXT**. Under the importer's key the sync inserts
`102003663034827_1` as a new PO and reports the old row as "in AF, not in
sheet" (§3.5 never deletes). The stale row needs a manual delete once the
sync has run; nothing references it.

### Canceled POs (STOP item 2 — a decision, not a patch stop)

Rows with Status "Closed, Canceled" today carry L = 0, N = 0, Refund Amount
= the old total, Order Total = 0 (`devrom.com 200058280`, `honestmed.com
391928`, `rei.com A402960277`, `jcpenney.com 2026115412305399` ×4 lines,
`cvs.com 759256288`, `dkhardware.com DKH-3192308`). AF currently holds the
ordered quantities for those (12, 3, 5, 8×4 …) with `qty_canceled` from the
§6.4 backfill. Literal D2 overwrites all three to 0. Options:

- Literal (default if no answer): sheet wins, zeros land, Canceled column
  shows 0; the PO's original ordered quantity is kept nowhere in AF.
- Keep-on-cancel: when the sheet says Canceled and Col L is 0, leave
  `qty_ordered` / `qty` as stored and set `qty_canceled = qty_ordered`.

### Scope note

`classifyRows` keeps 2026 rows only; the 2,433 non-2026 rows are the 2025
tail the importer never covered and `purchase_orders` holds no pre-2026
PO. The sync keeps that filter ("the importer's existing key" and parse,
§3.1/§3.2); extending to 2025 would be a separate import decision.

### Returned token

§3.2's "Returned → `qty_returned`" is read as the importer does it: Col R
(per-line returned qty, blank → 0) is the sheet-owned source of
`qty_returned`, and the "Returned" Status word itself maps to nothing (it
carries no quantity — `script/migrate-po-status.ts:12`). §3.3's "sheet no
longer says Returned → NULL" therefore does not apply to `qty_returned`
(Col R is overwritten verbatim, never NULL); it applies to `qty_canceled`.

## P5 — `po_asins.id` ↔ `po_asin_shipments`

Confirmed:

```
po_asin_shipments.po_asin_id uuid NOT NULL
  REFERENCES po_asins(id) ON DELETE CASCADE          (po_asin_shipments_po_asin_id_fkey)
UNIQUE (po_asin_id, fba_shipment_id)
trigger po_asin_shipments_rollup_trg → po_asins.qty_shipped_fba / qty_received_amazon
```

Also relevant to §3.4: `po_line_items.po_asin_id` is `ON DELETE SET NULL`,
so deleting a `po_asins` row would orphan its lines rather than remove
them — the sync deletes the lines explicitly before the ASIN row. `po_asins`
has `UNIQUE (po_id, asin)`, which is the §3.4 match key.

## Implementation notes for commit 2 (what the dry run above was built on)

- `server/po-sheet-sync.ts` (uncommitted at commit 1): `parsePoSheet`
  ports the importer's assembly verbatim; `syncPoSheet({ sheetId, dryRun })`
  diffs against the three tables and applies in one transaction; the
  result carries the §3.9 counts, 10 sample diffs, the full diff list, the
  unmapped tokens, the kept-with-shipments list and the in-AF-not-in-sheet
  list. Dry run and any stop condition write nothing.
- Lines are matched by `(po_asin_id, position)`; a position past the
  sheet's line count is deleted (§3.5).
- AF-owned and never written: the six `po_asins` qty columns,
  `po_asin_shipments`, `po_asins.notes`, `po_asins.sku` after insert,
  `po_line_items.notes` / `item_discount`.
