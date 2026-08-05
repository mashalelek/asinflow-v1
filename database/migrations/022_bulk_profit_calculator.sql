-- Migration 022: Bulk Profit Calculator (SPEC §21).
--
-- Isolation guarantee (§21): these tables are written ONLY by the bulk
-- profit calculator path and read by NOTHING in the main catalog. There is
-- deliberately no FK to asins — the `in_database` indicator is computed at
-- render time via the single sanctioned EXISTS read, never stored.
--
-- has_live_offer is intentionally NOT a column: the bulk path never runs the
-- getListingsItem live-status check.

BEGIN;

CREATE TABLE bulk_lists (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name            VARCHAR(200) NOT NULL,
    source_filename VARCHAR(255),
    asin_count      INTEGER NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE bulk_list_asins (
    id       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    list_id  UUID NOT NULL REFERENCES bulk_lists(id) ON DELETE CASCADE,
    asin     VARCHAR(10) NOT NULL,
    added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),  -- "Date Added" column source

    -- Catalog snapshot (analyze fetch)
    title      TEXT,
    image_url  TEXT,
    brand      VARCHAR(255),
    category   VARCHAR(255),
    weight_lb  NUMERIC(10,4),  -- inbound shipping is $/lb
    length_in  NUMERIC(8,3),   -- package dims from the catalog fetch (returned for §21; main path ignores)
    width_in   NUMERIC(8,3),
    height_in  NUMERIC(8,3),

    -- Pricing / fee snapshot (a snapshot from the last analyze run, not live)
    sale_price           NUMERIC(10,2),
    price_source         VARCHAR(20),  -- 'lowest_fba' | 'buy_box' | 'lowest' (resolution order, same as fee-price pick)
    fba_fee              NUMERIC(10,2),  -- total non-referral fees — INCLUDES variable closing fee, same semantics as main path
    referral_fee         NUMERIC(10,2),
    variable_closing_fee NUMERIC(10,2),  -- informational breakout; already contained in fba_fee
    fees_estimate_price  NUMERIC(10,2),  -- price fees were estimated at — required by getEstimatedProfit() referral scaling
    bsr                  INTEGER,
    sellers_fba          INTEGER,
    sellers_fbm          INTEGER,

    -- COGS: CSV column or manual inline edit ONLY (§21 — never 'po_sheet')
    estimated_cogs        NUMERIC(10,2),
    estimated_cogs_source VARCHAR(10)
        CHECK (estimated_cogs_source IN ('csv', 'manual')),

    -- Eligibility / flags
    eligibility_status TEXT,
    is_meltable        BOOLEAN NOT NULL DEFAULT FALSE,
    is_hazmat          BOOLEAN,  -- tri-state: NULL = inbound probe inconclusive
    is_dangerous_good  BOOLEAN,  -- tri-state; needed so getEstimatedProfit() applies the DG/hazmat surcharge identically to the main table

    error      TEXT,         -- analyze fetch error snapshot (dead/restricted/no-data ASINs render honestly)
    fetched_at TIMESTAMPTZ,  -- last analyze run for this row; list snapshot age = MAX(fetched_at)

    UNIQUE (list_id, asin)
);

CREATE INDEX idx_bulk_list_asins_list ON bulk_list_asins(list_id);

COMMIT;
