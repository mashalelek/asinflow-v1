-- §21 price-source toggle on Bulk Calc (2026-09-09): store the parsed
-- offer prices verbatim so getSelectedPrice picks + falls back exactly as
-- on the main page. sale_price becomes STRICTLY the lowest-FBA price;
-- buy-box and overall-lowest get their own columns. price_source is
-- DROPPED — redundant once all three are stored (the fallback label
-- derives from which fields are present). Legacy rows: values move to the
-- column their recorded source names; buy_box stays NULL elsewhere until
-- the next Refresh.
BEGIN;
ALTER TABLE bulk_list_asins ADD COLUMN sale_price_buy_box NUMERIC(10,2) NULL;
ALTER TABLE bulk_list_asins ADD COLUMN sale_price_lowest NUMERIC(10,2) NULL;
UPDATE bulk_list_asins SET sale_price_buy_box = sale_price, sale_price = NULL
 WHERE price_source = 'buy_box';
UPDATE bulk_list_asins SET sale_price_lowest = sale_price, sale_price = NULL
 WHERE price_source = 'lowest';
ALTER TABLE bulk_list_asins DROP COLUMN price_source;
COMMIT;
