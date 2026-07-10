/**
 * Purchase Orders module — REST API (Phase 2).
 *
 * Endpoints:
 *   POST   /api/pos                                — create PO + line items + po_asins + GC links
 *   GET    /api/pos                                — list with filters / pagination / search
 *   GET    /api/pos/:id                            — full detail (LIs, po_asins, GCs, refund warning)
 *   PUT    /api/pos/:id                            — update order-level fields (+ optional GC sync); recalcs COGS
 *   DELETE /api/pos/:id                            — hard delete (CASCADE wipes children)
 *   POST   /api/pos/:id/line-items                 — add a line item + its po_asins; auto-update PO status
 *   PUT    /api/pos/:id/line-items/:lineItemId    — update LI; auto-update LI + PO status; recalc COGS
 *   DELETE /api/pos/:id/line-items/:lineItemId    — delete LI (cascades po_asins); auto-update PO status
 *
 * Auto-update behavior:
 *   - LI status: derived from qty fields per spec (Canceled / Returned / Received in Full / Partial / Ordered).
 *     User-set 'Shipped FBA' or 'FBM' is preserved (not overwritten by auto-calc).
 *   - PO status: derived from LI statuses, joining asins.fulfillment_channel to determine the 'Closed' case.
 *   - PO refund: if !refund_manual_override, auto-set to sum of LI refund_amounts. If manually overridden
 *     and the override doesn't match the LI sum, response includes refund_warning.
 *   - COGS: per-LI po_asins recomputed via shared/po-cogs.ts whenever any input changes (order-level fields,
 *          gift cards, or LI fields).
 *
 * Note: per spec, PO totals (order_subtotal/order_total) are user-entered, NOT auto-derived from LIs.
 * Adding/removing line items does NOT mutate the PO totals — caller is responsible.
 */
import type { Express, Request, Response } from "express";
import type pg from "pg";
import { query, isDbAvailable, withTransaction } from "./db";
import { calculateAsinCosts, type PoForCogs, type LineItemForCogs, type GiftCardForCogs } from "../shared/po-cogs";
import { log } from "./index";

// ─── Request body types ───────────────────────────────────────────────────────

type DiscType = "percentage" | "dollar" | null | undefined;

interface PoOrderFields {
  order_id?: string;
  order_date?: string;
  supplier?: string;
  order_subtotal?: number;
  shipping_cost?: number;
  tax?: number;
  order_discount?: number;
  order_discount_type?: DiscType;
  discount_description?: string | null;
  order_total?: number;
  refund?: number;
  refund_manual_override?: boolean;
  cashback_website?: "BeFrugal" | "TopCashback" | "Rakuten" | "None" | null;
  cashback_percentage?: number;
  tracking_number?: string | null;
  payment_method?: string | null;
  purchased_by?: string | null;
  is_subscription?: boolean;
  subscription_frequency?: string | null;
  subscription_next_order_date?: string | null;
  general_notes?: string | null;
  internal_email?: string | null;
  invoice_file_path?: string | null;
  status?: string;
}

interface LineItemFields {
  sku?: string | null;
  product_name?: string;
  product_price?: number;
  product_discount?: number;
  product_discount_type?: DiscType;
  qty_ordered?: number;
  qty_received?: number;
  qty_canceled?: number;
  qty_returned_refunded?: number;
  unreimbursed_lost_damaged_qty?: number;
  unreimbursed_lost_damaged_amount?: number;
  expiration_date?: string | null;
  tax_exempt?: boolean;
  unique_products_per_asin?: number;
  asin?: string;
  asin_qty_per_product?: number;
  tags?: string[] | null;
  notes?: string | null;
  refund_amount?: number;
  status?: string;
}

interface GcLinkBody { gift_card_id: string; amount_used: number }

interface PoCreateBody extends PoOrderFields {
  line_items?: LineItemFields[];
  gift_cards?: GcLinkBody[];
}

// ─── Tiny helpers ─────────────────────────────────────────────────────────────

const bad = (res: Response, msg: string, code = 400) => { res.status(code).json({ message: msg }); };
const num = (v: any): number => v == null ? 0 : Number(v);
const isStr = (v: any): v is string => typeof v === "string" && v.length > 0;

const PO_FIELDS: (keyof PoOrderFields)[] = [
  "order_id", "order_date", "supplier", "order_subtotal", "shipping_cost", "tax",
  "order_discount", "order_discount_type", "discount_description", "order_total",
  "refund", "refund_manual_override", "cashback_website", "cashback_percentage",
  "tracking_number", "payment_method", "purchased_by", "is_subscription",
  "subscription_frequency", "subscription_next_order_date", "general_notes",
  "internal_email", "invoice_file_path", "status",
];

