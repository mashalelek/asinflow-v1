-- ============================================================================
-- HISTORICAL — superseded 2026-10-15 by database/schema_baseline_2026-10-15.sql
-- ============================================================================
-- This was the original base schema (April 2026). It is kept for the record
-- only. It is NOT applied by the migration runner and does NOT reproduce the
-- live schema: columns and a whole table were added by hand after it was
-- written and never captured in a migration file (see the header of the
-- baseline file for the list). Do not run this against any database.
-- ============================================================================

-- ============================================================================
-- AsinFlow Database Schema v1.1
-- Migration: Initial schema for persistent ASIN database
-- ============================================================================

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================================
-- USERS & AUTH
-- ============================================================================

CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email           VARCHAR(255) UNIQUE NOT NULL,
    password_hash   VARCHAR(255) NOT NULL,
    display_name    VARCHAR(100),
    role            VARCHAR(20) DEFAULT 'user' CHECK (role IN ('admin', 'user')),
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    last_login_at   TIMESTAMPTZ
);

-- ============================================================================
-- CORE ASIN CATALOG
-- ============================================================================

CREATE TABLE asins (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    asin            VARCHAR(10) UNIQUE NOT NULL,
    primary_sku     VARCHAR(50),
    title           TEXT,
    image_url       TEXT,
    brand           VARCHAR(255),
    category        VARCHAR(255),          -- e.g. "Pet Supplies", "Grocery & Gourmet Food"
    weight_lb       NUMERIC(10,4),
    length_in       NUMERIC(8,3),
    width_in        NUMERIC(8,3),
    height_in       NUMERIC(8,3),
    size_tier       VARCHAR(50),           -- Amazon size tier classification

    -- Sourcing fields (supplier derived from buy_link domain)
    buy_link        TEXT,                  -- full URL to supplier product page
    supplier        VARCHAR(255),          -- auto-derived domain from buy_link, or manual

    -- Status flags
    in_catalog      BOOLEAN DEFAULT FALSE, -- exists in seller's Amazon listings
    fulfillment_channel VARCHAR(10) DEFAULT 'FBA' CHECK (fulfillment_channel IN ('FBA', 'FBM')),
    is_meltable     BOOLEAN DEFAULT FALSE, -- from SP-API product attributes
    is_listing_active BOOLEAN DEFAULT TRUE,-- from SP-API listing status
    is_gated        BOOLEAN,              -- from Listings Restrictions API
    gating_reason   TEXT,
    is_active       BOOLEAN DEFAULT TRUE,  -- false = archived (user action)

    -- Notes
    notes           TEXT,

    -- Timestamps
    added_at        TIMESTAMPTZ DEFAULT NOW(),
    last_refreshed_at TIMESTAMPTZ,

    -- Who added it
    added_by        UUID REFERENCES users(id)
);

CREATE INDEX idx_asins_asin ON asins(asin);
CREATE INDEX idx_asins_active ON asins(is_active);
CREATE INDEX idx_asins_supplier ON asins(supplier);

-- Additional SKUs for ASINs that have more than one
CREATE TABLE asin_skus (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    asin_id         UUID NOT NULL REFERENCES asins(id) ON DELETE CASCADE,
    sku             VARCHAR(50) NOT NULL,
    is_primary      BOOLEAN DEFAULT FALSE,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(asin_id, sku)
);

-- ============================================================================
-- TAGS
-- ============================================================================

