-- Supplier claims (SPEC §22 "Supplier claims" §3.3, Maria 2026-11-12): the timer never starts before the supplier was
-- contacted. Every open claim that was never reported (reported_at NULL, no supplier confirmation, not an emailed
-- cancellation) carries an open contact_supplier task — the "Contacted supplier" control — so it sits in Needs
-- attention, not in Waiting on supplier with a timer that started from nothing (the converted never_received claim
-- "no_poid_at_checkout" on production had no task and showed Waiting on supplier).
INSERT INTO supplier_claim_tasks (claim_id, kind, "group", reason)
SELECT c.id, 'contact_supplier', 'supplier', 'report the claim to the supplier — the timer starts from the report date'
  FROM supplier_claims c
 WHERE c.status = 'open' AND c.reported_at IS NULL AND c.supplier_confirmed_at IS NULL
   AND NOT (c.kind = 'canceled' AND c.found_by = 'email')
   AND NOT EXISTS (SELECT 1 FROM supplier_claim_tasks t WHERE t.claim_id = c.id AND t.kind = 'contact_supplier');
-- A Follow up the old timer created on an unreported claim (the timer had started from the found date) is not real:
-- the claim was never reported, so there is nothing to follow up — removed (3 on production, 2026-11-12). The sweep
-- recreates one 5 business days after the report, if the supplier stays silent.
DELETE FROM supplier_claim_tasks t
 USING supplier_claims c
 WHERE c.id = t.claim_id AND t.kind IN ('follow_up_supplier', 'check_on_it') AND t.done_at IS NULL
   AND c.status = 'open' AND c.reported_at IS NULL AND c.supplier_confirmed_at IS NULL
   AND NOT (c.kind = 'canceled' AND c.found_by = 'email')
   AND NOT EXISTS (SELECT 1 FROM supplier_claim_tasks x WHERE x.claim_id = c.id AND x.kind = 'contact_supplier' AND x.done_at IS NOT NULL);
