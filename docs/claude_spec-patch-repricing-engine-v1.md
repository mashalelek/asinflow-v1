# SPEC Patch — Repricing Engine (v1.6)

> **Phase 1b status (2026-09-15): SHIPPED in commit `83e0daa`, folded into
> SPEC.md as §23 (+ §8 nav). 503/503 tests, tsc baseline-only. Gate report
> accepted: endpoint vs direct-SQL cross-check exact (32/32); boundary cases
> proven in rolled-back transactions where no natural rows existed;
> NULL-flag rows absent-but-counted ("not yet checked" banner working).
> `has_buyable_offer` written in the same UPDATE as `has_live_offer` by the
> same probe owners; manual verdicts deliberately write neither.
> **Pending:** a full Prices & Stock run to drain the remaining ~52
> "not yet checked" stocked ASINs (only 60 probed so far); Maria's visual
> pass on the page. **Process note, owned in the report and commit:**
> migration 043 was applied before commit, inverting the commit-then-apply
> rule — no data risk (additive, nullable), rule stands.**
>
> **Follow-ups shipped after 1b:** selectable no-sales date range +
> shared-picker parity; FBA Stock column; final zeros semantics (one
> accessor for render/sort/filter/CSV, commit `5b9ca71`). Maria confirmed
> working 2026-09-17.

*Drafted 2026-09-14 with Maria; v1.3 2026-09-15 (min rules rewritten,
windows finalized); v1.4 2026-09-15 (Amazon exclusion made explicit,
lowest-offer outlier rule, FBM anchor fallback dropped, 180-day history cap
fixed, SC min/max caveat); v1.5 2026-09-21 (new §6b: Aura state pull onto
the Repricer tab); v1.6 2026-10-05 (qualified set aligned with §18 Price
Resolution v2 revision: feedback threshold 20 → 15, low-credibility
junk-outlier filter removed). Extends/supersedes SPEC §11 "Aura repricer (planned)".
Values in [brackets] are tunable defaults.*

---

## 0. Phasing

- **Phase 1b — Zero-sales view: SHIPPED** (`83e0daa` + follow-ups
  `5b9ca71`). §6.
- **Phase 1a-pre — Aura state pull (approved 2026-09-21, NEXT BUILD).**
  Read current min/max/strategy/repricing per listing from Aura's API and
  display on the Repricer tab. Read-only; also the reusable read half of
  the Phase 1a diff. §6b.
- **Phase 1a — Min/Max sync.** Compute min/max per SKU in AF, push to Aura.
  No strategy reassignment; existing Aura strategies/workflows untouched.
