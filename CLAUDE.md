# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# CLAUDE.md — Architecture Section (paste this at the TOP of your existing CLAUDE.md)

## ⚠️ ARCHITECTURE — DO NOT QUESTION OR MODIFY ⚠️

This app runs on the following stack. This is settled. Do not suggest alternatives, do not question whether these exist, do not propose removing any of these. If you survey the codebase and something seems missing, it means there's a bug to fix — not an architecture decision to revisit.

### Stack
- **Frontend:** React + Tailwind CSS + Recharts (Vite dev server)
- **Backend:** Node.js + Express (TypeScript via tsx)
- **Database:** PostgreSQL (local, database name: `asinflow`)
- **ORM/DB access:** Direct `pg` queries (no Drizzle, no Prisma)
- **Scheduled jobs:** node-cron (runs in the Express process)
- **APIs:** Amazon SP-API, Google Sheets API (service account)

### What exists and is working (do NOT rebuild or remove):
- PostgreSQL persistence — all ASIN data, estimates, sales, inventory, tags, settings stored in DB
- Schema defined in `docs/SCHEMA.md` — reference this for all table structures
- Google Sheets API integration — pulls COGS from PO tracker sheet, pulls ordered qty
- SP-API integrations: catalog data, pricing, inventory (`getInventorySummaries`), sales (flat file orders report), listings restrictions, suppression (FYP report)
- Daily inventory cron job at 6 AM EST
- Toolbar buttons: Upload File, Analyze, Sync PO, Sync Inventory, Sync Sales
- Date range selector with presets
- Three view presets: Full View, Replenishment, Sourcing
- Combined Product cell with image, ASIN, SKU, title, icons (SAS, Keepa, meltable, hazmat, suppressed, catalog status)
- Inline editing for: tags, notes, buy link (with query param stripping and domain extraction)
- Keepa-style column filters (numeric/text/boolean operators)
- Pagination with page reset on filter/view changes
- Archive/unarchive, Buy List cart icon
- Stock and sales history graph popup (Recharts)
- Keepa hover graph popup with Buy Box line
- Smart Replenishment filter with tiered profitability thresholds
- Scorecard cards (Total ASINs, Profitable, Unprofitable, Buy List, Avg ROI) — clickable to filter table
- Meltable/hazmat detection from SP-API attributes (temperature_rating, hazmat, supplier_declared_dg_hz_regulation)
- Meltable seasonal auto-filter (Apr 15 – Sep 15)
- Search suppressed detection via GET_MERCHANTS_LISTINGS_FYP_REPORT
- Hazmat surcharge settings applied to profitability calculations
- Price source toggle (Lowest FBA / Buy Box)
- Include Inbound Shipping toggle
- `amzn.gr.*` SKUs excluded from primary SKU selection
- `in_catalog` flag covers all listing statuses (Active, Inactive, Closed)

### Key files:
- `server/index.ts` — Express server entry point
- `server/routes.ts` — API endpoints
- `server/spapi.ts` — SP-API integration (catalog, pricing, fees, meltable/hazmat detection)
- `server/sales-sync.ts` — Sales data sync via orders report
- `server/suppression-sync.ts` — FYP report for search suppressed listings
- `client/src/pages/home.tsx` — Main page with table, filters, scorecards
- `client/src/components/results-table.tsx` — Table rendering and column logic
- `shared/schema.ts` — Column definitions, profit calculation, types
- `docs/SCHEMA.md` — Database schema documentation
- `docs/ROADMAP.md` — Feature roadmap

### Dev commands:
- `npm run dev` — starts both frontend and backend (PORT=3000)
- `psql asinflow` — connect to the local database

### COGS priority:
1. Google Sheets PO data (Col Y) → `cogs_source = 'po_sheet'`
2. CSV upload → `cogs_source = 'csv'`
3. Manual entry → `cogs_source = 'manual'`

### Settings stored in DB (`settings` table):
- `default_date_range`, `include_inbound_shipping`, `google_sheet_id`, `default_fulfillment_channel`
- `hazmat_ship_surcharge`, `hazmat_prep_surcharge`
- Inbound shipping ($/lb), prep cost ($/unit), additional fees ($/unit), low-inventory surcharge ($/unit)
- Profitability thresholds (min ROI %, min margin %)


## Commands

