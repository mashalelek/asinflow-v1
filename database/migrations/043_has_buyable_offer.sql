-- §23 Repricer Phase 1b (2026-09-15): "SC-Active" = a listing carrying a
-- BUYABLE offer. has_live_offer can't answer this — by design it means "a
-- listing record EXISTS at SC" and so also counts Inactive/DISCOVERABLE-only
-- listings (§18 one definition). Tri-state: NULL = never checked, never
-- conflated with FALSE. Written ONLY by the definitive getListingsItem probes
-- that already own has_live_offer, in the same statement.
ALTER TABLE asins ADD COLUMN has_buyable_offer BOOLEAN NULL;
ALTER TABLE asins ADD COLUMN buyable_checked_at TIMESTAMPTZ NULL;
