# Spec patch — PO matching: Unmatched shipments cleanup + matcher rules

Status: IMPLEMENTED 2026-10-29 (commits f98616b…; production backfill live 2026-10-29: 5 seeds, 53 links, panel 62 → 9). AMENDED 2026-10-29 (reconciled with the Col P matcher, commits 11055c3 / 6b2ca36 / fa46b18) — decisions taken with Maria 2026-10-22; DRAFT 2026-10-23. One-time backfill + a small set of permanent rules.
Repo path: `docs/claude_spec-patch-po-matching.md`. Touches SPEC §11 (Velocity), §22 (PO module), §26 (PO tracking).

## 0. Reconciliation with Col P (2026-10-29)

Since the draft, Sync Shipments gained the Orders sheet's Col P ("FBA Shipment ID") as a matching signal:
migration 071 (`po_sheet_fba_shipments`, `shipment_unmatched.candidates jsonb`), `resolveByColP` in
`server/shipment-sync-velocity.ts`, and Col P candidate buttons inside the "Link to PO ASIN" popover.
It resolved 10 of the 72 panel rows (72 → 62: 59 `po_not_found`, 3 `no_order`).

| Draft section | Col P already delivers | Still to build (this patch) |
|---|---|---|
| §2 kinds | the `(none)`-order-# rows whose FBA shipment the sheet names (Heath, Monin, Celestial, Carter's B0DB6B3LDK, …) | INSH, `_N`, free-text, retailer aliases, the 3 `(none)` rows Col P doesn't name |
| §3 exact rules | — | aliases, normalization, base-ID |
| §4 candidate | a *different* candidate source (sheet FBA ids, not ASIN/date/units) and the `candidates` column to store candidates | the ASIN + supplier + date + units rule, ranking, nearest-miss |
| §5 backfill | its own dry run (`script/sync-shipments.ts`) | the per-line report and the alias-seed review |
| §6 panel | candidate buttons — but only inside the popover, only for Col P, no rank | buttons on the row, ranked §4 candidates, nearest-miss, dismiss, visible-only count |
| §7 tracking | — | everything |

