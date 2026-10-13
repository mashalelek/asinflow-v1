-- §6 Lead Source (2026-10-13): where a lead came from, as a first-class
-- field rather than a tag.
--
-- Replaces the Spark Lead / OA Hunt / OAL 24/7 tags, which encoded the same
-- fact in a structure that cannot express "exactly one of these" — an ASIN
-- could carry two of them, or none, and nothing noticed. A CHECKed column
-- can.
--
-- NULL is meaningful and allowed: "we don't know". Phase c (SC import)
-- leaves it NULL deliberately — a listing discovered in Seller Central has
-- no lead source AF can honestly claim.
--
-- §14: USER-CONTROLLED. Never written by Analyze, Product Info or
-- Prices & Stock. Only INSERT paths (CSV upload, sourcing sync, bulk
-- promote) and the inline edit.
ALTER TABLE asins ADD COLUMN lead_source TEXT NULL
  CHECK (lead_source IN ('ER', 'Spark', 'OA Hunt', 'OAL 24/7', 'MP', 'RA'));

-- §21 Bulk Calc carries it through the export -> upload -> promote round
-- trip, so the bulk row needs the same column and the same CHECK.
ALTER TABLE bulk_list_asins ADD COLUMN lead_source TEXT NULL
  CHECK (lead_source IN ('ER', 'Spark', 'OA Hunt', 'OAL 24/7', 'MP', 'RA'));

CREATE INDEX IF NOT EXISTS asins_lead_source_idx ON asins (lead_source);
