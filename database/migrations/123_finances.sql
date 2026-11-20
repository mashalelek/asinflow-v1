-- Finances API patch commit 2 (docs/claude_spec-patch-finances-api.md §8,
-- 2026-11-20): Amazon's money records at their finest grain, the per-order
-- sales lines they attach to, and the per-day / per-ASIN / per-line aggregate
-- every Actual figure reads.

-- One row per Finances v2024-06-19 transaction AF has seen, RELEASED or
-- DEFERRED. A DEFERRED_RELEASED row (the copy Amazon leaves behind when it
-- releases a deferred transaction, same transactionId) is never stored: it
-- marks the stored DEFERRED row superseded instead, as does a RELEASED row
-- naming it in DEFERRED_TRANSACTION_ID. Nothing keys on transaction_id but
-- this table; the natural keys of §3 live on the lines.
CREATE TABLE finances_transactions (
  transaction_id          text PRIMARY KEY,
  transaction_type        text NOT NULL,                 -- Shipment | Refund | ServiceFee | FBAInventoryReimbursement | Transfer | …
  transaction_status      text NOT NULL CHECK (transaction_status IN ('RELEASED', 'DEFERRED')),
  posted_at               timestamptz NOT NULL,
  posted_day              date NOT NULL,                 -- America/Los_Angeles calendar day of posted_at
  description             text NULL,                     -- ServiceFee: the fee type; reimbursements: the reason
  total_amount            numeric(12,2) NOT NULL,
  order_id                text NULL,                     -- ORDER_ID: the customer order, or the FBA shipment / removal order a service fee names
  shipment_id             text NULL,                     -- SHIPMENT_ID (Shipment rows)
  refund_id               text NULL,                     -- REFUND_ID (Refund rows)
  settlement_id           text NULL,
  event_group_id          text NULL,
  deferred_transaction_id text NULL,                     -- on a RELEASED row: the DEFERRED row it releases
  superseded_at           timestamptz NULL,              -- a DEFERRED row whose release has been seen: out of every aggregate
  raw                     jsonb NOT NULL,
  ingested_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX finances_transactions_day_idx ON finances_transactions (posted_day, transaction_type);
CREATE INDEX finances_transactions_order_idx ON finances_transactions (order_id);
CREATE INDEX finances_transactions_settlement_idx ON finances_transactions (settlement_id);

-- One row per breakdown leaf of each item (or of the transaction, for fee
-- rows without items), classified into the SellerBoard line it belongs to
-- (shared/finances.ts LINE keys). Natural keys of §3: (order_id,
-- shipment_id, sku) for shipment fee rows, (order_id, refund_id, sku) for
-- refunds — the aggregate takes the RELEASED state over the DEFERRED one per
-- key, so nothing is ever counted twice.
CREATE TABLE finances_lines (
  id                  bigserial PRIMARY KEY,
  transaction_id      text NOT NULL REFERENCES finances_transactions (transaction_id) ON DELETE CASCADE,
  transaction_type    text NOT NULL,
  transaction_status  text NOT NULL,
  posted_at           timestamptz NOT NULL,
  posted_day          date NOT NULL,
  order_id            text NULL,
  shipment_id         text NULL,
  refund_id           text NULL,
  item_index          integer NOT NULL DEFAULT 0,
  sku                 text NULL,
  asin                text NULL,                         -- the item context's ASIN, else resolved from the SKU at ingest
  quantity            integer NULL,                      -- quantityShipped of the item context
  leaf_path           text NOT NULL,                     -- "AmazonFees > Commission > Base"; the fee type for ServiceFee rows; the reason for reimbursements
  line                text NOT NULL,                     -- shared/finances.ts line key
  amount              numeric(12,2) NOT NULL
);
CREATE INDEX finances_lines_day_line_idx ON finances_lines (posted_day, line);
CREATE INDEX finances_lines_order_sku_idx ON finances_lines (order_id, sku);
CREATE INDEX finances_lines_tx_idx ON finances_lines (transaction_id);

-- Per-order sales lines (§2 "Sales, Units, Orders"; commit 3 fills them from
-- the orders report, which carries the purchase day and the order status the
-- Finances rows lack). The Finances row for the same (order_id, sku), when
-- one exists, supplies Sales and the fees; the report price only when none
-- does. A Canceled status takes the line out of Sales / Units / Orders.
CREATE TABLE finances_order_lines (
  order_id            text NOT NULL,
  sku                 text NOT NULL,
  asin                text NULL,
  purchase_at         timestamptz NOT NULL,
  purchase_day        date NOT NULL,                     -- America/Los_Angeles calendar day
  order_status        text NOT NULL,                     -- Pending | Unshipped | Shipped | Canceled | … (orders report)
  units               integer NOT NULL,                  -- quantity ordered
  item_price          numeric(12,2) NULL,                -- report item-price (the line's gross principal)
  item_promo          numeric(12,2) NULL,                -- report item-promotion-discount (positive number, subtracted)
  fulfillment_channel text NULL,
  synced_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (order_id, sku)
);
CREATE INDEX finances_order_lines_day_idx ON finances_order_lines (purchase_day);
CREATE INDEX finances_order_lines_asin_idx ON finances_order_lines (asin, purchase_day);

-- The aggregate every range read sums (§8): one row per Pacific day × ASIN ×
-- line; asin = '' holds the account-only part of a line (Subscription, the
-- Orders count, the unallocated remainder of a split fee). Valuation lines
-- (COGS, Lost/damaged, Value of returned items, Disposal) carry the COGS part
-- in `amount` and the units that take the Settings prep in `prep_units` /
-- `prep_hazmat_units` (signed), so Prep follows the current Settings values
-- without a rebuild (§5). `est_amount` / `est_units` = the part of a fee line
-- that is a DEFERRED row's own figure or AF's estimate (§6 hover text).
CREATE TABLE finances_daily (
  day                 date NOT NULL,
  asin                text NOT NULL DEFAULT '',
  line                text NOT NULL,
  amount              numeric(14,4) NOT NULL DEFAULT 0,
  quantity            numeric(14,4) NOT NULL DEFAULT 0,
  est_amount          numeric(14,4) NOT NULL DEFAULT 0,
  est_units           numeric(14,4) NOT NULL DEFAULT 0,
  prep_units          numeric(14,4) NOT NULL DEFAULT 0,
  prep_hazmat_units   numeric(14,4) NOT NULL DEFAULT 0,
  PRIMARY KEY (day, asin, line)
);
CREATE INDEX finances_daily_asin_idx ON finances_daily (asin, day);

-- Ingest ledger: the posted windows read in full (fail-closed per window, §7).
CREATE TABLE finances_ingest_log (
  id            bigserial PRIMARY KEY,
  source        text NOT NULL,                           -- transactions | orders | returns | storage | removals
  window_from   timestamptz NOT NULL,
  window_to     timestamptz NOT NULL,
  rows_read     integer NOT NULL,
  rows_written  integer NOT NULL,
  calls         integer NOT NULL DEFAULT 0,
  finished_at   timestamptz NOT NULL DEFAULT now(),
  job_id        integer NULL
);
