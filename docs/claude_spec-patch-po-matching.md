# Spec patch — PO matching: Unmatched shipments cleanup + matcher rules

Status: DRAFT 2026-10-23 — decisions taken with Maria 2026-10-22; no open decisions. One-time backfill + a small set of permanent rules.
Repo path: `docs/claude_spec-patch-po-matching.md`. Touches SPEC §11 (Velocity), §22 (PO module), §26 (PO tracking).

## 1. Goal

The POs page carries two review panels that today need hand work:

- **Unmatched shipments (70 rows)** — Velocity `/shipments` lines that Sync Shipments could not place on a `po_asins` row by (Order #, retailer, ASIN). Maria's decision (2026-10-22): match them to the real POs, INSH-era rows included — never hide; auto-link whenever exactly one PO fits; show only ambiguous rows.
- **Unmatched tracking (76 rows)** — already reduced from 120 by the 2026-10-22 matcher fixes (platform senders, order-#-unique, link-follow). What remains is mostly emails with no tracking number anywhere. This patch only adds the shared alias map and the `_N` base rule to that matcher; no other tracking changes.

Scope rule (Maria 2026-10-22): the INSH backlog is a **one-time** cleanup — every PO uploaded through AF carries its order #. Only the rules that keep recurring become permanent: retailer aliases, `_N` base-ID matching, order-#-unique auto-attach (tracking, already shipped). No permanent fuzzy-matching machinery beyond the candidate rule in §4, which is invoked only for rows that fail the exact rules.

## 2. Why rows are unmatched (from the 2026-10-18 and 2026-10-22 screenshots)

| Kind | Example | Fix |
|---|---|---|
| INSH-… order # (PrepBusiness-era inbound IDs, Apr–Jul 2026) | INSH-051526-1043381-13772482 | candidate match §4 (ASIN + units + date; retailer often blank at Velocity) |
| `(none)` order # at Velocity | carters.com B0DB6B3LDK 9/30; Monin; Webstaurant; celestialseasonings.com | candidate match §4 |
| Velocity retailer ≠ AF supplier | "Carters" / "WALMART" / "Webstraunt Store" / "Monin" | alias map §3 |
| `_N` suffix at Velocity | CAR118805142_1, 200014815022950_1 | base-ID rule §3 |
| Free-text order # | voltagecoffeesupply.com "Confirmation #G9TG5IACK" | digits/alnum normalization §3, then candidate match |
| Order # genuinely not in AF | walmart 200015022377538 (RED HEART, 15+30 u), pyramydair 115449859 | stays in the panel as "no PO" — fix is Sync POs after the sheet row is repaired (`docs/po-history-skips-2026-10-18.csv`) |

## 3. Permanent rules (shared by Sync Shipments and tracking matching)

1. **`supplier_aliases` table** (migration NNN): `alias text PK (lowercased)`, `supplier text` (canonical AF supplier name), `source text` ('seed' | 'manual' | 'auto'), `created_at`. Seeded by Claude Code from the distinct Velocity `retailer` strings vs `purchase_orders.supplier` (obvious pairs auto: "WALMART"→walmart.com, "Carters"→carters.com, "Monin"→monin.com, "Webstraunt Store"→webstaurantstore.com, …; everything else proposed in the dry-run report for Maria to confirm). Editable under Settings next to `tracking.supplier_domain_map`. Both matchers resolve retailer → canonical supplier through it before comparing. A blank Velocity retailer matches any supplier.
2. **Order-# normalization**, one function used everywhere: uppercase, strip whitespace, strip everything except `[A-Z0-9]`, strip a trailing `_N` / `-N` suffix for the *base* key (`CAR118805142_1` → base `CAR118805142`; the suffixed PO `CAR118805142_1` still exists in AF and is preferred when it matches exactly). Free-text prefixes ("Confirmation #", "Order ") are stripped by the same function.
3. **Exact match order**: (a) full normalized order # + ASIN; (b) base order # + ASIN; (c) base order # alone when it resolves to exactly one PO and that PO has the ASIN. Only rows failing all three go to §4.

## 4. Candidate match (used by the one-time backfill, and by Sync Shipments for any later row that fails §3)

Inputs per Velocity shipment line: `retailer` (may be blank), `asin`, `units` (Velocity total component units for the line, Σ over split shipments of the same parent), Velocity order `date`.

Candidate POs = `po_asins` rows where:
- `asin` matches, AND
- supplier matches via aliases (skipped when Velocity retailer is blank), AND
- PO date is within **±30 days** of the Velocity order date (Maria: the true match should be within ~1 day — the window is wide so a date typo doesn't fail it; ranking does the work), AND
- **units fit**: the line's ordered units (`ordered × units_per_pack`) minus units already placed by other shipments ≥ this shipment's units (split shipments to the same PO line are allowed; over-placement is not), AND
- the PO line is not already fully placed.

Rank by |PO date − Velocity date|, then by closeness of units fit.

Outcome:
- **exactly one candidate → auto-link**, `match_reason = 'candidate_unique'`, edit-log row, no review.
- **2+ candidates → panel row** with the ranked candidates as one-click "Link to <order #>" buttons (best first), plus the existing free-text picker.
- **0 candidates → panel row**, reason `no_po`, with the nearest-miss shown (why it failed: no ASIN / date / units) so Maria can tell "PO missing from AF" from "wrong ASIN at Velocity".

Nothing else about Sync Shipments changes: allocation (oldest PO first), Shipped FBA / At Prep derivation, SC matching, fail-closed legs, all unchanged. A candidate link writes exactly what a manual "Link to PO ASIN" writes today.

## 5. One-time backfill (script, like `backfill:tracking`)

`npm run backfill:shipment-matching` — dry run by default, `--live` to write.

1. Load the 70 unmatched lines (plus any new ones), re-run §3 exact rules with the alias map, then §4 for the rest.
2. Report, per line: kind (§2), rule that matched, PO linked / candidates / nearest miss. Totals: auto-linked by exact, auto-linked by candidate, ambiguous, no_po.
3. Maria reviews the dry-run report; `--live` applies the auto-links and leaves ambiguous/no_po in the panel.
4. INSH rows that link also pin their Velocity parent to the PO the same way the `velocity_bundle_identity` `manual_map` rows do, where the row is a bundle — so Upload to Velocity's match set stays consistent.

## 6. Panel changes (Unmatched shipments)

- Shows only ambiguous and `no_po` rows (auto-linked rows disappear).
- Each row: ranked candidate buttons (§4) or nearest-miss text; existing free-text picker kept as override.
- Bulk actions: tick rows → "Dismiss selected (N)" (dismissed rows get `dismissed_at`, hidden, listed under a "Dismissed (N)" toggle — never deleted).
- Count chip reflects only visible rows.

## 7. Tracking queue (small)

- Supplier resolution in the tracking matcher goes through `supplier_aliases` too (so "Carters" in a platform-email subject resolves).
- Base-ID rule from §3.2 replaces the tracking matcher's own `_N` and trailing `-1` handling (one function).
- No other changes; the 76 remaining rows are expected to stay (41 no-number emails, 14 no_po, 10 unknown_sender with no order #, 5 return, 5 unpaired, 1 ambiguous).

## 8. SPEC / CLAUDE.md

- SPEC §11: `supplier_aliases`, order-# normalization function, candidate rule + ranking, backfill script.
- SPEC §22: Unmatched shipments panel behavior (visible set, candidates, dismiss).
- SPEC §26: tracking matcher now uses the shared alias map + normalization.
- SPEC §14: "exactly one candidate → auto-link, otherwise review" recorded as the general rule for AF's PO matchers.

## 9. Commits (single-concern, gated)

1. Migration: `supplier_aliases` (+ seed from Velocity retailers), `dismissed_at` on the unmatched-shipments store, `match_reason` where missing.
2. Shared order-# normalization + alias resolution; tests (CAR118805142_1, 2000152-79183885, "Confirmation #G9TG5IACK", INSH-…).
3. Sync Shipments: exact rules §3 → candidate rule §4; tests for unique / ambiguous / none / units-fit / split shipments.
4. Backfill script with dry run + report; run dry on production (Maria pastes DATABASE_URL), STOP for her review of the proposed alias seeds and the auto-link list, then `--live`.
5. Panel UI: visible set, candidate buttons, bulk dismiss, count chip.
6. Tracking matcher on the shared functions; SPEC/CLAUDE.md.

Stop only at the commit-4 review and for anything the patch doesn't cover.
