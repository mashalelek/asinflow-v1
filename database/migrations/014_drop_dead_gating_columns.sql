-- Drop vestigial is_gated + gating_reason columns from `asins`.
--
-- These were the never-populated half of an unfinished migration. The
-- canonical gating signal is asin_estimates.eligibility_status (written by
-- the analyze path via getEligibility — see server/spapi.ts:getEligibility).
--
-- Grep across server/, client/src/, shared/, script/ confirmed zero reads
-- or writes outside schema files. Safe to drop.

ALTER TABLE asins DROP COLUMN is_gated;
ALTER TABLE asins DROP COLUMN gating_reason;
