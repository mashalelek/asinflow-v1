-- 100_bundle_units_per_bundle.sql — the bundle rule (Maria 2026-11-09, walmart 200015415094735 B0GWG5S64Q).
--
-- A bundle's "×N" (po_asins.units_per_pack, sold_as = 'bundle') is the TOTAL Individual units
-- in one bundle, the same meaning a multi-pack's ×N has. Each component line carries the units
-- of ITS product in one bundle; the components' counts sum to N. NULL = not known: AF proposes
-- an even split (N ÷ components when whole) in amber for Maria to confirm — a "(6 pack)" in a
-- title never sets it. Bundle ASIN units = min over components (line Individual units ÷ count);
-- leftovers are shown; Cost/Unit = Σ per-Individual cost × count + the PO's share (shared/bundle.ts,
-- shared/po-cost.ts bundleAsinCosts).
--
-- Before this, a bundle component's retailer_units_per_product (migration 080) was written by the
-- yield backfill as real pack × N (yield = retailer ÷ N = 1 for a single), so Ordered came out right
-- only when every component was a single and N = the component count. Those lines are converted
-- (÷ N) by script/fix-bundle-lines.ts --convert-packs after a dry run; nothing is converted here.
ALTER TABLE po_line_items ADD COLUMN IF NOT EXISTS units_per_bundle integer CHECK (units_per_bundle IS NULL OR units_per_bundle >= 1);
COMMENT ON COLUMN po_line_items.units_per_bundle IS 'Bundle component: units of this product in one bundle (Individual units). NULL = not known — an even split is proposed, never stored, until confirmed. Σ over the bundle''s lines = po_asins.units_per_pack. Migration 100.';
COMMENT ON COLUMN po_asins.units_per_pack IS 'Individual units per ASIN unit: 1 for individual, the pack for a multi-pack, the TOTAL Individual units in one bundle for a bundle (migration 100). NULL = pack size not known.';
