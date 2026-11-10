-- 101_supplier_claims.sql — Supplier claims, commit 1 (docs/claude_spec-patch-supplier-claims.md §4,
-- approved 2026-11-06, amended 2026-11-07 / 2026-11-09). Four things, in this order:
--
--   A. The claims model: po_line_defects → supplier_claims (widened, §4.1), supplier_claim_tasks (§4.2),
--      supplier_claim_events (§4.3), po_line_defect_refunds → supplier_claim_refunds (+ amount_applied, §4.4),
--      po_warning_dismissals (§4.5); claim_id + direction on po_tracking, claim_id + type return_label on
--      po_documents, po_edit_log entity 'claim' (§4.7).
--   B. Stored base → Individual units (D17, §4.7): every quantity on po_asins, po_asin_shipments,
--      po_line_items, po_line_refunds and supplier_claims is multiplied by its pack size in place — the ASIN
--      pack for ASIN-unit columns, the line's Product pack (retailer_units_per_product) for Product-unit
--      columns; a bundle ASIN row by × N (N = its total Individual units, SPEC §22 "Bundles"), a bundle
--      component line by its own real pack, never × N. The product must be a whole number: a 2-dp stored
--      value within 0.05 of one (3.33 × 3 = 9.99 → 10, 1.17 × 6 = 7.02 → 7) is rounded; anything else, and
--      any row whose pack size is not known, is LEFT AS STORED with qty_basis = 'asin_legacy' /
--      'product_legacy' — the views below read such a row exactly as before, and the triggers convert it
--      the moment its pack becomes known (an ASIN row's sold_as + units_per_pack, a line's
--      retailer_units_per_product).
--   C. The two views every net-quantity reader uses (§4.6): po_line_expected (per product line) and
--      po_asin_expected (per ASIN row) — ordered / expected / received / at prep / at warehouse /
--      lost-damaged / shipped FBA / received by Amazon / Σ canceled / Σ returned / Σ claimed in Individual,
--      Product and ASIN units; a bundle's ASIN units = min over components (Individual ÷ units per bundle).
--   D. The conversions (§4.8): the defect → a claim, the due refund row → amount_owed, qty_canceled /
--      qty_returned → closed claims, "Confirm refund / replacement" and "Missing / damaged from supplier"
--      action items → claims (cleared, "converted to claim"), the sheet's col V / W losses → closed write_off
--      claims (+ chewy 1627249988 B08F2JGCXT 3 / $8.55; michaels 9800109062072825 Red Heart excluded);
--      then DROP qty_canceled / qty_returned / final_qty and po_line_refunds.status.
--
-- The dry run (npm run claims:dryrun -- --prod) applies this very file inside a transaction, compares the
-- three readers before / after, writes the CSVs and ROLLS BACK; the runner applies it live at deploy.

-- ───────────────────────────── A. the claims model ─────────────────────────────
ALTER TABLE po_line_defects RENAME TO supplier_claims;
ALTER TABLE po_line_defect_refunds RENAME TO supplier_claim_refunds;
ALTER TABLE supplier_claim_refunds RENAME COLUMN defect_id TO claim_id;
ALTER TABLE supplier_claim_refunds ADD COLUMN amount_applied numeric(12,2) CHECK (amount_applied IS NULL OR amount_applied >= 0);
COMMENT ON COLUMN supplier_claim_refunds.amount_applied IS 'How much of the refund row this claim takes (one refund across several claims: Michaels); NULL = the whole row.';
ALTER INDEX po_line_defects_pkey RENAME TO supplier_claims_pkey;
ALTER INDEX po_line_defects_po_idx RENAME TO supplier_claims_po_idx;
ALTER INDEX po_line_defects_line_idx RENAME TO supplier_claims_line_idx;
ALTER INDEX po_line_defect_refunds_pkey RENAME TO supplier_claim_refunds_pkey;
ALTER INDEX po_line_defect_refunds_refund_idx RENAME TO supplier_claim_refunds_refund_idx;
ALTER SEQUENCE po_line_defects_id_seq RENAME TO supplier_claims_id_seq;

ALTER TABLE supplier_claims
  DROP CONSTRAINT po_line_defects_kind_check,
  DROP CONSTRAINT po_line_defects_status_check,
  DROP CONSTRAINT po_line_defects_resolution_check,
  DROP CONSTRAINT po_line_defects_check,
  DROP CONSTRAINT po_line_defects_check1,
  DROP CONSTRAINT po_line_defects_replacement_po_line_item_id_fkey,
  DROP COLUMN replacement_po_line_item_id,
  ALTER COLUMN po_line_item_id DROP NOT NULL;
ALTER TABLE supplier_claims RENAME COLUMN amount TO amount_owed;
ALTER TABLE supplier_claims RENAME COLUMN resolution TO outcome;
ALTER TABLE supplier_claims RENAME COLUMN opened_at TO found_at;
ALTER TABLE supplier_claims RENAME COLUMN resolved_at TO closed_at;
ALTER TABLE supplier_claims DROP CONSTRAINT po_line_defects_qty_check;
ALTER TABLE supplier_claims ADD CONSTRAINT supplier_claims_qty_check CHECK (qty >= 0); -- 0 only for a sheet line canceled with no ordered qty (0 / 0): the marker survives as a 0-unit canceled claim
ALTER TABLE supplier_claims RENAME CONSTRAINT po_line_defects_amount_check TO supplier_claims_amount_owed_check;
ALTER TABLE supplier_claims RENAME CONSTRAINT po_line_defects_po_id_fkey TO supplier_claims_po_id_fkey;
ALTER TABLE supplier_claims RENAME CONSTRAINT po_line_defects_po_line_item_id_fkey TO supplier_claims_po_line_item_id_fkey;
ALTER TABLE supplier_claim_refunds RENAME CONSTRAINT po_line_defect_refunds_defect_id_fkey TO supplier_claim_refunds_claim_id_fkey;
ALTER TABLE supplier_claim_refunds RENAME CONSTRAINT po_line_defect_refunds_po_line_refund_id_fkey TO supplier_claim_refunds_po_line_refund_id_fkey;
UPDATE supplier_claims SET status = 'closed' WHERE status = 'resolved';
-- The one 'refund' resolution would map to the linked refund's method; none exists on 2026-11-09 (the only defect is open).
UPDATE supplier_claims c SET outcome = COALESCE(
  (SELECT CASE r.method WHEN 'gift_card' THEN 'gift_card' WHEN 'store_credit' THEN 'store_credit' ELSE 'refund_card' END
     FROM supplier_claim_refunds x JOIN po_line_refunds r ON r.id = x.po_line_refund_id WHERE x.claim_id = c.id ORDER BY r.id LIMIT 1), 'refund_card')
 WHERE c.outcome = 'refund';
ALTER TABLE supplier_claims
  ADD COLUMN amount_owed_source text NOT NULL DEFAULT 'auto' CHECK (amount_owed_source IN ('auto', 'manual')),
  ADD COLUMN outcome_amount numeric(12,2) CHECK (outcome_amount IS NULL OR outcome_amount >= 0),
  ADD COLUMN outcome_detail text,
  ADD COLUMN replacement_qty numeric(10,2) CHECK (replacement_qty IS NULL OR replacement_qty >= 0),
  ADD COLUMN replacement_shipped_at date,
  ADD COLUMN replacement_arrived_at date,
  ADD COLUMN return_required boolean NOT NULL DEFAULT false,
  ADD COLUMN qty_disposed numeric(10,2) CHECK (qty_disposed IS NULL OR qty_disposed >= 0),
  ADD COLUMN found_by text NOT NULL DEFAULT 'maria' CHECK (found_by IN ('auto', 'maria', 'email')),
  ADD COLUMN reported_at date,
  ADD COLUMN reported_channel text,
  ADD COLUMN last_supplier_reply_at timestamptz,
  ADD COLUMN supplier_confirmed_at timestamptz,
  ADD COLUMN source_email_id text,
  ADD COLUMN source_items_json jsonb,
  ADD COLUMN created_by_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD CONSTRAINT supplier_claims_kind_check CHECK (kind IN ('missing', 'damaged', 'wrong_item', 'expired', 'never_received', 'cant_sell', 'canceled', 'returned')),
  ADD CONSTRAINT supplier_claims_status_check CHECK (status IN ('suggested', 'open', 'closed', 'dismissed')),
  ADD CONSTRAINT supplier_claims_outcome_check CHECK (outcome IS NULL OR outcome IN ('refund_card', 'gift_card', 'store_credit', 'replacement', 'write_off')),
  ADD CONSTRAINT supplier_claims_write_off_reason_check CHECK (outcome IS DISTINCT FROM 'write_off' OR NULLIF(btrim(write_off_reason), '') IS NOT NULL);
COMMENT ON TABLE supplier_claims IS 'Supplier claims (SPEC §22 "Supplier claims", migration 101; was po_line_defects, 094): one row per supplier problem on a PO line (po_line_item_id NULL = the whole PO). qty is INDIVIDUAL units (D17), stored, never derived. status suggested | open | closed | dismissed; the bucket is derived from the open tasks and timers. outcome: one of refund_card | gift_card | store_credit | replacement | write_off.';
COMMENT ON COLUMN supplier_claims.qty IS 'Individual units (D16/D17). On a product_legacy line (pack not known) it is still the line''s stored basis — Product units — until the line converts.';
COMMENT ON COLUMN supplier_claims.amount_owed IS '$ the supplier owes: qty × the line''s sourcing cost per Individual unit when amount_owed_source = auto (recomputed on a qty / cost change), as typed once manual.';