- **Phase 2 — Sell-through windows.** Per-ASIN `st_target_days` and
  AF-driven age workflows (replaces Aura's one-size age workflow).
- **Phase 3 — Seller-count monitoring (Keepa-backed).**
  ⚠️ **Standing note: Maria reviews §5 in full before Phase 3 is specced —
  treat §5 as directional, not approved.**

Everything runs manually before any cron (per §11 crons policy).

**Vocabulary.** "Min/max sync job" = an AF-side batch job in the mold of
the existing Aura cost sync: recompute mins/maxes for all mapped SKUs →
diff against Aura's current values → dry-run report → push only what
changed. "Idempotent" = safe to re-run any time; unchanged values are never
re-pushed.

## 1. Architecture

AF computes per SKU `{min_cents, max_cents}` (Phase 1a) and later strategy
assignment (Phase 2/3) from data only AF has. The repricer executes
competition between the bounds. Output is numbers + a strategy label, so an
Aura→SellerSnap switch only swaps the adapter.

**Verified Aura API contract (docs.goaura.com, 2026-09-14):**
`POST /listings/:id` accepts `minimum_price`, `maximum_price`, `cost`,
`strategy` (ID), `repricing`, `manual_price` — integer cents, form/query
params (first dry-run must confirm the JSON-body-ignored gotcha applies to
these fields too). `GET /listings` lists listings; `GET
/repricing/strategies` → strategy IDs; mapping in AF config. [5] rps.
Existing `AURA_API_KEY`. Reuses cost-sync machinery: SKU→ASIN bridge,
idempotency, fail-closed skips (+ `min_gte_max`, `manual_locked`), dry-run
script, capped live push.

## 2. Min price rules (Phase 1a)

**No uniform ROI target across the catalog.** Two modes per ASIN:

- **AUTO (default, most ASINs):**
  `min = max( lowest qualified competitive FBA offer , breakeven )`
- **MANUAL (per-ASIN):** Maria sets the min directly (for ASINs that
  consistently sell above market/Keepa data). Manual lock pattern
  (`…_source='manual'`); sync job never overwrites; skip `manual_locked`.

**Qualified competitive FBA offer (for the min):**
- FBA, New condition, landed price, seller feedback count ≥ **15**
  (20 → 15 on 2026-10-05).
- **Amazon is ALWAYS excluded** — Amazon is technically FBA but we never
  compete with Amazon. (Applies everywhere a qualified offer set is used,
  incl. §18 v2.)
- **Lowest-offer outlier rule (Maria 2026-09-15):** exclude the lowest
  remaining FBA offer when it is an outlier — > [20%] below the next-lowest
  qualified FBA offer — and, when it is the ONLY FBA offer, validate it
  against price history instead: > [20%] below the [180-day] traded
  median (Keepa) → exclude. Catches repricer glitches and
  expiration-dumping sellers so the min never chases them.
- If exclusions leave no qualified FBA offer → **no auto min**: flag
  `min_market_unreliable` for review, keep the existing min unchanged.

**Breakeven** = solved from landed cost (`actual_cogs` + `prep_override`;
fallback `estimated_cogs`, flagged) + AF's existing fee stack (referral at
price, FBA fee, inbound ship estimate). No returns allowance — AF does not
model returns.

**Monitoring requirement (AF UI):** per ASIN, show the current min and the
**estimated ROI at that min** — the tanking indicator. An auto min sitting
on the breakeven guard = tanking ASIN; surface visually + filterable.
Home: Repricer tab (grows out of §6/§6b in Phase 1a).

**Guardrails:** never below breakeven without approval (Watch-List salvage
flow) · never min ≥ max · manual wins.
**Recalc triggers:** PO-sync cost change · fee change · each sync-job run.

## 3. Max price rules

**Decision (Maria 2026-09-14):** max is NOT bounded by the competitive
range except when liquidating quickly. High ceilings are deliberate
(leadership pop-outs, stockout capture).

**Offer anchor (corrected 2026-09-15):** the **highest qualified FBA landed
price** (qualified as §2: FBA, New, feedback ≥ 15, Amazon excluded, lowest-offer
outlier rule applied). **No qualified FBA offers — or no offers at all — → no
anchor: manual.** (The former FBM × 1.15 fallback is dropped.)

**High-price-deactivation protection — the standing rule:**
`effective max = min( loose formula , recent 180-day traded high (Keepa) × [1.1–1.2] )`
The history cap is primary protection. The SC Minimum/Maximum Allowed Price
mechanism (Amazon uses seller-set bounds for its pricing-error check when
present) is a possible supplement — **but per Maria it is not an immunity:
Amazon may still deactivate an offer whose max it deems too high.** Treat
as risk reduction only; evaluate before wiring.

**CPT (Maria 2026-09-15):** relates to Buy Box eligibility/suppression, NOT
high-price deactivation. Repricing context only; never a min/max input;
constantly changing — cautious use only.

Per-bucket maxes: Maven — not pushed in Phase 1 (Maven AI max owns it) ·
Buy Box Targeting — loose: max([180-day] high, offer anchor × [1.3–1.5]),
then history-capped per the standing rule · Liquidation — tight: offer
anchor × [1.05] · Only-seller — Keepa history or manual, flagged until set.
Max never below min.

