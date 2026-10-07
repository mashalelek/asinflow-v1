# SPEC §18 Patch — Price Resolution v2 (offer-anchored)

*Drafted 2026-09-02 with Maria; updated 2026-09-15 (feedback threshold
10 → 20; Amazon explicitly excluded from the qualified set; FBM fallback
anchor dropped — aligned with the Repricing Engine spec); **revised
2026-10-05 with Maria** (feedback threshold 20 → 15; low-credibility outlier
rule removed from opening price — price-gap outliers are a repricer-only
concern; manual entry replaced by a 60% ROI
solve; COGS prompted inline when missing; floor guard replaced by the
20% → 40% ROI rule; CPT shown as a value per row and removed from all
pricing and warnings). This is the replacement text for SPEC.md §18's
"Price Resolution" and "Suppression cap (18555 prevention)" subsections.
Fold it into SPEC.md in the implementation session (doc first, then code,
per the Maintenance rule). Until then this doc is the agreed design.*

**Status (2026-10-05):** never implemented. SPEC.md §18 and
`shared/price-resolver.ts` are still v1 (cap chain unchanged since 860ee27,
2026-08-02). About 36 of 80 offers submitted since 2026-09-15 have the
capped price shape.

**Motivating case (B0BS6NVYCN, 2026-09-02):** listing glutted for months
(~50 sellers, ~$20), field collapsed to 6 offers, survivors repriced to
$37–40, last FBA Buy Box $39.99 / FBM $36.99 — Buy Box now suppressed because
Amazon's CPT lags at ~$21. The v1 cap chain priced the new offer at $20.99,
$3 below breakeven. CPT was measuring the past, not the market. Conclusion:
current qualified offers are the reference; CPT is not a pricing input.

**Further cases (2026-10-04):** B00IJYJKRI — 5 competing offers at
$21.57–$21.95, CPT $5.68, COGS $5.36; v1 capped the opening price to $5.59
(ROI −102.4%). B00MN4IRRO (CPT $6.88 vs $11.00 floor) and B099KRQ1W7
(CPT $12.50 vs $30.98) show the same pattern: CPT far below every live offer.

---

## Price Resolution (v2)

The resolver keeps its data source (`fetchCompetingOffers` /
`getItemOffers`, landed prices, own offers filtered by seller ID) and its
`.99` ceil-rounding. What changes: the anchor is chosen from a **qualified
offer set**, CPT is never a pricing input, and every path resolves to a
price without manual entry.

### Qualified offer set

All competing offers (other sellers, New condition, landed price), minus
two exclusion classes:

1. **Amazon — always excluded** (2026-09-15, per Maria): Amazon is
   technically FBA but we never compete with Amazon. Applies everywhere a
   qualified offer set is used (here, and the Repricing Engine's min/max).
2. **Hard exclusion — no track record:** feedback count < **15** → always
   disqualified, regardless of price. (10 on 2026-09-03 → 20 on 2026-09-15
   → **15 on 2026-10-05**.)
Disqualified offers are listed in the preview with reasons, never silently
dropped.

**No outlier rule here (2026-10-05, per Maria):** the former
"low-credibility outlier" rule is removed, and no price-gap rule replaces it
for opening prices. The anchor is the HIGHEST qualified FBA offer, so
excluding low-priced outliers could never change it. Low-outlier handling
lives only in the Repricing Engine's min calculation (its §2 lowest-offer
outlier rule).

**Data limitation (v2 scope):** `getItemOffers` carries per-offer feedback
but NOT stock depth, so the "1 review and 5 units" case is filterable on
feedback only. Stock-depth-aware filtering (Keepa offer data or cart
probing) is a possible v3; do not fake it from available fields.

### COGS required (2026-10-05)

Every path below needs COGS (`COALESCE(estimated_cogs, cogs)`), so COGS is
required to price a row. When COGS is null or ≤ 0, the preview row expands
inline for a COGS entry (same no-nested-modal pattern as `legend_pending`).
The row cannot be submitted until COGS is entered. The entered value is
saved as the ASIN's estimated COGS through the same write path as the
product row's Est. COGS edit, and the row's price then resolves normally.
This replaces the v1 `skip_no_cogs` skip.

### Anchor resolution

