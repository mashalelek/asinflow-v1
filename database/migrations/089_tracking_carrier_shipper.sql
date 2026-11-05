-- 089_tracking_carrier_shipper.sql (Maria 2026-11-04; SPEC §26 "Carrier
-- notices"). A UPS / FedEx / USPS notice is sent by the carrier "at the
-- request of" the shipper ("ZARA DEL AMO FASHION CENTER") and usually
-- carries no order #, only the carrier's reference numbers.
-- 1. po_tracking.shipper_name: the shipper the notice names (the supplier is
--    resolved from it through supplier_aliases).
-- 2. po_tracking.carrier_refs: the carrier's reference numbers as printed
--    ("Reference Number 1: 212355503949"), never a tracking number.
-- 3. The Zara store names → zara.com (seed): the exact store and "zara",
--    which the shipper rule also reads as a word prefix.
ALTER TABLE po_tracking ADD COLUMN shipper_name text;
ALTER TABLE po_tracking ADD COLUMN carrier_refs text[];
INSERT INTO supplier_aliases (alias, supplier, source) VALUES
  ('zara del amo fashion center', 'zara.com', 'seed'),
  ('zara', 'zara.com', 'seed')
ON CONFLICT DO NOTHING;
