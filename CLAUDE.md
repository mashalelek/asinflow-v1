# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
