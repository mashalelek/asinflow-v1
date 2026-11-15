-- 116: "Components only" PO rows (Maria 2026-11-15; SPEC §22 "Bundles" → "Components only"). A PO row that buys
-- components for a bundle whose other parts are already at Velocity (walmart 200015730948075: 5 Dr Teal's balms for
-- B0GWG5S64Q) is a purchase record and nothing else: never a Velocity order (Upload to Velocity leaves it out, its
-- PO's tracking is not pushed when every row is components only), never in COGS (the cost map, the hourly backstop,
-- Export SB COGS and Update COGS in SC skip it), not in On Order, never blocks or drives auto-close; Spend, claims,
-- refunds and tracking in AF work as usual. Its stored qty is Σ its lines' Individual units (what it shows); one
-- product on a bundle ASIN row is allowed. A checkbox on the ASIN row of New PO / Edit PO / Capture PO, off by default.
ALTER TABLE po_asins ADD COLUMN components_only boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN po_asins.components_only IS 'Components only (2026-11-15): a purchase record — not a Velocity order, not in COGS, not On Order, outside the auto-close rule; qty = Σ its lines'' Individual units';
