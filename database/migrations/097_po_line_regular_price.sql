-- 097_po_line_regular_price.sql — free-item promos (Maria 2026-11-06,
-- yankeecandle.com HFUS09823034326: "Buy 2, Get 2 Free" put 10 candles at
-- $0.00 beside 10 at $34.99). regular_price = the line's unit price before
-- an item-level multi-buy deal (BOGO, B2G2, "free"). When any line of a PO
-- carries one, the order's cost is allocated over the lines by regular
-- price × qty (a line without one weighs its own money), so free units share
-- the cost: $297.41 ÷ 20 = $14.87 a candle before the GC %. NULL = no deal;
-- allocation by line totals as before (SPEC §22 "Costs").
ALTER TABLE po_line_items ADD COLUMN regular_price numeric(14,6);