1. **Qualified FBA offers exist** → anchor = **highest qualified FBA landed
   price**. Opening price = anchor, rounded UP to next `.99`, then the ROI
   check below.
   (Err-high philosophy retained — the repricer walks down — but bounded by
   real offers, not by CPT and not by ×1.30 over a junk outlier.)
2. **No qualified FBA offers — or no offers at all** → **price solved for
   60% ROI** on COGS (2026-10-05, replaces manual entry): bisection over
   `calculateProfit` targeting `roi === 60`, rounded UP to next `.99` (so
   resulting ROI is always ≥ 60%). If 60% ROI is unreachable within the
   price search range (`skip_unreachable`), the row is blocked with that
   reason.

The v1 "highest competing × 1.30" anchor, the v1 100% ROI solve, and manual
price entry are all retired.

### ROI check on the FBA anchor (2026-10-05, replaces the floor guard)

After path 1, compute ROI at the anchor price. If ROI **< 20%** → price =
**40% ROI solve** (same bisection, rounded UP to `.99`), and the row shows
the warning **`low_roi_repriced`**: "highest qualified FBA offer gives X%
ROI — priced at 40% ROI." This is the only warning the resolver emits.
Path 2 needs no check (it is already solved for 60%).

Rationale: offers are born closed and the repricer owns the price
afterward; a starting price above the market beats live-at-a-loss.

### CPT: shown, never used (2026-10-05)

`CompetitivePriceThreshold` is still parsed (free, same `getItemOffers`
call) and **shown as a value on every preview row** ("—" when Amazon
returns none). It is **never an input to any price** — not a cap, not a
floor, not a trigger — and produces **no warning or flag**. The Buy Box
landed price is likewise not a pricing input. The 18555 history and old
cap-chain calibration stay in SPEC as history.

*Scope clarification (2026-09-15, per Maria):* CPT relates to Featured
Offer (Buy Box) eligibility/suppression — it is NOT the mechanism behind
"potential high pricing error" listing deactivation, and it is never an
input to min/max prices anywhere in AF.

### Preview visibility

Per row:
- price source: `fba_anchor` / `roi_60_solve` / `roi_40_floor`
- the anchor offer's landed price and seller feedback (FBA path)
- resulting ROI
- CPT value (or "—")
- qualified vs disqualified counts, disqualified expandable with reasons:
  `amazon_offer`, `under_15_feedback`
- the inline COGS input when COGS is missing
- the `low_roi_repriced` warning when it applies

Retired from v1/v2-draft: "capped" indicator, `lowRoiAfterCap`,
"no market reference — 18555 risk", above-CPT advisory,
`priced_above_market`, `no_cogs_floor_unknown`, manual price entry.

### Worked example (the motivating listing)

6 offers; FBA cluster ~$39.99, FBM $36.99, CPT ~$21, breakeven ~$24.
v1: capped $20.99 (below breakeven). v2: qualified FBA anchor → opens at
$39.99 (ROI well above 20%, no warning); the row shows CPT $21 as
information only; repricer takes over from a sane starting point.

---

## Confirmed decisions

1. FBA anchor statistic → **highest qualified FBA offer** after filtering. (2026-09-02)
2. ~~FBM fallback uplift +15%~~ — superseded 2026-09-15; ~~manual entry~~ —
   superseded 2026-10-05: **no qualified FBA → 60% ROI solve.**
3. Hard exclusion: < 10 feedback (2026-09-03) → < 20 (2026-09-15) →
   **< 15 (2026-10-05)**.
4. **Amazon always excluded** from qualified offer sets. (2026-09-15)
5. ~~Low-credibility outlier (feedback < 100 or rating < 90%, and > 20%
   below median)~~ — **removed 2026-10-05; no outlier rule for opening
   prices** (low-outlier handling is repricer-only).
6. ~~Floor clash → price at 15% ROI floor + flag~~ — superseded 2026-10-05:
   **FBA anchor ROI < 20% → price at 40% ROI + `low_roi_repriced` warning.**
7. **COGS missing → inline COGS prompt; saved as estimated COGS.** (2026-10-05)
8. **CPT shown per row, never used in pricing, no CPT warnings.** (2026-10-05)

## Repricing Engine alignment (2026-10-05)

`claude_spec-patch-repricing-engine-v1.md` updated to match (v1.6): its
shared qualified set now uses feedback ≥ 15 and drops the low-credibility
junk-outlier filter. Its lowest-offer outlier rule is unchanged.
