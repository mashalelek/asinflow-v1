-- 075_po_capture_model.sql — Capture PO / AI prefill (docs/claude_spec-patch-po-ai-prefill.md
-- §8–§9, amended 2026-10-31; SPEC §22 "Capture PO data model").
--
-- Schema only. Every data backfill (payments from payment_method, refunds from
-- refund_amount / qty_returned, subscriptions from the subscription flag,
-- asins pack fields from the 2026 PO rows, sourcing / paid cost from the
-- sheet's col AR and col Y) runs from `npm run backfill:po-model` — dry run
-- by default, --live after the production dry run is reviewed. Nothing here
-- changes an existing value. Money columns stay dollars (no _cents twins —
-- Maria 2026-10-31); NULL = not recorded, never 0 on import.

-- §8.1 purchase_orders
ALTER TABLE purchase_orders
  ADD COLUMN purchased_by_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN cashback_status text CHECK (cashback_status IN ('pending', 'received', 'denied')),
  -- NULL = sheet-imported or created before the §7.1 rule: costs are never recomputed.
  -- 2 = the §7.1 allocation (2026-10-31): the PO editor may recompute from its lines, promos and payments.
  ADD COLUMN cost_formula_version smallint;
ALTER TABLE purchase_orders DROP CONSTRAINT purchase_orders_source_check;
ALTER TABLE purchase_orders ADD CONSTRAINT purchase_orders_source_check
  CHECK (source IN ('manual', 'sheet_import', 'extension', 'email_renewal'));

-- §8.5 po_asins: the three costs (cost_per_unit stays COGS = col Y) and the adjustment.
ALTER TABLE po_asins
  ADD COLUMN sourcing_cost numeric(10,2),          -- col AR: COGS before the gift-card discount, promos applied
  ADD COLUMN paid_cost numeric(10,2),              -- every discount counted (rewards too); = COGS for imported rows
  ADD COLUMN cogs_adjustment numeric(10,2),        -- added onto COGS (e.g. prep materials $3); NULL = none
  ADD COLUMN cogs_adjustment_reason text;

-- §6.4 / §6.5 (amendment 3): ASIN-level pack fields. NULL = not filled in
-- (Maria fills the gaps from docs/pack-size-gaps-2026-10-31.csv).
ALTER TABLE asins
  ADD COLUMN sold_as text CHECK (sold_as IN ('individual', 'multi-pack', 'bundle')),
  ADD COLUMN units_per_pack integer CHECK (units_per_pack >= 1);

-- History for ASIN-level fields (po_edit_log is PO-scoped): the pack override's
-- "Update ASIN in AF" writes one row per changed field.
CREATE TABLE asin_field_log (
  id          bigserial PRIMARY KEY,
  asin        varchar(10) NOT NULL,
  user_id     integer REFERENCES users(id) ON DELETE SET NULL,
  field       text NOT NULL,
  old_value   text,
  new_value   text,
  source      text NOT NULL CHECK (source IN ('manual', 'po_form', 'backfill')),
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX asin_field_log_asin_idx ON asin_field_log (asin, at DESC);

-- §8.2 po_payments: several per PO; Σ amount should equal the order total (a warning, never a constraint).
CREATE TABLE po_payments (
  id                      bigserial PRIMARY KEY,
  po_id                   uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  position                integer NOT NULL DEFAULT 0,
  method                  text NOT NULL CHECK (method IN ('card', 'gift_card', 'store_credit', 'paypal', 'other')),
  nickname                text,
  last4                   text CHECK (last4 ~ '^[0-9]{4}$'),
  amount                  numeric(12,2),       -- NULL = not recorded
  gift_card_discount_pct  numeric(6,2),        -- percent units (7.00 = 7 %), gift cards only
  raw_text                text,                -- the payment_method text this row was parsed from (backfill)
  needs_review            boolean NOT NULL DEFAULT false,
  created_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX po_payments_po_idx ON po_payments (po_id);

-- §8.4 po_promos: type NULL = awaiting Maria's classification (promo-classification-review CSV).
CREATE TABLE po_promos (
  id                  bigserial PRIMARY KEY,
  po_id               uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  position            integer NOT NULL DEFAULT 0,
  type                text CHECK (type IN ('sale', 'coupon', 'rewards')),
  description         text,
  amount              numeric(12,2),
  percent             numeric(6,2),
  counts_toward_cogs  boolean NOT NULL DEFAULT true,   -- §7.2: sale / coupon true, rewards false by default
  raw_text            text,                            -- the col AK text / the captured promo line, verbatim
  confidence          text CHECK (confidence IN ('high', 'low')),
  source              text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'capture', 'backfill')),
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX po_promos_po_idx ON po_promos (po_id);

-- §8.3 po_line_refunds: per supplier line; a PO-level placeholder has po_line_item_id NULL and needs_split.
CREATE TABLE po_line_refunds (
  id                bigserial PRIMARY KEY,
  po_id             uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  po_line_item_id   uuid REFERENCES po_line_items(id) ON DELETE SET NULL,
  qty               numeric(10,2),
  amount            numeric(12,2),
  refunded_at       date,
  method            text CHECK (method IN ('card', 'gift_card', 'store_credit', 'paypal', 'other')),
  nickname          text,
  last4             text CHECK (last4 ~ '^[0-9]{4}$'),
  source            text NOT NULL CHECK (source IN ('manual', 'email', 'sheet')),
  email_message_id  text,
  note              text,
  needs_split       boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX po_line_refunds_po_idx ON po_line_refunds (po_id);
CREATE INDEX po_line_refunds_line_idx ON po_line_refunds (po_line_item_id);

-- §5 po_prefill_log: one row per model call. Nothing from the page text is stored here.
CREATE TABLE po_prefill_log (
  id             bigserial PRIMARY KEY,
  created_at     timestamptz NOT NULL DEFAULT now(),
  user_id        integer REFERENCES users(id) ON DELETE SET NULL,
  kind           text NOT NULL CHECK (kind IN ('capture', 'backfill', 'promo_classify')),
  retailer       text,
  model          text NOT NULL,
  input_chars    integer,
  input_tokens   integer,
  output_tokens  integer,
  cost_estimate  numeric(10,5),
  duration_ms    integer,
  schema_ok      boolean,
  error          text,
  po_id          uuid REFERENCES purchase_orders(id) ON DELETE SET NULL
);

-- §9 subscriptions (SPEC §27).
CREATE TABLE subscriptions (
  id               bigserial PRIMARY KEY,
  supplier         text NOT NULL,
  po_asin_id       uuid REFERENCES po_asins(id) ON DELETE SET NULL,   -- the originating PO's ASIN row
  asin             varchar(10),
  product_name     text,
  frequency_weeks  integer CHECK (frequency_weeks > 0),
  next_order_date  date,
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'canceled')),
  last_po_id       uuid REFERENCES purchase_orders(id) ON DELETE SET NULL,
  created_from     text NOT NULL CHECK (created_from IN ('capture', 'manual', 'email', 'sheet')),
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX subscriptions_status_idx ON subscriptions (status, next_order_date);

-- New action items (§6.7 "Confirm order details", §9 "Subscription renews", "Review renewal PO").
ALTER TABLE po_line_action_items DROP CONSTRAINT po_line_action_items_item_check;
ALTER TABLE po_line_action_items ADD CONSTRAINT po_line_action_items_item_check CHECK (item IN (
  'Need to return', 'Missing / damaged from supplier', 'Confirm refund / replacement',
  'ATTN: Velocity', 'See comments', 'SHIP', 'Received - FBM', 'Review Velocity',
  'Confirm order details', 'Subscription renews', 'Review renewal PO'));
