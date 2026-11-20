// SQL every Finances reader shares (patch commits 3 / 5): the LIVE shipment
// and refund rows — per natural key (order id, shipment id, SKU) / (order id,
// refund id, SKU) the RELEASED state when one exists, else the DEFERRED one;
// a superseded DEFERRED row never counts (SPEC §3: nothing is added twice,
// transactionId is never the key).

/** One row per live shipment transaction × SKU: the transaction chosen for its natural key. */
export const LIVE_SHIPMENT_TX_SQL = `
  SELECT DISTINCT ON (t.order_id, t.shipment_id, l.sku) t.transaction_id, t.order_id, t.shipment_id, l.sku, t.transaction_status, t.posted_day, t.posted_at
    FROM finances_transactions t
    JOIN finances_lines l ON l.transaction_id = t.transaction_id
   WHERE t.transaction_type = 'Shipment' AND t.superseded_at IS NULL
   ORDER BY t.order_id, t.shipment_id, l.sku, (t.transaction_status = 'RELEASED') DESC, t.posted_at DESC`;

/** One row per live refund transaction × SKU. */
export const LIVE_REFUND_TX_SQL = `
  SELECT DISTINCT ON (t.order_id, t.refund_id, l.sku) t.transaction_id, t.order_id, t.refund_id, l.sku, t.transaction_status, t.posted_day, t.posted_at
    FROM finances_transactions t
    JOIN finances_lines l ON l.transaction_id = t.transaction_id
   WHERE t.transaction_type = 'Refund' AND t.superseded_at IS NULL
   ORDER BY t.order_id, t.refund_id, l.sku, (t.transaction_status = 'RELEASED') DESC, t.posted_at DESC`;

/** The units a live transaction row shipped of one SKU: Σ over its items (a transaction can list the same SKU twice — 7 + 3 on order 114-7199344-3666669) of each item's quantity. Correlates on `live`. */
export const TX_SKU_QTY_SQL = `SELECT SUM(z.q) AS qty FROM (SELECT MAX(x.quantity) AS q FROM finances_lines x WHERE x.transaction_id = live.transaction_id AND x.sku IS NOT DISTINCT FROM live.sku GROUP BY x.item_index) z`;

/** `live_qty`: units shipped per (order id, SKU) over the live rows — computed per transaction row, never through the lines join (which multiplies by the number of fee lines). Needs `live`. */
export const LIVE_QTY_CTE_SQL = `live_qty AS (
    SELECT live.order_id, live.sku, SUM(tq.qty) AS qty
      FROM live LEFT JOIN LATERAL (${"${TX_SKU_QTY_SQL}"}) tq ON true
     GROUP BY live.order_id, live.sku)`.replace("${TX_SKU_QTY_SQL}", TX_SKU_QTY_SQL);

/**
 * Per (order id, SKU): what Amazon's live shipment rows say — principal, promotion,
 * fees, the quantity shipped and whether any of it is still DEFERRED. $1 = the order
 * ids to read (text[]); NULL = every order.
 */
export const ORDER_SKU_FINANCES_SQL = `
  WITH live AS (${LIVE_SHIPMENT_TX_SQL}),
  ${LIVE_QTY_CTE_SQL}
  SELECT l.order_id, l.sku,
         COALESCE(SUM(l.amount) FILTER (WHERE l.line = 'sales'), 0)::float8        AS principal,
         COALESCE(SUM(l.amount) FILTER (WHERE l.line = 'promo'), 0)::float8        AS promo,
         COALESCE(SUM(l.amount) FILTER (WHERE l.line = 'fba_fee'), 0)::float8      AS fba_fee,
         COALESCE(SUM(l.amount) FILTER (WHERE l.line = 'referral_fee'), 0)::float8 AS referral_fee,
         COALESCE(SUM(l.amount) FILTER (WHERE l.line = 'vcf'), 0)::float8          AS vcf,
         COALESCE(SUM(l.amount) FILTER (WHERE l.line LIKE 'fee:%'), 0)::float8     AS other_fee,
         COALESCE(MAX(lq.qty), 0)::int                                              AS quantity,
         bool_or(live.transaction_status = 'DEFERRED')                              AS any_deferred
    FROM live
    JOIN finances_lines l ON l.transaction_id = live.transaction_id AND l.sku IS NOT DISTINCT FROM live.sku
    LEFT JOIN live_qty lq ON lq.order_id = live.order_id AND lq.sku IS NOT DISTINCT FROM live.sku
   WHERE ($1::text[] IS NULL OR l.order_id = ANY($1::text[]))
   GROUP BY l.order_id, l.sku`;
