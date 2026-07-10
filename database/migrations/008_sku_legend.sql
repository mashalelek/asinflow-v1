-- Authoritative brand/dept/sub → 3-char code map.
-- Resurrection must use approved codes; proposed entries surface for review
-- before SKU commit. Derivation is a fallback proposer, never silently overrides.
--
-- Single table with `type` discriminator: small expected size (200-300 rows
-- lifetime), simpler than three parallel tables.

CREATE TABLE sku_legend (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    type            VARCHAR(10) NOT NULL CHECK (type IN ('brand', 'dept', 'sub')),
    raw_value       TEXT NOT NULL,           -- Amazon's string, case preserved
    code            CHAR(3) NOT NULL,
    status          VARCHAR(10) NOT NULL CHECK (status IN ('approved', 'proposed')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    approved_at     TIMESTAMPTZ,
    note            TEXT
);

-- Case/whitespace-insensitive uniqueness within a type, so "BAMBULAB" /
-- "Bambu Lab" / "bambu lab" all fold to one row.
CREATE UNIQUE INDEX uq_sku_legend_type_raw
  ON sku_legend (type, LOWER(REGEXP_REPLACE(raw_value, '\s+', ' ', 'g')));

-- A code is unique within its type — no two brands share "AMG".
-- (Cross-type is fine: a brand "AMG" + a dept "AMG" would not collide here.)
CREATE UNIQUE INDEX uq_sku_legend_type_code ON sku_legend (type, code);

CREATE INDEX idx_sku_legend_type ON sku_legend (type);

COMMENT ON TABLE sku_legend IS
  'Authoritative brand/dept/sub → 3-char code map. status=approved is user-blessed; proposed=algorithmic suggestion awaiting approval. Resurrection must use approved codes; proposed ones surface for review before SKU commit.';

-- ============================================================================
-- SEED
-- ============================================================================

-- 1 brand (the only legacy brand with approved code; new brands accrue on
-- offer-add approval, never auto-seeded).
INSERT INTO sku_legend (type, raw_value, code, status, approved_at, note) VALUES
  ('brand', 'AminoGenesis', 'AMG', 'approved', NOW(), 'Legacy brand; 15 existing SKUs use this code');

-- 23 dept codes: every distinct top-level category currently in `asins`.
-- BPC and SPC are the two non-algorithmic overrides:
--   BPC for Beauty & Personal Care — matches legacy AMG `-BP-` segment.
--   SPC for Sports Collectibles — resolves the SPO collision with Sports & Outdoors.
INSERT INTO sku_legend (type, raw_value, code, status, approved_at, note) VALUES
  ('dept', 'Grocery & Gourmet Food',     'GRO', 'approved', NOW(), NULL),
  ('dept', 'Industrial & Scientific',    'IND', 'approved', NOW(), NULL),
  ('dept', 'Health & Household',         'HEA', 'approved', NOW(), NULL),
  ('dept', 'Beauty & Personal Care',     'BPC', 'approved', NOW(), 'Override: matches legacy AMG -BP- segment'),
  ('dept', 'Home & Kitchen',             'HOM', 'approved', NOW(), NULL),
  ('dept', 'Arts, Crafts & Sewing',      'ART', 'approved', NOW(), NULL),
  ('dept', 'Kitchen & Dining',           'KIT', 'approved', NOW(), NULL),
  ('dept', 'Tools & Home Improvement',   'TOO', 'approved', NOW(), NULL),
  ('dept', 'Pet Supplies',               'PET', 'approved', NOW(), NULL),
  ('dept', 'Sports & Outdoors',          'SPO', 'approved', NOW(), NULL),
  ('dept', 'Clothing, Shoes & Jewelry',  'CLO', 'approved', NOW(), NULL),
  ('dept', 'Automotive',                 'AUT', 'approved', NOW(), NULL),
  ('dept', 'Toys & Games',               'TOY', 'approved', NOW(), NULL),
  ('dept', 'Patio, Lawn & Garden',       'PAT', 'approved', NOW(), NULL),
  ('dept', 'Office Products',            'OFF', 'approved', NOW(), NULL),
  ('dept', 'Electronics',                'ELE', 'approved', NOW(), NULL),
  ('dept', 'Baby',                       'BAB', 'approved', NOW(), NULL),
  ('dept', 'Video Games',                'VID', 'approved', NOW(), NULL),
  ('dept', 'Musical Instruments',        'MUS', 'approved', NOW(), NULL),
  ('dept', 'Sports Collectibles',        'SPC', 'approved', NOW(), 'Override: resolves SPO collision vs Sports & Outdoors'),
  ('dept', 'Books',                      'BOO', 'approved', NOW(), NULL),
  ('dept', 'Movies & TV',                'MOV', 'approved', NOW(), NULL),
  ('dept', 'Cell Phones & Accessories',  'CEL', 'approved', NOW(), NULL);

-- No SUB seeds — sub_category source / strategy is being decided post-scan.
-- No additional brand seeds — accrue on offer-add approval per spec.