const LI_FIELDS: (keyof LineItemFields)[] = [
  "sku", "product_name", "product_price", "product_discount", "product_discount_type",
  "qty_ordered", "qty_received", "qty_canceled", "qty_returned_refunded",
  "unreimbursed_lost_damaged_qty", "unreimbursed_lost_damaged_amount",
  "expiration_date", "tax_exempt", "unique_products_per_asin", "asin_qty_per_product",
  "tags", "notes", "refund_amount", "status",
];

// ─── Status auto-update ───────────────────────────────────────────────────────

function computeLineItemStatus(li: {
  qty_ordered: number; qty_canceled: number;
  qty_returned_refunded: number; qty_received: number; status?: string;
}): string {
  // Preserve user-set manual statuses that the auto-calc has no opinion on.
  if (li.status === "Shipped FBA" || li.status === "FBM") return li.status;
  if (li.qty_canceled >= li.qty_ordered)         return "Canceled";
  if (li.qty_returned_refunded >= li.qty_ordered) return "Returned";
  if (li.qty_received >= li.qty_ordered)          return "Received in Full";
  if (li.qty_received > 0)                        return "Received Partial";
  return "Ordered";
}

async function recomputePoStatus(client: pg.PoolClient, poId: string): Promise<void> {
  const { rows: lis } = await client.query<{ status: string; qty_received: number; fulfillment_channel: string }>(`
    SELECT li.status, li.qty_received,
           COALESCE(a.fulfillment_channel, 'FBA') AS fulfillment_channel
    FROM po_line_items li
    LEFT JOIN po_asins pa ON pa.po_line_item_id = li.id
    LEFT JOIN asins a    ON a.asin = pa.asin
    WHERE li.order_id = $1
  `, [poId]);
  if (lis.length === 0) return; // PO with no LIs: leave status untouched

  let next: string;
  const all = (pred: (l: typeof lis[number]) => boolean) => lis.every(pred);
  const some = (pred: (l: typeof lis[number]) => boolean) => lis.some(pred);

  if      (all(l => l.status === "Canceled")) next = "Canceled";
  else if (all(l => l.status === "Shipped FBA" || (l.status === "Received in Full" && l.fulfillment_channel === "FBM")))
                                              next = "Closed";
  else if (all(l => l.status === "Received in Full")) next = "Received in Full";
  else if (some(l => Number(l.qty_received) > 0))     next = "Received Partial";
  else                                                next = "Ordered";

  await client.query(`UPDATE purchase_orders SET status = $1, updated_at = NOW() WHERE id = $2`, [next, poId]);
}

// ─── Refund auto-calc + warning ───────────────────────────────────────────────

async function recomputePoRefund(client: pg.PoolClient, poId: string): Promise<void> {
  const po = await client.query<{ refund_manual_override: boolean }>(
    `SELECT refund_manual_override FROM purchase_orders WHERE id = $1`, [poId],
  );
  if (po.rows.length === 0 || po.rows[0].refund_manual_override) return;
  await client.query(
    `UPDATE purchase_orders po
     SET refund = COALESCE((SELECT SUM(refund_amount) FROM po_line_items WHERE order_id = $1), 0),
         updated_at = NOW()
     WHERE po.id = $1`, [poId],
  );
}

async function refundWarning(client: pg.PoolClient | { query: typeof query }, poId: string): Promise<{ warning: boolean; message?: string }> {
  const po = await client.query(
    `SELECT refund, refund_manual_override FROM purchase_orders WHERE id = $1`, [poId],
  );
  if (po.rows.length === 0) return { warning: false };
  const { refund, refund_manual_override } = po.rows[0];
  if (!refund_manual_override) return { warning: false };
  const sumR = await client.query(
    `SELECT COALESCE(SUM(refund_amount), 0)::numeric AS s FROM po_line_items WHERE order_id = $1`, [poId],
  );
  const sum = Number(sumR.rows[0].s);
  const r = Number(refund);
  if (sum > 0 && Math.abs(r - sum) > 0.01) {
    return { warning: true, message: `PO-level refund ($${r.toFixed(2)}) doesn't match sum of line-item refunds ($${sum.toFixed(2)})` };
  }
  return { warning: false };
}

// ─── COGS recompute ───────────────────────────────────────────────────────────

