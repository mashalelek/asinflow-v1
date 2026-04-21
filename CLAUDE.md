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
npm run dev        # Start dev server (Express + Vite HMR) on port 5000
npm run build      # Build for production (tsx script/build.ts)
npm run start      # Run production build
npm run check      # TypeScript type checking
```

There are no tests in this codebase.

## Required Environment Variables

```
SP_API_CLIENT_ID
SP_API_CLIENT_SECRET
SP_API_REFRESH_TOKEN
SP_API_SELLER_ID
APP_PASSWORD       # Optional: enables password protection
```

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