```bash
npm run dev        # Start dev server (Express + Vite HMR) on port 3000 (PORT from .env; code default 5000 collides with macOS AirPlay)
npm run build      # Build for production (tsx script/build.ts)
npm run start      # Run production build
npm run check      # TypeScript type checking (source — EXCLUDES *.test.ts)
npm run check:tests # TypeScript type checking (test files — tsconfig.test.json)
npm test           # Run the test suite once (vitest run)
npm run test:watch # Run the test suite in watch mode
```

**Production build and start, checked locally** (SPEC §24 "Deployment" —
Render runs the same two commands):

```bash
npm run build                      # dist/public (Vite) + dist/index.cjs (esbuild); dist/ is gitignored
PORT=5055 npm start                # NODE_ENV=production node dist/index.cjs — npm start sets NODE_ENV itself; needs SESSION_SECRET in .env
curl -s -w ' %{http_code}\n' http://127.0.0.1:5055/health   # {"ok":true} 200 when the DB answers; {"ok":false} 503 otherwise
```

Use a spare port so a running `npm run dev` on 3000 is untouched (5000 is
taken by macOS AirPlay on this machine), and stop the process afterwards.
The production session cookie is `Secure`, so this local `npm start` can
serve the login page but cannot keep a session over plain http — check
`/health` and the shell here, and do login checks against `npm run dev`.
The build pulls tsx, vite, esbuild and the PostCSS/Tailwind toolchain from
`dependencies`, so it also works after a production-only install
(`npm ci --omit=dev`).

**Known tsc baseline: 4× TS1252 in `server/spapi.ts` (lines 870/879/888/896).**
These are pre-existing (function declarations nested in a block under the ES5
target) and are the expected clean state. The SAME four are the only expected
errors from both `check` and `check:tests`. Gate reports must label tsc errors
as **baseline vs. introduced** — e.g. "4 errors, all baseline; 0 introduced" —
and any introduced error must be fixed forward before committing.

## Tests

`npm test` (vitest). **905 tests across 59 files** as of 2026-10-13 — this
codebase IS tested; the old "there are no tests" line was years stale.

**A gate report must cover BOTH typecheck commands, labelled separately:**

```
npm run check        -> 4 baseline TS1252, 0 introduced
npm run check:tests  -> 4 baseline TS1252, 0 introduced
npm test             -> 905/905
```

`npm run check` alone is NOT a complete gate. The base `tsconfig.json`
excludes `**/*.test.ts`, so it never sees test code — and vitest does not
typecheck, so a test can import a non-existent export and BOTH stay silent
(commit d3123ef shipped exactly that). `check:tests` is the other half; run
it alongside, never instead. Quote the two separately in the report so a
reader can tell which half passed.

## Required Environment Variables

```
SP_API_CLIENT_ID
SP_API_CLIENT_SECRET
SP_API_REFRESH_TOKEN
SP_API_SELLER_ID
SESSION_SECRET     # Signs the login cookie (SPEC §25). Required by `npm start`
                   # (it sets NODE_ENV=production, and production refuses to
                   # start without one). Generate: openssl rand -hex 32.
                   # `npm run dev` falls back to a logged insecure dev value.
```

Full list with purposes: SPEC §24 "Environment variables". `APP_PASSWORD`
no longer exists.

**Auth (SPEC §25):** every `/api` route except `/api/auth/*` and `/health`
needs a session. First account, once, against an empty `users` table:

```bash
tsx script/create-admin.ts --email you@example.com --name "Your Name"   # prompts for the password, no echo
```

Further accounts: Settings → Users (admin only). The script refuses when any
user exists.

## Architecture

This is a **single-server full-stack app**: Express serves both the API and the Vite-built React frontend on the same port (5000). In development, Vite middleware is injected into Express. In production, static files from `dist/public` are served by `server/static.ts`.

### Path aliases (vite + tsconfig)
- `@/` → `client/src/`
- `@shared/` → `shared/`
- `@assets/` → `attached_assets/`

### Data flow

**Upload → Analysis pipeline (two-step):**
1. `POST /api/parse-file` — parses CSV/XLSX, returns headers + auto-mapped column suggestions
2. Column mapping modal shown to user
3. `POST /api/parse-mapped` — re-parses file with confirmed column mapping, returns `AsinInput[]`
4. `POST /api/analyze` — streams NDJSON results back to the client

**Analysis streaming:** `/api/analyze` uses NDJSON (`application/x-ndjson`) with three message types: `progress`, `result`, `_update` (for retry-updated results), and `complete`. The frontend reads this as a stream and appends results as they arrive.