CREATE TABLE supplier_claim_tasks (
  id            bigserial PRIMARY KEY,
  claim_id      bigint NOT NULL REFERENCES supplier_claims(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('review_suggestion', 'confirm_outcome', 'contact_supplier', 'follow_up_supplier', 'confirm_reship_order',
                                             'send_label', 'tell_velocity_replacement', 'dispose_units', 'update_velocity_order',
                                             'refund_received', 'replacement_arrived', 'upload_return_label', 'check_on_it')),
  "group"       text NOT NULL CHECK ("group" IN ('decide', 'supplier', 'velocity', 'money', 'timed_out')),
  qty           numeric(10,2),
  reason        text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  due_at        timestamptz,
  done_at       timestamptz,
  done_by       integer REFERENCES users(id) ON DELETE SET NULL,
  snoozed_until timestamptz
);
CREATE UNIQUE INDEX supplier_claim_tasks_open_key ON supplier_claim_tasks (claim_id, kind) WHERE done_at IS NULL;
CREATE INDEX supplier_claim_tasks_claim_idx ON supplier_claim_tasks (claim_id);
COMMENT ON TABLE supplier_claim_tasks IS 'Every manual step on a claim is a task with a checkbox (SPEC §22 "Supplier claims" §3.2–3.3). Open = done_at IS NULL; one open task per kind per claim.';