Consequences, applied below:
1. **Col P runs before the §4 candidate rule** and is extended from `no_order` lines to every line that fails the exact rules (`po_not_found` too — INSH rows whose FBA shipment the sheet names). For a `no_order` line it stays today's hard rule (one PO ASIN row → link; Monin 73 of 72 stands). For a `po_not_found` line the units must also fit — the line's own order # disagrees with the sheet, and the production dry run showed Col P alone would place `CAR118805142_1` on a fully shipped CAR118908837 (5 → 10 of 5) and an INSH B00N50VOH0 line on 200014983225757 (1 → 2.5 of 1.5). A Col P row that doesn't fit stays in the panel as a one-click candidate with the reason.
2. **The `candidates` column from 071 is reused**, not duplicated: each entry gains `source` (`col_p` | `candidate`) and, for §4, `order_date`, `days`, `remaining_units`, `units`. No new candidates table.
3. **The panel's candidate buttons are the existing Col P buttons, generalized** (both sources, ranked, shown on the row).
4. **Base-ID matching must fit units** (new — the draft's §3.3(b) did not say so). Checked on the real rows: `CAR118805142_1` B0DZ33XH15 → AF `CAR118805142` already shows 5 of 5 shipped; an unconditional base match would place 10 against 5, the over-link class Maria ruled a bug (2026-10-29). A base match that doesn't fit stays in the panel with that as its nearest miss ("_1 PO missing from AF").
5. **Alias seeds are reviewed before they exist**: migration 072 creates `supplier_aliases` empty; the backfill dry run proposes the seeds and `--live` writes them (source `seed`). A migration would apply them at deploy, before the review.
6. **Alias editing lives in the Unmatched panel** (an unmapped retailer gets a "Map → supplier" control, like the tracking queue's Map domain), not on Settings — `tracking.supplier_domain_map` has no Settings page either.
7. **Monin**: AF has a `monin.com` supplier (3 POs), so the backfill proposes "Monin" → monin.com. The one Velocity "Monin" line is placed by Col P on Webstaurant 126768935 before any alias is read (Maria: 73 is correct); the alias only affects future Monin lines.

## 1. Goal

The POs page carries two review panels that today need hand work:

- **Unmatched shipments (62 rows after Col P)** — Velocity `/shipments` lines that Sync Shipments could not place on a `po_asins` row. Maria's decision (2026-10-22): match them to the real POs, INSH-era rows included — never hide; auto-link whenever exactly one PO fits; show only ambiguous rows.
- **Unmatched tracking (78 rows)** — mostly emails with no tracking number anywhere. This patch only adds the shared alias map and the shared order-# functions to that matcher; no other tracking changes.

Scope rule (Maria 2026-10-22): the INSH backlog is a **one-time** cleanup — every PO uploaded through AF carries its order #. Only the rules that keep recurring become permanent: retailer aliases, `_N` base-ID matching, order-#-unique auto-attach (tracking, already shipped), Col P (shipped). No permanent fuzzy-matching machinery beyond the candidate rule in §4, which is invoked only for rows that fail the exact rules and Col P.

## 2. Why rows are unmatched (62 rows, 2026-10-29)

| Kind | Rows | Example | Fix |
|---|---|---|---|
| INSH-… order # (PrepBusiness-era inbound IDs, Apr–Jul 2026) | 52 | INSH-051526-1043381-13772482 | Col P if the sheet names the shipment, else candidate §4 (ASIN + units + date; retailer blank at Velocity) |
| `(none)` order # at Velocity, not in Col P | 3 | Carters B0DZ34B5H5 9/21; WALMART B0GGLS46Q1 ×2 | alias §3 + candidate §4 |
| `_N` suffix at Velocity | 2 | CAR118805142_1, 200014815022950_1 | base-ID rule §3, units must fit |
| Free-text order # | 2 | voltagecoffeesupply.com "Confirmation #G9TG5IACK" (AF has the Voltage POs as 64255 / 64504 / …) | normalization §3 finds nothing → candidate §4 |
| AF order_id holds two ids | 1 | pyramydair 115449859 vs AF "115449859 / 115450009" | normalization §3 (each part) |
| Order # in AF, ASIN not on it | 2 | walmart 200015022377538 (B07N6XRBRD at Velocity, B09W1K4GYX in AF) | stays; nearest miss says exactly that |

## 3. Permanent rules (shared by Sync Shipments and tracking matching)

1. **`supplier_aliases` table** (migration 072): `alias text PK (lowercased, trimmed)`, `supplier text` (canonical AF supplier name), `source text` ('seed' | 'manual'), `created_at`. Created empty; seeds come from the backfill (§5). A retailer resolves to a supplier by: alias row → case-insensitive equality with an AF supplier → none. A blank Velocity retailer matches any supplier.
2. **Order-# normalization**, one module (`server/order-number.ts`) used by both matchers: strip a free-text prefix ("Confirmation #", "Order #", "Order No.", "PO #"), uppercase, keep `[A-Z0-9]`. **Base** = the same after removing a trailing `_N` / `-N` (1–2 digits) first (`CAR118805142_1` → `CAR118805142`; WorldPantry `70633076-1` → `70633076`). An AF order_id holding two ids ("115449859 / 115450009") yields both. The suffixed PO, when it exists in AF, is preferred by the full-key step.
3. **Match order** (after the existing pinned / picker / recorded links, unchanged). Main pass: (0) today's rules, unchanged — (retailer, Order #, ASIN) exact, then (Order #, ASIN) unique; (a) the retailer through an alias, then the full normalized order # + ASIN — exactly one row; Col P for a no-Order # line. Units pass, once every other placement is known, oldest Velocity order first: Col P for a line with an Order # AF lacks, units must fit; (b) base order # + ASIN, same supplier filter — exactly one row **and units fit** (§4 definition); then §4. (c) is merged into (a)/(b): with a blank or unresolved retailer they already search every supplier. Every units-pass link is recorded like a picker link (`match_reason` col_p / base_id / candidate_unique) so later runs keep it.

## 4. Candidate match (Sync Shipments, for any line that fails §3 and Col P)

Grouped per **Velocity order** (`order_id`): all its shipment lines go to one row. Inputs: `retailer` (may be blank), `asin`, `units` = Σ `quantity_shipped` over the order's shipment lines, Velocity order `date` (`line.date`, fallback `created_at`).

Candidate rows = `po_asins` rows where:
- `asin` matches, AND
- supplier matches via §3.1 (skipped when the retailer is blank; an unresolved non-blank retailer → no candidates, nearest miss "retailer 'X' not mapped"), AND
- PO date within **±30 days** of the Velocity date, AND
- **units fit**: `qty × units_per_pack` (AF pack; Velocity's when AF's is NULL; else 1) minus the units every other line places on that row in this run (and manual rows) ≥ the order's units.

Orders are taken oldest Velocity date first, so two orders competing for one row are settled deterministically. Rank: |PO date − Velocity date|, then smallest remaining − units.

Outcome:
- **exactly one candidate → auto-link**: the line is recorded exactly as a picker link (`shipment_unmatched.resolved_po_asin_id`, `resolved_at`) with `match_reason = 'candidate_unique'`, so later runs keep it (units-fit is not re-evaluated against itself); one `po_edit_log` row (entity `shipment`, field `link`, user NULL) per linked line.
- **2+ → panel row** with the ranked candidates (`candidates`, `source: 'candidate'`, top 5).
- **0 → panel row** with `nearest_miss` text: order # in AF without this ASIN / no AF PO has this ASIN / ASIN only from other suppliers / nearest PO N days away / PO X has R units left, line needs U / base PO fully shipped.

Nothing else about Sync Shipments changes: allocation, Shipped FBA / At Prep derivation, SC matching, pack-size rules, fail-closed legs.

## 5. One-time backfill (script)

`npm run backfill:shipment-matching` — dry run by default, `--live` to write.

1. Proposes alias seeds: every distinct Velocity retailer (stored shipments + unmatched lines) that is not an AF supplier, with the supplier it obviously names (alnum-equal to a supplier's first label — "WALMART" → walmart.com, "Carters" → carters.com; a "a / b" value whose first part is a supplier; near-spelling within 2 edits of a supplier label (3 for a 12+ character name) — "Webstraunt Store" → webstaurantstore.com) or "no proposal".
2. Runs Sync Shipments component A as a dry run **with the proposed seeds in memory**, and reports per line: kind (§2), rule that matched (exact / alias / normalized / base_id / col_p / candidate_unique), PO linked, date delta, units, or candidates / nearest miss. Totals: linked by exact rule, by Col P, by candidate, ambiguous, no_po. CSV in `Claude outputs/`.
3. Maria reviews; `--live` inserts the seeds (source `seed`), then runs Sync Shipments live (A, then B, then auto-close for touched POs), which writes the links.
4. Bundle pinning (draft §5.4): none of the 62 rows is a bundle — not built; a bundle parent that fails stays in the panel.

## 6. Panel changes (Unmatched shipments)

- Shows unresolved, not-dismissed lines (+ the SC exact-tie case, unchanged). Auto-linked lines disappear.
- Each row: its candidates (Col P and §4, ranked, best first) as one-click "Link to <order #>" buttons on the row, or the nearest-miss text; the free-text "Link to PO ASIN" picker stays as override.
- An unmapped retailer on a row gets "Map → supplier" (writes `supplier_aliases`, source `manual`).
- Bulk: tick rows → "Dismiss selected (N)" (`dismissed_at`; hidden; listed under a "Dismissed (N)" toggle — never deleted). A dismissed line that later resolves by rule is simply resolved.
- The count chip and the POs page badge count only visible rows.

## 7. Tracking queue (small)

- A platform email's subject name resolves through `supplier_aliases` before the existing name match (so "Carters" resolves).
- The tracking matcher's own `_N` / `-N` / punctuation handling moves to `server/order-number.ts` (behavior unchanged, pinned by the existing tests).
- No other changes; the 78 rows are expected to stay (43 ai_disabled, 12 no_po, 10 unknown_sender, 7 unpaired, 5 return, 1 ambiguous).

## 8. SPEC / CLAUDE.md

- SPEC §11/§26 component A: aliases, normalization, base-ID with units fit, Col P extended to `po_not_found`, candidate rule + ranking, backfill script.
- SPEC §22: Unmatched shipments panel behavior (visible set, candidates, map retailer, dismiss).
- SPEC §26 tracking: shared alias map + normalization.
- SPEC §14: "exactly one candidate → auto-link, otherwise review; never past ordered units" as the general rule for AF's PO matchers.

## 9. Commits (single-concern, gated)

1. Migration 072: `supplier_aliases` (empty), `shipment_unmatched.dismissed_at`, `match_reason`, `nearest_miss`.
2. `server/order-number.ts` (normalization, base, parts) + alias resolution; tests (CAR118805142_1, 2000152-79183885, "Confirmation #G9TG5IACK", INSH-…, "115449859 / 115450009").
3. Sync Shipments: exact rules §3 → Col P (all failing lines) → candidate §4; tests for unique / ambiguous / none / units-fit / split shipments / base-ID over-link.
4. Backfill script with dry run + report; run dry on production, **STOP** for Maria's review of the alias seeds and the auto-link list, then `--live`. Only commits 1–2 are pushed before the review (Sync Shipments on Render must not auto-link before the go).
5. Panel UI: visible set, row candidate buttons, nearest miss, map retailer, bulk dismiss, count chip.
6. Tracking matcher on the shared functions + aliases; SPEC/CLAUDE.md.

Stop only at the commit-4 review and for anything the patch doesn't cover.
