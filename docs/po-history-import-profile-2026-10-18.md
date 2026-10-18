# PO history import — profiling pass (commit 1)

Patch: `docs/claude_spec-patch-po-history-import.md` §1 (P1–P6). Read-only,
2026-10-18 at `234d5eb`, mirror sheet `Sheet1!A2:AZ`, local DB (same PO
state as production). **STOP — three §1 conditions hit (P2, P3, P5).**
Commits 2–4 not started; nothing written.

## P1 — volume

4,087 sheet rows: 1,647 dated 2026, **2,433 dated before 2026**, 7 blank
spacer rows. Pre-2026: **1,401 (supplier, order_id) groups**, 2024-05 →
2025-12. Monthly: 2024-05 2 rows · 06 1 · 07 24 · 08 14 · 09 89 · 10 53 ·
11 103 · 12 69 · 2025-01 173 · 02 226 · 03 112 · 04 127 · 05 145 · 06 159 ·
07 228 · 08 178 · 09 219 · 10–12 the rest.

## P2 — column layout by period (fill %) — STOP

| Column | 2024-H1 (3 rows) | 2024-H2 | 2025-H1 | 2025-H2 | 2026 |
|---|---|---|---|---|---|
| G product · K price · L qty · T yield · X · **Y COGS** | 0 | 61–70 | 94–95 | 100 | 100 |
| N ASIN qty · B · AB/AG money | 100 | 69–100 | 94–100 | 100 | 100 |
| S unique products | 0 | 9 | 94 | 100 | 100 |
| **AS prep** | 0 | 0 | 0 | 0 | 62 |
| **AX sold_as · AY units/pack** | 0 | 0 | 0 | 0 | 39 |

- **AS (prep) is absent before 2026.** The importer reads a blank AS on a
  real row as a deliberate $0 (SPEC §3); before 2026 the column did not
  exist, so blank means "not recorded", and importing would stamp $0 prep
  on every historical ASIN row.
- **AX / AY (sold_as, units/pack) are absent before 2026.** The importer
  defaults to "individual", 1 — but 2025 rows carry multi-pack yields
  (T = 0.50 on 224 rows, 0.33 on 43, 0.25 on 32), so many historical ASIN
  rows would be recorded as individual units with the wrong pack size.
- **2024 rows are thin:** product, price, qty and COGS are empty on 30–39 %
  of 2024-H2 rows and on all three 2024-H1 rows (those carry N and money
  only).
- Formats are otherwise compatible: every date is M/D/YYYY; no unusual
  money; N = L × T on 2,148 of 2,229 single-product rows (81 differ, e.g.
  zoro.com WB8751491317 B00GXO5AQG L=72 T=0.17 N=12 — T rounded to 2 dp).

## P3 — Status tokens — STOP

Closed 2,303 · Ordered 124 · Returned 61 · Canceled 60 · Missing / Damaged
from Supplier 35 · **Lost / Damaged by Us 21** · See Comments 8 · SHIP 6 ·
Received - FBM 6 · **Partial Return 6** · Received 2.

Two tokens the map does not know:
- **"Lost / Damaged by Us"** (21 rows, e.g. row 1656 macys.com B002PLQ17S
  12/31/2025 "Closed, Lost / Damaged by Us", V = 1.00) — Col V carries the
  lost quantity on these rows; AF tracks this as `qty_lost_damaged_us`.
- **"Partial Return"** (6 rows, e.g. rows 2714, 2889, 2977).

## P4 — rows / POs the importer would reject

The parser accepts 1,376 of 1,401 groups (2,280 lines). Rejected:

| Reason | Count | Examples |
|---|---|---|
| Unparseable percent "%" (Weighted GC % / Cashback %) — **throws, aborting the whole parse** | 9 POs | walmart.com 200013211531231 (row 3154), harborfreight.com 125494885, govets.com 000457055, zara.com 53627938983 |
| Unparseable int "5, 1" in a qty cell — **throws** | 6 POs | walgreens.com 211548218668 (row 4060), target.com 102001855890511, funko.com 14298279 |
| No ASIN on any row (expense rows) | 9 groups | "Spend Placeholder for Graph" (row 2928), "2024-12-12_AMZ_Shipping-Supplies" (row 3770), lowes.com 300901026250213377 |
| A row with no ASIN inside a PO (row skipped) | 10 | walmart.com 200013627883961 (row 2418) |
| Blank Order ID | 1 | homedepot.com (row 2101) |
| Mixed Col S | 0 | — |

The two "throws" reasons would stop the importer outright today (one bad
cell fails the whole read), not just skip the PO.

## P5 — collisions with AF — STOP

1: **leadersrpmshop.com 10507736.** The supplier reused the order number:
row 2041 is 10/19/2025, B07S5R68XZ, 5 × N 30 @ $7.60; row 743 is
6/21/2026, same ASIN, 3 × N 18 @ $7.04, already in AF (2026-06-21, closed).
Under the (supplier, order_id) key the 2025 order cannot be imported as a
separate PO.

## P6 — Velocity tie-in

Of 59 open "order number not in AF" Velocity lines, **0** would match an
imported PO (exact or by order # + ASIN). They are PrepBusiness-era INSH
orders and 2026 re-keyed / free-text order numbers, all after the
history window.

48 of the importable pre-2026 POs carry action items.

## Decisions needed

1. **Prep and sold_as / units-per-pack before 2026** — import prep as NULL
   (not recorded) instead of $0, and derive units/pack from T (e.g. T =
   0.50 → 2-pack) or leave them as individual?
2. **"Lost / Damaged by Us"** → `qty_lost_damaged_us` from Col V on that
   ASIN row, or nothing? **"Partial Return"** → nothing (Col R carries the
   qty when present), or treated like Returned?
3. **leadersrpmshop.com 10507736 (2025)** — import under a suffixed key
   (e.g. `10507736_2025`, the sheet's own `_1` convention), or skip it?
4. **The 15 throwing rows** — skip those POs and report them, or fix the
   cells in the sheet first?