CREATE TABLE supplier_claim_events (
  id                bigserial PRIMARY KEY,
  claim_id          bigint NOT NULL REFERENCES supplier_claims(id) ON DELETE CASCADE,
  at                timestamptz NOT NULL DEFAULT now(),
  type              text NOT NULL CHECK (type IN ('found', 'opened', 'dismissed', 'reported', 'supplier_reply', 'outcome_set', 'label_saved', 'return_shipped',
                                                 'return_delivered', 'supplier_confirmed', 'refund_received', 'replacement_shipped', 'replacement_arrived',
                                                 'task_done', 'amount_overridden', 'remainder_written_off', 'reopened', 'closed', 'converted')),
  summary           text,
  gmail_message_id  text,
  po_document_id    bigint REFERENCES po_documents(id) ON DELETE SET NULL,
  po_tracking_id    bigint REFERENCES po_tracking(id) ON DELETE SET NULL,
  po_line_refund_id bigint REFERENCES po_line_refunds(id) ON DELETE SET NULL,
  by                integer REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX supplier_claim_events_claim_idx ON supplier_claim_events (claim_id, at);

CREATE TABLE po_warning_dismissals (
  id              bigserial PRIMARY KEY,
  po_id           uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  warning_type    text NOT NULL,
  quantities_json jsonb,
  note            text NOT NULL,
  dismissed_by    integer REFERENCES users(id) ON DELETE SET NULL,
  dismissed_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX po_warning_dismissals_po_idx ON po_warning_dismissals (po_id, warning_type);
COMMENT ON TABLE po_warning_dismissals IS 'A Velocity-vs-AF warning dismissed with a note (SPEC §22 "Supplier claims" §3.8): per PO + warning type + the quantities at dismissal; comes back if those change.';

ALTER TABLE po_tracking
  ADD COLUMN claim_id bigint REFERENCES supplier_claims(id) ON DELETE SET NULL,
  ADD COLUMN direction text NOT NULL DEFAULT 'inbound' CHECK (direction IN ('inbound', 'return'));
CREATE INDEX po_tracking_claim_idx ON po_tracking (claim_id) WHERE claim_id IS NOT NULL;
ALTER TABLE po_documents ADD COLUMN claim_id bigint REFERENCES supplier_claims(id) ON DELETE SET NULL;
ALTER TABLE po_documents DROP CONSTRAINT po_documents_type_check;
ALTER TABLE po_documents ADD CONSTRAINT po_documents_type_check CHECK (type IN ('order_confirmation', 'invoice', 'shipped', 'delivered', 'invoice_manual', 'return_label'));
ALTER TABLE po_edit_log DROP CONSTRAINT po_edit_log_entity_check;
ALTER TABLE po_edit_log ADD CONSTRAINT po_edit_log_entity_check CHECK (entity IN ('po', 'line', 'asin', 'shipment', 'document', 'claim'));

-- ───────────────────────────── B. stored base → Individual units (D17) ─────────────────────────────
-- v × pack when that is within 0.05 of a whole number (a 2-dp stored third or sixth), else NULL = "does not convert".
CREATE OR REPLACE FUNCTION po_qty_individual(v numeric, pack integer) RETURNS numeric
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN v IS NULL OR pack IS NULL OR pack < 1 THEN NULL
              WHEN ABS(v * pack - ROUND(v * pack)) <= 0.05 THEN ROUND(v * pack)
              ELSE NULL END
$$;
COMMENT ON FUNCTION po_qty_individual(numeric, integer) IS 'D17 (migration 101): a stored ASIN / Product quantity × its pack size, rounded when within 0.05 of a whole number; NULL when the value does not convert.';
-- The history columns (a sheet loss of 0.17 pack, a received 14.75, a returned 0.36) convert × pack and keep their fraction (2 dp): they never
-- drive On Order or auto-close, so a fraction there must not hold a whole row in its old basis.
CREATE OR REPLACE FUNCTION po_qty_individual_loose(v numeric, pack integer) RETURNS numeric
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN v IS NULL OR pack IS NULL OR pack < 1 THEN NULL ELSE COALESCE(po_qty_individual(v, pack), ROUND(v * pack, 2)) END
$$;

ALTER TABLE po_asins ADD COLUMN qty_basis text NOT NULL DEFAULT 'asin_legacy' CHECK (qty_basis IN ('individual', 'asin_legacy'));
ALTER TABLE po_line_items ADD COLUMN qty_basis text NOT NULL DEFAULT 'product_legacy' CHECK (qty_basis IN ('individual', 'product_legacy'));
COMMENT ON COLUMN po_asins.qty_basis IS 'individual = every quantity column of this row is Individual units (D17). asin_legacy = the pack size was not known (or a value did not convert) at migration 101: qty, qty_shipped_supplier, qty_at_warehouse, qty_lost_damaged_us, unreimbursed_loss_qty and extra_units_cleared_shipped are ASIN units as stored before; qty_at_prep, received_velocity and the shipment rows were already Individual (÷ 1). The BEFORE UPDATE trigger converts the row when sold_as + units_per_pack arrive.';
COMMENT ON COLUMN po_line_items.qty_basis IS 'individual = qty_ordered / qty_received (and the line''s claims and refund qty) are Individual units (D17). product_legacy = retailer_units_per_product was not known (or a value did not convert) at migration 101: Product units as stored before; the BEFORE UPDATE trigger converts the line when its pack arrives.';

-- Lines: Product pack known, every value converts (incl. the line's refund rows and claims).
UPDATE po_line_items l
   SET qty_ordered = po_qty_individual(l.qty_ordered, l.retailer_units_per_product),
       qty_received = po_qty_individual_loose(l.qty_received, l.retailer_units_per_product),
       qty_canceled = po_qty_individual_loose(l.qty_canceled, l.retailer_units_per_product),
       qty_returned = po_qty_individual_loose(l.qty_returned, l.retailer_units_per_product),
       qty_basis = 'individual'
 WHERE l.retailer_units_per_product IS NOT NULL
   AND (l.qty_ordered IS NULL OR po_qty_individual(l.qty_ordered, l.retailer_units_per_product) IS NOT NULL);
UPDATE po_line_refunds r SET qty = po_qty_individual_loose(r.qty, l.retailer_units_per_product)
  FROM po_line_items l WHERE l.id = r.po_line_item_id AND l.qty_basis = 'individual' AND r.qty IS NOT NULL;
UPDATE supplier_claims c SET qty = po_qty_individual_loose(c.qty, l.retailer_units_per_product)
  FROM po_line_items l WHERE l.id = c.po_line_item_id AND l.qty_basis = 'individual';

-- ASIN rows: pack known, every column and every shipment row converts.
UPDATE po_asins pa
   SET qty = po_qty_individual(pa.qty, pa.units_per_pack),
       qty_shipped_supplier = po_qty_individual(pa.qty_shipped_supplier, pa.units_per_pack),
       qty_at_prep = po_qty_individual(pa.qty_at_prep, pa.units_per_pack),
       qty_at_warehouse = po_qty_individual(pa.qty_at_warehouse, pa.units_per_pack),
       qty_lost_damaged_us = po_qty_individual_loose(pa.qty_lost_damaged_us, pa.units_per_pack),
       received_velocity = po_qty_individual(pa.received_velocity, pa.units_per_pack),
       unreimbursed_loss_qty = po_qty_individual_loose(pa.unreimbursed_loss_qty, pa.units_per_pack),
       extra_units_cleared_shipped = po_qty_individual(pa.extra_units_cleared_shipped, pa.units_per_pack),
       qty_basis = 'individual'
 WHERE pa.sold_as IS NOT NULL AND pa.units_per_pack IS NOT NULL
   AND po_qty_individual(pa.qty, pa.units_per_pack) IS NOT NULL
   AND (pa.qty_shipped_supplier IS NULL OR po_qty_individual(pa.qty_shipped_supplier, pa.units_per_pack) IS NOT NULL)
   AND (pa.qty_at_prep IS NULL OR po_qty_individual(pa.qty_at_prep, pa.units_per_pack) IS NOT NULL)
   AND (pa.qty_at_warehouse IS NULL OR po_qty_individual(pa.qty_at_warehouse, pa.units_per_pack) IS NOT NULL)
   AND (pa.received_velocity IS NULL OR po_qty_individual(pa.received_velocity, pa.units_per_pack) IS NOT NULL)
   AND (pa.extra_units_cleared_shipped IS NULL OR po_qty_individual(pa.extra_units_cleared_shipped, pa.units_per_pack) IS NOT NULL)
   AND (pa.qty_shipped_fba IS NULL OR po_qty_individual(pa.qty_shipped_fba, pa.units_per_pack) IS NOT NULL)
   AND (pa.qty_received_amazon IS NULL OR po_qty_individual(pa.qty_received_amazon, pa.units_per_pack) IS NOT NULL)
   AND NOT EXISTS (SELECT 1 FROM po_asin_shipments s WHERE s.po_asin_id = pa.id
                    AND (po_qty_individual(s.qty_shipped, pa.units_per_pack) IS NULL OR (s.qty_received IS NOT NULL AND po_qty_individual(s.qty_received, pa.units_per_pack) IS NULL)));
-- Shipment rows of converted rows (the rollup trigger re-sums qty_shipped_fba / qty_received_amazon per row).
UPDATE po_asin_shipments s
   SET qty_shipped = po_qty_individual(s.qty_shipped, pa.units_per_pack), qty_received = po_qty_individual(s.qty_received, pa.units_per_pack), updated_at = now()
  FROM po_asins pa WHERE pa.id = s.po_asin_id AND pa.qty_basis = 'individual';
-- A converted row with a stored sum but no shipment rows (the trigger never wrote it): convert the sum itself.
UPDATE po_asins pa
   SET qty_shipped_fba = po_qty_individual(pa.qty_shipped_fba, pa.units_per_pack), qty_received_amazon = po_qty_individual(pa.qty_received_amazon, pa.units_per_pack)
 WHERE pa.qty_basis = 'individual' AND (pa.qty_shipped_fba IS NOT NULL OR pa.qty_received_amazon IS NOT NULL)
   AND NOT EXISTS (SELECT 1 FROM po_asin_shipments s WHERE s.po_asin_id = pa.id);

-- From here on a NEW row or line is Individual units by construction (D17); only the migration marks legacy rows.
-- A row can claim the Individual basis only while its pack is known (a raw insert with no pack must say asin_legacy).
ALTER TABLE po_asins ALTER COLUMN qty_basis SET DEFAULT 'individual';
ALTER TABLE po_line_items ALTER COLUMN qty_basis SET DEFAULT 'individual';
ALTER TABLE po_asins ADD CONSTRAINT po_asins_qty_basis_pack_check CHECK (qty_basis = 'asin_legacy' OR units_per_pack IS NOT NULL);
ALTER TABLE po_line_items ADD CONSTRAINT po_line_items_qty_basis_pack_check CHECK (qty_basis = 'product_legacy' OR retailer_units_per_product IS NOT NULL);
-- An insert with no pack is legacy by construction (the stored number can only be the caller's ASIN / Product units).
CREATE OR REPLACE FUNCTION po_asins_basis_on_insert() RETURNS trigger AS $$
BEGIN IF NEW.units_per_pack IS NULL THEN NEW.qty_basis := 'asin_legacy'; END IF; RETURN NEW; END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER po_asins_basis_on_insert_trg BEFORE INSERT ON po_asins FOR EACH ROW EXECUTE FUNCTION po_asins_basis_on_insert();
CREATE OR REPLACE FUNCTION po_line_items_basis_on_insert() RETURNS trigger AS $$
BEGIN IF NEW.retailer_units_per_product IS NULL THEN NEW.qty_basis := 'product_legacy'; END IF; RETURN NEW; END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER po_line_items_basis_on_insert_trg BEFORE INSERT ON po_line_items FOR EACH ROW EXECUTE FUNCTION po_line_items_basis_on_insert();

-- A legacy row converts the moment its pack arrives (an edit, Velocity's pack fill, the ASIN pack confirm):
-- the ASIN-unit columns × pack; qty_at_prep / received_velocity / the Velocity shipment rows were written as units ÷ 1 and stay.
CREATE OR REPLACE FUNCTION po_asins_legacy_to_individual() RETURNS trigger AS $$
BEGIN
  IF OLD.qty_basis = 'asin_legacy' AND NEW.qty_basis = 'asin_legacy' AND NEW.sold_as IS NOT NULL AND NEW.units_per_pack IS NOT NULL
     AND po_qty_individual(NEW.qty, NEW.units_per_pack) IS NOT NULL
     AND (NEW.qty_shipped_supplier IS NULL OR po_qty_individual(NEW.qty_shipped_supplier, NEW.units_per_pack) IS NOT NULL)
     AND (NEW.qty_at_warehouse IS NULL OR po_qty_individual(NEW.qty_at_warehouse, NEW.units_per_pack) IS NOT NULL)
     AND (NEW.extra_units_cleared_shipped IS NULL OR po_qty_individual(NEW.extra_units_cleared_shipped, NEW.units_per_pack) IS NOT NULL) THEN
    NEW.qty := po_qty_individual(NEW.qty, NEW.units_per_pack);
    NEW.qty_shipped_supplier := po_qty_individual(NEW.qty_shipped_supplier, NEW.units_per_pack);
    NEW.qty_at_warehouse := po_qty_individual(NEW.qty_at_warehouse, NEW.units_per_pack);
    NEW.qty_lost_damaged_us := po_qty_individual_loose(NEW.qty_lost_damaged_us, NEW.units_per_pack);
    NEW.unreimbursed_loss_qty := po_qty_individual_loose(NEW.unreimbursed_loss_qty, NEW.units_per_pack);
    NEW.extra_units_cleared_shipped := po_qty_individual(NEW.extra_units_cleared_shipped, NEW.units_per_pack);
    NEW.qty_basis := 'individual';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER po_asins_legacy_to_individual_trg BEFORE UPDATE ON po_asins FOR EACH ROW EXECUTE FUNCTION po_asins_legacy_to_individual();
-- After the flip: hand-placed shipment rows (ASIN units) × pack, and a History row.
CREATE OR REPLACE FUNCTION po_asins_legacy_converted() RETURNS trigger AS $$
BEGIN
  IF OLD.qty_basis = 'asin_legacy' AND NEW.qty_basis = 'individual' THEN
    UPDATE po_asin_shipments s SET qty_shipped = COALESCE(po_qty_individual(s.qty_shipped, NEW.units_per_pack), s.qty_shipped * NEW.units_per_pack),
                                   qty_received = COALESCE(po_qty_individual(s.qty_received, NEW.units_per_pack), s.qty_received * NEW.units_per_pack), updated_at = now()
     WHERE s.po_asin_id = NEW.id AND s.source = 'manual';
    INSERT INTO po_edit_log (po_id, user_id, entity, entity_id, field, old_value, new_value, derived)
    VALUES (NEW.po_id, NULL, 'asin', NEW.id::text, 'qty_basis', 'asin_legacy (ASIN units: ' || OLD.qty || ')', 'individual (× ' || NEW.units_per_pack || ' = ' || NEW.qty || ')', true);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER po_asins_legacy_converted_trg AFTER UPDATE ON po_asins FOR EACH ROW EXECUTE FUNCTION po_asins_legacy_converted();

CREATE OR REPLACE FUNCTION po_line_items_legacy_to_individual() RETURNS trigger AS $$
BEGIN
  IF OLD.qty_basis = 'product_legacy' AND NEW.qty_basis = 'product_legacy' AND NEW.retailer_units_per_product IS NOT NULL
     AND (NEW.qty_ordered IS NULL OR po_qty_individual(NEW.qty_ordered, NEW.retailer_units_per_product) IS NOT NULL) THEN
    NEW.qty_ordered := po_qty_individual(NEW.qty_ordered, NEW.retailer_units_per_product);
    NEW.qty_received := po_qty_individual_loose(NEW.qty_received, NEW.retailer_units_per_product);
    NEW.qty_basis := 'individual';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER po_line_items_legacy_to_individual_trg BEFORE UPDATE ON po_line_items FOR EACH ROW EXECUTE FUNCTION po_line_items_legacy_to_individual();
CREATE OR REPLACE FUNCTION po_line_items_legacy_converted() RETURNS trigger AS $$
BEGIN
  IF OLD.qty_basis = 'product_legacy' AND NEW.qty_basis = 'individual' THEN
    UPDATE po_line_refunds r SET qty = po_qty_individual_loose(r.qty, NEW.retailer_units_per_product) WHERE r.po_line_item_id = NEW.id AND r.qty IS NOT NULL;
    UPDATE supplier_claims c SET qty = po_qty_individual_loose(c.qty, NEW.retailer_units_per_product), updated_at = now() WHERE c.po_line_item_id = NEW.id;
    INSERT INTO po_edit_log (po_id, user_id, entity, entity_id, field, old_value, new_value, derived)
    VALUES (NEW.po_id, NULL, 'line', NEW.id::text, 'qty_basis', 'product_legacy (Product units: ' || COALESCE(OLD.qty_ordered::text, '∅') || ')', 'individual (× ' || NEW.retailer_units_per_product || ' = ' || COALESCE(NEW.qty_ordered::text, '∅') || ')', true);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER po_line_items_legacy_converted_trg AFTER UPDATE ON po_line_items FOR EACH ROW EXECUTE FUNCTION po_line_items_legacy_converted();

-- ───────────────────────────── D1. conversions that need the old columns (§4.8) ─────────────────────────────
-- Dates: a sheet-era claim is dated by the PO's last edit.
CREATE OR REPLACE FUNCTION po_last_edit_date(p_po_id uuid) RETURNS date
LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT MAX(e.at) FROM po_edit_log e WHERE e.po_id = p_po_id), (SELECT p.updated_at FROM purchase_orders p WHERE p.id = p_po_id), now())::date
$$;
-- $ per Individual unit of a line (§3.7): the stored adjusted product cost (price with discount, tax and shipping allocated),
-- else price × (subtotal − discount + tax + shipping) ÷ subtotal, else the plain price — ÷ the line's Product pack. NULL without a price.
CREATE OR REPLACE FUNCTION po_line_cost_per_individual(p_line_id uuid) RETURNS numeric
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN l.adjusted_product_cost IS NOT NULL THEN l.adjusted_product_cost
              WHEN l.price IS NULL THEN NULL
              WHEN COALESCE(p.subtotal, 0) > 0 THEN l.price * (p.subtotal - COALESCE(p.discount, 0) + COALESCE(p.tax, 0) + COALESCE(p.sh_donations, 0)) / p.subtotal
              ELSE l.price END
         / GREATEST(COALESCE(l.retailer_units_per_product, 1), 1)
    FROM po_line_items l JOIN purchase_orders p ON p.id = l.po_id WHERE l.id = p_line_id
$$;

-- Conversion bookkeeping (kept, for the report and for undo-by-hand): which rows each converted claim came from.
CREATE TABLE supplier_claim_conversions (
  claim_id   bigint NOT NULL REFERENCES supplier_claims(id) ON DELETE CASCADE,
  source     text NOT NULL CHECK (source IN ('defect', 'qty_canceled', 'qty_returned', 'confirm_refund_item', 'missing_damaged_item', 'sheet_loss', 'sheet_loss_added')),
  source_id  text,
  old_value  text,
  flags      text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (claim_id, source)   -- a converted canceled claim reopened by a "Confirm refund / replacement" item carries both sources
);
COMMENT ON TABLE supplier_claim_conversions IS 'Migration 101 §4.8: where each converted claim came from (the defect row, a line''s qty_canceled / qty_returned, an action item row, a po_asins loss) and what was assumed (flags: kind_unclear, qty_assumed_ordered, refund_not_tracked, legacy_units, …). Read-only history.';

-- 1. The defect row is already a claim (renamed above); mark it.
INSERT INTO supplier_claim_conversions (claim_id, source, source_id, old_value)
SELECT c.id, 'defect', c.id::text, c.kind || ' ' || c.qty || ' $' || COALESCE(c.amount_owed::text, '—') FROM supplier_claims c;
-- 2. Refund-due rows: a due row linked to a claim becomes its amount_owed and goes; an unlinked due row becomes an open claim
--    on its line (kind unclear → missing, flagged) carrying the amount, then goes.
UPDATE supplier_claims c SET amount_owed = COALESCE(c.amount_owed, r.amount), updated_at = now()
  FROM supplier_claim_refunds x JOIN po_line_refunds r ON r.id = x.po_line_refund_id WHERE x.claim_id = c.id AND r.status = 'due';
WITH due_unlinked AS (
  SELECT r.* FROM po_line_refunds r WHERE r.status = 'due' AND NOT EXISTS (SELECT 1 FROM supplier_claim_refunds x WHERE x.po_line_refund_id = r.id)
), ins AS (
  INSERT INTO supplier_claims (po_id, po_line_item_id, kind, qty, amount_owed, amount_owed_source, found_at, note, status, found_by, created_at)
  SELECT d.po_id, d.po_line_item_id, 'missing', COALESCE(NULLIF(d.qty, 0), 1), d.amount, 'manual', COALESCE(d.created_at::date, CURRENT_DATE),
         COALESCE(d.note, '') || CASE WHEN d.note IS NULL OR d.note = '' THEN '' ELSE ' — ' END || 'from a refund-due row; kind unclear', 'open', 'maria', d.created_at
    FROM due_unlinked d WHERE d.po_line_item_id IS NOT NULL
  RETURNING id, po_line_item_id, amount_owed
)
INSERT INTO supplier_claim_conversions (claim_id, source, source_id, old_value, flags)
SELECT i.id, 'defect', NULL, 'due refund row $' || COALESCE(i.amount_owed::text, '—'), ARRAY['kind_unclear', 'from_due_refund_row'] FROM ins i;
DELETE FROM po_line_refunds WHERE status = 'due';

-- 3. qty_canceled > 0 → a closed canceled claim per line; qty_returned > 0 → a closed returned claim. Individual units on a
--    converted line (the line's basis otherwise, flagged); dated by the PO's last edit; $ owed = qty × cost per Individual.
WITH ins AS (
  INSERT INTO supplier_claims (po_id, po_line_item_id, kind, qty, amount_owed, amount_owed_source, found_at, status, closed_at, found_by, note, created_at)
  SELECT l.po_id, l.id, 'canceled', l.qty_canceled,
         CASE WHEN po_line_cost_per_individual(l.id) IS NULL THEN NULL ELSE ROUND(l.qty_canceled * po_line_cost_per_individual(l.id) * CASE WHEN l.qty_basis = 'individual' THEN 1 ELSE GREATEST(COALESCE(l.retailer_units_per_product, 1), 1) END, 2) END,
         'auto', po_last_edit_date(l.po_id), 'closed', po_last_edit_date(l.po_id)::timestamptz, 'maria',
         CASE WHEN EXISTS (SELECT 1 FROM po_line_refunds r WHERE r.po_id = l.po_id) THEN NULL ELSE 'sheet-era, refund not tracked' END,
         now()
    FROM po_line_items l WHERE COALESCE(l.qty_canceled, 0) > 0
       -- a sheet line canceled with no ordered qty (0 / 0, canceledNoOrderedQty): the canceled marker survives as a 0-unit claim
       OR (l.qty_canceled IS NOT NULL AND COALESCE(l.qty_ordered, 0) = 0)
  RETURNING id, po_line_item_id, qty, note
)
INSERT INTO supplier_claim_conversions (claim_id, source, source_id, old_value, flags)
SELECT i.id, 'qty_canceled', i.po_line_item_id::text, i.qty::text,
       ARRAY(SELECT f FROM unnest(ARRAY[CASE WHEN l.qty_basis <> 'individual' THEN 'legacy_units' END, CASE WHEN i.note IS NOT NULL THEN 'refund_not_tracked' END, CASE WHEN i.qty = 0 THEN 'canceled_no_ordered_qty' END]) f WHERE f IS NOT NULL)
  FROM ins i JOIN po_line_items l ON l.id = i.po_line_item_id;
WITH ins AS (
  INSERT INTO supplier_claims (po_id, po_line_item_id, kind, qty, amount_owed, amount_owed_source, found_at, status, closed_at, found_by, note, created_at)
  SELECT l.po_id, l.id, 'returned', l.qty_returned,
         CASE WHEN po_line_cost_per_individual(l.id) IS NULL THEN NULL ELSE ROUND(l.qty_returned * po_line_cost_per_individual(l.id) * CASE WHEN l.qty_basis = 'individual' THEN 1 ELSE GREATEST(COALESCE(l.retailer_units_per_product, 1), 1) END, 2) END,
         'auto', po_last_edit_date(l.po_id), 'closed', po_last_edit_date(l.po_id)::timestamptz, 'maria',
         CASE WHEN EXISTS (SELECT 1 FROM po_line_refunds r WHERE r.po_id = l.po_id) THEN NULL ELSE 'sheet-era, refund not tracked' END,
         now()
    FROM po_line_items l WHERE COALESCE(l.qty_returned, 0) > 0
  RETURNING id, po_line_item_id, qty, note
)
INSERT INTO supplier_claim_conversions (claim_id, source, source_id, old_value, flags)
SELECT i.id, 'qty_returned', i.po_line_item_id::text, i.qty::text,
       ARRAY(SELECT f FROM unnest(ARRAY[CASE WHEN l.qty_basis <> 'individual' THEN 'legacy_units' END, CASE WHEN i.note IS NOT NULL THEN 'refund_not_tracked' END]) f WHERE f IS NOT NULL)
  FROM ins i JOIN po_line_items l ON l.id = i.po_line_item_id;
-- Their outcome and refund links: every received refund row of the PO is linked to each of the PO's converted canceled / returned
-- claims, amount_applied = the row's amount × the claim's share of the PO's converted $ owed (equal shares when no $ is known);
-- outcome follows the refund's method (refund_card unless gift card / store credit).
WITH conv AS (
  SELECT c.id, c.po_id, c.amount_owed, COUNT(*) OVER (PARTITION BY c.po_id) AS n, SUM(COALESCE(c.amount_owed, 0)) OVER (PARTITION BY c.po_id) AS owed_sum
    FROM supplier_claims c JOIN supplier_claim_conversions k ON k.claim_id = c.id WHERE k.source IN ('qty_canceled', 'qty_returned')
)
INSERT INTO supplier_claim_refunds (claim_id, po_line_refund_id, amount_applied)
SELECT conv.id, r.id, ROUND(r.amount * CASE WHEN conv.owed_sum > 0 THEN COALESCE(conv.amount_owed, 0) / conv.owed_sum ELSE 1.0 / conv.n END, 2)
  FROM conv JOIN po_line_refunds r ON r.po_id = conv.po_id
ON CONFLICT DO NOTHING;
UPDATE supplier_claims c SET outcome = sub.outcome, outcome_amount = sub.applied, updated_at = now()
  FROM (SELECT x.claim_id,
               (ARRAY_AGG(CASE r.method WHEN 'gift_card' THEN 'gift_card' WHEN 'store_credit' THEN 'store_credit' ELSE 'refund_card' END ORDER BY r.id))[1] AS outcome,
               SUM(COALESCE(x.amount_applied, r.amount)) AS applied
          FROM supplier_claim_refunds x JOIN po_line_refunds r ON r.id = x.po_line_refund_id
          JOIN supplier_claim_conversions k ON k.claim_id = x.claim_id AND k.source IN ('qty_canceled', 'qty_returned')
         GROUP BY x.claim_id) sub
 WHERE sub.claim_id = c.id;

-- 4. "Confirm refund / replacement" (open items): the line's converted claim reopens with a refund_received task; a line without one
--    gets an open claim (kind unclear → missing, qty = the line's ordered units, flagged) with the same task.
WITH items AS (
  SELECT ai.id AS item_id, ai.po_line_item_id, l.po_id, l.qty_ordered, l.qty_basis, ai.reason, ai.set_at
    FROM po_line_action_items ai JOIN po_line_items l ON l.id = ai.po_line_item_id
   WHERE ai.cleared_at IS NULL AND ai.item = 'Confirm refund / replacement'
), reopened AS (
  UPDATE supplier_claims c SET status = 'open', closed_at = NULL, updated_at = now(),
         note = COALESCE(c.note || ' — ', '') || 'Confirm refund / replacement: kind, outcome and $ to confirm'
    FROM items i WHERE c.po_line_item_id = i.po_line_item_id AND c.status = 'closed'
      AND c.id = (SELECT MIN(c2.id) FROM supplier_claims c2 JOIN supplier_claim_conversions k2 ON k2.claim_id = c2.id WHERE c2.po_line_item_id = i.po_line_item_id AND k2.source IN ('qty_canceled', 'qty_returned'))
  RETURNING c.id, c.po_line_item_id
), created AS (
  INSERT INTO supplier_claims (po_id, po_line_item_id, kind, qty, amount_owed, amount_owed_source, found_at, status, found_by, note, created_at)
  SELECT i.po_id, i.po_line_item_id, 'missing', GREATEST(COALESCE(i.qty_ordered, 1), 0.01), NULL, 'auto', i.set_at::date, 'open', 'maria',
         'Confirm refund / replacement' || COALESCE(': ' || i.reason, '') || ' — kind unclear; qty set to the line''s ordered units, confirm', i.set_at
    FROM items i WHERE NOT EXISTS (SELECT 1 FROM reopened r WHERE r.po_line_item_id = i.po_line_item_id)
  RETURNING id, po_line_item_id, qty
), conv AS (
  INSERT INTO supplier_claim_conversions (claim_id, source, source_id, old_value, flags)
  SELECT r.id, 'confirm_refund_item', i.item_id::text, 'reopened converted claim', ARRAY['kind_unclear', 'outcome_unclear', 'amount_unclear']
    FROM reopened r JOIN items i ON i.po_line_item_id = r.po_line_item_id
  UNION ALL
  SELECT c.id, 'confirm_refund_item', i.item_id::text, 'Confirm refund / replacement', ARRAY['kind_unclear', 'outcome_unclear', 'amount_unclear', 'qty_assumed_ordered']
    FROM created c JOIN items i ON i.po_line_item_id = c.po_line_item_id
  RETURNING claim_id
)
INSERT INTO supplier_claim_tasks (claim_id, kind, "group", reason)
SELECT claim_id, 'refund_received', 'money', 'converted from "Confirm refund / replacement": confirm the kind, the outcome and the $ owed, then tick when the refund posts' FROM conv;

-- 5. "Missing / damaged from supplier" (open items): on an open PO → an open missing claim + contact_supplier task; on a closed PO → a
--    closed claim for history, no outcome guessed. qty = the line's ordered units (the badge carried none), flagged; the note carried over.
WITH items AS (
  SELECT ai.id AS item_id, ai.po_line_item_id, l.po_id, l.qty_ordered, ai.reason, ai.set_at, (p.closed_at IS NOT NULL) AS po_closed, p.closed_at
    FROM po_line_action_items ai JOIN po_line_items l ON l.id = ai.po_line_item_id JOIN purchase_orders p ON p.id = l.po_id
   WHERE ai.cleared_at IS NULL AND ai.item = 'Missing / damaged from supplier'
     AND NOT EXISTS (SELECT 1 FROM supplier_claims c JOIN supplier_claim_conversions k ON k.claim_id = c.id WHERE c.po_line_item_id = ai.po_line_item_id AND k.source = 'defect')
), created AS (
  INSERT INTO supplier_claims (po_id, po_line_item_id, kind, qty, amount_owed, amount_owed_source, found_at, status, closed_at, found_by, note, created_at)
  SELECT i.po_id, i.po_line_item_id, 'missing', GREATEST(COALESCE(i.qty_ordered, 1), 0.01), NULL, 'auto', i.set_at::date,
         CASE WHEN i.po_closed THEN 'closed' ELSE 'open' END, CASE WHEN i.po_closed THEN COALESCE(i.closed_at, i.set_at) END, 'maria',
         'Missing / damaged from supplier' || COALESCE(': ' || i.reason, '') || ' — qty set to the line''s ordered units, confirm', i.set_at
    FROM items i
  RETURNING id, po_line_item_id, status
), conv AS (
  INSERT INTO supplier_claim_conversions (claim_id, source, source_id, old_value, flags)
  SELECT c.id, 'missing_damaged_item', i.item_id::text, 'Missing / damaged from supplier', ARRAY['kind_unclear', 'qty_assumed_ordered'] || CASE WHEN c.status = 'closed' THEN ARRAY['history_no_outcome'] ELSE '{}'::text[] END
    FROM created c JOIN items i ON i.po_line_item_id = c.po_line_item_id
  RETURNING claim_id
)
INSERT INTO supplier_claim_tasks (claim_id, kind, "group", reason)
SELECT c.id, 'contact_supplier', 'supplier', 'converted from "Missing / damaged from supplier": confirm what and how many, then report it' FROM created c WHERE c.status = 'open';

-- 6. Sheet write-offs: po_asins.unreimbursed_loss_qty / _amount (cols V / W) → a closed write_off claim on the row's first line,
--    kind from the row's notes (damaged / wrong / expired words), dated by the PO's last edit; the amount is the sheet's, kept as typed.
--    michaels 9800109062072825 Red Heart (B07N6V47HC, 11 / $32.25) is excluded — already refunded by the $36.11 eGift card.
WITH loss AS (
  SELECT pa.id AS po_asin_id, pa.po_id, pa.asin, pa.qty_basis, pa.units_per_pack, pa.unreimbursed_loss_qty AS lq, pa.unreimbursed_loss_amount AS la, pa.notes,
         (SELECT l.id FROM po_line_items l WHERE l.po_asin_id = pa.id ORDER BY l.position NULLS LAST, l.id LIMIT 1) AS line_id,
         (SELECT COUNT(*) FROM po_line_items l WHERE l.po_asin_id = pa.id) AS n_lines, p.order_id
    FROM po_asins pa JOIN purchase_orders p ON p.id = pa.po_id
   WHERE (COALESCE(pa.unreimbursed_loss_qty, 0) > 0 OR COALESCE(pa.unreimbursed_loss_amount, 0) > 0)
     AND NOT (p.order_id = '9800109062072825' AND pa.asin = 'B07N6V47HC')
), created AS (
  INSERT INTO supplier_claims (po_id, po_line_item_id, kind, qty, amount_owed, amount_owed_source, found_at, status, outcome, outcome_amount, write_off_reason, closed_at, found_by, note, created_at)
  SELECT x.po_id, x.line_id,
         CASE WHEN x.notes ~* 'damag|broken|leak|crush|dent' THEN 'damaged' WHEN x.notes ~* 'wrong' THEN 'wrong_item' WHEN x.notes ~* 'expir|short.?dated' THEN 'expired' ELSE 'missing' END,
         -- qty: the row's loss in its basis (Individual when converted, ASIN units on a legacy row); a $-only loss counts as 1 unit, flagged.
         CASE WHEN COALESCE(x.lq, 0) > 0 THEN x.lq ELSE 1 END,
         x.la, 'manual', po_last_edit_date(x.po_id), 'closed', 'write_off', x.la, 'sheet col V / W (unreimbursed loss)', po_last_edit_date(x.po_id)::timestamptz, 'maria',
         'sheet-era write-off (col V / W)' || COALESCE(' — ' || x.notes, ''), now()
    FROM loss x WHERE x.line_id IS NOT NULL
  RETURNING id, po_line_item_id, qty, amount_owed
)
INSERT INTO supplier_claim_conversions (claim_id, source, source_id, old_value, flags)
SELECT c.id, 'sheet_loss', x.po_asin_id::text, 'V ' || COALESCE(x.lq::text, '0') || ' / W $' || COALESCE(x.la::text, '0'),
       ARRAY(SELECT f FROM unnest(ARRAY[
         CASE WHEN x.qty_basis <> 'individual' THEN 'legacy_units' END,
         CASE WHEN COALESCE(x.lq, 0) = 0 THEN 'qty_assumed_one' END,
         CASE WHEN x.n_lines > 1 THEN 'asin_row_loss_on_first_line' END,
         CASE WHEN x.notes IS NULL THEN 'kind_unclear' END]) f WHERE f IS NOT NULL)
  FROM created c JOIN loss x ON x.line_id = c.po_line_item_id;
-- chewy 1627249988 B08F2JGCXT: 3 / $8.55, missing from AF's col V / W (§4.8).
WITH tgt AS (
  SELECT pa.id AS po_asin_id, pa.po_id, pa.qty_basis, pa.units_per_pack,
         (SELECT l.id FROM po_line_items l WHERE l.po_asin_id = pa.id ORDER BY l.position NULLS LAST, l.id LIMIT 1) AS line_id
    FROM po_asins pa JOIN purchase_orders p ON p.id = pa.po_id WHERE p.order_id = '1627249988' AND pa.asin = 'B08F2JGCXT'
      AND NOT EXISTS (SELECT 1 FROM supplier_claims c JOIN supplier_claim_conversions k ON k.claim_id = c.id WHERE k.source = 'sheet_loss_added' AND c.po_id = pa.po_id)
), created AS (
  INSERT INTO supplier_claims (po_id, po_line_item_id, kind, qty, amount_owed, amount_owed_source, found_at, status, outcome, outcome_amount, write_off_reason, closed_at, found_by, note, created_at)
  SELECT t.po_id, t.line_id, 'missing', CASE WHEN t.qty_basis = 'individual' THEN 3 * COALESCE(t.units_per_pack, 1) ELSE 3 END, 8.55, 'manual', po_last_edit_date(t.po_id), 'closed', 'write_off', 8.55,
         'sheet col V / W (unreimbursed loss) — missing from AF, added 2026-11-09 (spec §4.8)', po_last_edit_date(t.po_id)::timestamptz, 'maria', 'chewy 1627249988 B08F2JGCXT 3 / $8.55 (claims patch §4.8)', now()
    FROM tgt t WHERE t.line_id IS NOT NULL
  RETURNING id, po_line_item_id
)
INSERT INTO supplier_claim_conversions (claim_id, source, source_id, old_value, flags)
SELECT c.id, 'sheet_loss_added', t.po_asin_id::text, 'V 3 / W $8.55 (probe 2026-11-07)', ARRAY['added_by_spec'] FROM created c JOIN tgt t ON t.line_id = c.po_line_item_id;

-- Events: one 'converted' event per converted claim.
INSERT INTO supplier_claim_events (claim_id, at, type, summary)
SELECT k.claim_id, now(), 'converted', 'migration 101 (' || k.source || '): ' || COALESCE(k.old_value, '') || CASE WHEN array_length(k.flags, 1) > 0 THEN ' [' || array_to_string(k.flags, ', ') || ']' ELSE '' END
  FROM supplier_claim_conversions k;

-- 7. The converted action items are cleared (cleared_by auto, "converted to claim"); the two labels leave the vocabulary for NEW rows.
UPDATE po_line_action_items ai SET cleared_at = now(), cleared_by = 'auto', reason = COALESCE(ai.reason || ' — ', '') || 'converted to claim'
 WHERE ai.cleared_at IS NULL AND ai.item IN ('Confirm refund / replacement', 'Missing / damaged from supplier');
ALTER TABLE po_line_action_items DROP CONSTRAINT po_line_action_items_item_check;
ALTER TABLE po_line_action_items ADD CONSTRAINT po_line_action_items_item_check CHECK (
  cleared_at IS NOT NULL OR item IN ('Need to return', 'ATTN: Velocity', 'See comments', 'SHIP', 'Received - FBM', 'Review Velocity',
                                     'Confirm order details', 'Subscription renews', 'Review renewal PO', 'Subscription may be active'));
INSERT INTO po_edit_log (po_id, user_id, entity, entity_id, field, old_value, new_value, derived)
SELECT c.po_id, NULL, 'claim', c.id::text, 'claim converted', k.source, c.kind || ' ' || c.qty || ' · ' || c.status || COALESCE(' · $' || c.amount_owed::text, ''), true
  FROM supplier_claims c JOIN supplier_claim_conversions k ON k.claim_id = c.id;

-- ───────────────────────────── D2. drops ─────────────────────────────
ALTER TABLE po_line_items DROP COLUMN final_qty;
ALTER TABLE po_line_items DROP COLUMN qty_canceled;
ALTER TABLE po_line_items DROP COLUMN qty_returned;
DROP INDEX IF EXISTS po_line_refunds_status_idx;
ALTER TABLE po_line_refunds DROP COLUMN status;
COMMENT ON TABLE po_line_refunds IS 'Refunds RECEIVED (money that arrived), per PO / line. Since migration 101 what the supplier still owes lives on supplier_claims (amount_owed − Σ supplier_claim_refunds.amount_applied); there is no "due" row any more.';

-- ───────────────────────────── C. the views (§4.6) ─────────────────────────────
-- Counting rule (§3.6, read precisely): a claim's units leave Expected when it is CLOSED with any outcome but replacement (the units
-- are gone), or OPEN and either canceled (counts from the moment it is opened) or already promised a refund / credit / write-off.
-- Suggested and dismissed claims never count. A whole-PO claim (po_line_item_id NULL) spreads over the PO's lines by ordered units.
CREATE VIEW po_line_expected AS
WITH line_base AS (
  SELECT l.id, l.po_id, l.po_asin_id, l.position, l.qty_basis,
         l.retailer_units_per_product AS product_pack, l.asin_units_per_pack AS line_asin_pack, l.asin_qty_per_product AS legacy_yield, l.units_per_bundle,
         pa.sold_as, pa.units_per_pack AS asin_pack, pa.qty_basis AS row_basis,
         (SELECT COUNT(*) FROM po_line_items x WHERE x.po_asin_id = l.po_asin_id) AS row_lines,
         l.qty_ordered, l.qty_received
    FROM po_line_items l LEFT JOIN po_asins pa ON pa.id = l.po_asin_id
), lb AS (
  SELECT b.*,
         CASE WHEN b.sold_as = 'bundle' THEN COALESCE(b.units_per_bundle, CASE WHEN b.asin_pack IS NOT NULL AND b.row_lines > 0 AND b.asin_pack % b.row_lines = 0 THEN b.asin_pack / b.row_lines END)::int END AS per_bundle,
         -- Individual units per ASIN unit for this line's ASIN units: the row's pack (the line's own when the row has none).
         COALESCE(b.asin_pack, b.line_asin_pack) AS eff_asin_pack
    FROM line_base b
), line_claims AS (
  SELECT c.po_line_item_id AS line_id,
         SUM(c.qty) FILTER (WHERE c.kind = 'canceled') AS canceled_q,
         SUM(c.qty) FILTER (WHERE c.kind = 'returned') AS returned_q,
         SUM(c.qty) AS claimed_q,
         BOOL_OR(c.kind = 'canceled') AS any_canceled
    FROM supplier_claims c
   WHERE c.po_line_item_id IS NOT NULL
     AND ((c.status = 'closed' AND c.outcome IS DISTINCT FROM 'replacement')
          OR (c.status = 'open' AND (c.kind = 'canceled' OR c.outcome IN ('refund_card', 'gift_card', 'store_credit', 'write_off'))))
   GROUP BY c.po_line_item_id
), po_claims AS (
  SELECT c.po_id,
         SUM(c.qty) FILTER (WHERE c.kind = 'canceled') AS canceled_q,
         SUM(c.qty) FILTER (WHERE c.kind = 'returned') AS returned_q,
         SUM(c.qty) AS claimed_q
    FROM supplier_claims c
   WHERE c.po_line_item_id IS NULL
     AND ((c.status = 'closed' AND c.outcome IS DISTINCT FROM 'replacement')
          OR (c.status = 'open' AND (c.kind = 'canceled' OR c.outcome IN ('refund_card', 'gift_card', 'store_credit', 'write_off'))))
   GROUP BY c.po_id
), po_ordered AS (
  SELECT po_id, SUM(CASE WHEN qty_basis = 'individual' THEN qty_ordered END) AS tot_individual FROM lb GROUP BY po_id
), q AS (
  SELECT lb.*,
         -- the line's own claims are in its basis; a whole-PO claim's share is Individual and lands on converted lines only
         COALESCE(lc.canceled_q, 0) + CASE WHEN lb.qty_basis = 'individual' AND po.tot_individual > 0 THEN COALESCE(pc.canceled_q, 0) * lb.qty_ordered / po.tot_individual ELSE 0 END AS canceled_base,
         COALESCE(lc.returned_q, 0) + CASE WHEN lb.qty_basis = 'individual' AND po.tot_individual > 0 THEN COALESCE(pc.returned_q, 0) * lb.qty_ordered / po.tot_individual ELSE 0 END AS returned_base,
         COALESCE(lc.claimed_q, 0) + CASE WHEN lb.qty_basis = 'individual' AND po.tot_individual > 0 THEN COALESCE(pc.claimed_q, 0) * lb.qty_ordered / po.tot_individual ELSE 0 END AS claimed_base,
         COALESCE(lc.any_canceled, false) OR COALESCE(pc.canceled_q, 0) > 0 AS any_canceled
    FROM lb LEFT JOIN line_claims lc ON lc.line_id = lb.id LEFT JOIN po_claims pc ON pc.po_id = lb.po_id LEFT JOIN po_ordered po ON po.po_id = lb.po_id
), u AS (
  -- one expression per kind: base → Individual / Product / ASIN
  SELECT q.*,
         GREATEST(COALESCE(q.qty_ordered, 0) - q.claimed_base, 0) AS expected_base
    FROM q
), o AS (
SELECT u.id AS line_id, u.po_id, u.po_asin_id, u.position, u.qty_basis, u.product_pack, u.eff_asin_pack AS asin_pack, u.per_bundle, u.sold_as,
       -- ordered
       CASE WHEN u.qty_basis = 'individual' THEN u.qty_ordered ELSE u.qty_ordered * u.product_pack END AS ordered_individual,
       CASE WHEN u.qty_basis = 'individual' THEN u.qty_ordered / NULLIF(u.product_pack, 0) ELSE u.qty_ordered END AS ordered_product,
       CASE WHEN u.qty_basis = 'individual' THEN (CASE WHEN u.sold_as = 'bundle' THEN u.qty_ordered / NULLIF(u.per_bundle, 0) ELSE u.qty_ordered / NULLIF(u.eff_asin_pack, 0) END)
            ELSE u.qty_ordered * COALESCE(u.legacy_yield, 1) END AS ordered_asin,
       -- received (the line's own count; a Velocity PO reads the ASIN row's Received by Velocity instead)
       CASE WHEN u.qty_basis = 'individual' THEN u.qty_received ELSE u.qty_received * u.product_pack END AS received_individual,
       CASE WHEN u.qty_basis = 'individual' THEN u.qty_received / NULLIF(u.product_pack, 0) ELSE u.qty_received END AS received_product,
       CASE WHEN u.qty_basis = 'individual' THEN (CASE WHEN u.sold_as = 'bundle' THEN u.qty_received / NULLIF(u.per_bundle, 0) ELSE u.qty_received / NULLIF(u.eff_asin_pack, 0) END)
            ELSE u.qty_received * COALESCE(u.legacy_yield, 1) END AS received_asin,
       -- Σ canceled / returned / claimed
       CASE WHEN u.qty_basis = 'individual' THEN u.canceled_base ELSE u.canceled_base * u.product_pack END AS canceled_individual,
       CASE WHEN u.qty_basis = 'individual' THEN u.canceled_base / NULLIF(u.product_pack, 0) ELSE u.canceled_base END AS canceled_product,
       CASE WHEN u.qty_basis = 'individual' THEN (CASE WHEN u.sold_as = 'bundle' THEN u.canceled_base / NULLIF(u.per_bundle, 0) ELSE u.canceled_base / NULLIF(u.eff_asin_pack, 0) END)
            ELSE u.canceled_base * COALESCE(u.legacy_yield, 1) END AS canceled_asin,
       CASE WHEN u.qty_basis = 'individual' THEN u.returned_base ELSE u.returned_base * u.product_pack END AS returned_individual,
       CASE WHEN u.qty_basis = 'individual' THEN u.returned_base / NULLIF(u.product_pack, 0) ELSE u.returned_base END AS returned_product,
       CASE WHEN u.qty_basis = 'individual' THEN (CASE WHEN u.sold_as = 'bundle' THEN u.returned_base / NULLIF(u.per_bundle, 0) ELSE u.returned_base / NULLIF(u.eff_asin_pack, 0) END)
            ELSE u.returned_base * COALESCE(u.legacy_yield, 1) END AS returned_asin,
       CASE WHEN u.qty_basis = 'individual' THEN u.claimed_base ELSE u.claimed_base * u.product_pack END AS claimed_individual,
       CASE WHEN u.qty_basis = 'individual' THEN u.claimed_base / NULLIF(u.product_pack, 0) ELSE u.claimed_base END AS claimed_product,
       CASE WHEN u.qty_basis = 'individual' THEN (CASE WHEN u.sold_as = 'bundle' THEN u.claimed_base / NULLIF(u.per_bundle, 0) ELSE u.claimed_base / NULLIF(u.eff_asin_pack, 0) END)
            ELSE u.claimed_base * COALESCE(u.legacy_yield, 1) END AS claimed_asin,
       -- expected = ordered − claimed (floored at 0)
       CASE WHEN u.qty_basis = 'individual' THEN u.expected_base ELSE u.expected_base * u.product_pack END AS expected_individual,
       CASE WHEN u.qty_basis = 'individual' THEN u.expected_base / NULLIF(u.product_pack, 0) ELSE u.expected_base END AS expected_product,
       CASE WHEN u.qty_basis = 'individual' THEN (CASE WHEN u.sold_as = 'bundle' THEN u.expected_base / NULLIF(u.per_bundle, 0) ELSE u.expected_base / NULLIF(u.eff_asin_pack, 0) END)
            ELSE u.expected_base * COALESCE(u.legacy_yield, 1) END AS expected_asin,
       -- fully canceled: the canceled claims cover the ordered units; a line with nothing ordered is canceled when a canceled claim marks it (a 0 / 0 sheet line)
       ((COALESCE(u.qty_ordered, 0) > 0 AND u.canceled_base >= u.qty_ordered) OR (COALESCE(u.qty_ordered, 0) = 0 AND u.any_canceled)) AS fully_canceled
  FROM u
)
SELECT line_id, po_id, po_asin_id, position, qty_basis, product_pack, asin_pack, per_bundle, sold_as,
       ROUND(ordered_individual, 2) AS ordered_individual,
       ROUND(ordered_product, 2) AS ordered_product,
       ROUND(ordered_asin, 2) AS ordered_asin,
       ROUND(received_individual, 2) AS received_individual,
       ROUND(received_product, 2) AS received_product,
       ROUND(received_asin, 2) AS received_asin,
       ROUND(canceled_individual, 2) AS canceled_individual,
       ROUND(canceled_product, 2) AS canceled_product,
       ROUND(canceled_asin, 2) AS canceled_asin,
       ROUND(returned_individual, 2) AS returned_individual,
       ROUND(returned_product, 2) AS returned_product,
       ROUND(returned_asin, 2) AS returned_asin,
       ROUND(claimed_individual, 2) AS claimed_individual,
       ROUND(claimed_product, 2) AS claimed_product,
       ROUND(claimed_asin, 2) AS claimed_asin,
       ROUND(expected_individual, 2) AS expected_individual,
       ROUND(expected_product, 2) AS expected_product,
       ROUND(expected_asin, 2) AS expected_asin,
       fully_canceled
  FROM o;
COMMENT ON VIEW po_line_expected IS 'SPEC §22 "Supplier claims" §4.6 (migration 101): per product line, ordered / received / Σ canceled / Σ returned / Σ claimed / expected in Individual, Product and ASIN units from the stored Individual base (D17); a product_legacy line reads its stored Product units as before. The ONLY source for every net-quantity reader.';

CREATE VIEW po_asin_expected AS
WITH l AS (
  SELECT e.po_asin_id,
         COUNT(*)::int AS line_count,
         SUM(e.canceled_asin) AS canceled_asin_sum, SUM(e.returned_asin) AS returned_asin_sum, SUM(e.claimed_asin) AS claimed_asin_sum,
         SUM(e.canceled_individual) AS canceled_individual_sum, SUM(e.returned_individual) AS returned_individual_sum, SUM(e.claimed_individual) AS claimed_individual_sum,
         MIN(e.expected_asin) AS min_expected_asin, MIN(e.ordered_asin) AS min_ordered_asin,
         CASE WHEN COUNT(DISTINCT e.product_pack) = 1 AND COUNT(*) FILTER (WHERE e.product_pack IS NULL) = 0 THEN MIN(e.product_pack) END AS product_pack,
         BOOL_OR(e.qty_basis <> 'individual') AS any_legacy_line,
         BOOL_AND(e.fully_canceled) AS all_lines_canceled
    FROM po_line_expected e GROUP BY e.po_asin_id
), oc AS (
  SELECT li.po_asin_id, COUNT(*) AS n FROM supplier_claims c JOIN po_line_items li ON li.id = c.po_line_item_id WHERE c.status = 'open' GROUP BY li.po_asin_id
), base AS (
  SELECT pa.id, pa.po_id, pa.asin, pa.qty_basis, pa.sold_as, pa.units_per_pack, pa.unique_products,
         (pa.qty_basis = 'individual') AS ind, pa.units_per_pack AS upp, l.product_pack, l.line_count, l.any_legacy_line, l.all_lines_canceled,
         pa.qty, pa.qty_shipped_supplier, pa.received_velocity, pa.qty_at_prep, pa.qty_at_warehouse, pa.qty_lost_damaged_us, pa.qty_shipped_fba, pa.qty_received_amazon, pa.unreimbursed_loss_qty,
         -- ASIN units ordered: Individual ÷ pack, or the legacy stored value
         CASE WHEN pa.qty_basis = 'individual' THEN pa.qty / NULLIF(pa.units_per_pack, 0) ELSE pa.qty END AS ordered_asin_v,
         l.canceled_asin_sum, l.returned_asin_sum, l.claimed_asin_sum, l.canceled_individual_sum, l.returned_individual_sum, l.claimed_individual_sum, l.min_expected_asin,
         COALESCE(oc.n, 0)::int AS open_claims
    FROM po_asins pa LEFT JOIN l ON l.po_asin_id = pa.id LEFT JOIN oc ON oc.po_asin_id = pa.id
), x AS (
  SELECT b.*,
         -- expected ASIN units: a bundle builds as many as its scarcest component's expected units allow; otherwise ordered − Σ claimed
         CASE WHEN b.sold_as = 'bundle' AND b.min_expected_asin IS NOT NULL THEN LEAST(COALESCE(b.ordered_asin_v, 0), b.min_expected_asin)
              ELSE GREATEST(COALESCE(b.ordered_asin_v, 0) - COALESCE(b.claimed_asin_sum, 0), 0) END AS expected_asin_v
    FROM base b
), o AS (
SELECT x.id, x.po_id, x.asin, x.qty_basis, x.sold_as, x.units_per_pack, x.unique_products, x.product_pack, x.line_count, x.any_legacy_line, x.open_claims,
       x.ordered_asin_v AS ordered_asin,
       CASE WHEN x.ind THEN x.qty END AS ordered_individual,
       CASE WHEN x.ind THEN x.qty / NULLIF(x.product_pack, 0) END AS ordered_product,
       x.expected_asin_v AS expected_asin,
       CASE WHEN x.ind THEN x.expected_asin_v * x.upp END AS expected_individual,
       CASE WHEN x.ind THEN x.expected_asin_v * x.upp / NULLIF(x.product_pack, 0) END AS expected_product,
       -- Σ claims on the row's lines (a bundle: ordered − expected, split by the canceled / returned share)
       CASE WHEN x.sold_as = 'bundle' THEN CASE WHEN COALESCE(x.claimed_asin_sum, 0) > 0 THEN (COALESCE(x.ordered_asin_v, 0) - x.expected_asin_v) * COALESCE(x.canceled_asin_sum, 0) / x.claimed_asin_sum ELSE 0 END
            ELSE COALESCE(x.canceled_asin_sum, 0) END AS canceled_asin,
       CASE WHEN x.sold_as = 'bundle' THEN CASE WHEN COALESCE(x.claimed_asin_sum, 0) > 0 THEN (COALESCE(x.ordered_asin_v, 0) - x.expected_asin_v) * COALESCE(x.returned_asin_sum, 0) / x.claimed_asin_sum ELSE 0 END
            ELSE COALESCE(x.returned_asin_sum, 0) END AS returned_asin,
       CASE WHEN x.sold_as = 'bundle' THEN COALESCE(x.ordered_asin_v, 0) - x.expected_asin_v ELSE COALESCE(x.claimed_asin_sum, 0) END AS claimed_asin,
       CASE WHEN x.ind THEN COALESCE(x.canceled_individual_sum, 0) END AS canceled_individual,
       CASE WHEN x.ind THEN COALESCE(x.returned_individual_sum, 0) END AS returned_individual,
       CASE WHEN x.ind THEN COALESCE(x.claimed_individual_sum, 0) END AS claimed_individual,
       COALESCE(x.all_lines_canceled, false) AS fully_canceled,
       -- the stage quantities: ASIN units (÷ pack, or as stored on a legacy row), Individual (converted rows), Product (one pack over the lines)
       CASE WHEN x.ind THEN x.qty_shipped_supplier / NULLIF(x.upp, 0) ELSE x.qty_shipped_supplier END AS shipped_supplier_asin,
       CASE WHEN x.ind THEN x.qty_shipped_supplier END AS shipped_supplier_individual,
       CASE WHEN x.ind THEN x.qty_shipped_supplier / NULLIF(x.product_pack, 0) END AS shipped_supplier_product,
       CASE WHEN x.ind THEN x.received_velocity / NULLIF(x.upp, 0) ELSE x.received_velocity END AS received_velocity_asin,
       CASE WHEN x.ind THEN x.received_velocity END AS received_velocity_individual,
       CASE WHEN x.ind THEN x.received_velocity / NULLIF(x.product_pack, 0) END AS received_velocity_product,
       CASE WHEN x.ind THEN x.qty_at_prep / NULLIF(x.upp, 0) ELSE x.qty_at_prep END AS at_prep_asin,
       CASE WHEN x.ind THEN x.qty_at_prep END AS at_prep_individual,
       CASE WHEN x.ind THEN x.qty_at_prep / NULLIF(x.product_pack, 0) END AS at_prep_product,
       CASE WHEN x.ind THEN x.qty_at_warehouse / NULLIF(x.upp, 0) ELSE x.qty_at_warehouse END AS at_warehouse_asin,
       CASE WHEN x.ind THEN x.qty_at_warehouse END AS at_warehouse_individual,
       CASE WHEN x.ind THEN x.qty_at_warehouse / NULLIF(x.product_pack, 0) END AS at_warehouse_product,
       CASE WHEN x.ind THEN x.qty_lost_damaged_us / NULLIF(x.upp, 0) ELSE x.qty_lost_damaged_us END AS lost_damaged_us_asin,
       CASE WHEN x.ind THEN x.qty_lost_damaged_us END AS lost_damaged_us_individual,
       CASE WHEN x.ind THEN x.qty_lost_damaged_us / NULLIF(x.product_pack, 0) END AS lost_damaged_us_product,
       CASE WHEN x.ind THEN x.qty_shipped_fba / NULLIF(x.upp, 0) ELSE x.qty_shipped_fba END AS shipped_fba_asin,
       CASE WHEN x.ind THEN x.qty_shipped_fba END AS shipped_fba_individual,
       CASE WHEN x.ind THEN x.qty_shipped_fba / NULLIF(x.product_pack, 0) END AS shipped_fba_product,
       CASE WHEN x.ind THEN x.qty_received_amazon / NULLIF(x.upp, 0) ELSE x.qty_received_amazon END AS received_amazon_asin,
       CASE WHEN x.ind THEN x.qty_received_amazon END AS received_amazon_individual,
       CASE WHEN x.ind THEN x.qty_received_amazon / NULLIF(x.product_pack, 0) END AS received_amazon_product,
       CASE WHEN x.ind THEN x.unreimbursed_loss_qty / NULLIF(x.upp, 0) ELSE x.unreimbursed_loss_qty END AS loss_asin,
       CASE WHEN x.ind THEN x.unreimbursed_loss_qty END AS loss_individual
  FROM x
)
SELECT id, po_id, asin, qty_basis, sold_as, units_per_pack, unique_products, product_pack, line_count, any_legacy_line, open_claims, fully_canceled,
       ROUND(ordered_asin, 2) AS ordered_asin,
       ROUND(ordered_individual, 2) AS ordered_individual,
       ROUND(ordered_product, 2) AS ordered_product,
       ROUND(expected_asin, 2) AS expected_asin,
       ROUND(expected_individual, 2) AS expected_individual,
       ROUND(expected_product, 2) AS expected_product,
       ROUND(canceled_asin, 2) AS canceled_asin,
       ROUND(returned_asin, 2) AS returned_asin,
       ROUND(claimed_asin, 2) AS claimed_asin,
       ROUND(canceled_individual, 2) AS canceled_individual,
       ROUND(returned_individual, 2) AS returned_individual,
       ROUND(claimed_individual, 2) AS claimed_individual,
       ROUND(shipped_supplier_asin, 2) AS shipped_supplier_asin,
       ROUND(shipped_supplier_individual, 2) AS shipped_supplier_individual,
       ROUND(shipped_supplier_product, 2) AS shipped_supplier_product,
       ROUND(received_velocity_asin, 2) AS received_velocity_asin,
       ROUND(received_velocity_individual, 2) AS received_velocity_individual,
       ROUND(received_velocity_product, 2) AS received_velocity_product,
       ROUND(at_prep_asin, 2) AS at_prep_asin,
       ROUND(at_prep_individual, 2) AS at_prep_individual,
       ROUND(at_prep_product, 2) AS at_prep_product,
       ROUND(at_warehouse_asin, 2) AS at_warehouse_asin,
       ROUND(at_warehouse_individual, 2) AS at_warehouse_individual,
       ROUND(at_warehouse_product, 2) AS at_warehouse_product,
       ROUND(lost_damaged_us_asin, 2) AS lost_damaged_us_asin,
       ROUND(lost_damaged_us_individual, 2) AS lost_damaged_us_individual,
       ROUND(lost_damaged_us_product, 2) AS lost_damaged_us_product,
       ROUND(shipped_fba_asin, 2) AS shipped_fba_asin,
       ROUND(shipped_fba_individual, 2) AS shipped_fba_individual,
       ROUND(shipped_fba_product, 2) AS shipped_fba_product,
       ROUND(received_amazon_asin, 2) AS received_amazon_asin,
       ROUND(received_amazon_individual, 2) AS received_amazon_individual,
       ROUND(received_amazon_product, 2) AS received_amazon_product,
       ROUND(loss_asin, 2) AS loss_asin,
       ROUND(loss_individual, 2) AS loss_individual
  FROM o;
COMMENT ON VIEW po_asin_expected IS 'SPEC §22 "Supplier claims" §4.6 (migration 101): per ASIN row, every quantity in ASIN / Individual / Product units from the stored Individual base (D17), expected = ordered − Σ claims (a bundle: min over components), open_claims (D15). On Order, auto-close, the Velocity plan, the PO editor and the Dashboard read it; nothing divides by a pack size on its own any more.';
