-- 096_po_promo_in_line_prices.sql — "Which promos are already in the prices?"
-- (Maria 2026-11-06, SPEC §22 "Costs" per promo). NULL = AF decides from the
-- amounts (reflectedPromos: the one subset of promos that closes subtotal −
-- Σ line totals). true / false = Maria's answer, which wins: true = the
-- promo is already in the line prices (reduces no cost), false = it is not
-- (subtracted as usual). Asked only when more than one subset fits; until
-- then the ambiguous promos are not subtracted (COGS errs high) and Create
-- PO / Save is blocked.
ALTER TABLE po_promos ADD COLUMN in_line_prices boolean;
