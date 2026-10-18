# Spec patch — Row-level Status: action items and cancels per Product/ASIN; Closed and On Order fixed

Date: 2026-10-17
Status: APPROVED 2026-10-17 (Maria's rules in §2; stop only on pre-flight surprises listed in §1)
Supersedes: the PO-level Status mapping in `claude_spec-patch-po-sheet-sync.md` §3.2–3.3 and `claude_spec-patch-po-expand-by-asin.md` §6.1/§6.4; decision D1 of `claude_spec-patch-asins-on-order-from-pos.md`.

> **Superseded in part (2026-10-18):** for POs already in AF, the sheet-side mapping of §2.3 (each row's Status → that line's action items / cancel, Closed when every row says Closed, reopen otherwise) no longer runs — `claude_spec-patch-po-af-owned.md` §2 makes Sync POs intake-only and AF the owner of action items, cancels and Closed. The row-level mapping still sets a **new** PO's initial state when it is inserted. The ASIN-level derivations (§2.4, bundle ÷ N, On Order / At Prep over open and closed POs) are unchanged.

## 0. Why

The Orders sheet's Status is set **per row**, and a row is a Product (a `po_line_items` row). The PO sync reads the Status cell of the **first row of each PO only** and applies it to the whole PO (`server/po-sheet-sync.ts`, `statusCell = t(c[COL.status])`). Result, e.g. target.com 912003733645362: row 1 Kinder's (Closed) closed the PO while row 3 Topps B0HGP5P91F (Received, 2 units still at Velocity) was never read. The same flaw drops action items on rows 2+ and turns a first-row Canceled into a whole-PO cancel. Separately, the ASINs page hides On Order / At Prep for Closed POs (D1), so a wrong Closed hides real units.

## 1. Pre-flight (commit 1, report; no code)

P1. How many sheet POs have rows with differing Status cells; for each kind of difference (Closed vs non-Closed, action items on rows 2+, Canceled on a subset of rows) the count and 5 examples.
P2. Confirm the yield column (Col "ASIN Qty per Product" / `asin_qty_per_product`) encodes Maria's rule: 2-pack → 0.5 per product unit; bundle of N different products → 1/N per product unit. Show 3 multi-pack and 3 bundle examples. **Stop** if bundle yields are stored differently (e.g. 1 per product).
P3. Confirm the ASIN-row Canceled/Returned derivation today is Σ(line qty × yield). List every reader of `purchase_orders.action_items`.
P4. Dry-run diff of the new rules (§2) against current DB: POs whose Closed flips, action items moved, lines whose canceled qty changes, ASIN rows whose derived Canceled changes.

## 2. Rules (Maria 2026-10-17)

2.1 **Action items live at Product level** (`po_line_items.action_items text[] NOT NULL DEFAULT '{}'`, same allowed values/CHECK as today), because a sheet row is a Product.
- Sheet sync: each row's Status tokens → that row's line `action_items` (full replace, per line).
- ASIN row shows the union of its lines' action items. Setting an action item on an ASIN row in AF writes it to **all** its mapped lines; removing it from an ASIN removes it from all its lines. Setting/removing on a Product affects that line only (and so shows/disappears on its ASIN via the union).
- PO level: the Action Items column on the POs page shows the union over all lines (read-only aggregate there, editable on the nested ASIN rows / PO detail). `purchase_orders.action_items` stops being written; kept for one release, dropped later (same pattern as `status`).

2.2 **Canceled is per Product and ASIN.**
- Product (row) marked Canceled → that line's `qty_canceled = qty_ordered`. The ASIN's Canceled is derived as today, Σ(line qty_canceled × yield): 1 product unit of a 2-pack → 0.5 ASIN units; 1 product of a 3-product bundle → 1/3 ASIN unit.
- ASIN marked Canceled in AF (UI action on the ASIN row) → every line mapped to that ASIN gets `qty_canceled = qty_ordered`.
- Keep the existing rule: a sheet row Canceled with Col L = 0 on a line already in AF keeps the stored ordered qty and sets canceled = ordered.
- Returned: same per-row treatment (row says Returned → that line's `qty_returned` only where the sheet carries a qty; otherwise leave as-is and report).

2.3 **Closed** (PO level, while the sheet still wins): the PO is Closed from the sheet only when **every** row's Status contains Closed. Otherwise the sheet leaves it Open. The auto-close rule now checks "no action items on any line" instead of the PO-level array.

2.4 **On Order / At Prep on the ASINs page** no longer depend on Closed:
- At Prep = Velocity's quantity for every PO ASIN row, open or closed.
- On Order = Σ max(Expected − COALESCE(Shipped FBA,0), 0) over PO ASIN rows whose PO date ≥ the reconciliation start (earliest Velocity shipment date / `VELOCITY_MIN_ORDER_DATE`, whichever Phase 2 used), open or closed. Older rows contribute 0 (no shipment data exists for them).

## 3. Commits

1. Pre-flight report (§1).
2. Migration: `po_line_items.action_items`; backfill lines from the sheet's per-row Status (dry run first, counts per §1 P4).
3. Sheet sync: per-row Status mapping (§2.1–2.3), unmapped-token STOP unchanged.
4. UI: action items on ASIN rows (union, write-through to lines) and Product rows; POs-page column = aggregate; ASIN "Mark canceled" action (§2.2); auto-close uses line action items.
5. ASINs page On Order / At Prep rule (§2.4).
6. SPEC §14, §22, §6; supersession notes in the three earlier patch files.
Gates per commit; dry run then live locally; one report before pushing (include target.com 912003733645362: PO Open, Topps B0HGP5P91F On Order 2 / At Prep 2, Kinder's rows' action items/closed state). After deploy: production dry run, then live, then report.
