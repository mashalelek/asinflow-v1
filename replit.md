# Amazon FBA Profitability Analyzer

## Overview
A full-stack web app that analyzes Amazon FBA profitability by uploading a CSV/Excel file with ASIN and COGS data, fetching pricing/fee data from Amazon SP-API, and calculating profit metrics.

## Architecture
- **Frontend:** React + Tailwind CSS + shadcn/ui (dark mode default)
- **Backend:** Express.js with file parsing (multer, xlsx, papaparse) and SP-API integration
- **Database:** PostgreSQL (users table for authentication, sessions via connect-pg-simple)
- **Auth:** Email/password login-only (registration disabled), bcrypt hashing, express-session with PostgreSQL session store

## Key Files
- `shared/schema.ts` - TypeScript interfaces, column definitions, and calculation logic (calculateProfit, getSelectedPrice, getEffectivePrep, getEffectiveStorage, extractDomain, ColumnMapping)
- `client/src/pages/home.tsx` - Main page with upload, analysis, results, filter state, buy list state, sort state (receives user/onLogout props)
- `client/src/App.tsx` - Root component with session-based auth check (GET /api/me on load), renders LoginScreen or Router
- `client/src/components/login-screen.tsx` - Login-only screen with email+password (registration disabled)
- `server/create-user.ts` - One-time script to seed a user (idempotent, uses INSERT ON CONFLICT DO NOTHING)
- `client/src/components/` - UI components (file-upload, results-table, settings-dialog, export-buttons, summary-cards, theme-provider, column-manager, column-mapping-modal)
- `client/src/lib/settings.ts` - localStorage settings management
- `client/src/lib/columns.ts` - Column config (order + visibility) persisted in localStorage
- `server/index.ts` - Express setup with session middleware (connect-pg-simple store)
- `server/db.ts` - PostgreSQL connection pool (pg)
- `server/auth.ts` - registerUser/validateUser functions (bcrypt, salt rounds: 10)
- `server/routes.ts` - API routes with requireAuth middleware, auth routes, file parsing, analysis (streaming NDJSON)
- `server/spapi.ts` - Amazon SP-API integration (OAuth token refresh, pricing, fees with referral fallback, catalog with images/BSR/salesRanks)

## Environment Secrets
Required as Replit Secrets:
- `SP_API_CLIENT_ID`
- `SP_API_CLIENT_SECRET`
- `SP_API_REFRESH_TOKEN`
- `AMAZON_SELLER_ID` - Your seller account ID (used for Listings Restrictions eligibility checks)
- `SESSION_SECRET` - Secret for express-session cookie signing
- `DATABASE_URL` - PostgreSQL connection string (auto-provisioned)

## Database Schema
- `users` table: id (serial PK), email (unique, not null), password_hash (text, not null), created_at (timestamp default now())
- `session` table: auto-created by connect-pg-simple for session storage

## Features
- Email/password user authentication (register, login, logout, session-based)
- All API routes protected with requireAuth middleware
- Two-step upload flow: upload file → column mapping modal → analysis
- Template download (`/api/download-template`) with example data and notes
- Column mapping modal with auto-match and required/optional field validation
- CSV/Excel file upload (supports ASIN, COGS, Buy Link, Prep Cost, Additional Fees columns)
- SP-API integration for pricing, fees, catalog data (title, image, BSR, weight)
- Eligibility column: checks gating status per-ASIN via SP-API Listings Restrictions API (v2021-08-01); ✅ green = ungated, ⚠️ amber = gated (clickable link to approval page if available), `-` = unknown/error; rate-limited to 1 req/sec; requires `AMAZON_SELLER_ID` secret
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
ASIN, Image, Product Name, Eligible, Supplier, COGS, Sale Price, Profit/Unit, Margin, ROI, FBA Fee, Referral Fee, Inbound Ship., Prep Cost (hidden), Additional Fees (hidden), BSR, Sellers (FBA), Sellers (FBM)

## API Endpoints
### Auth (public)
- `POST /api/register` - Create account (email, password) → sets session
- `POST /api/login` - Sign in (email, password) → sets session
- `GET /api/me` - Get current user from session (401 if not authenticated)
- `GET /api/logout` - Destroy session

### Protected (requireAuth)
- `GET /api/credentials-status` - Check SP-API credentials
- `GET /api/download-template` - Download XLSX template with example data
- `POST /api/parse-file` - Upload file, returns `{ headers, rowCount, autoMapping }`
- `POST /api/parse-mapped` - Upload file + column mapping, returns `{ asins, hasPrepOverrides, hasStorageOverrides, hasBuyLinks }`
- `POST /api/analyze` - Streaming NDJSON analysis (progress, results, complete)

## localStorage Keys
- `fba-column-config` - Column order and visibility
- `fba-analyzer-settings` - Settings (shipping cost, prep, storage, surcharge, thresholds)
- `fba-buy-list` - Checked ASINs for buy list

## GitHub
Repository: https://github.com/mashalelek/asinflow-v1
