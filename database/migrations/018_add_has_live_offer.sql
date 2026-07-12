-- 018: Live-offer truth for the catalog icon.
--
-- The Product-cell "in catalog" icon previously read asins.in_catalog, which is
-- a one-way discovery latch fed by tombstone-retaining sources (sales-sync sets
-- it TRUE on any order; inventory-sync sets it TRUE for every ASIN in
-- getInventorySummaries, which retains tombstones for deleted listings). Nothing
-- ever cleared it, so deleted listings kept the checkmark.
--
-- has_live_offer is the dedicated live-offer signal, sourced ONLY from the
-- Listings API (getListingsItem 404 = no offer), owned by the daily staleness
-- pass and the §19 verification 'live' transition. Tri-state:
--   NULL  = never checked (icon shows "+", same as no offer)
--   TRUE  = >=1 SKU has a live listing (Active OR Inactive both count)
--   FALSE = every SKU for the ASIN definitively 404s
-- offer_checked_at records when the pass last wrote a definitive verdict.
--
-- in_catalog is NOT dropped — it remains an internal discovery latch, but is no
-- longer read by the UI.
ALTER TABLE asins ADD COLUMN IF NOT EXISTS has_live_offer BOOLEAN;       -- NULL = never checked
ALTER TABLE asins ADD COLUMN IF NOT EXISTS offer_checked_at TIMESTAMPTZ;

-- is_listing_active: dead column (zero readers; only ever a DEFAULT TRUE column
-- def). Its DEFAULT TRUE would poison the has_live_offer tri-state if reused, so
-- it is dropped rather than repurposed.
ALTER TABLE asins DROP COLUMN IF EXISTS is_listing_active;
