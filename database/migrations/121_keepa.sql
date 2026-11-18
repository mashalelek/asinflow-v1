-- 121_keepa.sql — Keepa trend columns, commit 2 (docs/claude_spec-patch-keepa-trends.md "Data model";
-- spike docs/keepa-spike-2026-11-18.md). Keepa's history per ASIN and series as one integer per
-- America/New_York day, keyed by ASIN text with no FK (public data, like asin_estimates); the fetch
-- record per ASIN; and a second job kind, 'keepa', for lane K (component 33, Keepa jobs only).
--
-- Written by component 33 only (SPEC §14 ownership). Every pull carries the full history, so a series
-- row is REPLACED on each fetch; a successful response that lacks a series AF already holds leaves the
-- stored row alone (outcome series_missing:<name>).

CREATE TABLE keepa_series (
  asin       TEXT      NOT NULL,
  series     TEXT      NOT NULL CHECK (series IN
             ('buy_box','new_price','sales_rank','monthly_sold',
              'offers_new','offers_new_fba','rating_count')),
  first_day  DATE      NOT NULL,   -- America/New_York day of vals[1]
  vals       INTEGER[] NOT NULL,   -- one element per day; NULL = no value (Keepa -1). Prices in cents; buy_box = price + shipping.
  PRIMARY KEY (asin, series)
);

CREATE TABLE keepa_fetch (
  asin              TEXT PRIMARY KEY,
  fetched_at        TIMESTAMPTZ NOT NULL,
  keepa_last_update TIMESTAMPTZ,   -- product.lastUpdate
  tokens            INTEGER,       -- the batch's tokensConsumed ÷ its ASIN count
  status            TEXT NOT NULL CHECK (status IN ('fetched','not_found','error')),
  error             TEXT
);
CREATE INDEX keepa_fetch_fetched_at_idx ON keepa_fetch (fetched_at);

-- jobs.kind gains 'keepa' (lane K: trigger 'scheduled' = the daily job, 'onboarding' = a new-ASIN job).
ALTER TABLE jobs DROP CONSTRAINT jobs_kind_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_kind_check CHECK (kind IN ('refresh', 'keepa'));
