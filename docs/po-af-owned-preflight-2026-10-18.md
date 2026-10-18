# AF-owned POs patch — pre-flight findings (commit 1)

Patch: `docs/claude_spec-patch-po-af-owned.md` §1 (P1–P4). Evidence
2026-10-18 at `c59ced2`, mirror sheet read-only, local DB. **STOP on P1:**
the per-ASIN COGS reader needs sheet rows AF never imported (every row
dated before 2026). Commits 2–8 not started.

## P1 — every code path that reads the Orders sheet

All read `Sheet1!A2:AZ` of `GOOGLE_SHEET_ID` through `getSheetValues`.

| Reader | Where | Reads | Does | Switchable to AF tables? |
|---|---|---|---|---|
| Sync POs — PO half | `server/po-sheet-sync.ts:304` `readPoSheet` | A1:AZ, 2026 rows | inserts / updates POs | intake stays on the sheet by design (§2.1) |
| Sync POs — per-ASIN COGS half; Push to Aura's inline read; scheduled component 9 | `server/routes.ts:944–1040` `runSheetsSync` → `server/google-sheets.ts:44` `fetchSheetDataWithMeta` | D status, E supplier, H ASIN, Y COGS, AS prep (U / O only for the retired ordered qty) | `asin_estimates.actual_cogs` / `cogs_source='po_sheet'` / `estimated_cogs` / `prep_override`, `asins.supplier`, from the **first non-canceled row per ASIN in sheet order, any year** | **No — see the stop below** |
| COGS reset / sync-from-PO / bulk sync-from-PO | `server/routes.ts:4204–4290` (`fetchSheetData`) | same map | per-ASIN `cogs`, `estimated_cogs` | same dependency as the row above |
| Onboarding supplier fallback | `server/full-scope-pass.ts:507–515` (`fetchSheetData`) | E supplier | supplier for SC-discovered ASINs | same map; supplier exists for 2026 POs only |
| Upload to Velocity — CSV + plan + execute | `server/velocity-export.ts:157–260` (`buildVelocityRecords`), `server/velocity-reconcile.ts:131–280` (`buildVelocityPlan`) | B, C, D, E, G, H, I, L, N, S, T, AS, AX, AY, **AZ** | create candidates (floor 7/30/2026, not canceled, prep > 0, live SKU, pack math), bundle derivation, quantity audit vs Velocity | Yes: rows ≥ the floor are all 2026, imported; AZ is derivable (below) |
| Export SB COGS | `server/sellerboard-cogs.ts:154–240` | C, D, H, U, Y, AS | per ASIN × date cost, **2026 rows only** (`excludedNonYtd`) | Yes: U derivable (below); Y / AS stored on `po_asins` |
| Sourcing-cost export | `server/sourcing-cost.ts:133–160` | C, D, H | which ASINs were purchased in a user-chosen window; cost from `asin_estimates` | Yes for windows inside 2026; a window reaching before 2026 has no AF rows |
| Velocity reconcile Status readers | `server/velocity-reconcile.ts:174, 233` | D "canceled" | dedup / delete-candidate signal | Yes: line `qty_canceled` |
| Update COGS in SC | — | — | reads `asin_estimates`, not the sheet | nothing to switch; inherits the COGS half |

The five Status-cell readers of the earlier patches are the D reads in
`google-sheets.ts:53–55`, `sellerboard-cogs.ts:179–185`,
`velocity-export.ts:191`, `sourcing-cost.ts:151`,
`velocity-reconcile.ts:174/233` — all "canceled" / "closed" substring
tests, all replaceable by line `qty_canceled` / PO `closed_at`.

### The stop: COGS needs pre-2026 sheet rows

`runSheetsSync` takes each ASIN's cost from its **first non-canceled row
in sheet order, of any year** (the sheet is newest-first; bottom rows date
to 2024-05). AF imported 2026 rows only (2,433 older rows were never
imported, by design of the 2026 importer).

| Measure | Count |
|---|---|
| ASINs with a non-canceled sheet row | 1,622 |
| …whose cost-giving row is not 2026 | 790 |
| ASINs with **no 2026 row at all** | 786 |
| …that are in `asins` | 763 |
| …whose `actual_cogs` comes from the sheet today (`cogs_source = 'po_sheet'`) | **751** |

Examples: B000GGJCOI (12/28/2025, $5.86), B087D9MTR9 (12/28/2025, $6.99),
B09DGRL9QT (12/28/2025, $13.98), B0DFK825T3 (12/27/2025, $3.74),
B07MDSPDDQ (12/23/2025, $7.99).

Switching this reader to the AF tables would leave 751 catalog ASINs with
no PO cost source. The stored `actual_cogs` would stay as last written
(nothing clears it), but no later correction in the sheet could reach it,
and a newly onboarded ASIN with only pre-2026 history would get none.

## P2 — sheet columns readers use that AF does not import

| Column | Used by | AF equivalent |
|---|---|---|
| **pre-2026 rows (all columns)** | COGS half (cost, prep, supplier); sourcing-cost windows before 2026 | **none** |
| AZ quantity (Velocity units) | Upload to Velocity (create quantity, quantity audit) | derivable: on 2026 rows AZ = N × AY on 635 of 637 filled rows; the 2 exceptions are spoiledchild.com rows with AZ = 0 and blank AY; 1,007 rows have AZ blank (all before the Velocity floor or self-prep) |
| U qty per row | Export SB COGS (BatchQuantity) | derivable: U = N on 1,604 of 1,644 2026 rows; the 40 others are bundle components where U = N ÷ S (Yves Rocher 2.5 = 5 ÷ 2; Godiva 6 = 18 ÷ 3) — i.e. `po_asins.qty ÷ unique_products` split per line |
| O shipped | only the retired ordered qty | not needed |
| D Status | five substring readers | line `qty_canceled`, PO `closed_at` |

## P3 — `closed_by = 'sheet'` and the sheet-wins update path

- Writers: `server/po-sheet-sync.ts:483–487` (update path), `:581` (insert);
  `script/import-po-2026.ts:436`; `script/migrate-po-status.ts:82`.
- Readers / labels: `server/po-close.ts:3` (comment; auto never reopens
  'sheet'), `client/src/pages/purchase-orders.tsx:84` ("closed (from the
  Orders sheet)"), `server/po-status-map.ts:42` (comment).
- Sheet-wins update path: `server/po-sheet-sync.ts` HEADER_FIELDS /
  ASIN_FIELDS / LINE_FIELDS diff and the apply block (`:430–640`).
- Local DB: all 862 closed POs have `closed_by = 'sheet'`.

## P4 — POs where the sheet differs from AF today

Current-code dry run, local: 1,081 sheet POs, **8 new**, **0 existing POs
differ**, 1,073 unchanged. Nothing freezes in a state different from the
sheet as of this run.

## Decision needed

How should the per-ASIN COGS reader (and the COGS reset / sync-from-PO
routes and the onboarding supplier fallback) get cost for ASINs whose
only purchase history is before 2026?

1. **Recommended:** keep those three readers on the sheet for now, scoped
   to cost / prep / supplier, and switch only the Velocity, SB COGS,
   sourcing-cost and Status readers. One more import later brings
   pre-2026 POs into AF, then the COGS reader switches.
2. Import the pre-2026 rows into the AF PO tables first (a new importer
   run with its own profiling pass, as SPEC §22 already defers), then
   switch every reader.
3. Switch now and accept that 751 ASINs keep their last sheet cost frozen
   with no PO source.