## 4. Sell-through windows (Phase 2 — finalized 2026-09-15)

- **`st_target_days` ∈ {30, 60, 90, 180}** (sell within, inclusive),
  **default [60]**, dedicated `asins` column, inline-editable, filterable.
  No separate "OK to hold" class — window choice covers it.
- Evaluation via Amazon's inventory-age buckets (0–30 / 31–60 / 61–90 /
  91–180 / 181–270 / 271–365 / 365+). Escalation at **W, then the next two
  bucket edges**:

  | W | → Push (L2) | → Exit (L3) | Review prompt |
  |---|---|---|---|
  | 30 | 30d | 60d | 90d |
  | 60 | 60d | 90d | 180d |
  | 90 | 90d | 180d | 270d |
  | 180 | 180d | 270d | 365d |

- **Escalation gate:** move only when > [50%] of on-hand inventory is older
  than the boundary (protects fresh replenishments). De-escalation when the
  aged share drops back under; [7]-day hysteresis.
- Standing pre-cliff review prompt when > [50%] of units enter the 181–270
  bucket, regardless of window (the ~day-271 surcharge cliff always gets
  eyes).
- **Age data source:** `GET_FBA_INVENTORY_PLANNING_DATA` (Inventory
  Health) — per-SKU age buckets, sell-through, est. storage cost. Not yet
  ingested; Phase 2's main build item; step 1 = pull + verify columns.

## 5. Seller-count monitoring (Phase 3 — DIRECTIONAL ONLY; Maria reviews before implementation)

Data: Keepa API offer-count history, live ASINs only (~200), token-paced;
[3–12] month backfill then incremental. Verify series granularity (total vs
FBA-only) and token cost. AF `sellers_fba` snapshots as corroboration.

**Conservative posture (Maria 2026-09-15): automatic strategy changes are
rare.** Absolute jumps are never sufficient (+3 is not a trigger, even
1→4 overnight). Any auto-move must be demand-aware via Amazon's "bought in
past month" (`monthly_sold`; **assume [40] when missing**) — the question
is whether demand per competing seller is collapsing. Sketch to fine-tune
on real data: auto-escalate only when ALL hold — level shift vs trailing
[90]d median ≥ +[100%] · absolute count ≥ [8] · monthly_sold ÷ sellers <
[5] units/seller/month · sustained [2+] observations. Everything else that
trends (Mann–Kendall + Theil–Sen creep, moderate spikes, low-count jumps) →
review flag only. Q4 seasonality guard once 12-month backfill exists.

## 6. Zero-sales view (Phase 1b — SHIPPED)

- **Location: the Repricer tab** (activates the "Soon" nav item; §8
  structure otherwise unchanged; NOT a date-picker route — the 7-day window
  is fixed).
- **Content:** the full ASINs table (same components/columns as the main
  page, own column-config storage key per §21 precedent), **pre-filtered on
  the backend**:
  1. **Listing is Active in Seller Central** (Maria's clarification
     2026-09-15: "active" = SC listing status Active, i.e. ≥1 SKU with a
     BUYABLE offer — NOT AF's catalog `status` bucket, and NOT
     `has_live_offer`, which deliberately counts Inactive/DISCOVERABLE
     listings too). With born-closed offers, stock + Closed listing is
     common and must NOT appear here. Requires persisting buyability: a
     small `asins` flag (e.g. `has_buyable_offer` + checked-at) written by
     the SAME definitive `getListingsItem` probes that own
     `has_live_offer` (listings stage of Prices & Stock, full-scope pass,
     verify-sweep) — same single-owner and fail-closed rules; one
     migration. Maria confirmed 2026-09-15: SC-Active ONLY, strictly — a
     born-closed offer whose stock just checked in was effectively OOS
     until reopened and does not belong on this list either; no special
     handling for recently-reopened listings.
  2. **At-FBA stock > 0** — `available` from the latest inventory snapshot;
     **`ordered` explicitly excluded**;
  3. **0 sales in the trailing 7 calendar days** —
     `SUM(sales_daily.units_sold) = 0` over that range. Sales dates are
     REAL order dates (all-orders flat file), not stock diffs.
  Catalog scope on top: AF `status = 'active'` rows (dead/parked excluded
  from the view by default).
