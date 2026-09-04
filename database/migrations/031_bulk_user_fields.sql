-- 031: Bulk Profit Calculator user-controlled fields (SPEC §21, 2026-09-04).
-- buy_link/supplier give the Supplier column its writer on the bulk path
-- (supplier derived via the same cleanBuyLink + extractDomain as the main
-- path). tags is TEXT[] free text — deliberately NOT a join table; bulk tags
-- never touch tags/asin_tags (§21 isolation). promo_notes is bulk-local.
-- All four (plus added_at backdating) are user-controlled (§14): CSV or
-- manual only; the bulk analyze sink never writes them.
ALTER TABLE bulk_list_asins ADD COLUMN buy_link TEXT;
ALTER TABLE bulk_list_asins ADD COLUMN supplier VARCHAR(255);
ALTER TABLE bulk_list_asins ADD COLUMN tags TEXT[];
ALTER TABLE bulk_list_asins ADD COLUMN promo_notes TEXT;
