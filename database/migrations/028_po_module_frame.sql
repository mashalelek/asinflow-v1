-- Migration 028: PO module v1 frame — schema + seeded lookup lists.
-- Per docs/po-module-v1-frame-plan.md §1 (SQL verbatim from the plan).
--
-- Purely additive: nothing existing reads or writes these tables until the
-- deliberate cutover layer. The Google Sheet remains source of truth for the
-- PO sync, Velocity export, SB COGS export, and sourcing-cost export.
-- (The old PO scaffold with these table names was dropped wholesale in
-- migration 021; these are fresh definitions, not a revival.)

BEGIN;

CREATE TABLE purchase_orders (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_id        TEXT NOT NULL,            -- supplier's real order number
    order_date      DATE NOT NULL,
    supplier        TEXT NOT NULL,            -- bare domain
    status          TEXT NOT NULL DEFAULT 'Ordered',  -- comma-joined tokens, sheet vocabulary

    -- money (order level)
    subtotal        NUMERIC(12,2) DEFAULT 0,
    tax             NUMERIC(12,2) DEFAULT 0,
    sh_donations    NUMERIC(12,2) DEFAULT 0,  -- S&H + Donations
    discount        NUMERIC(12,2) DEFAULT 0,  -- order-level discount
    refund_amount   NUMERIC(12,2) DEFAULT 0,
    order_total     NUMERIC(12,2) DEFAULT 0,

    -- payment
    payment_method  TEXT,
    weighted_gc_discount_pct NUMERIC(6,2),    -- plain number; no GC ledger in v1
    promo           TEXT,
    cashback_site   TEXT,
    cashback_pct    NUMERIC(6,2),

    -- meta
    purchased_by    TEXT,                     -- entry default 'Maria' (UI concern)
    subscription    BOOLEAN DEFAULT FALSE,    -- plain flag, alerts deferred
    email_used      TEXT,                     -- entry default mpeters.cqg@gmail.com (UI concern)
    invoice_attached BOOLEAN DEFAULT FALSE,   -- replaces Rcpt; file storage is a later layer
    notes           TEXT,                     -- PO-level notes

    source          TEXT NOT NULL DEFAULT 'manual'
                    CHECK (source IN ('manual','sheet_import')),
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE (supplier, order_id)               -- order IDs collide across suppliers (§10)
);

CREATE TABLE po_asins (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    po_id           UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
    asin            VARCHAR(10) NOT NULL,
    asin_name       TEXT,                     -- snapshot at entry/import
    sku             VARCHAR(50),              -- our AMAZON SKU (primary_sku at entry); NULL → amber warning. UI label: "Amazon SKU"
    qty             INTEGER NOT NULL DEFAULT 0,       -- sheet Col N (per-ASIN total)
    cost_per_unit   NUMERIC(10,2),            -- adjusted COGS snapshot (sheet Col Y)
    prep_cost       NUMERIC(10,2) DEFAULT 0,  -- per unit; blank-on-real-row = 0 (§3)
    sold_as         TEXT DEFAULT 'individual'
                    CHECK (sold_as IN ('individual','multi-pack','bundle')),
    units_per_pack  INTEGER DEFAULT 1,        -- forced 1 when sold_as = individual
    unreimbursed_loss_qty    INTEGER DEFAULT 0,
    unreimbursed_loss_amount NUMERIC(10,2) DEFAULT 0,
    notes           TEXT,
    UNIQUE (po_id, asin)
);

CREATE TABLE po_line_items (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    po_id           UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
    po_asin_id      UUID REFERENCES po_asins(id) ON DELETE SET NULL,
    position        INTEGER,                  -- stable display order within the PO
    product_name    TEXT,
    supplier_sku    TEXT,                     -- sheet SKU/UPC (Col F), often blank. UI label: "Supplier SKU / UPC"
    price           NUMERIC(10,2),
    item_discount   NUMERIC(10,2) DEFAULT 0,  -- NEW per-item discount ($); % helper in form later
    qty_ordered     INTEGER,
    qty_received    INTEGER,                  -- NULL = not yet tracked (blank in sheet)
    qty_refunded    INTEGER DEFAULT 0,
    asin_qty_per_product NUMERIC(8,2) DEFAULT 1,  -- yield: 5-pack → 5
    adjusted_product_cost NUMERIC(10,2),      -- snapshot (sheet Col X)
    notes           TEXT
);

CREATE INDEX idx_po_date ON purchase_orders(order_date DESC);
CREATE INDEX idx_po_supplier ON purchase_orders(supplier);
CREATE INDEX idx_po_asins_po ON po_asins(po_id);
CREATE INDEX idx_po_asins_asin ON po_asins(asin);   -- powers the future POs-by-ASIN view
CREATE INDEX idx_po_lines_po ON po_line_items(po_id);

-- Lookup lists in the existing settings table (JSONB).
-- list order is meaningful: element 0 is the default (entry form must
-- preserve order). ON CONFLICT DO NOTHING: re-running the migration never
-- clobbers lists once the entry form manages them (layer 1).
INSERT INTO settings (key, value) VALUES
  ('po_payment_methods',
   '["Gift cards","Amex (1001)","Amex (1005)","Chase (7927)","Chase (9647)","Chase Ink (7927)","Chase (6120)","Citi (9510)","Discover","Webstaurant Visa"]'::jsonb),
  ('po_cashback_sites',
   '["BeFrugal","TopCashback","Rakuten","RetailMeNot","Coupert"]'::jsonb),
  ('po_emails',
   '["mpeters.cqg@gmail.com","orders@coastalqualitygoods.com"]'::jsonb),
  ('po_purchasers',
   '["Maria"]'::jsonb)
ON CONFLICT (key) DO NOTHING;

COMMIT;