- **Range selection (Maria 2026-09-16, follow-up to the shipped v1):** the
  no-sales window becomes a selectable from–to date range — "which products
  have not been sold during this time." Default = trailing 7 days inclusive
  of today (preserves shipped behavior). Stock and SC-Active conditions are
  still evaluated NOW (current snapshot, current flag): the view answers
  "currently stocked, currently Active ASINs with zero sales during the
  selected period." Page-local range control (same component family as the
  global picker, but local state — it must never mutate the global range
  other pages read). **Data-coverage honesty:** if the selected range
  starts before the earliest synced `sales_daily` date, missing data would
  masquerade as "no sales" — clamp or warn, never silently overstate. This
  supersedes the §6/§0 "not a date-picker route" note.
- "Had stock ≥ 7 days ago" condition **deferred until the app is live on
  cloud hosting** (Maria 2026-09-15). Two candidate data sources for
  historical stock, researched 2026-09-16, decision open:
  (a) **SellerBoard Stock History report via SB's report-feed API**
  (Settings → API; recurring report as a protected web-feed URL, CSV/Excel
  — SB lists "Stock History: inventory levels over time" among automatable
  reports). Quick to ingest (fetch CSV from a URL), leverages history SB
  already holds; but a fixed-report poll, columns/granularity to verify
  from a real export, and it deepens dependence on SB — the tool the
  Actuals audit is meant to retire.
  (b) **Amazon FBA Inventory Ledger report (SP-API,
  GET_LEDGER_SUMMARY_VIEW_DATA)** — per-SKU daily balances from the
  source, ~18-month lookback, uses AF's existing SP-API report machinery;
  more parsing work, Amazon-primary (root-cause path).
  **Correction (2026-09-16):** earlier framing implied AF had to collect
  snapshots forward to build stock history — that was true only of AF's
  existing `getInventorySummaries` snapshot path, which is point-in-time.
  Under (b) the history is retroactive: once ledger ingestion is built,
  the in-stock-during-range condition ships with ~18 months of backfill —
  no waiting, no cron dependency for the historical part. The live
  snapshot path remains the "stock right now" source (ledger balances lag
  ~a day); the two are complementary, not alternatives.
- Scope: `status = 'active'` (the three-state status model from the
  2026-09-07 patch); Show parked / Show dead toggles only if trivially
  reusable from the main page.
- Data-as-of shown from the last **Prices & Stock** run's sales and
  inventory stages (one consolidated job since 2026-09-07; `refresh_runs`
  ledger is the natural source). Manual-sync reality: stale data must be
  visible, never mistaken for a dead ASIN.
- Read-only; no new writers; CSV export via existing pattern.

## 6b. Aura state on the Repricer tab (Phase 1a-pre — approved 2026-09-21)

Bring each listing's CURRENT Aura state — min, max, strategy, repricing
on/off — into AF and display it on the Repricer tab.

**Direction-rule clarification (important, record in SPEC):** the existing
"one-directional AF → Aura, never Aura → AF" rule governs COSTS — AF owns
cost truth and Aura must never write it back. This feature reads a
different data family, **repricer state**, where Aura IS the source of
truth today (and remains so until Phase 1a flips min/max ownership).
The pull writes ONLY to its own table; it never touches `asins`,
`asin_estimates`, costs, or any analyze-owned field. Not a reversal of the
cost rule — a new family with a new single owner (this pull).

- **Fetch:** `GET /listings` (paginated — verify the pagination scheme on
  first run; docs confirm the endpoint, not the paging params) at [5] rps
  with the existing `AURA_API_KEY`, plus `GET /repricing/strategies` once
  per run for the strategy id → name map. Reuses the cost-sync client.