async function fetchPoForCogs(client: pg.PoolClient, poId: string): Promise<PoForCogs | null> {
  const r = await client.query(`
    SELECT order_subtotal, order_total, shipping_cost, tax, order_discount, order_discount_type
    FROM purchase_orders WHERE id = $1
  `, [poId]);
  if (r.rows.length === 0) return null;
  const p = r.rows[0];
  return {
    order_subtotal: Number(p.order_subtotal),
    order_total: Number(p.order_total),
    shipping_cost: Number(p.shipping_cost),
    tax: Number(p.tax),
    order_discount: Number(p.order_discount),
    order_discount_type: p.order_discount_type,
  };
}

async function fetchGiftCardsForCogs(client: pg.PoolClient, poId: string): Promise<GiftCardForCogs[]> {
  const r = await client.query(`
    SELECT pgc.amount_used, gc.discount_percentage
    FROM po_gift_cards pgc JOIN gift_cards gc ON gc.id = pgc.gift_card_id
    WHERE pgc.order_id = $1
  `, [poId]);
  return r.rows.map((g) => ({
    amount_used: Number(g.amount_used),
    discount_percentage: Number(g.discount_percentage),
  }));
}

async function recomputeCogsForPo(client: pg.PoolClient, poId: string): Promise<void> {
  const po = await fetchPoForCogs(client, poId);
  if (!po) return;
  const gcs = await fetchGiftCardsForCogs(client, poId);
  const { rows: lis } = await client.query(`
    SELECT li.product_price, li.product_discount, li.product_discount_type,
           li.asin_qty_per_product, li.tax_exempt,
           pa.id AS pa_id, COALESCE(a.prep_cost_per_unit, 1.00) AS prep
    FROM po_line_items li
    JOIN po_asins pa ON pa.po_line_item_id = li.id
    LEFT JOIN asins a ON a.asin = pa.asin
    WHERE li.order_id = $1
  `, [poId]);
  for (const row of lis) {
    const liFor: LineItemForCogs = {
      product_price: Number(row.product_price),
      product_discount: Number(row.product_discount),
      product_discount_type: row.product_discount_type,
      asin_qty_per_product: Number(row.asin_qty_per_product),
      tax_exempt: !!row.tax_exempt,
    };
    const r = calculateAsinCosts(po, liFor, gcs, Number(row.prep));
    await client.query(`
      UPDATE po_asins SET
        adjusted_product_cost = $1,
        cogs_per_asin_unit = $2,
        sourcing_cost_per_asin_unit = $3
      WHERE id = $4
    `, [r.adjusted_product_cost, r.cogs_per_asin_unit, r.sourcing_cost_per_asin_unit, row.pa_id]);
  }
}

async function recomputeCogsForLineItem(client: pg.PoolClient, poId: string, lineItemId: string): Promise<void> {
  const po = await fetchPoForCogs(client, poId);
  if (!po) return;
  const gcs = await fetchGiftCardsForCogs(client, poId);
  const { rows } = await client.query(`
    SELECT li.product_price, li.product_discount, li.product_discount_type,
           li.asin_qty_per_product, li.tax_exempt,
           pa.id AS pa_id, COALESCE(a.prep_cost_per_unit, 1.00) AS prep
    FROM po_line_items li
    JOIN po_asins pa ON pa.po_line_item_id = li.id
    LEFT JOIN asins a ON a.asin = pa.asin
    WHERE li.id = $1
  `, [lineItemId]);
  if (rows.length === 0) return;
  const row = rows[0];
  const liFor: LineItemForCogs = {
    product_price: Number(row.product_price),
    product_discount: Number(row.product_discount),
    product_discount_type: row.product_discount_type,
    asin_qty_per_product: Number(row.asin_qty_per_product),
    tax_exempt: !!row.tax_exempt,
  };
  const r = calculateAsinCosts(po, liFor, gcs, Number(row.prep));
  await client.query(`
    UPDATE po_asins SET adjusted_product_cost=$1, cogs_per_asin_unit=$2, sourcing_cost_per_asin_unit=$3
    WHERE id=$4
  `, [r.adjusted_product_cost, r.cogs_per_asin_unit, r.sourcing_cost_per_asin_unit, row.pa_id]);
}

// ─── Validation ───────────────────────────────────────────────────────────────

function validateLineItemQty(li: LineItemFields, ctx: string): string | null {
  const o = num(li.qty_ordered), rcv = num(li.qty_received),
        can = num(li.qty_canceled), ret = num(li.qty_returned_refunded);
  if (li.qty_ordered != null && o < 1) return `${ctx}: qty_ordered must be >= 1`;
  if (rcv + can + ret > o) {
    return `${ctx}: qty_received + qty_canceled + qty_returned_refunded (${rcv + can + ret}) exceeds qty_ordered (${o})`;
  }
  return null;
}

