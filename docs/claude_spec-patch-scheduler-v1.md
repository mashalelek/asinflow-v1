# SPEC Patch — Scheduler v1 (one job, one queue, scheduled passes)

*Drafted 2026-10-15 with Maria. Decisions confirmed 2026-10-13 through
2026-10-15 and recorded in the component map
`AsinFlow Jobs List (Cloud Deployment)` (Maria's Google Sheet; CSV snapshot
`af_data_components.csv`, 2026-10-13). Supersedes the Product Info and
Prices & Stock job definitions in SPEC §11 and the three node-cron
schedules. Prerequisite for `ENABLE_CRONS=true` on Render.*

> **Status: IMPLEMENTED 2026-10-15** — six commits (`3a7094a`, `49338b1`,
> `a958e5f`, `1f0e1b4`, `ab5249f`, docs), under the 2026-10-15 approval
> model. `ENABLE_CRONS=true` on Render is the remaining step (hard stop).
> **Deviations from the text, all approved:** component 14 persists
> nothing — decision A (ledger counts complete-input ASINs; no `est_*`
> columns); 20/21 ledger-only (`skipped`) and 17 derived-only until the
> Finances patch; `jobs.bulk_list_id` is UUID (bulk_lists.id is uuid);
> the `refresh_runs.trigger` CHECK is the historical set ∪ the four new
> values; batch components checkpoint every 100 ASINs (5 batches of 20),
> per-ASIN every 50; `server/index.ts` skips its boot under vitest so the
> runner tests can import it; **commit 4 added migration 053
> `jobs.components INTEGER[]`** so a decision-9 job can name the one
> component it runs, and the preview route streams NDJSON (heartbeats)
> because the job may wait behind a running pass; the preview and push
> routes refuse with 503 when no runner is started. The Aura **chain**
> reads the sheet through the queue too (one function, with or without a
> selection). Sync POs (`POST /api/sheets/sync`) still calls
> `runSheetsSync` directly — out of this patch's text; candidate for a
> one-component job like decision 9.

## Why

The 2026-10-13 cron audit found: three crons that have never run (zero
`cron` ledger rows), no lock anywhere so cron and button runs collide,
the cron listings stage cannot onboard SC discoveries (callback injected by
the route only), a Product Info button that silently fires a full-catalog
PO sync and a clear-all-then-reset suppression sync that nobody ledgers,
two buttons with overlapping stages in different orders, a third order for
onboarding, a fourth for Bulk Calc, a 30-day cache that was supposed to be
gone, and schedules written in UTC comments that fired host-local. AF now
runs on an always-on host; the data should refresh itself, on a sequence
designed around dependencies and cadence rather than around which toolbar
button happened to own which API call.

## Decisions (all confirmed)

| # | Decision | Date |
|---|---|---|
| 1 | Public vs store split — components grouped by whether they key on ASIN alone or on seller/SKU | 10-13 |
| 2 | SP-API first; Keepa only where it is the better fit (history, statistics) | 10-13 |
| 3 | No freshness caches anywhere; the Bulk Calc 30-day gating/hazmat cache goes | 10-13 |
| 4 | One **Refresh** button replaces Product Info and Prices & Stock; it refreshes everything | 10-13 |
| 5 | Onboarding and Bulk Calc Refresh run the same full refresh; Bulk Calc writes only to bulk tables (main → bulk ok; bulk → main only via Buy List icons) | 10-13 |
| 6 | Cadence per component as in the sheet: hourly / daily / on-demand | 10-13 |
| 7 | One pass at 00:00 ET that also runs the daily block; no passes 01–03; hourly passes 04:00–23:00 (21/day) | 10-13 |
| 8 | SC-only SKU discovery is hourly and runs first in every pass | 10-13 |
| 9 | Add to SC probes gating live for its selection; Push to Aura reads the PO sheet for its selection first | 10-13 |
| 10 | Hourly listings scope = active + parked (dead excluded) | 10-13 |
| 11 | `asins.in_catalog` retired | 10-13 |
| 12 | CPT moves to `asin_estimates`, written by the prices component | 10-13 |
| 13 | Durable Postgres job queue, no Redis | 10-15 |
| 14 | Interrupted passes resume at the component + ASIN where they stopped | 10-15 |
| 15 | Manual Refresh scope = selection, else the current filtered view | 10-15 |
| 16 | Completion notification: on-screen; reports gated↔ungated and suppressed↔unsuppressed flips, never price counts; email pinned | 10-15 |
| 17 | Runs in the web process; a Render Background Worker is a later move if needed | 10-15 |

## Rule

**Every refresh of Amazon-side or sheet-side data is a job on one queue,
executed by one runner, one job at a time, in one fixed component order.
Scheduled passes and the Refresh button enqueue the same job with
different scopes. Nothing refreshes data outside the queue.**