**SP-API calls (`server/spapi.ts`):** For each ASIN, pricing and catalog data are fetched in parallel, then fees are fetched using the real price. If any component fails, the ASIN enters a retry queue (up to 2 retries, 2s delay). After retries, if fees are still missing but pricing exists, `estimateFeeFallback` computes fees from a category-based referral percentage map + weight-based FBA fee. Fee estimates based on fallback prices ($15 default when no real price) are **discarded** to prevent false fee data.

### Calculation logic (`shared/schema.ts`)

All profit calculations live in `calculateProfit()` in `shared/schema.ts` — used client-side only (the server never calculates profit, it only fetches raw data). The formula:

```
profit = salePrice - cogs - (fbaFee + lowInventorySurcharge) - adjustedReferralFee - inboundShipping - prepCost - storageFee
```

Referral fee is proportionally adjusted when the sale price differs from the fee estimate price. Inbound shipping is `weightLbs × inboundShippingCost`; if weight is null, inbound shipping shows "?" in the UI (not $0).

### Frontend state (`client/src/pages/home.tsx`)

Above the pages, `AuthProvider` (`client/src/contexts/auth-context.tsx`,
SPEC §25) gates the router: one `GET /api/auth/me` on load, the login page
on 401, and a global `window.fetch` interceptor that returns to the login
page when any later `/api` call answers 401. `useAuth()` gives the user.

All application state lives in the single `Home` component:
- `asins` — parsed inputs from file upload
- `results` — `AsinResult[]` streamed from the server, accumulated as they arrive
- `priceSource` — "lowestFba" | "buyBox", toggles which price feeds `calculateProfit`
- `settings` — loaded from localStorage (`fba-analyzer-settings`)
- `columnConfig` — column order/visibility, loaded from localStorage (`fba-column-config`)
- `buySet` — Set of ASINs in the buy list, persisted in localStorage (`fba-buy-list`)
- `activeFilter` — summary tile filter: "all" | "profitable" | "unprofitable" | "buyList"
- `sortCol` / `sortDir` — table sort state

### Column system

Columns are defined in `shared/schema.ts` as `ALL_COLUMNS` (array of `ColumnDef`). `client/src/lib/columns.ts` manages localStorage persistence of column order and visibility. The `ColumnManager` component (drag-to-reorder, toggle visibility) writes back to this store. Three columns are always frozen/visible regardless of config: `#` (row number), `☑` (buy checkbox), `asin`.

## Blob-staging shared files: inventory-diff before commit

When staging a shared file by CONSTRUCTING the staged blob (index version +
selected slices, `git hash-object` + `git update-index`) instead of normal
`git add` — the workaround for files co-edited by a parallel session — the
slice boundaries can silently swallow unrelated code sitting between the
anchors. This happened in commit `9360780`: a deletion slice spanning two
comment anchors also removed the three §19 submission-ledger routes between
them, breaking the verification panel's only entry point unnoticed
(restored in `aed66a9`).

**Rule: any constructed-blob staging of a shared file requires an inventory
diff against HEAD before commit.** For `routes.ts`: diff the
`app.get/post/put/delete("…")` route list. For other files: the export list
(`grep -E '^export'`). Every removed entry must be one you intended to
remove, by name — an inventory diff of "what I meant to touch" vs "what
actually changed" is the check; eyeballing the patch is not. The
route-registration test (`server/route-inventory.test.ts`) backstops
routes.ts specifically, but the inventory-diff rule applies to every
blob-staged shared file.

## Gate tests must not leave ROWS behind

Any gate test or verification run that CREATES a row — of any kind — must
remove it before the gate report is written. Not just ASINs: **tags**, SKUs,
bulk lists, view presets, submissions, registry reservations, anything.

**Why:** most of these have no delete in the UI, so a test row lives in the
database forever, polluting counts, filters, dropdowns, and every later "how
many X are there" answer. `B0INVALID9` survived three gate runs before anyone
noticed. Tag verification created `zz-test`, `zz-grouped`, `zz-badcolor`,
`zz-inline` and `zz-free` across several sessions; each was cleaned up, but
only because it was tracked deliberately — nothing in the system would have
flagged a leftover.

**Prefer not to create at all.** Use a dry run, or a row that already exists,
whenever the gate allows it. Reach for an invented row only when the behaviour
under test genuinely requires a new one. A great many gates can be run against
existing data: the listings reconcile, the price/fee stages and the lead-source
backfill were all verified without creating anything.

**Name test rows so they are findable.** A `zz-` prefix sorts last in every
list and greps cleanly; an invented ASIN should be obviously synthetic. A row
you cannot find later is a row you cannot clean up.

