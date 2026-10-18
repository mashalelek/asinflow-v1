# Spec patch — Import pre-2026 POs from the Orders sheet

Date: 2026-10-18
Status: APPROVED 2026-10-18
Blocks: `claude_spec-patch-po-af-owned.md` (paused after its pre-flight, 332a904, unpushed). Resume that patch at commit 2 once this one is live on production.

## 0. Why

The original PO import kept 2026 rows only, so 2,433 sheet rows from 2024–2025 never reached AF. The per-ASIN cost half of Sync POs (and the COGS reset / sync-from-PO routes and the onboarding supplier fallback) still read those rows from the sheet: 751 catalog ASINs get their actual COGS from a pre-2026 row (e.g. B000GGJCOI $5.86 from 12/28/2025). Before every reader can move from the sheet to AF, AF must hold the full PO history.

## 1. Profiling pass (commit 1, report; no writes)

Over every sheet row with order date < 2026-01-01:
P1. Row and PO counts by year-month; (supplier, order_id) groups.
P2. Column-format differences vs. the 2026 layout the importer expects: columns empty/absent by period, different date formats, money formats, Sold As / Units-per-pack / yield (ASIN qty per product) / Col S populated or not, Col N (ASIN qty) vs. Col L (product qty) consistency.
P3. Status tokens: distinct values and counts; any token the current map doesn't know.
P4. Rows the importer would reject or skip (unparseable date, missing ASIN, mixed Col S, pack math), with counts and 10 examples per reason.
P5. Collisions: any pre-2026 (supplier, order_id) that already exists in AF.
P6. Velocity tie-in: how many of today's `shipment_unmatched` "order number not in AF" lines would match an imported PO.
**Stop and report** if P2 shows a column the importer depends on is absent or means something different for a period, if P3 finds unmapped tokens, or if P5 finds collisions. Otherwise continue.

## 2. Import rules

- Same parse/insert path as Sync POs' insert (row-level Status mapping: per-line action items, per-line cancels, bundle ÷ N derivation), applied to every pre-2026 PO not in AF.
- Every imported PO is **Closed**: `closed_at = order_date`, `closed_by = 'import'` (new value, labelled "Imported (history)" wherever closed_by is shown). They appear in the normal POs list, hidden by the default Open filter.
- Action items recorded on old rows are imported as-is; report the count of imported POs carrying action items so Maria can clear stale ones.
- No `po_asin_shipments` rows are created. On Order already excludes POs before the reconciliation start (2026-05-20), so these POs don't affect the ASINs page.
- Sync POs' 2026-only year filter is removed, so intake considers every sheet row; already-imported POs are skipped as existing (no-op).
- After the import, run Sync Shipments' matching (dry run first) so any Velocity lines that now find their PO (P6) are placed.

## 3. Verification

- B000GGJCOI: the 12/28/2025 PO exists in AF with cost/unit $5.86.
- For the 751 ASINs: every one now has at least one AF PO ASIN row, and the cost the sheet reader returns today equals the cost on that ASIN's newest non-canceled AF PO ASIN row. Report mismatches (count + 10 examples) — this is the evidence the af-owned patch needs to switch the cost reader.
- Second dry run: nothing left to insert.

## 4. Commits

1. Profiling report (§1).
2. Importer: remove year filter, `closed_by='import'` path, label.
3. Run: dry run then live locally; Sync Shipments matching dry run then live; verification (§3).
4. SPEC §22 (PO history) + note in the af-owned patch that its P1 blocker is resolved.
Gates per commit; one report before pushing. After deploy: production dry run, report, live, verification, report.