CREATE TABLE tags (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name            VARCHAR(100) UNIQUE NOT NULL,
    color           VARCHAR(7),            -- hex color for UI, e.g. '#FF6B6B'
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE asin_tags (
    asin_id         UUID NOT NULL REFERENCES asins(id) ON DELETE CASCADE,
    tag_id          UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    applied_at      TIMESTAMPTZ DEFAULT NOW(),
    applied_by      UUID REFERENCES users(id),
    PRIMARY KEY (asin_id, tag_id)
);

-- Pre-seed tags
INSERT INTO tags (name, color) VALUES
    ('Waiting for sale',                '#F59E0B'),
    ('OOS (supplier)',                  '#EF4444'),
    ('Need more leads from supplier',   '#8B5CF6'),
    ('Wholesale',                       '#3B82F6'),
    ('Cost went up',                    '#F97316'),
    ('Fall/Q4',                         '#92400E'),
    ('Summer',                          '#FBBF24'),
    ('Back to School',                  '#6366F1'),
    ('Spring',                          '#10B981'),
    ('St. Valentine''s Day',            '#EC4899'),
    ('St. Patrick''s Day',              '#059669'),
    ('Easter',                          '#A78BFA'),
    ('Wrong product',                   '#6B7280'),
    ('IP/Brand on the listing',         '#DC2626'),
    ('Discontinued',                    '#374151');

-- ============================================================================
-- ESTIMATES (current competitive pricing & estimated profitability)
-- ============================================================================

CREATE TABLE asin_estimates (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    asin_id         UUID NOT NULL REFERENCES asins(id) ON DELETE CASCADE,

    -- Price data
    sale_price      NUMERIC(10,2),
    price_source    VARCHAR(20) CHECK (price_source IN ('lowest_fba', 'buy_box', 'manual')),

    -- Cost inputs
    cogs            NUMERIC(10,2),
    cogs_source     VARCHAR(20) CHECK (cogs_source IN ('po_sheet', 'csv', 'manual')),
    inbound_ship_estimate NUMERIC(10,2),
    prep_cost       NUMERIC(10,2) DEFAULT 0,  -- per unit, from CSV or manual entry

    -- Amazon fees
    referral_fee    NUMERIC(10,2),
    fba_fee         NUMERIC(10,2),
    variable_closing_fee NUMERIC(10,2) DEFAULT 0,

    -- Calculated estimates
    est_profit_unit NUMERIC(10,2),
    est_margin      NUMERIC(6,2),          -- percentage
    est_roi         NUMERIC(8,2),          -- percentage

    -- Competitive landscape
    bsr             INTEGER,               -- Best Sellers Rank
    sellers_fba     INTEGER,               -- number of FBA sellers
    sellers_fbm     INTEGER,               -- number of FBM sellers

    -- Staleness tracking
    fetched_at      TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(asin_id)
);

CREATE INDEX idx_asin_estimates_asin ON asin_estimates(asin_id);
CREATE INDEX idx_asin_estimates_fetched ON asin_estimates(fetched_at);

-- ============================================================================
-- ACTUALS: DAILY SALES DATA (from SP-API)
-- ============================================================================

CREATE TABLE sales_daily (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    asin_id         UUID NOT NULL REFERENCES asins(id) ON DELETE CASCADE,
    sale_date       DATE NOT NULL,
    units_sold      INTEGER DEFAULT 0,
    revenue         NUMERIC(12,2) DEFAULT 0,
    units_refunded  INTEGER DEFAULT 0,
    refund_amount   NUMERIC(12,2) DEFAULT 0,

    -- Actual Amazon fees for this day's sales
    actual_fba_fees      NUMERIC(12,2) DEFAULT 0,
    actual_referral_fees NUMERIC(12,2) DEFAULT 0,
    actual_other_fees    NUMERIC(12,2) DEFAULT 0,

    synced_at       TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(asin_id, sale_date)
);

CREATE INDEX idx_sales_daily_asin_date ON sales_daily(asin_id, sale_date);
CREATE INDEX idx_sales_daily_date ON sales_daily(sale_date);

-- ============================================================================
-- INVENTORY SNAPSHOTS
-- ============================================================================

CREATE TABLE inventory_snapshots (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    asin_id         UUID NOT NULL REFERENCES asins(id) ON DELETE CASCADE,

    -- FBA inventory breakdown
    available_fba   INTEGER DEFAULT 0,
    reserved        INTEGER DEFAULT 0,
    inbound_shipped INTEGER DEFAULT 0,     -- sent to FBA, in transit
    inbound_receiving INTEGER DEFAULT 0,   -- at FC, being checked in

    -- FBM inventory (if applicable)
    available_fbm   INTEGER DEFAULT 0,

    -- From Google Sheet PO data (until PO module is built)
    ordered_qty     INTEGER DEFAULT 0,

    -- Calculated total
    total_inventory_position INTEGER GENERATED ALWAYS AS (
        COALESCE(available_fba, 0) + COALESCE(available_fbm, 0) +
        COALESCE(reserved, 0) + COALESCE(inbound_shipped, 0) +
        COALESCE(inbound_receiving, 0) + COALESCE(ordered_qty, 0)
    ) STORED,

    snapshot_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_inventory_asin ON inventory_snapshots(asin_id);
CREATE INDEX idx_inventory_latest ON inventory_snapshots(asin_id, snapshot_at DESC);

-- ============================================================================
-- VIEW PRESETS
-- ============================================================================

CREATE TABLE view_presets (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name            VARCHAR(100) NOT NULL,
    description     TEXT,
    config          JSONB NOT NULL,
    created_by      UUID REFERENCES users(id),
    is_default      BOOLEAN DEFAULT FALSE,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Notes on column keys used in presets:
--   Product info:  image, asin, title, brand, buy_link (shows supplier domain + link)
--   Tools:         selleramp, keepa (icon links, always shown together)
--   Status:        eligible
--   Stock:         stock (hover breakdown: available_fba/fbm, ordered, reserved, inbound)
--   Estimates:     cogs, sale_price, fba_fee, referral_fee, inbound_ship, prep_cost,
--                  est_profit, est_margin, est_roi
--   Competition:   bsr, sellers_fba, sellers_fbm
--   Actuals:       units_sold, revenue, refunds, actual_profit, actual_profit_unit,
--                  actual_margin, actual_roi
--   Meta:          tags, notes

INSERT INTO view_presets (name, description, config, is_default) VALUES
    (
        'Full View',
        'All columns visible',
        '{
            "columns": ["image", "asin", "selleramp", "keepa", "title", "brand",
                         "eligible", "buy_link", "cogs", "sale_price",
                         "est_profit", "est_margin", "est_roi",
                         "fba_fee", "referral_fee", "inbound_ship", "prep_cost",
                         "bsr", "sellers_fba", "sellers_fbm",
                         "stock", "units_sold", "revenue", "refunds",
                         "actual_profit", "actual_profit_unit", "actual_margin", "actual_roi",
                         "tags", "notes"],
            "sort_by": "revenue",
            "sort_dir": "desc"
        }'::jsonb,
        TRUE
    );
-- Note: prior "Replenishment" and "Sourcing" built-in presets were removed
-- in the B3 cutover. The Replenishment FILTER LOGIC now lives in
-- shared/profitability.ts (isReplens) and is invoked via the Replens
-- scorecard tile. See database/delete_replenishment_sourcing_presets.sql.

-- ============================================================================
-- SETTINGS
-- ============================================================================

CREATE TABLE settings (
    key             VARCHAR(100) PRIMARY KEY,
    value           JSONB NOT NULL,
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO settings (key, value) VALUES
    ('default_date_range', '{"preset": "last_30_days"}'::jsonb),
    ('include_inbound_shipping', 'true'::jsonb),
    ('google_sheet_id', '"1WC7r4Z-fIVENFoj_Z14rAgXs2U4Etue0BM065DPGl7Q"'::jsonb),
    ('default_fulfillment_channel', '"FBA"'::jsonb);
