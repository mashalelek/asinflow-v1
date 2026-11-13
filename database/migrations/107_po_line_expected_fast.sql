-- 107: po_line_expected rewritten so a per-line read is an index lookup (2026-11-13, the 502s of 11/12–11/13).
--
-- The migration-101 definition built the whole view (a CTE referenced twice, so materialized: all 4,044 lines, a
-- COUNT(*) per line) before it could apply any WHERE — a correlated `(SELECT fully_canceled FROM po_line_expected
-- WHERE line_id = l.id)` cost 100–700 ms EACH on production. Capture PO's history lookup ran it once per PO line of
-- the supplier (walmart.com: 1,066 → 43 s – 3.5 min per call, up to six calls per capture), the pool filled, /health
-- timed out and Render restarted the instance (01:14 and 01:20 UTC on 11/13; 23:49 UTC on 11/12 the same way).
--
-- Same columns, same types, same values (checked row for row on production before this file was written: both
-- EXCEPT ALL directions empty over all 4,044 lines and 3,967 rows). The shape is one flat SELECT over po_line_items
-- with two LATERAL lookups per line (the PO's lines: row line count + Individual total; the PO's counting claims: the
-- line's own and the whole-PO ones) — nothing grouped or materialized, so the planner pulls the view up into the
-- caller's query and a `WHERE line_id = $1` / `po_asin_id = $1` / `po_id = $1` reaches the po_line_items indexes
-- (0.1 ms on production). A whole-view read costs two index reads per line (~0.4 s on the 0.1-CPU Basic instance,
-- against 0.3 s before); the per-row readers — the POs list, the Dashboard, the sweep, the PO page — were the
-- ones paying 0.1–0.7 s per row. A line's claims carry the line's po_id (addClaim; 0 mismatches on production).
--
-- Counting rule (§3.6, unchanged): a claim's units leave Expected when it is CLOSED with any outcome but replacement,
-- or OPEN and either canceled or already promised a refund / credit / write-off. Suggested and dismissed never count.
-- A whole-PO claim (po_line_item_id NULL) spreads over the PO's converted lines by ordered Individual units.
CREATE OR REPLACE VIEW po_line_expected AS
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
  FROM (
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
  FROM (
SELECT q.*, GREATEST(COALESCE(q.qty_ordered, 0) - q.claimed_base, 0) AS expected_base
  FROM (
SELECT lb.*,
       -- the line's own claims are in its basis; a whole-PO claim's share is Individual and lands on converted lines only
       COALESCE(lb.lc_canceled_q, 0) + CASE WHEN lb.qty_basis = 'individual' AND lb.tot_individual > 0 THEN COALESCE(lb.pc_canceled_q, 0) * lb.qty_ordered / lb.tot_individual ELSE 0 END AS canceled_base,
       COALESCE(lb.lc_returned_q, 0) + CASE WHEN lb.qty_basis = 'individual' AND lb.tot_individual > 0 THEN COALESCE(lb.pc_returned_q, 0) * lb.qty_ordered / lb.tot_individual ELSE 0 END AS returned_base,
       COALESCE(lb.lc_claimed_q, 0) + CASE WHEN lb.qty_basis = 'individual' AND lb.tot_individual > 0 THEN COALESCE(lb.pc_claimed_q, 0) * lb.qty_ordered / lb.tot_individual ELSE 0 END AS claimed_base,
       COALESCE(lb.lc_any_canceled, false) OR COALESCE(lb.pc_canceled_q, 0) > 0 AS any_canceled
  FROM (
SELECT b.*,
       CASE WHEN b.sold_as = 'bundle' THEN COALESCE(b.units_per_bundle, CASE WHEN b.asin_pack IS NOT NULL AND b.row_lines > 0 AND b.asin_pack % b.row_lines = 0 THEN b.asin_pack / b.row_lines END)::int END AS per_bundle,
       -- Individual units per ASIN unit for this line's ASIN units: the row's pack (the line's own when the row has none).
       COALESCE(b.asin_pack, b.line_asin_pack) AS eff_asin_pack
  FROM (
SELECT l.id, l.po_id, l.po_asin_id, l.position, l.qty_basis,
       l.retailer_units_per_product AS product_pack, l.asin_units_per_pack AS line_asin_pack, l.asin_qty_per_product AS legacy_yield, l.units_per_bundle,
       pa.sold_as, pa.units_per_pack AS asin_pack, pa.qty_basis AS row_basis,
       l.qty_ordered, l.qty_received,
       -- the row's line count and the PO's Individual total (the whole-PO claim's denominator): ONE index read of the
       -- PO's lines (a row's lines are lines of its PO)
       t.row_lines, t.tot_individual,
       cl.lc_canceled_q, cl.lc_returned_q, cl.lc_claimed_q, cl.lc_any_canceled,
       cl.pc_canceled_q, cl.pc_returned_q, cl.pc_claimed_q
  FROM po_line_items l
  LEFT JOIN po_asins pa ON pa.id = l.po_asin_id
  LEFT JOIN LATERAL (
    SELECT COUNT(*) FILTER (WHERE x.po_asin_id = l.po_asin_id) AS row_lines,
           SUM(x.qty_ordered) FILTER (WHERE x.qty_basis = 'individual') AS tot_individual
      FROM po_line_items x WHERE x.po_id = l.po_id
  ) t ON true
  -- the PO's claims that count, in ONE index read (supplier_claims_po_idx): this line's own and the whole-PO ones
  LEFT JOIN LATERAL (
    SELECT SUM(c.qty) FILTER (WHERE c.po_line_item_id = l.id AND c.kind = 'canceled') AS lc_canceled_q,
           SUM(c.qty) FILTER (WHERE c.po_line_item_id = l.id AND c.kind = 'returned') AS lc_returned_q,
           SUM(c.qty) FILTER (WHERE c.po_line_item_id = l.id) AS lc_claimed_q,
           BOOL_OR(c.kind = 'canceled') FILTER (WHERE c.po_line_item_id = l.id) AS lc_any_canceled,
           SUM(c.qty) FILTER (WHERE c.po_line_item_id IS NULL AND c.kind = 'canceled') AS pc_canceled_q,
           SUM(c.qty) FILTER (WHERE c.po_line_item_id IS NULL AND c.kind = 'returned') AS pc_returned_q,
           SUM(c.qty) FILTER (WHERE c.po_line_item_id IS NULL) AS pc_claimed_q
      FROM supplier_claims c
     WHERE c.po_id = l.po_id
       AND ((c.status = 'closed' AND c.outcome IS DISTINCT FROM 'replacement')
            OR (c.status = 'open' AND (c.kind = 'canceled' OR c.outcome IN ('refund_card', 'gift_card', 'store_credit', 'write_off'))))
  ) cl ON true
  ) b
  ) lb
  ) q
  ) u
  ) o;
CREATE OR REPLACE VIEW po_asin_expected AS
-- 107: the line sums and the open-claim count are keyed by (po_asin_id, po_id) — a line's po_id is its row's po_id, so the
-- join is the same; the second key lets a caller's `WHERE po_id = $1` reach idx_po_lines_po inside the grouped subquery
-- (a grouping column is pushed down; `id = $1` always was). Whole-view reads keep the one hash aggregate.
WITH l AS (
  SELECT e.po_asin_id, e.po_id,
         COUNT(*)::int AS line_count,
         SUM(e.canceled_asin) AS canceled_asin_sum, SUM(e.returned_asin) AS returned_asin_sum, SUM(e.claimed_asin) AS claimed_asin_sum,
         SUM(e.canceled_individual) AS canceled_individual_sum, SUM(e.returned_individual) AS returned_individual_sum, SUM(e.claimed_individual) AS claimed_individual_sum,
         MIN(e.expected_asin) AS min_expected_asin, MIN(e.ordered_asin) AS min_ordered_asin,
         CASE WHEN COUNT(DISTINCT e.product_pack) = 1 AND COUNT(*) FILTER (WHERE e.product_pack IS NULL) = 0 THEN MIN(e.product_pack) END AS product_pack,
         BOOL_OR(e.qty_basis <> 'individual') AS any_legacy_line,
         BOOL_AND(e.fully_canceled) AS all_lines_canceled
    FROM po_line_expected e GROUP BY e.po_asin_id, e.po_id
), oc AS (
  SELECT li.po_asin_id, li.po_id, COUNT(*) AS n FROM supplier_claims c JOIN po_line_items li ON li.id = c.po_line_item_id WHERE c.status = 'open' GROUP BY li.po_asin_id, li.po_id
), base AS (
  SELECT pa.id, pa.po_id, pa.asin, pa.qty_basis, pa.sold_as, pa.units_per_pack, pa.unique_products,
         (pa.qty_basis = 'individual') AS ind, pa.units_per_pack AS upp, l.product_pack, l.line_count, l.any_legacy_line, l.all_lines_canceled,
         pa.qty, pa.qty_shipped_supplier, pa.received_velocity, pa.qty_at_prep, pa.qty_at_warehouse, pa.qty_lost_damaged_us, pa.qty_shipped_fba, pa.qty_received_amazon, pa.unreimbursed_loss_qty,
         -- ASIN units ordered: Individual ÷ pack, or the legacy stored value
         CASE WHEN pa.qty_basis = 'individual' THEN pa.qty / NULLIF(pa.units_per_pack, 0) ELSE pa.qty END AS ordered_asin_v,
         l.canceled_asin_sum, l.returned_asin_sum, l.claimed_asin_sum, l.canceled_individual_sum, l.returned_individual_sum, l.claimed_individual_sum, l.min_expected_asin,
         COALESCE(oc.n, 0)::int AS open_claims
    FROM po_asins pa LEFT JOIN l ON l.po_asin_id = pa.id AND l.po_id = pa.po_id LEFT JOIN oc ON oc.po_asin_id = pa.id AND oc.po_id = pa.po_id
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
COMMENT ON VIEW po_asin_expected IS 'SPEC §22 "Supplier claims" §4.6 (migration 101; its line sums keyed by row and PO since 107): per ASIN row, every quantity in ASIN / Individual / Product units from the stored Individual base (D17), expected = ordered − Σ claims (a bundle: min over components), open_claims (D15). On Order, auto-close, the Velocity plan, the PO editor and the Dashboard read it; nothing divides by a pack size on its own any more.';

COMMENT ON VIEW po_line_expected IS 'SPEC §22 "Supplier claims" §4.6 (migration 101, rewritten flat in 107 so a per-line read is an index lookup): per product line, ordered / received / Σ canceled / Σ returned / Σ claimed / expected in Individual, Product and ASIN units from the stored Individual base (D17); a product_legacy line reads its stored Product units as before. The ONLY source for every net-quantity reader.';
