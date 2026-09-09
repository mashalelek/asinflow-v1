-- 2026-09-09 "⚠ Error with populated prices" incident: two generations of
-- synthesized pipeline strings were persisted into asin_estimates.error and
-- never cleared by later conclusive price writes (writePrice now clears
-- error on every conclusive outcome; buildResult no longer synthesizes
-- price-absence errors). Clear the stale rows — genuine errors (none of
-- these two families) are untouched.
UPDATE asin_estimates SET error = NULL
 WHERE error LIKE 'Price unavailable - product found%'
    OR error LIKE 'No data after 2 retries%';
