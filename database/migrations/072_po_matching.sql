-- PO matching (docs/claude_spec-patch-po-matching.md §3, §4, §6; amended 2026-10-29).
--
-- supplier_aliases: a Velocity retailer string (lowercased, trimmed) → the
-- canonical AF supplier. Created empty: the seeds are proposed by
-- `npm run backfill:shipment-matching` and written by its --live run after
-- Maria's review (source 'seed'); the Unmatched panel's "Map → supplier"
-- writes source 'manual'.
CREATE TABLE supplier_aliases (
  alias      TEXT PRIMARY KEY CHECK (alias = lower(btrim(alias)) AND alias <> ''),
  supplier   TEXT NOT NULL,
  source     TEXT NOT NULL CHECK (source IN ('seed', 'manual')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Unmatched shipments panel: dismissed lines are hidden, never deleted;
-- match_reason records how a line left the panel (picker | candidate_unique |
-- a rule name); nearest_miss explains a line with no candidate.
ALTER TABLE shipment_unmatched
  ADD COLUMN dismissed_at TIMESTAMPTZ,
  ADD COLUMN match_reason TEXT,
  ADD COLUMN nearest_miss TEXT;

-- Lines already linked by hand through the picker.
UPDATE shipment_unmatched SET match_reason = 'picker' WHERE resolved_po_asin_id IS NOT NULL;