async function validateGiftCards(client: pg.PoolClient, links: GcLinkBody[] | undefined): Promise<string | null> {
  if (!links || links.length === 0) return null;
  for (const l of links) {
    if (!isStr(l.gift_card_id) || !(num(l.amount_used) >= 0)) {
      return `gift_cards entry invalid: ${JSON.stringify(l)}`;
    }
    const gc = await client.query(`SELECT current_balance FROM gift_cards WHERE id = $1`, [l.gift_card_id]);
    if (gc.rows.length === 0) return `gift_card ${l.gift_card_id} not found`;
    if (Number(l.amount_used) > Number(gc.rows[0].current_balance)) {
      return `gift_card ${l.gift_card_id}: amount_used ${l.amount_used} exceeds current_balance ${gc.rows[0].current_balance}`;
    }
  }
  return null;
}

function buildDynamicUpdate<T extends object>(
  body: T, allowed: (keyof T)[], startIdx: number,
): { setClause: string; values: any[] } {
  const sets: string[] = [];
  const values: any[] = [];
  let idx = startIdx;
  for (const k of allowed) {
    if (k in body) {
      sets.push(`${String(k)} = $${idx++}`);
      values.push((body as any)[k]);
    }
  }
  return { setClause: sets.join(", "), values };
}

// ─── Detail fetch (used by POST result + GET :id) ─────────────────────────────

async function getPoDetail(qExec: { query: typeof query } | pg.PoolClient, poId: string): Promise<any | null> {
  const po = await qExec.query(`SELECT * FROM purchase_orders WHERE id = $1`, [poId]);
  if (po.rows.length === 0) return null;
  const lis = await qExec.query(`
    SELECT li.*, pa.id AS po_asin_id, pa.asin, pa.qty_received AS pa_qty_received,
           pa.adjusted_product_cost, pa.cogs_per_asin_unit, pa.sourcing_cost_per_asin_unit,
           pa.receipt_date, a.title AS asin_title, a.fulfillment_channel
    FROM po_line_items li
    LEFT JOIN po_asins pa ON pa.po_line_item_id = li.id
    LEFT JOIN asins a    ON a.asin = pa.asin
    WHERE li.order_id = $1
    ORDER BY li.created_at, li.id
  `, [poId]);
  const gcs = await qExec.query(`
    SELECT pgc.id AS link_id, pgc.amount_used,
           gc.id AS gift_card_id, gc.card_number, gc.face_value, gc.amount_paid,
           gc.discount_percentage, gc.current_balance, gc.status
    FROM po_gift_cards pgc JOIN gift_cards gc ON gc.id = pgc.gift_card_id
    WHERE pgc.order_id = $1
  `, [poId]);
  const warn = await refundWarning(qExec as any, poId);
  return { po: po.rows[0], line_items: lis.rows, gift_cards: gcs.rows, refund_warning: warn };
}

// ─── Routes ───────────────────────────────────────────────────────────────────

