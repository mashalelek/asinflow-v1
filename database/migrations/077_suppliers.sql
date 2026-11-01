-- 077 — suppliers: the supplier record (Maria 2026-11-01, PO form polish;
-- SPEC §22 "Suppliers"). One row per AF supplier — the domain string
-- purchase_orders.supplier carries, lowercased — with per-supplier defaults
-- as JSON (`supplier_defaults`). Today's one key: "email_used", the Email
-- used the New PO form / Capture PO fills for that supplier. Rule
-- (server/supplier-defaults.ts): the supplier's default → else the email on
-- its most recent PO → else settings.po_email_unknown_supplier (a supplier
-- with no PO yet). Seeded from today's suppliers, with the walmart.com rule.
CREATE TABLE suppliers (
  supplier          TEXT PRIMARY KEY CHECK (supplier = lower(btrim(supplier)) AND supplier <> ''),
  supplier_defaults JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO suppliers (supplier)
  SELECT DISTINCT lower(btrim(supplier)) FROM purchase_orders WHERE btrim(supplier) <> ''
ON CONFLICT (supplier) DO NOTHING;
INSERT INTO suppliers (supplier, supplier_defaults) VALUES ('walmart.com', '{"email_used": "orders@coastalqualitygoods.com"}'::jsonb)
ON CONFLICT (supplier) DO UPDATE SET supplier_defaults = suppliers.supplier_defaults || EXCLUDED.supplier_defaults, updated_at = now();
INSERT INTO settings (key, value) VALUES ('po_email_unknown_supplier', '"mpeters.cqg@gmail.com"'::jsonb)
ON CONFLICT (key) DO NOTHING;