- **Storage:** new table (e.g. `aura_listings`), sole writer = this pull.
  Per row: aura listing id, sku, mapped asin (nullable), `minimum_price`,
  `maximum_price`, `strategy` id + resolved name, `repricing`,
  `current_price`, currency, status, `synced_at`. Full refresh per run
  (upsert by aura listing id). SKU→ASIN via `asin_skus` (prefer
  `primary_sku`; ambiguous SKU → stored unmapped + reported, never
  guessed — cost-sync semantics). Aura retains deleted/never-stocked SC
  listings; store them, display only mapped rows, report the unmapped
  count.
- **Display (Repricer tab):** new column group "Repricer": **Aura Min,
  Aura Max, Aura Strategy, Aura Repricing (on/off), Aura Current Price** —
  sortable, filterable (strategy = multi-select by name), CSV-exported.
  Default-visible on the Repricer tab only (its own column-config key);
  available but default-hidden on the main page.
- **Null min/max in Aura = "not set"** — record-derived: render $0.00 in
  normal text with the amber missing-record indicator (the §3/Actual-COGS
  pattern), filter/sort/CSV as 0. An unset min is a listing running
  unprotected — exactly the row Maria wants to find with a filter.
- **Trigger & freshness:** "Sync Aura" toolbar button on the Repricer tab
  (manual; joins the daily chain after cost sync when crons return).
  Run report: fetched / mapped / unmapped / strategies count / duration.
  Aura-synced-at joins the page's data-as-of stamps.
- **Build note:** structure the fetch as a reusable module — it is the
  read half of the Phase 1a diff (`compute → GET Aura state → diff →
  push`), so Phase 1a consumes it unchanged.

## 7. Sync-job execution & rollout (Phase 1a)

Manual toolbar trigger: compute → GET Aura listing state (§6b module) →
diff → dry-run report → paced push of changes only → per-SKU results +
skips. Runs after PO sync + cost sync. Rollout: full-catalog dry-run →
pilot [10–20] SKUs [1 week] → catalog. Aura's in-app workflows untouched
until Phase 2 replaces them.

## 8. Resolved / open

**Resolved 2026-10-05 (v1.6):** feedback threshold 20 → 15 (shared with
§18 v2) · the "junk-outlier filter per §18 v2 (low-cred + far-below-median)"
is removed from the qualified set; low-outlier handling is the lowest-offer
outlier rule alone · §18 v2 has no outlier rule of its own (its anchor is
the highest offer).

**Resolved 2026-09-21 (v1.5):** Aura state pull approved — read-only, own
table, new "Repricer" column group on the Repricer tab; direction-rule
clarification recorded (cost rule ≠ repricer-state family).

**Resolved 2026-09-15 (v1.4):** Amazon always excluded from qualified offer
sets · lowest-FBA-offer outlier exclusion (vs next-lowest; vs 180-day
history when sole FBA seller) · anchor fallback = manual only (FBM × 1.15
dropped) · effective max = min(loose formula, 180-day traded high ×
[1.1–1.2]) as standing rule · SC min/max allowed prices reduce but do NOT
eliminate deactivation risk · Phase 1b scoped and handed to Claude Code.

**Earlier:** min = max(lowest qualified FBA offer, breakeven), per-ASIN
manual mode, no uniform ROI, no returns allowance, min + ROI-at-min
displayed (tanking monitor) · feedback threshold 20 (propagated to §18 v2) ·
windows {30, 60, 90, 180} default 60 · CPT never a min/max input ·
conservative demand-aware seller monitoring.

**Open:** §5 numeric defaults (full Maria review pre-Phase-3) ·
Amazon-present / tanker handling in v1 · Phase 1a min/ROI-at-min column
placement · SC min/max-allowed-price supplement (evaluate later) · Aura
`GET /listings` pagination scheme (verify at §6b implementation).
