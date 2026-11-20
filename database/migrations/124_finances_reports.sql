-- Finances API patch commit 4 (SPEC §2 "Value of returned items", "Disposal
-- of sellable products", §4 per-ASIN storage; §8 "Report rows are stored as
-- received"): the three reports behind the lines Finances does not carry.
-- Also §8: the never-read actual_* fee columns on sales_daily go; the
-- aggregate (finances_daily) is the fee store.

-- GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA, one row per returned unit line.
CREATE TABLE fba_customer_returns (
  return_at       timestamptz NOT NULL,
  return_day      date NOT NULL,                      -- America/Los_Angeles day of return_at
  order_id        text NOT NULL,
  sku             text NOT NULL,
  asin            text NULL,
  fnsku           text NULL,
  quantity        integer NOT NULL,
  fc              text NULL,
  disposition     text NOT NULL,                      -- SELLABLE | CUSTOMER_DAMAGED | DEFECTIVE | …
  reason          text NULL,
  status          text NULL,
  lpn             text NOT NULL DEFAULT '',           -- license-plate-number (empty on a few rows)
  raw             jsonb NOT NULL,
  synced_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (return_at, order_id, sku, lpn)
);
CREATE INDEX fba_customer_returns_day_idx ON fba_customer_returns (return_day, asin);

-- GET_FBA_STORAGE_FEE_CHARGES_DATA, one row per fnsku × fulfillment center for the month.
CREATE TABLE fba_storage_fees (
  id              bigserial PRIMARY KEY,
  month           text NOT NULL,                      -- month_of_charge, YYYY-MM
  asin            text NULL,
  fnsku           text NULL,
  fc              text NULL,
  fee             numeric(12,4) NOT NULL,             -- estimated_monthly_storage_fee
  avg_qty         numeric(12,4) NULL,                 -- average_quantity_on_hand
  raw             jsonb NOT NULL,
  synced_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fba_storage_fees_month_idx ON fba_storage_fees (month, asin);

-- GET_FBA_FULFILLMENT_REMOVAL_ORDER_DETAIL_DATA, one row per removal order × SKU × disposition.
CREATE TABLE fba_removals (
  order_id        text NOT NULL,
  sku             text NOT NULL,
  disposition     text NOT NULL DEFAULT '',
  asin            text NULL,
  fnsku           text NULL,
  request_at      timestamptz NOT NULL,
  updated_at      timestamptz NULL,
  completed_day   date NULL,                          -- America/Los_Angeles day of last-updated-date
  order_type      text NOT NULL,                      -- Return | Disposal | Liquidations | …
  order_status    text NOT NULL,
  requested_qty   integer NOT NULL DEFAULT 0,
  cancelled_qty   integer NOT NULL DEFAULT 0,
  disposed_qty    integer NOT NULL DEFAULT 0,
  shipped_qty     integer NOT NULL DEFAULT 0,
  in_process_qty  integer NOT NULL DEFAULT 0,
  removal_fee     numeric(12,2) NULL,
  raw             jsonb NOT NULL,
  synced_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (order_id, sku, disposition)
);
CREATE INDEX fba_removals_completed_idx ON fba_removals (completed_day);

ALTER TABLE sales_daily DROP COLUMN IF EXISTS actual_fba_fees;
ALTER TABLE sales_daily DROP COLUMN IF EXISTS actual_referral_fees;
ALTER TABLE sales_daily DROP COLUMN IF EXISTS actual_other_fees;
