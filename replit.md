# Amazon FBA Profitability Analyzer

## Overview
A full-stack web app that analyzes Amazon FBA profitability by uploading a CSV/Excel file with ASIN and COGS data, fetching pricing/fee data from Amazon SP-API, and calculating profit metrics.

## Architecture
- **Frontend:** React + Tailwind CSS + shadcn/ui (dark mode default)
- **Backend:** Express.js with file parsing (multer, xlsx, papaparse) and SP-API integration
- **No database** - this is a stateless analysis tool. Settings persist in localStorage.

## Key Files
- `shared/schema.ts` - TypeScript interfaces, column definitions, and calculation logic (calculateProfit, getSelectedPrice, getEffectivePrep, getEffectiveStorage, extractDomain, ColumnMapping)
- `client/src/pages/home.tsx` - Main page with upload, analysis, results, filter state, buy list state, sort state
- `client/src/components/` - UI components (file-upload, results-table, settings-dialog, export-buttons, summary-cards, theme-provider, column-manager, login-screen, column-mapping-modal)
- `client/src/lib/settings.ts` - localStorage settings management
- `client/src/lib/columns.ts` - Column config (order + visibility) persisted in localStorage
- `server/routes.ts` - API routes for file parsing (two-step: parse-file → parse-mapped), template download, and analysis (streaming NDJSON)
- `server/spapi.ts` - Amazon SP-API integration (OAuth token refresh, pricing, fees with referral fallback, catalog with images/BSR/salesRanks)

## SP-API Credentials
Required as Replit Secrets:
- `SP_API_CLIENT_ID`
- `SP_API_CLIENT_SECRET`
- `SP_API_REFRESH_TOKEN`
- `SP_API_SELLER_ID`
- `APP_PASSWORD` - Password protection for app access

## Features
- Password-protected access (APP_PASSWORD secret)
- Two-step upload flow: upload file → column mapping modal → analysis
- Template download (`/api/download-template`) with example data and notes
- Column mapping modal with auto-match and required/optional field validation
- CSV/Excel file upload (supports ASIN, COGS, Buy Link, Prep Cost, Additional Fees columns)
- SP-API integration for pricing, fees, catalog data (title, image, BSR, weight)
- Supplier column: extracts domain from Buy Link, shown as clickable link
- Product Name and Image thumbnails from Catalog Items API
- BSR (Best Seller Rank) with category name
- Split seller counts: Sellers (FBA) and Sellers (FBM) — shows 0 when API confirms, "-" only when null
- Retry logic: ASINs with missing fees/pricing/BSR are retried up to 2 times with 2s delay; only re-fetches failing components
- Error classification: restricted products show "Restricted", missing data shows "No data", "Price unavailable" when catalog succeeds but pricing fails
- $0.00 referral fee fallback: category-based referral percentage map (35+ categories) with manual calculation when SP-API returns $0 or null
- Suspicious weight detection: items < 0.1 lbs fall back to dimensional weight; null weight when no data (no hardcoded default)
- No fallback FBA fees: fee estimates based on fallback price ($15 default) are discarded to prevent false $3.17 fees
- Inbound shipping: shows "?" with warning when weight unavailable instead of $0.00
- Streaming progress updates during analysis
- Price source toggle (Lowest FBA / Buy Box) with fallback chain
- Profit/ROI/Margin calculations with configurable thresholds
- Low-inventory-level surcharge ($0.26 default, configurable in settings)
- Full-width edge-to-edge table layout
- Frozen columns: # (row number), ☑ (buy checkbox), ASIN always visible when scrolling horizontally
- All columns sortable (click header to toggle asc/desc)
- Sticky header row for vertical scrolling
- Column Manager (toggle visibility, drag-to-reorder, reset to default, localStorage persistence)
- Per-ASIN Prep Cost/Additional Fees overrides with asterisk indicator
- Conditional row highlighting (green/red/gray, blue for buy-list items)
- Summary tile filters: Total ASINs, Profitable, Unprofitable, Buy List — click to filter, click again to deselect
- Buy List: checkbox per row, persists in localStorage, "Clear Buy List" button, count shown on tile
- Combined Export dropdown (CSV / Excel) with Supplier and Buy Link columns
- Summary cards with aggregate metrics (Avg ROI, total profit)
- Dark/light mode toggle
- Persistent settings via localStorage

## Column Default Order
ASIN, Image, Product Name, Supplier, COGS, Sale Price, Profit/Unit, Margin, ROI, FBA Fee, Referral Fee, Inbound Ship., Prep Cost (hidden), Additional Fees (hidden), BSR, Sellers (FBA), Sellers (FBM)

## API Endpoints
- `POST /api/verify-password` - Password verification
- `GET /api/credentials-status` - Check SP-API credentials
- `GET /api/download-template` - Download XLSX template with example data
- `POST /api/parse-file` - Upload file, returns `{ headers, rowCount, autoMapping }`
- `POST /api/parse-mapped` - Upload file + column mapping, returns `{ asins, hasPrepOverrides, hasStorageOverrides, hasBuyLinks }`
- `POST /api/analyze` - Streaming NDJSON analysis (progress, results, complete)

## localStorage Keys
- `fba-column-config` - Column order and visibility
- `fba-analyzer-settings` - Settings (shipping cost, prep, storage, surcharge, thresholds)
- `fba-auth-token` - Auth session
- `fba-buy-list` - Checked ASINs for buy list

## GitHub
Repository: https://github.com/mashalelek/asinflow-v1
