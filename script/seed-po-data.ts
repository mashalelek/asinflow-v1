/**
 * Seed sample purchase orders for the PO module (Phase 1 deliverable).
 *
 * Inserts 2 POs end-to-end (purchase_orders → po_line_items → po_asins),
 * including one gift_card and one po_gift_cards link for PO #2. Calls the
 * COGS engine so po_asins rows carry real computed values — this proves the
 * schema + calc engine work together.
 *
 * Idempotent: deletes existing SEED-PO-* / SEED-GC-* rows first (CASCADE
 * removes children). Re-runnable safely.
 *
 * Uses real ASINs already in the asins table.
 *
 * Run: npx tsx script/seed-po-data.ts
 */
import "dotenv/config";
import pg from "pg";
import { calculateAsinCosts, type PoForCogs, type LineItemForCogs, type GiftCardForCogs } from "../shared/po-cogs";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function getPrep(asin: string): Promise<number> {
  const r = await pool.query("SELECT prep_cost_per_unit FROM asins WHERE asin=$1", [asin]);
  if (r.rows.length === 0) throw new Error(`ASIN ${asin} not in asins table`);
  return Number(r.rows[0].prep_cost_per_unit);
}

async function seed() {
  await pool.query("BEGIN");
  try {
    // Idempotent cleanup. PO delete cascades to its line_items / po_asins / po_gift_cards.
    await pool.query("DELETE FROM purchase_orders WHERE order_id LIKE 'SEED-PO-%'");
    await pool.query("DELETE FROM gift_cards WHERE card_number LIKE 'SEED-GC-%'");

    // ─── PO #1: simple PO, no discounts/tax/shipping/GC ────────────────────────
    const po1 = await pool.query(
      `INSERT INTO purchase_orders
       (order_id, order_date, supplier, order_subtotal, shipping_cost, tax, order_discount, order_total, payment_method, purchased_by, status)
       VALUES ('SEED-PO-001', CURRENT_DATE - 14, 'Walmart', 50, 0, 0, 0, 50, 'Credit Card', 'Maria', 'Ordered')
       RETURNING id`,
    );
    const po1Id = po1.rows[0].id;

    const po1Data: PoForCogs = { order_subtotal: 50, order_total: 50, shipping_cost: 0, tax: 0, order_discount: 0, order_discount_type: null };
    const li1Data: LineItemForCogs = { product_price: 50, product_discount: 0, product_discount_type: null, asin_qty_per_product: 1, tax_exempt: false };

    const li1 = await pool.query(
      `INSERT INTO po_line_items
       (order_id, product_name, product_price, qty_ordered, asin_qty_per_product, status)
       VALUES ($1, 'AND1 Low Cut Socks 12pk - sample seed', 50, 5, 1, 'Ordered')
       RETURNING id`,
      [po1Id],
    );
    const li1Id = li1.rows[0].id;

    const prep1 = await getPrep("B07JPJFHTB");
    const cogs1 = calculateAsinCosts(po1Data, li1Data, [], prep1);
    await pool.query(
      `INSERT INTO po_asins (order_id, po_line_item_id, asin, qty_received, adjusted_product_cost, cogs_per_asin_unit, sourcing_cost_per_asin_unit)
       VALUES ($1, $2, 'B07JPJFHTB', 0, $3, $4, $5)`,
      [po1Id, li1Id, cogs1.adjusted_product_cost, cogs1.cogs_per_asin_unit, cogs1.sourcing_cost_per_asin_unit],
    );

    // ─── PO #2: complex PO with discounts, tax, shipping, gift card, 2 line items ─
    // Mirrors the kitchen-sink test case so the seed exercises every code path.
    const gc = await pool.query(
      `INSERT INTO gift_cards (card_number, purchase_date, face_value, amount_paid, current_balance, purchase_source, status)
       VALUES ('SEED-GC-001', CURRENT_DATE - 30, 100, 95, 50, 'Raise', 'Active')
       RETURNING id, discount_percentage`,
    );
    const gcId = gc.rows[0].id;
    const gcPct = Number(gc.rows[0].discount_percentage); // 5.00

    const po2 = await pool.query(
      `INSERT INTO purchase_orders
       (order_id, order_date, supplier, order_subtotal, shipping_cost, tax, order_discount, order_discount_type, order_total, payment_method, purchased_by, status)
       VALUES ('SEED-PO-002', CURRENT_DATE - 7, 'Target', 200, 10, 15, 10, 'percentage', 205, 'Credit Card', 'Maria', 'Ordered')
       RETURNING id`,
    );
    const po2Id = po2.rows[0].id;

    await pool.query(
      `INSERT INTO po_gift_cards (order_id, gift_card_id, amount_used) VALUES ($1, $2, 50)`,
      [po2Id, gcId],
    );

    const po2Data: PoForCogs = {
      order_subtotal: 200, order_total: 205, shipping_cost: 10, tax: 15,
      order_discount: 10, order_discount_type: "percentage",
    };
    const gcs: GiftCardForCogs[] = [{ amount_used: 50, discount_percentage: gcPct }];

    // L1: AND1 socks, $120, 5% product discount, taxable, 1 ASIN/product
    const l1Data: LineItemForCogs = { product_price: 120, product_discount: 5, product_discount_type: "percentage", asin_qty_per_product: 1, tax_exempt: false };
    const li2a = await pool.query(
      `INSERT INTO po_line_items
       (order_id, product_name, product_price, product_discount, product_discount_type, qty_ordered, asin_qty_per_product, tax_exempt, status)
       VALUES ($1, 'AND1 Socks 12pk (qty 4)', 120, 5, 'percentage', 4, 1, FALSE, 'Ordered')
       RETURNING id`,
      [po2Id],
    );
    const prep2a = await getPrep("B07JPJFHTB");
    const cogs2a = calculateAsinCosts(po2Data, l1Data, gcs, prep2a);
    await pool.query(
      `INSERT INTO po_asins (order_id, po_line_item_id, asin, qty_received, adjusted_product_cost, cogs_per_asin_unit, sourcing_cost_per_asin_unit)
       VALUES ($1, $2, 'B07JPJFHTB', 0, $3, $4, $5)`,
      [po2Id, li2a.rows[0].id, cogs2a.adjusted_product_cost, cogs2a.cogs_per_asin_unit, cogs2a.sourcing_cost_per_asin_unit],
    );

    // L2: AND1 boxer briefs, $80, no product discount, tax_exempt, 2 ASINs per product
    const l2Data: LineItemForCogs = { product_price: 80, product_discount: 0, product_discount_type: null, asin_qty_per_product: 2, tax_exempt: true };
    const li2b = await pool.query(
      `INSERT INTO po_line_items
       (order_id, product_name, product_price, qty_ordered, asin_qty_per_product, tax_exempt, status)
       VALUES ($1, 'AND1 Boxer Briefs 6-pack twin', 80, 2, 2, TRUE, 'Ordered')
       RETURNING id`,
      [po2Id],
    );
    const prep2b = await getPrep("B0CCSVV4K5");
    const cogs2b = calculateAsinCosts(po2Data, l2Data, gcs, prep2b);
    await pool.query(
      `INSERT INTO po_asins (order_id, po_line_item_id, asin, qty_received, adjusted_product_cost, cogs_per_asin_unit, sourcing_cost_per_asin_unit)
       VALUES ($1, $2, 'B0CCSVV4K5', 0, $3, $4, $5)`,
      [po2Id, li2b.rows[0].id, cogs2b.adjusted_product_cost, cogs2b.cogs_per_asin_unit, cogs2b.sourcing_cost_per_asin_unit],
    );

    await pool.query("COMMIT");

    console.log("Seed complete.");
    console.log(`  SEED-PO-001 (simple): po_asins cogs=$${cogs1.cogs_per_asin_unit.toFixed(4)} sourcing=$${cogs1.sourcing_cost_per_asin_unit.toFixed(4)}`);
    console.log(`  SEED-PO-002 L1 (kitchen sink, AND1 socks): cogs=$${cogs2a.cogs_per_asin_unit.toFixed(4)} sourcing=$${cogs2a.sourcing_cost_per_asin_unit.toFixed(4)}`);
    console.log(`  SEED-PO-002 L2 (tax-exempt, asin_qty=2, boxer briefs): cogs=$${cogs2b.cogs_per_asin_unit.toFixed(4)} sourcing=$${cogs2b.sourcing_cost_per_asin_unit.toFixed(4)}`);
  } catch (e) {
    await pool.query("ROLLBACK");
    throw e;
  } finally {
    await pool.end();
  }
}

seed().catch((e) => { console.error("FATAL:", e?.message ?? e); process.exit(1); });
