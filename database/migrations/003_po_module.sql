-- Migration 003: Purchase Orders module — schema foundation
--
-- Creates the 5 tables that back the PO module (gift_cards, purchase_orders,
-- po_line_items, po_asins, po_gift_cards) plus the prep_cost_per_unit column
-- on asins. Ordering respects FK dependencies: gift_cards before po_gift_cards,
-- purchase_orders before its children.
--
-- Atomic: wrapped in a transaction. Postgres DDL is transactional, so a failure
-- in any statement rolls back all schema changes.
--
-- DG/hazmat fields are NOT included on PO tables. PO module uses the existing
-- asins.is_hazmat_override (manual checkbox) — the auto-detection signal was
-- proven unreliable in the COMMINGLING investigation (see SPEC.md hazmat note).

BEGIN;

-- ─── asins augmentation ───────────────────────────────────────────────────────
ALTER TABLE asins
  ADD COLUMN IF NOT EXISTS prep_cost_per_unit DECIMAL(10,2) DEFAULT 1.00;

COMMENT ON COLUMN asins.prep_cost_per_unit IS
  'Per-unit prep cost (default $1.00). Added to ASIN-level COGS in PO calculations; NOT included in sourcing cost.';

-- ─── gift_cards (no FK deps) ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS gift_cards (
    id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    card_number          VARCHAR(50) NOT NULL,
    purchase_date        DATE NOT NULL,
    face_value           DECIMAL(10,2) NOT NULL,
    amount_paid          DECIMAL(10,2) NOT NULL,
    discount_percentage  DECIMAL(5,2)
                         GENERATED ALWAYS AS ((face_value - amount_paid) / face_value * 100) STORED,
    current_balance      DECIMAL(10,2) NOT NULL,
    purchase_source      VARCHAR(255),
    status               VARCHAR(50) DEFAULT 'Active'
                         CHECK (status IN ('Active', 'Depleted', 'Expired')),
    notes                TEXT,
    created_at           TIMESTAMPTZ DEFAULT NOW(),
    updated_at           TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_gift_cards_status ON gift_cards(status);

-- ─── purchase_orders (no FK deps) ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS purchase_orders (
    id                            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_id                      VARCHAR(255) UNIQUE NOT NULL,
    order_date                    DATE NOT NULL,
    supplier                      VARCHAR(255) NOT NULL,
    order_subtotal                DECIMAL(10,2) NOT NULL,
    shipping_cost                 DECIMAL(10,2) DEFAULT 0,
    tax                           DECIMAL(10,2) DEFAULT 0,
    order_discount                DECIMAL(10,2) DEFAULT 0,
    order_discount_type           VARCHAR(20)
                                  CHECK (order_discount_type IN ('percentage', 'dollar')),
    discount_description          TEXT,
    order_total                   DECIMAL(10,2) NOT NULL,
    refund                        DECIMAL(10,2) DEFAULT 0,
    refund_manual_override        BOOLEAN DEFAULT FALSE,
    cashback_website              VARCHAR(50)
                                  CHECK (cashback_website IN ('BeFrugal', 'TopCashback', 'Rakuten', 'None')),
    cashback_percentage           DECIMAL(5,2) DEFAULT 0,
    tracking_number               VARCHAR(255),
    payment_method                VARCHAR(100),
    purchased_by                  VARCHAR(255),
    is_subscription               BOOLEAN DEFAULT FALSE,
    subscription_frequency        VARCHAR(50),
    subscription_next_order_date  DATE,
    general_notes                 TEXT,
    internal_email                VARCHAR(255),
    invoice_file_path             VARCHAR(500),
    status                        VARCHAR(50) DEFAULT 'Ordered'
                                  CHECK (status IN ('Ordered', 'Received in Full', 'Received Partial', 'Canceled', 'Closed')),
    created_at                    TIMESTAMPTZ DEFAULT NOW(),
    updated_at                    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_po_order_date ON purchase_orders(order_date);
CREATE INDEX IF NOT EXISTS idx_po_supplier   ON purchase_orders(supplier);
CREATE INDEX IF NOT EXISTS idx_po_status     ON purchase_orders(status);

-- ─── po_line_items (FK → purchase_orders) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS po_line_items (
    id                                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_id                          UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
    sku                               VARCHAR(100),
    product_name                      VARCHAR(500) NOT NULL,
    product_price                     DECIMAL(10,2) NOT NULL,
    product_discount                  DECIMAL(10,2) DEFAULT 0,
    product_discount_type             VARCHAR(20)
                                      CHECK (product_discount_type IN ('percentage', 'dollar')),
    qty_ordered                       INTEGER NOT NULL,
    qty_received                      INTEGER DEFAULT 0,
    qty_canceled                      INTEGER DEFAULT 0,
    qty_returned_refunded             INTEGER DEFAULT 0,
    unreimbursed_lost_damaged_qty     INTEGER DEFAULT 0,
    unreimbursed_lost_damaged_amount  DECIMAL(10,2) DEFAULT 0,
    adjusted_qty_ordered              INTEGER
                                      GENERATED ALWAYS AS (qty_ordered - qty_canceled - qty_returned_refunded) STORED,
    expiration_date                   DATE,
    tax_exempt                        BOOLEAN DEFAULT FALSE,
    unique_products_per_asin          INTEGER DEFAULT 1,
    asin_qty_per_product              DECIMAL(10,3) NOT NULL,
    tags                              TEXT[],
    notes                             TEXT,
    refund_amount                     DECIMAL(10,2) DEFAULT 0,
    status                            VARCHAR(50) DEFAULT 'Ordered'
                                      CHECK (status IN ('Ordered', 'Received in Full', 'Received Partial', 'Canceled', 'Returned', 'Shipped FBA', 'FBM')),
    created_at                        TIMESTAMPTZ DEFAULT NOW(),
    updated_at                        TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_po_line_items_order  ON po_line_items(order_id);
CREATE INDEX IF NOT EXISTS idx_po_line_items_status ON po_line_items(status);

-- ─── po_asins (FK → purchase_orders, po_line_items, asins) ────────────────────
CREATE TABLE IF NOT EXISTS po_asins (
    id                            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_id                      UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
    po_line_item_id               UUID NOT NULL REFERENCES po_line_items(id) ON DELETE CASCADE,
    asin                          VARCHAR(10) NOT NULL REFERENCES asins(asin) ON DELETE CASCADE,
    qty_received                  DECIMAL(10,3) NOT NULL,
    adjusted_product_cost         DECIMAL(10,4) NOT NULL,
    cogs_per_asin_unit            DECIMAL(10,4) NOT NULL,
    sourcing_cost_per_asin_unit   DECIMAL(10,4) NOT NULL,
    receipt_date                  DATE,
    created_at                    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_po_asins_order     ON po_asins(order_id);
CREATE INDEX IF NOT EXISTS idx_po_asins_asin      ON po_asins(asin);
CREATE INDEX IF NOT EXISTS idx_po_asins_line_item ON po_asins(po_line_item_id);

-- ─── po_gift_cards (FK → purchase_orders, gift_cards) ─────────────────────────
CREATE TABLE IF NOT EXISTS po_gift_cards (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_id      UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
    gift_card_id  UUID NOT NULL REFERENCES gift_cards(id) ON DELETE CASCADE,
    amount_used   DECIMAL(10,2) NOT NULL,
    created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_po_gift_cards_order ON po_gift_cards(order_id);
CREATE INDEX IF NOT EXISTS idx_po_gift_cards_card  ON po_gift_cards(gift_card_id);

COMMIT;
