-- Migration 027: sourcing_cost_exports — the export history for the Amazon
-- Manage Your Sourcing Cost bulk upload.
--
-- There is no API for sourcing cost, so the upload is a manual step in Seller
-- Central. Nothing on the Amazon side tells us which windows we've already
-- covered, and a re-submitted cost spends a bulk-upload attempt. This table is
-- the only record of what went out: one row per generated file, written at
-- generation time (not at upload time — we cannot observe the upload).
--
-- range_start/range_end are the purchase window the file covered, which is also
-- encoded in the filename, so the history reads as a coverage log on its own.

CREATE TABLE IF NOT EXISTS sourcing_cost_exports (
    id              SERIAL PRIMARY KEY,
    filename        TEXT        NOT NULL,
    range_start     DATE        NOT NULL,
    range_end       DATE        NOT NULL,
    purchased_asins INTEGER     NOT NULL DEFAULT 0,  -- distinct ASINs bought in the window
    asins_written   INTEGER     NOT NULL DEFAULT 0,  -- ASINs that got a cost written
    rows_written    INTEGER     NOT NULL DEFAULT 0,  -- ASIN+FNSKU cells written (fan-out)
    created_at      TIMESTAMP   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sourcing_cost_exports_created
    ON sourcing_cost_exports (created_at DESC);
