# Amazon FBA Profitability Analyzer

## Overview
A full-stack web app that analyzes Amazon FBA profitability by uploading a CSV/Excel file with ASIN and COGS data, fetching pricing/fee data from Amazon SP-API, and calculating profit metrics.

## Architecture
- **Frontend:** React + Tailwind CSS + shadcn/ui (dark mode default)
- **Backend:** Express.js with file parsing (multer, xlsx, papaparse) and SP-API integration
- **No database** - this is a stateless analysis tool. Settings persist in localStorage.

## Key Files
- `shared/schema.ts` - TypeScript interfaces and calculation logic
- `client/src/pages/home.tsx` - Main page with upload, analysis, and results
- `client/src/components/` - UI components (file-upload, results-table, settings-dialog, export-buttons, summary-cards, theme-provider)
- `client/src/lib/settings.ts` - localStorage settings management
- `server/routes.ts` - API routes for file parsing and analysis (streaming NDJSON)
- `server/spapi.ts` - Amazon SP-API integration (OAuth token refresh, pricing, fees, catalog)

## SP-API Credentials
Required as Replit Secrets:
- `SP_API_CLIENT_ID`
- `SP_API_CLIENT_SECRET`
- `SP_API_REFRESH_TOKEN`
- `SP_API_SELLER_ID`

## Features
- CSV/Excel file upload and parsing
- SP-API integration for pricing, fees, and catalog data
- Streaming progress updates during analysis
- Price source toggle (Lowest FBA / Buy Box) with fallback chain
- Profit/ROI/Margin calculations with configurable thresholds
- Conditional row highlighting (green/red/gray)
- CSV and Excel export
- Summary cards with aggregate metrics
- Dark/light mode toggle
- Persistent settings via localStorage