export function registerPoRoutes(app: Express): void {

  // ─── GET /api/gift-cards ───────────────────────────────────────────────────
  // Lightweight list endpoint used by the PO entry form's gift-card picker.
  // Default returns Active only; pass ?status=all for everything.
  app.get("/api/gift-cards", async (req: Request, res: Response) => {
    if (!isDbAvailable()) return bad(res, "Database not available", 503);
    const status = (req.query.status as string | undefined) ?? "Active";
    try {
      const sql = status === "all"
        ? `SELECT id, card_number, purchase_date, face_value, amount_paid, discount_percentage, current_balance, purchase_source, status FROM gift_cards ORDER BY purchase_date DESC`
        : `SELECT id, card_number, purchase_date, face_value, amount_paid, discount_percentage, current_balance, purchase_source, status FROM gift_cards WHERE status = $1 ORDER BY purchase_date DESC`;
      const r = status === "all" ? await query(sql) : await query(sql, [status]);
      res.json({ rows: r.rows });
    } catch (err: any) {
      log(`GET /api/gift-cards error: ${err.message}`, "po");
      res.status(500).json({ message: err.message });
    }
  });

  // ─── POST /api/pos ─────────────────────────────────────────────────────────
  app.post("/api/pos", async (req: Request, res: Response) => {
    if (!isDbAvailable()) return bad(res, "Database not available", 503);
    const body = req.body as PoCreateBody;
    const required: (keyof PoOrderFields)[] = ["order_id", "order_date", "supplier", "order_subtotal", "order_total"];
    for (const f of required) if (body[f] == null) return bad(res, `Missing required field: ${String(f)}`);
    if (!Array.isArray(body.line_items) || body.line_items.length === 0) return bad(res, "At least one line_item required");

    for (let i = 0; i < body.line_items.length; i++) {
      const li = body.line_items[i];
      if (!isStr(li.product_name)) return bad(res, `line_items[${i}].product_name required`);
      if (li.product_price == null) return bad(res, `line_items[${i}].product_price required`);
      if (li.qty_ordered == null)   return bad(res, `line_items[${i}].qty_ordered required`);
      if (!isStr(li.asin))          return bad(res, `line_items[${i}].asin required`);
      if (li.asin_qty_per_product == null || !(li.asin_qty_per_product > 0))
        return bad(res, `line_items[${i}].asin_qty_per_product must be > 0`);
      const qErr = validateLineItemQty(li, `line_items[${i}]`); if (qErr) return bad(res, qErr);
    }

    try {
      const result = await withTransaction(async (client) => {
        const gcErr = await validateGiftCards(client, body.gift_cards);
        if (gcErr) throw Object.assign(new Error(gcErr), { httpCode: 400 });

        // 1. INSERT purchase_orders
        const { setClause, values } = buildDynamicUpdate(body as PoOrderFields, PO_FIELDS, 1);
        const cols = PO_FIELDS.filter((k) => k in body);
        const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
        const insertSql = `INSERT INTO purchase_orders (${cols.join(", ")}) VALUES (${placeholders}) RETURNING id`;
        let poId: string;
        try {
          const ins = await client.query(insertSql, values);
          poId = ins.rows[0].id;
        } catch (e: any) {
          if (e.code === "23505") throw Object.assign(new Error(`Order ID '${body.order_id}' already exists`), { httpCode: 409 });
          throw e;
        }

        // 2. INSERT line items + po_asins
        for (const li of body.line_items!) {
          const liCols = LI_FIELDS.filter((k) => k in li);
          const liVals = liCols.map((k) => (li as any)[k]);
          const sql = `INSERT INTO po_line_items (order_id, ${liCols.join(", ")})
                       VALUES ($1, ${liCols.map((_, i) => `$${i + 2}`).join(", ")}) RETURNING id`;
          const liIns = await client.query(sql, [poId, ...liVals]);
          const liId = liIns.rows[0].id;
          // Compute COGS for this LI and insert po_asins
          const po = await fetchPoForCogs(client, poId);
          const gcs = await fetchGiftCardsForCogs(client, poId);
          const prepR = await client.query(`SELECT COALESCE(prep_cost_per_unit, 1.00) AS p FROM asins WHERE asin = $1`, [li.asin]);
          const prep = prepR.rows.length > 0 ? Number(prepR.rows[0].p) : 1;
          const cogs = calculateAsinCosts(po!, {
            product_price: Number(li.product_price), product_discount: num(li.product_discount),
            product_discount_type: li.product_discount_type, asin_qty_per_product: Number(li.asin_qty_per_product),
            tax_exempt: !!li.tax_exempt,
          }, gcs, prep);
          await client.query(`
            INSERT INTO po_asins (order_id, po_line_item_id, asin, qty_received, adjusted_product_cost, cogs_per_asin_unit, sourcing_cost_per_asin_unit)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
          `, [poId, liId, li.asin, num(li.qty_received), cogs.adjusted_product_cost, cogs.cogs_per_asin_unit, cogs.sourcing_cost_per_asin_unit]);
        }

        // 3. INSERT po_gift_cards links
        if (body.gift_cards && body.gift_cards.length > 0) {
          for (const g of body.gift_cards) {
            await client.query(
              `INSERT INTO po_gift_cards (order_id, gift_card_id, amount_used) VALUES ($1, $2, $3)`,
              [poId, g.gift_card_id, g.amount_used],
            );
          }
          // If GCs present, COGS depends on them — recompute now that links exist.
          await recomputeCogsForPo(client, poId);
        }

        // 4. Auto-refund + status
        await recomputePoRefund(client, poId);
        await recomputePoStatus(client, poId);

        return await getPoDetail(client, poId);
      });
      res.status(201).json(result);
    } catch (err: any) {
      const code = err.httpCode ?? 500;
      log(`POST /api/pos error: ${err.message}`, "po");
      res.status(code).json({ message: err.message });
    }
  });

  // ─── GET /api/pos ──────────────────────────────────────────────────────────
  app.get("/api/pos", async (req: Request, res: Response) => {
    if (!isDbAvailable()) return bad(res, "Database not available", 503);
    const q = req.query as Record<string, string | undefined>;
    const where: string[] = [];
    const params: any[] = [];
    let idx = 1;

    if (q.startDate)             { where.push(`po.order_date >= $${idx++}`); params.push(q.startDate); }
    if (q.endDate)               { where.push(`po.order_date <= $${idx++}`); params.push(q.endDate); }
    if (q.supplier)              { where.push(`po.supplier = ANY($${idx++})`); params.push(q.supplier.split(",")); }
    if (q.status)                { where.push(`po.status = ANY($${idx++})`);   params.push(q.status.split(",")); }
    if (q.payment_method)        { where.push(`po.payment_method = ANY($${idx++})`); params.push(q.payment_method.split(",")); }
    if (q.is_subscription === "true") where.push(`po.is_subscription = TRUE`);
    if (q.search) {
      where.push(`(po.order_id ILIKE $${idx} OR EXISTS (SELECT 1 FROM po_line_items li WHERE li.order_id = po.id AND (li.product_name ILIKE $${idx} OR EXISTS (SELECT 1 FROM po_asins pa WHERE pa.po_line_item_id = li.id AND pa.asin ILIKE $${idx}))))`);
      params.push(`%${q.search}%`); idx++;
    }

    const sortBy = ["order_date", "order_id", "supplier", "order_total", "status", "created_at"].includes(q.sortBy || "")
      ? q.sortBy : "order_date";
    const sortDir = (q.sortDir || "DESC").toUpperCase() === "ASC" ? "ASC" : "DESC";
    const pageSize = Math.min(Math.max(parseInt(q.pageSize || "50", 10) || 50, 1), 500);
    const page = Math.max(parseInt(q.page || "1", 10) || 1, 1);
    const offset = (page - 1) * pageSize;

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    try {
      const totalR = await query(`SELECT count(*)::int AS n FROM purchase_orders po ${whereSql}`, params);
      const rows = await query(`
        SELECT po.id, po.order_id, po.order_date, po.supplier, po.order_total, po.status, po.is_subscription,
               po.payment_method, po.refund, po.refund_manual_override, po.created_at,
               (SELECT count(*) FROM po_line_items WHERE order_id = po.id)::int AS line_item_count,
               (SELECT COALESCE(SUM(qty_ordered), 0) FROM po_line_items WHERE order_id = po.id)::int AS total_units_ordered,
               (SELECT COALESCE(SUM(qty_received), 0) FROM po_line_items WHERE order_id = po.id)::int AS total_units_received
        FROM purchase_orders po
        ${whereSql}
        ORDER BY po.${sortBy} ${sortDir}, po.created_at DESC
        LIMIT $${idx} OFFSET $${idx + 1}
      `, [...params, pageSize, offset]);

      res.json({ rows: rows.rows, total: totalR.rows[0].n, page, pageSize });
    } catch (err: any) {
      log(`GET /api/pos error: ${err.message}`, "po");
      res.status(500).json({ message: err.message });
    }
  });

  // ─── GET /api/pos/:id ──────────────────────────────────────────────────────
  app.get("/api/pos/:id", async (req: Request, res: Response) => {
    if (!isDbAvailable()) return bad(res, "Database not available", 503);
    try {
      const detail = await getPoDetail({ query }, req.params.id as string);
      if (!detail) return bad(res, "PO not found", 404);
      res.json(detail);
    } catch (err: any) {
      log(`GET /api/pos/:id error: ${err.message}`, "po");
      res.status(500).json({ message: err.message });
    }
  });

  // ─── PUT /api/pos/:id ──────────────────────────────────────────────────────
  app.put("/api/pos/:id", async (req: Request, res: Response) => {
    if (!isDbAvailable()) return bad(res, "Database not available", 503);
    const body = req.body as PoCreateBody;
    const poId = req.params.id as string;

    try {
      const result = await withTransaction(async (client) => {
        const exists = await client.query(`SELECT id FROM purchase_orders WHERE id = $1`, [poId]);
        if (exists.rows.length === 0) throw Object.assign(new Error("PO not found"), { httpCode: 404 });

        // 1. Update order-level fields
        const upd = buildDynamicUpdate(body as PoOrderFields, PO_FIELDS, 1);
        if (upd.setClause) {
          try {
            await client.query(
              `UPDATE purchase_orders SET ${upd.setClause}, updated_at = NOW() WHERE id = $${upd.values.length + 1}`,
              [...upd.values, poId],
            );
          } catch (e: any) {
            if (e.code === "23505") throw Object.assign(new Error(`Order ID '${body.order_id}' already exists`), { httpCode: 409 });
            throw e;
          }
        }

        // 2. Optional: sync gift_cards (full replace)
        if (body.gift_cards !== undefined) {
          const gcErr = await validateGiftCards(client, body.gift_cards);
          if (gcErr) throw Object.assign(new Error(gcErr), { httpCode: 400 });
          await client.query(`DELETE FROM po_gift_cards WHERE order_id = $1`, [poId]);
          for (const g of body.gift_cards) {
            await client.query(
              `INSERT INTO po_gift_cards (order_id, gift_card_id, amount_used) VALUES ($1, $2, $3)`,
              [poId, g.gift_card_id, g.amount_used],
            );
          }
        }

        // 3. Recompute COGS for all LIs (order-level inputs may have changed)
        await recomputeCogsForPo(client, poId);
        // 4. Refund auto-calc + status refresh
        await recomputePoRefund(client, poId);
        await recomputePoStatus(client, poId);
        return await getPoDetail(client, poId);
      });
      res.json(result);
    } catch (err: any) {
      const code = err.httpCode ?? 500;
      log(`PUT /api/pos/:id error: ${err.message}`, "po");
      res.status(code).json({ message: err.message });
    }
  });

  // ─── DELETE /api/pos/:id ───────────────────────────────────────────────────
  app.delete("/api/pos/:id", async (req: Request, res: Response) => {
    if (!isDbAvailable()) return bad(res, "Database not available", 503);
    try {
      const r = await query(`DELETE FROM purchase_orders WHERE id = $1`, [req.params.id as string]);
      if (r.rowCount === 0) return bad(res, "PO not found", 404);
      res.json({ ok: true });
    } catch (err: any) {
      log(`DELETE /api/pos/:id error: ${err.message}`, "po");
      res.status(500).json({ message: err.message });
    }
  });

  // ─── POST /api/pos/:id/line-items ──────────────────────────────────────────
  app.post("/api/pos/:id/line-items", async (req: Request, res: Response) => {
    if (!isDbAvailable()) return bad(res, "Database not available", 503);
    const poId = req.params.id as string;
    const li = req.body as LineItemFields;
    if (!isStr(li.product_name)) return bad(res, "product_name required");
    if (li.product_price == null) return bad(res, "product_price required");
    if (li.qty_ordered == null)   return bad(res, "qty_ordered required");
    if (!isStr(li.asin))          return bad(res, "asin required");
    if (li.asin_qty_per_product == null || !(li.asin_qty_per_product > 0))
      return bad(res, "asin_qty_per_product must be > 0");
    const qErr = validateLineItemQty(li, "line_item"); if (qErr) return bad(res, qErr);

    try {
      const result = await withTransaction(async (client) => {
        const exists = await client.query(`SELECT id FROM purchase_orders WHERE id = $1`, [poId]);
        if (exists.rows.length === 0) throw Object.assign(new Error("PO not found"), { httpCode: 404 });

        const liCols = LI_FIELDS.filter((k) => k in li);
        const liVals = liCols.map((k) => (li as any)[k]);
        const sql = `INSERT INTO po_line_items (order_id, ${liCols.join(", ")})
                     VALUES ($1, ${liCols.map((_, i) => `$${i + 2}`).join(", ")}) RETURNING id`;
        const liIns = await client.query(sql, [poId, ...liVals]);
        const liId = liIns.rows[0].id;

        const po = await fetchPoForCogs(client, poId);
        const gcs = await fetchGiftCardsForCogs(client, poId);
        const prepR = await client.query(`SELECT COALESCE(prep_cost_per_unit, 1.00) AS p FROM asins WHERE asin = $1`, [li.asin]);
        const prep = prepR.rows.length > 0 ? Number(prepR.rows[0].p) : 1;
        const cogs = calculateAsinCosts(po!, {
          product_price: Number(li.product_price), product_discount: num(li.product_discount),
          product_discount_type: li.product_discount_type, asin_qty_per_product: Number(li.asin_qty_per_product),
          tax_exempt: !!li.tax_exempt,
        }, gcs, prep);
        await client.query(`
          INSERT INTO po_asins (order_id, po_line_item_id, asin, qty_received, adjusted_product_cost, cogs_per_asin_unit, sourcing_cost_per_asin_unit)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [poId, liId, li.asin, num(li.qty_received), cogs.adjusted_product_cost, cogs.cogs_per_asin_unit, cogs.sourcing_cost_per_asin_unit]);

        await recomputePoRefund(client, poId);
        await recomputePoStatus(client, poId);
        return await getPoDetail(client, poId);
      });
      res.status(201).json(result);
    } catch (err: any) {
      const code = err.httpCode ?? 500;
      log(`POST line-item error: ${err.message}`, "po");
      res.status(code).json({ message: err.message });
    }
  });

  // ─── PUT /api/pos/:id/line-items/:lineItemId ───────────────────────────────
  app.put("/api/pos/:id/line-items/:lineItemId", async (req: Request, res: Response) => {
    if (!isDbAvailable()) return bad(res, "Database not available", 503);
    const poId = req.params.id as string;
    const lineItemId = req.params.lineItemId as string;
    const body = req.body as LineItemFields;
    // qty validation needs the full post-update view: merge body over current row.

    try {
      const result = await withTransaction(async (client) => {
        const cur = await client.query(`SELECT * FROM po_line_items WHERE id=$1 AND order_id=$2`, [lineItemId, poId]);
        if (cur.rows.length === 0) throw Object.assign(new Error("Line item not found"), { httpCode: 404 });
        const merged: LineItemFields = { ...cur.rows[0], ...body };
        const qErr = validateLineItemQty(merged, "line_item"); if (qErr) throw Object.assign(new Error(qErr), { httpCode: 400 });

        // 1. Apply field updates (dynamic SET).
        const upd = buildDynamicUpdate(body, LI_FIELDS, 1);
        if (upd.setClause) {
          await client.query(
            `UPDATE po_line_items SET ${upd.setClause}, updated_at = NOW() WHERE id = $${upd.values.length + 1}`,
            [...upd.values, lineItemId],
          );
        }

        // 2. Auto-update LI status from quantities (unless user supplied a status explicitly).
        if (body.status === undefined) {
          const after = await client.query(`SELECT qty_ordered, qty_received, qty_canceled, qty_returned_refunded, status FROM po_line_items WHERE id=$1`, [lineItemId]);
          const a = after.rows[0];
          const next = computeLineItemStatus({
            qty_ordered: Number(a.qty_ordered), qty_received: Number(a.qty_received),
            qty_canceled: Number(a.qty_canceled), qty_returned_refunded: Number(a.qty_returned_refunded),
            status: a.status,
          });
          if (next !== a.status) {
            await client.query(`UPDATE po_line_items SET status=$1, updated_at=NOW() WHERE id=$2`, [next, lineItemId]);
          }
        }

        // 3. Mirror qty_received onto the po_asins row.
        if (body.qty_received !== undefined) {
          await client.query(`UPDATE po_asins SET qty_received = $1 WHERE po_line_item_id = $2`, [body.qty_received, lineItemId]);
        }

        // 4. Recompute COGS for this LI if any COGS-affecting field changed.
        const cogsKeys: (keyof LineItemFields)[] = ["product_price", "product_discount", "product_discount_type", "asin_qty_per_product", "tax_exempt"];
        if (cogsKeys.some((k) => k in body)) {
          await recomputeCogsForLineItem(client, poId, lineItemId);
        }

        // 5. Refund + PO status.
        await recomputePoRefund(client, poId);
        await recomputePoStatus(client, poId);
        return await getPoDetail(client, poId);
      });
      res.json(result);
    } catch (err: any) {
      const code = err.httpCode ?? 500;
      log(`PUT line-item error: ${err.message}`, "po");
      res.status(code).json({ message: err.message });
    }
  });

  // ─── DELETE /api/pos/:id/line-items/:lineItemId ────────────────────────────
  app.delete("/api/pos/:id/line-items/:lineItemId", async (req: Request, res: Response) => {
    if (!isDbAvailable()) return bad(res, "Database not available", 503);
    const poId = req.params.id as string;
    const lineItemId = req.params.lineItemId as string;
    try {
      const result = await withTransaction(async (client) => {
        const r = await client.query(`DELETE FROM po_line_items WHERE id=$1 AND order_id=$2`, [lineItemId, poId]);
        if (r.rowCount === 0) throw Object.assign(new Error("Line item not found"), { httpCode: 404 });
        // PO totals are user-entered per spec, not auto-recalc.
        await recomputePoRefund(client, poId);
        await recomputePoStatus(client, poId);
        return await getPoDetail(client, poId);
      });
      res.json(result);
    } catch (err: any) {
      const code = err.httpCode ?? 500;
      log(`DELETE line-item error: ${err.message}`, "po");
      res.status(code).json({ message: err.message });
    }
  });
}
