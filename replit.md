# Amazon FBA Profitability Analyzer

## Overview
A full-stack web app that analyzes Amazon FBA profitability by uploading a CSV/Excel file with ASIN and COGS data, fetching pricing/fee data from Amazon SP-API, and calculating profit metrics.

## Architecture
- **Frontend:** React + Tailwind CSS + shadcn/ui (dark mode default)
- **Backend:** Express.js with file parsing (multer, xlsx, papaparse) and SP-API integration
- **No database** - this is a stateless analysis tool. Settings persist in localStorage.

## Key Files
- `shared/schema.ts` - TypeScript interfaces, column definitions, and calculation logic (calculateProfit, getSelectedPrice, getEffectivePrep, getEffectiveStorage)
- `client/src/pages/home.tsx` - Main page with upload, analysis, results, filter state, buy list state, sort state
- `client/src/components/` - UI components (file-upload, results-table, settings-dialog, export-buttons, summary-cards, theme-provider, column-manager, login-screen)
- `client/src/lib/settings.ts` - localStorage settings management
- `client/src/lib/columns.ts` - Column config (order + visibility) persisted in localStorage
- `server/routes.ts` - API routes for file parsing (with optional Prep/Storage columns) and analysis (streaming NDJSON)
- `server/spapi.ts` - Amazon SP-API integration (OAuth token refresh, pricing, fees, catalog with images/BSR/salesRanks)

## SP-API Credentials
Required as Replit Secrets:
- `SP_API_CLIENT_ID`
- `SP_API_CLIENT_SECRET`
- `SP_API_REFRESH_TOKEN`
- `SP_API_SELLER_ID`
- `APP_PASSWORD` - Password protection for app access

## Features
- Password-protected access (APP_PASSWORD secret)
- CSV/Excel file upload and parsing (supports optional Prep/Storage columns for per-ASIN overrides)
- SP-API integration for pricing, fees, catalog data (title, image, BSR, weight)
- Product Name and Image thumbnails from Catalog Items API
- BSR (Best Seller Rank) with category name
- Split seller counts: Sellers (FBA) and Sellers (FBM)
- Retry logic: ASINs with missing fees/pricing/BSR are retried up to 2 times with 2s delay; only re-fetches failing components
- Error classification: restricted products show "Restricted", missing data shows "No data", detailed EXHAUSTED logs for each failed ASIN
- Suspicious weight detection: items < 0.1 lbs fall back to dimensional weight; null weight when no data (no hardcoded default)
- No fallback FBA fees: fee estimates based on fallback price ($15 default) are discarded to prevent false $3.17 fees
- Streaming progress updates during analysis
- Price source toggle (Lowest FBA / Buy Box) with fallback chain
- Profit/ROI/Margin calculations with configurable thresholds
- Low-inventory-level surcharge ($0.26 default, configurable in settings)
- Full-width edge-to-edge table layout
- Frozen columns: # (row number), ☑ (buy checkbox), ASIN always visible when scrolling horizontally
- All columns sortable (click header to toggle asc/desc)
- Sticky header row for vertical scrolling
- Column Manager (toggle visibility, drag-to-reorder, reset to default, localStorage persistence)
- Per-ASIN Prep/Storage overrides with asterisk indicator
- Conditional row highlighting (green/red/gray, blue for buy-list items)
- Summary tile filters: Total ASINs, Profitable, Unprofitable, Buy List — click to filter, click again to deselect
- Buy List: checkbox per row, persists in localStorage, "Clear Buy List" button, count shown on tile
- Combined Export dropdown (CSV / Excel) replacing separate buttons
- Summary cards with aggregate metrics (Avg ROI, total profit)
- Dark/light mode toggle
- Persistent settings via localStorage

## Column Default Order
ASIN, Image, Product Name, COGS, Sale Price, Profit/Unit, Margin, ROI, FBA Fee, Referral Fee, Inbound Ship., Prep (hidden), Storage (hidden), BSR, Sellers (FBA), Sellers (FBM)

## localStorage Keys
- `fba-column-config` - Column order and visibility
- `fba-analyzer-settings` - Settings (shipping cost, prep, storage, surcharge, thresholds)
- `fba-auth-token` - Auth session
- `fba-buy-list` - Checked ASINs for buy list

## GitHub
Repository: https://github.com/mashalelek/asinflow-v1
