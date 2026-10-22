-- tracking.platform_senders (SPEC §26; Maria 2026-10-22): registrable
-- domains of shipping / storefront / fulfilment platforms that send for many
-- stores. Their emails are matched by the store named in the subject, never
-- by the sender domain, and the domain is never seeded into
-- tracking.supplier_domain_map. Editable list; the code default matches.
INSERT INTO settings (key, value, updated_at) VALUES
  ('tracking.platform_senders',
   '["narvar.com", "narvarnotify.com", "shopifyemail.com", "shipstation.com", "parcelpanel.net", "aftership.com", "veeqo.com", "zendesk.com", "worldpantry.com"]'::jsonb,
   NOW())
ON CONFLICT (key) DO NOTHING;