## The component sequence

The single ordered list every job follows (numbers from the sheet; CALL-n
is the API request, shared where several components ride one call).

| # | Component | Tier | Call | Scope (scheduled) |
|---|---|---|---|---|
| 1 | SC-only SKU discovery + onboarding | hourly | CALL-1 `searchListingsItems` | account |
| 2 | Catalog attributes | daily | CALL-2 Catalog Items batch | active+parked |
| 3 | Catalog-deleted signal | daily | rides CALL-2 | " |
| 4 | BSR / rank + category | daily | rides CALL-2 | " |
| 5 | Meltable | daily | rides CALL-2 | " |
| 6 | Dangerous good | daily | rides CALL-2 | " |
| 7 | Hazmat | daily | CALL-3 inbound eligibility, per ASIN | " |
| 8 | Eligibility / gating | daily | CALL-4 Listings Restrictions, per ASIN | " |
| 9 | Actual COGS from PO sheet | hourly | CALL-5 Orders sheet | full sheet |
| 10 | Competitive prices | hourly | CALL-6 itemOffers batch | active+parked |
| 11 | Seller count | hourly | rides CALL-6 | " |
| 12 | CPT | hourly | rides CALL-6 (**new write**) | " |
| 13 | FBA fee estimate | hourly | CALL-7 feesEstimate batch | " |
| 14 | Estimated profit / margin / ROI | hourly | computed | " |
| 15 | FBA inventory snapshot | hourly | CALL-8 inventory summaries | " |
| 16 | Live offer / buyable / issues | hourly | CALL-9 getListingsItem, per SKU | active+parked |
| 17 | Primary SKU | hourly | derived from 15–16 | " |
| 18 | Suppressions (FYP) | hourly | CALL-10 FYP report | account |
| 19 | Sales units / revenue | hourly | CALL-11 Finances `listTransactions` (today: orders report) | account, delta |
| 20 | Refunds | hourly | rides CALL-11 | " |
| 21 | Actual fees charged | hourly | rides CALL-11 | " |

Dependencies the order encodes: 9 before 15 (inventory copies
`ordered_qty`); 10 before 13 (fees need the fresh price); 15 before 16
(listings need the SKU set); 19–21 last so Actual profit uses this hour's
COGS. The daily block (2–8) is executed only by the 00:00 pass; every
other pass skips it. 1 runs first in every pass.

Components 19–21 are implemented in this patch against the **current**
sales source (orders flat-file report, 30-day window) because the
Finances API patch is separate and not yet implemented. The scheduler
calls one function, `syncSales(scope, window)`; when the Finances patch
lands it swaps the implementation, not the schedule. The hourly window is
"last 48 hours" (overlap on purpose; the upsert is idempotent).

## Scope rules

- **Scheduled pass:** `status IN ('active','parked')` for ASIN-keyed
  components; account-wide for 1, 18, 19–21; full sheet for 9. Dead ASINs
  are never touched by a scheduled pass (decision 10).
- **Refresh button:** the checkbox selection if any, else every row of the
  current filtered view, visibility toggles included (decision 15). Dead
  ASINs in that set are refreshed. The button runs components 1–21 for
  that set — the daily block included — because "refresh" means
  everything (decision 4). Account-wide components (1, 18, 19–21) run
  account-wide regardless of selection; they are cheap.
- **Onboarding** (Upload File, Sync Sourcing, SC discovery, Buy List
  promote from Bulk Calc): enqueues a Refresh job scoped to the new ASINs.
  `onboardNewAsins` becomes a thin caller; its own stage order is gone.
- **Bulk Calc Refresh:** enqueues a Refresh job with `target: 'bulk'`,
  scoped to the list's ASINs. The runner resolves each ASIN: in `asins` →
  run the components against the main tables, then copy the result row
  into `bulk_list_asins`; not in `asins` → run the public components
  (2–8, 10–14) and write only to the bulk tables. Store components (15–21)
  are skipped for ASINs not in the catalog. Never writes bulk → main.
  The 30-day cache and `bulk_gating_hazmat_cache` are removed (decision 3).

## Data model

Migration `052_scheduler_v1.sql`:

```sql
CREATE TABLE jobs (
  id            BIGSERIAL PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('refresh')),      -- room for later kinds
  trigger       TEXT NOT NULL CHECK (trigger IN ('scheduled','manual','onboarding','bulk')),
  target        TEXT NOT NULL DEFAULT 'main' CHECK (target IN ('main','bulk')),
  bulk_list_id  INTEGER,                                          -- when target = 'bulk'
  include_daily BOOLEAN NOT NULL DEFAULT FALSE,                   -- daily block (2–8)
  scope_asins   TEXT[],                                           -- NULL = scheduled scope rule
  status        TEXT NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued','running','done','failed','cancelled')),
  progress      JSONB NOT NULL DEFAULT '{}',   -- {component: n, asin_cursor: 'B0…', done: [ids]}
  summary       JSONB,                         -- per-component counts + flips, written at end
  requested_by  INTEGER REFERENCES users(id),  -- NULL for scheduled
  queued_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ,
  error         TEXT
);
CREATE INDEX jobs_status_idx ON jobs (status) WHERE status IN ('queued','running');

ALTER TABLE asin_estimates ADD COLUMN competitive_price_threshold NUMERIC(10,2);  -- decision 12
ALTER TABLE asins DROP COLUMN in_catalog;                                           -- decision 11
DROP TABLE IF EXISTS bulk_gating_hazmat_cache;                                      -- decision 3
```

`refresh_runs` stays as the per-component ledger (one row per component
per job, `job_id` column added by the same migration, `trigger` CHECK
widened to the four values above). The history dialog reads jobs, expands
to components.

Retired writers of `in_catalog` (inventory, sales, phase-c onboarding) lose
that statement; the schema comment and CLAUDE.md line 44 are corrected; the
two tests that pin "verdicts never write it" are repointed at the column's
absence.

## Runner

- `server/scheduler/runner.ts`. Started from `server/index.ts` after
  migrations; a single loop: claim the oldest `queued` job with
  `SELECT … FOR UPDATE SKIP LOCKED`, run it, repeat; idle poll every 5 s.
  Exactly one job runs at a time per process. (One process on Render; the
  advisory lock `7342002` guards against the zero-downtime overlap.)
- **Components are functions** `run<Component>(ctx, scope) → ComponentResult`
  in `server/scheduler/components/`, one file each, numbered as the table.
  Each reads what it needs, writes what it owns (SPEC §14 ownership table
  updated to name the component), and returns per-ASIN outcomes. The
  existing stage functions (`refreshPrices`, `syncInventory`,
  `runFullScopePass`, `fetchCatalogBatch`, …) are moved into these files,
  not rewritten; a component that today exists as two paths (Product Info
  fees vs Prices & Stock fees) keeps the one that takes the fresh price.
- **Progress + resume** (decision 14): after each component completes, and
  every 50 ASINs within a per-ASIN component, the runner writes
  `progress` (`{component, asin_cursor, done}`). On startup, any job in
  `running` is resumed from its progress: components in `done` are
  skipped; the current component restarts from `asin_cursor` (ASINs are
  processed in a stable order — `asins.id`). Batch components (CALL-2,
  CALL-6, CALL-7) resume at the batch containing the cursor.
- **Failure:** a component that throws marks the job `failed` with the
  error and the component number; the ledger row for that component
  records what was done. Later components do not run (the sequence is
  dependency-ordered). The next scheduled pass is a new job; it does not
  retry the failed one. Retry failed (N) in the dialog enqueues a manual
  job scoped to the failed ASINs.
- **Cancel:** `PATCH /api/jobs/:id {status:'cancelled'}`; the runner
  checks between components and every 50 ASINs; a cancelled job keeps its
  partial progress in the ledger.
- **Serialisation is the lock.** Because the queue is single-consumer,
  the "cron and button collide" problem goes away structurally; no
  per-sync mutex is needed. A Refresh clicked during a scheduled pass
  queues behind it and the button shows "queued (1 ahead)".
