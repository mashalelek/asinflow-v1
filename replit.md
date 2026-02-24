# Amazon FBA Profitability Analyzer

## Overview
A full-stack web app that analyzes Amazon FBA profitability by uploading a CSV/Excel file with ASIN and COGS data, fetching pricing/fee data from Amazon SP-API, and calculating profit metrics.

## Architecture
- **Frontend:** React + Tailwind CSS + shadcn/ui (dark mode default)
- **Backend:** Express.js with file parsing (multer, xlsx, papaparse) and SP-API integration
- **No database** - this is a stateless analysis tool. Settings persist in localStorage.

## Key Files
- `shared/schema.ts` - TypeScript interfaces, column definitions, and calculation logic (calculateProfit, getSelectedPrice, getEffectivePrep, getEffectiveStorage)
- `client/src/pages/home.tsx` - Main page with upload, analysis, and results
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
- Streaming progress updates during analysis
- Price source toggle (Lowest FBA / Buy Box) with fallback chain
- Profit/ROI/Margin calculations with configurable thresholds
- All columns sortable (click header to toggle asc/desc)
- Sticky header row for scrolling
- Column Manager (toggle visibility, drag-to-reorder, reset to default, localStorage persistence)
- Per-ASIN Prep/Storage overrides with asterisk indicator
- Conditional row highlighting (green/red/gray)
- CSV and Excel export with all fields
- Summary cards with aggregate metrics
- Dark/light mode toggle
- Persistent settings via localStorage

## Column Default Order
ASIN, Image, Product Name, COGS, Sale Price, Profit/Unit, Margin, ROI, FBA Fee, Referral Fee, Inbound Ship., Prep (hidden), Storage (hidden), BSR, Sellers (FBA), Sellers (FBM)
