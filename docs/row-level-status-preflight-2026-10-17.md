# Row-level Status patch — pre-flight findings (commit 1)

Patch: `docs/claude_spec-patch-row-level-status.md` §1 (P1–P4). Evidence
2026-10-17 at `95958fc`, mirror sheet read-only, local DB (same state as
production). **STOP on P2** — bundle yields are not stored as 1/N per
product. Commits 2–6 not started.

## P1 — POs whose rows carry different Status cells

1,072 sheet PO keys (2026 rows), 307 multi-row, **66 with differing
Status cells**. No unmapped token on any row.

| Difference | POs | Examples |
|---|---|---|
| Closed on some rows, not all | 46 | walmart.com 200014880853940 "Ordered" / "SHIP" / "Closed"; michaels.com 5900109610195973 "SHIP" / "Closed"; walmart.com 200015678205081 "Closed" / "Closed" / "Missing / Damaged from Supplier, Need to Return"; walmart.com 200015303831595 "Closed" / "Closed" / "SHIP"; yvesrocherusa.com 137736 "Closed" / "Closed" / "SHIP" |
| Action items on rows 2+ not on row 1 | 35 | walmart.com 200014880853940; walmart.com 200015297647874 "SHIP" / "Need to Return, Confirm Refund / Replacement"; walmart.com 200015678205081; walmart.com 200015303831595; yvesrocherusa.com 137736 |
| Canceled on a subset of rows | 5 | walmart.com 200014824520197 "Closed, Canceled" / "Closed"; walmart.com 200015071555912; webstaurantstore.com 126768935; simplicity.com 15848232; walmart.com 200014030603715 |

target.com 912003733645362: Kinder's B0H4P226KP "Closed", Kinder's
B0H3XJTQVG "Closed", Topps B0HGP5P91F "Received" — the case in §0.

## P2 — yield (`asin_qty_per_product`, Col T) encoding — STOP

Multi-packs follow "ASIN units per product unit": macys.com 4800667218
B081S8MTJ5 4-pack, L=10 T=0.50 N=5 (a 2-pack product → ½ ASIN);
walmart.com 200015328073060 B00J3YPV1C 3-pack, L=9 T=0.33 N=3;
communitycoffee.com 56693 B07K889YZ7, L=6 T=2.67 N=16 (product is a
larger pack than the ASIN).

**Bundles do not follow 1/N.** All 16 ASIN groups with Col S ≥ 2 store a
per-component yield of "ASIN units per product unit as if the component
alone made the ASIN" — 1.00 for a 1:1 component, the pack count for a
multi-pack component — never 1/N:

| PO | ASIN | S | Components (L, T, N) |
|---|---|---|---|
| walmart.com 200015497641702 | B0G6R55GNQ (Kinder's bundle) | 2 | Veggie Rub 12 / 1.00 / 12; Smoked Onion 12 / 1.00 / 12 |
| yvesrocherusa.com 137736 | B0DWXWHXP1 | 2 | Hair Shine Vinegar 5 / 1.00 / 5; 5-pack Shampoo 1 / 5.00 / 5 |
| godiva.com 509573 | B019YPFEKM | 3 | three sets, each 1 / 18.00 / 18 |
| walmart.com 200015523189765 | B0GNHTYGPF | 2 | 10 / 1.00 / 10; 10 / 1.00 / 10 |

Under Maria's rule these would be 0.5 / 0.5, 0.5 / 2.5, 6 / 6 / 6 and
0.5 / 0.5. AF stores them exactly as the sheet has them (Kinder's
B0G6R55GNQ: two lines, qty 12, yield 1.00; `po_asins.qty` 12).

Five of the 16 groups (iherb.com 943568870 / 943318214 B00SKJW2U4,
petsmart.com 1113633269 B08QMDXLB1, walmart.com 200014535912609
B0FPF1CGQF, and one more) carry S ≥ 2 with sold_as blank — same-ASIN
listings, not bundles; their T is the ordinary per-product yield.

## P3 — ASIN-row Canceled / Returned derivation; action_items readers

Derivation today: `server/po-queries.ts:14–24` `derivedFromLines` =
Σ(line `qty_canceled` × `asin_qty_per_product`), NULL if any line NULL;
the same SQL is reused in `server/asin-po-pipeline.ts`. **Consequence of
P2:** a fully canceled 2-component bundle derives 2× its ASIN quantity
(Kinder's: 12 × 1 + 12 × 1 = 24 against `qty` 12), so On Order would go
negative before the max(…, 0).

Readers / writers of `purchase_orders.action_items`:
`server/po-sheet-sync.ts:264, 363, 540–560` (sync insert / diff / update);
`server/routes.ts:4326–4331` (list filter), `:4453–4474` (PATCH editor +
auto-close); `server/po-close.ts:43–54` (auto-close (b)); client
`client/src/pages/purchase-orders.tsx:39, 124–142, 464, 511, 649, 684,
718` (chips, editor, facet, detail card).

## P4 — diff of the §2 rules against the current DB

| Effect | Count |
|---|---|
| POs Closed → Open (not every row Closed) | 39 — includes the shipment-reconciliation auto-closed POs whose sheet rows still say "Ordered" (store.ui.com US6368989, SHOP533384, S602615, …); those already reopen under today's sheet-wins rule |
| POs Open → Closed | 0 |
| POs whose action-item union differs from today's PO array | 34 |
| Lines that get action items | 191 |
| Lines whose canceled qty changes | 5 (e.g. walmart.com 200014824520197 B0DYVMNL13 4 → NULL; simplicity.com 15848232 B01N5PZKPN NULL → 5) |
| ASIN rows whose derived Canceled changes | 3 (with today's stored yields) |
| Sheet rows without an AF line | 0 |

## Decision needed

How should a bundle's yield be read for §2.2?

1. **Recommended:** keep Col T as stored and derive a bundle ASIN's
   Canceled / Returned as **min over components** of (line qty × yield)
   instead of the sum — one ASIN needs one of each component. No sheet or
   data change; multi-packs and 1:1 rows are unaffected.
2. Rewrite bundle yields to 1/N × stored yield in AF (sheet keeps its
   values; the sync would re-apply the factor on every run).
3. Ask the VA to change Col T for bundles in the sheet.
