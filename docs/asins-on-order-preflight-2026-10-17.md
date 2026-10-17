# ASINs on-order patch — pre-flight findings (commit 1)

Patch: `docs/claude_spec-patch-asins-on-order-from-pos.md` §1 (P1–P4).
Evidence gathered 2026-10-17 at `8da162a` against the local database
(1,062 POs, 1,595 `po_asins`, 752 `po_asin_shipments`; the same state as
production after the shipment-reconciliation backfill).

**No stop.** Every formula `ordered_qty` feeds is one the patch names
(Stock total, FBA Stock, Days Left) — see P2.

## P1 — How "Ordered" is computed today, and every reader

| Role | Where | What |
|---|---|---|
| **Stored** | `asin_estimates.ordered_qty` (integer) | The Orders sheet's open quantity per ASIN: Σ Col U over rows whose Status is not canceled/closed, net of Col O shipped (`server/google-sheets.ts:53–95`) |
| **Writer 1** | `runSheetsSync` — `server/routes.ts:1000–1001` | `UPDATE asin_estimates SET … ordered_qty = $n` per ASIN on Sync POs (the per-ASIN half), on Push to Aura's inline read, and on scheduled component 9 (`server/scheduler/components/09-po-sheet.ts`) |
| **Writer 2** | clearing pass — `server/routes.ts:1022–1040` | `ordered_qty = 0` for ASINs with no sheet rows (fail-closed on `rawRowsRead = 0`) |
| **Copy** | `server/inventory-sync.ts:106–115` | component 15 copies the current `asin_estimates.ordered_qty` into every `inventory_snapshots` row (`ordered_qty` column) — snapshot history of the sheet number |
| **Reader: ASINs list** | `GET /api/asins` — `server/routes.ts:1198` (`e.ordered_qty AS est_ordered_qty`), `:1323` (`ordered`), `:1326–1341` (`stock.ordered`, `stock.total`), `:1348` (`fbaStock`) | `stock = { available_fba, reserved, inbound (Amazon shipped + receiving + working), ordered, total, hasSnapshot }`; `total = available + reserved + inbound + ordered`; `fbaStock = total − ordered` |
| **Reader: table** | `client/src/components/results-table.tsx:509` (sort/filter/CSV value), `:2241–2242` (cell), `:1091/:1098/:1829/:2388/:2395` (Stock tooltips "Ordered: N"), `:520–530` and `:2403–2410` (Days Left = `stock.total ÷ velocity`) | the "Ordered" column (`shared/schema.ts:693`, group Stock, hidden by default) and the Stock tooltip |
| **Reader: Analytics** | `client/src/pages/analytics.tsx:235` | the same column id in its value switch |
| **Reader: history modal** | `GET /api/asins/:asin/history` — `server/routes.ts:3296`, `:3314` (`metrics.ordered`); `client/src/components/stock-history-modal.tsx:26`, `:114` ("Ordered (PO)") | display only; `days_left` there uses `available_fba` only |
| **Reader: numeric filter list** | `client/src/components/column-filter.tsx:47` | `ordered` among the numeric-operator columns |
| **Reader: widths** | `results-table.tsx:54`, `grouped-table.tsx:55` | column width tables |
| **Export CSV** | `client/src/components/export-buttons.tsx:10–39` | headers from `ALL_COLUMNS` labels, values through the table's sort-value function — follows the column list automatically |
| **Not readers** | SB COGS export, Velocity export, sourcing-cost export, Aura push, Bulk Calc | `grep ordered_qty\|orderedQty` finds none; Bulk Calc excludes the Stock group entirely (`bulk-calc.tsx:34`) |

## P2 — Formulas that consume `ordered_qty`

1. **Stock (total)** — `routes.ts:1331–1336`: `available_fba + reserved + inbound + ordered`. "Inbound" here is Amazon's own inbound (shipped + receiving + working), so `ordered` is meant as **not-yet-shipped units** — the §3.3 "On Order" case, not Pipeline (Pipeline would double-count the shipped-not-received part already inside Amazon inbound).
2. **FBA Stock** — `routes.ts:1348`: `total − ordered`. Identity holds with On Order substituted.
3. **Days Left** — `results-table.tsx:520–530` and `:2403–2410`: `stock.total ÷ (units_sold ÷ active days)`. Inherits the Stock change; no separate use.
4. **inventory_snapshots.ordered_qty** — `inventory-sync.ts:107–115`: a copy for history. Switches to the PO-derived On Order at snapshot time (same column, new source).
5. No restock priority, profit, replenishment or Bulk Calc formula reads it (grep across `server/`, `shared/`, `client/src/`).

## P3 — Amazon's own inbound counts

Already fetched and stored. `server/inventory-sync.ts:50–74` calls
`getInventorySummaries` with `details: "true"` and stores
`inboundShippedQuantity` as `inventory_snapshots.inbound_shipped` and
`inboundReceivingQuantity + inboundWorkingQuantity` as
`inbound_receiving`. `GET /api/asins` returns their sum as
`stock.inbound`, rendered today as the **"Sent to FBA"** column
(`sentToFba`) and in the Stock tooltip. So §3.5 applies with no new
stage: "Amazon Inbound" is the existing `sentToFba` figure, relabelled,
shown beside the PO-derived Inbound FBA.

## P4 — Join path `asins` ↔ `po_asins`

By ASIN string: `po_asins.asin` (varchar, upper-case, trimmed — 0 rows
otherwise) ↔ `asins.asin`. 1,595 rows, 848 distinct ASINs, 846 present in
`asins` (2 PO-only ASINs, ignored by the ASINs page). An index on
`po_asins(asin)` exists. No per-SKU split is needed: 9 ASINs carry more
than one Amazon SKU across their PO rows (the SKU at import time), and
every on-order figure is per ASIN, summed over rows.

Fixture ASINs for the spot-check (local, after the reconciliation backfill):

| ASIN | Rows | Why |
|---|---|---|
| `B004WZ4CLW` (Equal Exchange) | one PO `SHOP533384`, 10 ordered, 10 shipped FBA, 0 received, auto-closed | fully shipped |
| `0349125937` (Twilight) | `102003840691113` 9/9 shipped; `102003843107733` 3 ordered, 1 shipped, 2 at prep, both open | partly shipped |
| `B0091CZ7WO` | `124976637` 2026-04-29, 12 ordered, closed from the sheet, no shipment rows | unreconciled pre-May PO (D1 excludes it from On Order) |

Over-received example for the pipeline test: `B01AWK114G` on `129059664`
— 16 ordered, 16 shipped, 17 received (contributes 0 to Inbound FBA).
