-- Authoritative (brand_code, NNN) → TTL product registry.
--
-- Product identity within a brand is the (brand_code, nnn) pair. TTL is a
-- function of that pair — a property of the product, not the listing.
--
-- Key design decision (Maria 2026-06-28): UNIQUE (brand_code, nnn). NOT
-- (brand, dept, nnn). NNN is unique per BRAND. Consequence — the same
-- product (same NNN/TTL) can carry DIFFERENT dept codes across its ASINs,
-- because dept reflects where each individual listing sits in Amazon's
-- catalog, and Amazon can categorize the same product differently per ASIN.
--
-- Example of a valid same-product-two-depts:
--   AMG-BPC-37C-RRC-001  (ASIN A — Amazon: Beauty & Personal Care)
--   AMG-KIT-9X2-RRC-001  (ASIN B — Amazon: Kitchen & Dining)
--   Same product (AMG, 001, RRC). Different DEP segments because Amazon
--   categorized each ASIN differently. Both valid; registry row is unchanged.
--
-- Implications enforced by schema:
--   - UNIQUE constraint is on (brand_code, nnn) only — dept_code is
--     informational and NOT part of the key.
--   - dept_code is recorded once (the dept of the first ASIN that registered
--     this product) for human inspection. NOT validated on reuse — operators
--     can submit a SKU with a different dept against an existing NNN/TTL.
--   - SKU assembly at submit time uses the PER-ASIN dept (from that ASIN's
--     catalog data), NOT the registry's stored dept. The registry never
--     dictates the DEP segment of a new SKU.
--
-- Write path: live submit endpoint, AFTER successful putListingsItem.
-- UPSERT-style: ON CONFLICT (brand_code, nnn) DO NOTHING — if the row
-- already exists, the submitted listing is reusing an existing product;
-- no row mutation. The pre-PUT validation step (registry-aware override
-- check in offerAddForAsin) is responsible for ensuring submitted TTL
-- matches existing registry TTL, so a successful PUT against an existing
-- NNN already has the correct TTL.
--
-- Read path: preview endpoint, one SELECT per Ready row's brand bucket —
-- returns the full (nnn, ttl, product_name) list so the client can do
-- "operator typed an NNN → look up TTL" lookups without a round-trip.

CREATE TABLE brand_product_registry (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    brand_code      VARCHAR(3) NOT NULL CHECK (brand_code ~ '^[A-Z]{3}$'),
    nnn             SMALLINT   NOT NULL CHECK (nnn BETWEEN 1 AND 999),
    ttl             VARCHAR(3) NOT NULL CHECK (ttl ~ '^[A-Z]{3}$'),
    -- Informational only. Dept of the FIRST ASIN that registered this product.
    -- Not part of the key. Not validated on reuse — same product can appear
    -- under different Amazon depts across ASINs (each listing's DEP segment
    -- comes from THAT ASIN's catalog data, not from this column).
    dept_code       VARCHAR(3) NOT NULL CHECK (dept_code ~ '^[A-Z]{3}$'),
    product_name    TEXT,                    -- first ASIN's title at registration; for human inspection
    first_asin      VARCHAR(10),             -- ASIN that registered this product
    registered_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    registered_by   UUID REFERENCES users(id), -- nullable for system writes
    UNIQUE (brand_code, nnn)
);

COMMENT ON TABLE brand_product_registry IS
  'Product identity within a brand: (brand_code, nnn) → ttl. UNIQUE key is (brand_code, nnn). dept_code is informational only, NOT part of the key and NOT validated on reuse — the same product can appear under different Amazon depts across ASINs because each listing carries its own dept from Amazon catalog data.';

COMMENT ON COLUMN brand_product_registry.dept_code IS
  'Informational: dept of the FIRST ASIN that registered this product. Not part of the unique key. Not validated on reuse — operators can submit the same NNN/TTL against a new ASIN with a different dept (Amazon categorizes the same product differently across ASINs).';

-- Bootstrap: empty table. 0 conforming SKUs exist in asin_skus today, so no
-- backfill is needed. The submit endpoint populates rows as offers are added.
