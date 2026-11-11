-- Supplier claims (SPEC §22 "Supplier claims" D6, Maria 2026-11-11): the Refund received tick opens when the supplier
-- confirms (the second of D6's two ticks), not at Set outcome. Migration 101 opened one on every converted
-- "confirm refund / item" badge claim (no outcome, no confirmation yet); those ticks are removed. A canceled claim keeps
-- its tick: the cancellation is the supplier's word (cancelLines). Confirmed by supplier re-creates the tick as before.
DELETE FROM supplier_claim_tasks t
USING supplier_claims c
WHERE c.id = t.claim_id AND t.kind = 'refund_received' AND t.done_at IS NULL
  AND c.status = 'open' AND c.supplier_confirmed_at IS NULL AND c.kind <> 'canceled';