- **Suppression sync** (component 18) is rewritten as stage-then-swap: the
  report's ASIN set is loaded into a temp table, then one `UPDATE … SET
  is_search_suppressed = (asin IN temp)` — no window where the catalog
  shows no suppressions. Crash-safe.
- **Listings** (16) uses the `onboardScDiscoveries` callback whether
  invoked by schedule or button — the cron divergence is gone because
  there is no second entry point.
- **Add to SC** and **Push to Aura** (decision 9) each enqueue a tiny
  manual job for their selection — components 8 and 9 respectively —
  and wait for it before proceeding. Both get a hard stop in the
  implementation (production writes).

## Schedule

`server/scheduler/schedule.ts`, one definition, `node-cron` with
`timezone: 'America/New_York'` passed explicitly (never host-local again):

```
0 0 * * *        enqueue refresh { trigger: scheduled, include_daily: true }
0 4-23 * * *     enqueue refresh { trigger: scheduled, include_daily: false }
```

Gated by `ENABLE_CRONS === 'true'` as today. **No stacking (Maria,
2026-10-16):** at most one scheduled pass waits at any time. A tick that
finds a scheduled pass already *queued* does not enqueue — it logs
"tick HH:00 skipped — scheduled pass #N already queued", and the 00:00
tick promotes that queued pass to `include_daily = true` instead. A tick
that finds a scheduled pass *running* but none queued enqueues one as
before, and it waits. Queued manual jobs (Refresh button, backfill) do
not count. A long manual job delays the next pass but never produces
back-to-back identical passes. The three existing cron files
(`refresh-cron.ts`, `sourcing-sync-cron.ts`, `aura-sync-cron.ts`) are
deleted; Sync Sourcing and the Aura chain are on-demand (sheet decisions)
and keep their buttons.

Expected durations on 2,453 active+parked at today's pacing: hourly pass
~40–50 min (prices ~21 min is Amazon's rate floor), midnight pass +10–15
min for the daily block. Fits the 04:00–23:00 slots; the midnight pass has
a four-hour window.

## UI

- **Toolbar:** Product Info and Prices & Stock buttons removed; one
  **Refresh (N)** button, N = working-set size. While a job runs the
  button shows the component ("Refresh · prices 840/2453") and a Cancel.
  Clicking while another job is running enqueues and shows the queue
  position. The history clock opens the jobs list.
- **Jobs / history dialog:** one row per job (trigger, scope size,
  started, duration, status), expandable to per-component counts and the
  outcome lists, plus **Retry failed (N)**. Replaces the refresh_runs
  history dialog.
- **Completion notification** (decision 16): a toast when a job the
  current user is watching (their own manual job, or any scheduled job
  while the tab is open) finishes: "Refresh done · 2,453 ASINs · 44 min",
  with a **Changes** link when the job's summary has flips. The flips
  panel lists ASINs that went gated→ungated, ungated→gated,
  suppressed→unsuppressed, unsuppressed→suppressed in that job, each a
  link to the row. No price-change counts. The client polls
  `GET /api/jobs/current` every 10 s while any job is queued/running.
- **Bulk Calc page:** Refresh button stays; it enqueues the bulk-target
  job; same progress/toast treatment.
- **Settings:** ~~a read-only "Scheduler" section~~ — **not built**
  (decided 2026-10-16 after commit 2 had added it; removed the same day).
  The jobs dialog is the only surface; `GET /api/jobs/scheduler` remains
  as an API read.

## Documentation

- SPEC §11: Product Info and Prices & Stock sections replaced by one
  "Refresh job" section with the component table; "Scheduled crons"
  rewritten to the two schedule lines; Bulk Calc refresh and onboarding
  sections point at the job.
- SPEC §14 ownership table: each field names its component number.
- SPEC §24: `ENABLE_CRONS` row updated — set to `true` after this patch's
  final commit; CLAUDE.md "crons disabled" notes updated.
- Component map CSV committed as `docs/af_data_components.csv` so the
  numbers in SPEC resolve to something in the repo.

## Commits

1. **`scheduler: jobs table, runner, component framework, progress/resume`** — migration 052 (jobs, CPT column, in_catalog drop, cache drop, refresh_runs.job_id), runner loop, component interface, the 21 component files wrapping the existing stage functions in the fixed order, resume logic, cancel route. No UI, no schedule yet. Tests: order is fixed; resume skips done components and restarts at the cursor; cancel honoured; one job at a time; stage-then-swap suppression leaves no empty window; in_catalog has no writers.
2. **`scheduler: Refresh button, jobs dialog, completion toast with flips`** — toolbar, dialog, polling (the Settings section it added was removed 2026-10-16). Product Info / Prices & Stock removed; their routes become thin enqueuers for one more release then are deleted (CLAUDE.md note). Tests: scope rule; queue-position display; flips panel content.
3. **`scheduler: onboarding and Bulk Calc enqueue the job; cache removed`** — `onboardNewAsins` → enqueue; Bulk Calc Refresh → bulk-target job with the main→bulk copy rule; `bulk_gating_hazmat_cache` and the 30-day rule gone. Tests: bulk never writes main tables; catalog ASIN refreshed in main then copied; non-catalog ASIN public-only.
4. **`scheduler: Add to SC probes gating live; Push to Aura reads PO sheet first`** — decision 9. **Hard stop before this commit** (touches submission and Aura paths).
5. **`scheduler: schedule definition; old cron files deleted`** — the two cron lines with explicit timezone, gated by ENABLE_CRONS. Still off on Render. Tests: expressions fire at 00:00 and 04–23 ET across a DST boundary.
6. **`docs: SPEC §11/§14/§24, CLAUDE.md, component map`** — documentation.

Then: dry-run the schedule locally with `ENABLE_CRONS=true` for one
hourly tick against the local DB; review the jobs row and ledger; push.
**Hard stop** before setting `ENABLE_CRONS=true` on Render. First
production pass is the next hourly slot; Maria checks the jobs dialog
after it.

## Out of scope

- Finances API implementation (own patch; this patch calls the sales
  function it will replace).
- Keepa (cadence TBD; will be components 22+ when it lands).
- Email notification (pinned).
- Moving the runner to a Background Worker.
- Per-component rate-limit tuning beyond what exists; prices stays at
  Amazon's floor.
- VA restrictions.
