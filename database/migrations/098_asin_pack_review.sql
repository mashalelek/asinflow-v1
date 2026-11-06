-- 098_asin_pack_review.sql — the ASIN pack size as a reviewed catalog field
-- (Maria 2026-11-06). asins.sold_as / units_per_pack stay what they mean to
-- every PO: the CONFIRMED pack ("on record"). A pack AF proposes but Maria has
-- not reviewed lives beside it — a suggestion with its source, or a conflict —
-- so status is derived: a value on record = confirmed; else a suggestion =
-- needs review; else missing.
ALTER TABLE asins
  ADD COLUMN pack_source text,              -- how the confirmed pack came: po | velocity | po_velocity | manual | upload | po_entry
  ADD COLUMN pack_suggested_sold_as text CHECK (pack_suggested_sold_as IN ('individual', 'multi-pack', 'bundle')),
  ADD COLUMN pack_suggested_units integer CHECK (pack_suggested_units >= 1),
  ADD COLUMN pack_suggestion_source text,   -- po | velocity | catalog | title | ai | record (an earlier unreviewed value)
  ADD COLUMN pack_review_reason text CHECK (pack_review_reason IN ('po_conflict', 'po_velocity_conflict', 'velocity_conflict', 'suggestion', 'nothing')),
  ADD COLUMN pack_note text,                -- the hover: each PO # / Velocity value, the suggestion's evidence
  ADD COLUMN pack_evaluated_at timestamptz;

ALTER TABLE asin_field_log DROP CONSTRAINT asin_field_log_source_check;
ALTER TABLE asin_field_log ADD CONSTRAINT asin_field_log_source_check CHECK (source = ANY (ARRAY['manual', 'po_form', 'backfill', 'upload']));

-- The pack review's AI read (image + title + catalog attributes) is logged with every other AI call.
ALTER TABLE po_prefill_log DROP CONSTRAINT po_prefill_log_kind_check;
ALTER TABLE po_prefill_log ADD CONSTRAINT po_prefill_log_kind_check CHECK (kind = ANY (ARRAY['capture', 'backfill', 'promo_classify', 'doc_classify', 'tracking_fallback', 'capture_preview', 'supplier_check', 'pack_review']));