**Verify the cleanup, do not assume it.** Re-query and show the count in the
gate report — "tags back to 17", "asins total unchanged at 2579". A delete
call that 404'd or matched zero rows looks identical to success from the
caller's side.

**When you must clean up, check provenance FIRST.** For an ASIN: `added_at`,
title, and dependent rows in `asin_skus`, `listing_submissions`,
`brand_product_registry`, `po_asins`, `asin_tags`. For a tag: its
`asin_tags` count and `created_at`. A row you merely READ during a gate is
not a test row — deleting an ASIN with a generated SKU or a submission record
destroys real history and frees a registry NNN that is supposed to be stable,
and deleting a real tag silently untags every ASIN carrying it.

**What stays:** `refresh_runs` rows are history, including those a gate run
produced — they record that the run happened and are never cleaned up.

## Never `git checkout <file>` to undo an experiment

When mutation-testing — deliberately breaking code to prove a test catches it
— undo the mutation with a **file copy**, never `git checkout <file>`.

```bash
cp server/thing.ts /tmp/thing.bak     # before
# ...mutate, run the test...
cp /tmp/thing.bak server/thing.ts     # after
```

**Why:** `git checkout <file>` reverts to HEAD, which silently discards every
uncommitted change in that file — not just the mutation. During the SC-mirror
commit 2 this destroyed a full file of work twice in one session
(`listing-submissions-repo.ts`, then `results-table.tsx`); both were
recoverable only because the edits had been applied by a saved script. The
command looks like an undo and is actually "discard my work since the last
commit".

Applies to `git restore <file>` and `git stash` mid-edit for the same reason.

## Refresh job (scheduler v1, 2026-10-15)

One **Refresh** button on the ASINs toolbar enqueues one job (`POST
/api/jobs`); a single runner executes the 21 components in SPEC §11's
fixed order, one job at a time. Product Info and Prices & Stock are gone.
`POST /api/analyze/all` and `POST /api/refresh` survive for ONE release as
thin enqueuers (202 + the job) and are then deleted; nothing in the client
calls them. `POST /api/analyze` (CSV upload onboarding) is rewired to the
queue in commit 3 of the scheduler patch.

## Approval model: Maria approves the spec patch, not each commit

Once a spec patch (`docs/claude_spec-patch-*.md`) is approved, implement
every commit it lists with the usual discipline — diff, gate (`check`,
`check:tests`, `test`), single-concern commit message — **without stopping
for per-commit approval**. Stop only when an input is actually needed:

- a deviation from the patch's text,
- a decision the patch does not cover,
- a finding that cannot be resolved from the patch alone.

If everything is straightforward, keep going. Report once, before pushing.

**Still a hard stop before the step that touches production:** migrations
against Render, SP-API or Aura writes, and auth changes.

## Migrations run from committed code only

Migrations and any DB-mutating script run only from committed code.
Apply-then-commit is backwards — commit, then apply, then verify.

**Procedure (SPEC §24 "Migrations", runner since 2026-10-15):** add
`database/migrations/0NN_*.sql`, restart the dev server (the runner applies
it on startup and logs it under `[migrate]`), confirm `npm run migrate:status`
shows it applied with 0 pending, commit. The same runner applies it on
Render at deploy, before the server listens; a failing file exits the
process and the deploy stays on the previous instance. `psql -f` is no
longer part of the procedure. Files must not carry their own
`BEGIN`/`COMMIT`; one that needs to run outside a transaction starts with
`-- migrate: no-transaction`. A fresh database is built by
`npm run migrate` from `database/schema_baseline_2026-10-15.sql`, not from
the archived v1.1 file.

## Definition of Done: committed

A feature isn't done until it's committed — same as it isn't done until
the dry-run passes.

- End of every working session: run `git status`. If the session's feature
  is verified and working, stage and propose the commit before stopping —
  don't leave finished work uncommitted overnight.
- New files belonging to a feature are added in the same commit as the
  feature — never left untracked. Untracked = one `git clean` from gone.
- If a session ends with work genuinely unfinished, say so explicitly in
  the wrap-up ("uncommitted: X, still needs Y") so the state is named, not
  silent.
- Docs-only SPEC edits may batch across sessions, but never past the next
  feature commit.
- After committing changes to sync/cron code, restart any long-running dev
  server before triggering jobs — `tsx` does not hot-reload, so a stale
  process silently runs pre-fix code (this caused a primary-SKU revert once).