// rebuildFinancesDaily on the REAL schema (migrations 123 / 124), seeded and rolled back:
// cost periods, the Prep units by ships_to, the fee estimate for a line without a row,
// the §4 allocations, Lost/damaged and the returns / disposal valuations. Skipped without Postgres.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { readBreakdown, rebuildFinancesDaily } from "./finances-aggregate";

const url = process.env.DATABASE_URL || "postgresql://localhost:5432/asinflow";
let client: pg.Client | null = null;
beforeAll(async () => { const c = new pg.Client({ connectionString: url }); try { await c.connect(); await c.query("SELECT 1 FROM finances_daily LIMIT 0"); client = c; } catch { await c.end().catch(() => {}); } });
afterAll(async () => { await client?.end(); });

const A = "B0ZZFINAGG", A2 = "B0ZZFINAG2", SKU = "ZZ-FIN-AGG", SKU2 = "ZZ-FIN-AG2";
type Q = (sql: string, params?: any[]) => Promise<any>;

async function seed(q: Q) {
  const aid = (await q(`INSERT INTO asins (asin, title, weight_lb) VALUES ($1, 'zz finances aggregate', 2) RETURNING id`, [A])).rows[0].id;
  const aid2 = (await q(`INSERT INTO asins (asin, title, weight_lb, is_hazmat) VALUES ($1, 'zz finances aggregate 2', 1, true) RETURNING id`, [A2])).rows[0].id;
  await q(`INSERT INTO asin_estimates (asin, fba_fee, referral_fee, fees_estimate_price, lowest_fba_price) VALUES ($1, 5, 3, 20, 20), ($2, 4, 2, 10, 10)`, [A, A2]);
  await q(`INSERT INTO asin_skus (asin_id, sku, is_primary) VALUES ($1, $2, true), ($3, $4, true)`, [aid, SKU, aid2, SKU2]);
  // Cost periods: PO 1 (Velocity, 10.00) from 2026-07-01; PO 2 (Home, 12.00) from 2026-08-15.
  const po = async (orderId: string, date: string, shipsTo: string, asin: string, cost: number) => {
    const id = (await q(`INSERT INTO purchase_orders (order_id, order_date, supplier, order_total, cost_formula_version, ships_to, source, entry_seq) VALUES ($1, $2, 'zz.com', 10, 3, $3, 'extension', $4) RETURNING id`, [orderId, date, shipsTo, Date.parse(date)])).rows[0].id;
    await q(`INSERT INTO po_asins (po_id, asin, qty, qty_basis, cost_per_unit, prep_cost, sold_as, units_per_pack) VALUES ($1, $2, 6, 'individual', $3, 1, 'individual', 1)`, [id, asin, cost]);
  };
  await po("zz-po-1", "2026-07-01", "velocity", A, 10); await po("zz-po-2", "2026-08-15", "home", A, 12); await po("zz-po-3", "2026-06-01", "velocity", A2, 4);
  // Order lines: Aug 10 (2 units, Finances row), Aug 20 (1 unit, no row, Pending, no price), a cancelled one, and A2 on Aug 11.
  await q(`INSERT INTO finances_order_lines (order_id, sku, asin, purchase_at, purchase_day, order_status, units, item_price) VALUES
    ('zz-o1', $1, $2, '2026-08-10T15:00:00Z', '2026-08-10', 'Shipped', 2, 40), ('zz-o2', $1, $2, '2026-08-20T15:00:00Z', '2026-08-20', 'Pending', 1, NULL),
    ('zz-o3', $1, $2, '2026-08-21T15:00:00Z', '2026-08-21', 'Cancelled', 1, 20), ('zz-o4', $3, $4, '2026-08-11T15:00:00Z', '2026-08-11', 'Shipped', 3, 30)`, [SKU, A, SKU2, A2]);
  const tx = async (id: string, type: string, status: string, posted: string, desc: string | null, total: number, ids: Record<string, string | null>, lines: [string, string, number, string | null, string | null, number | null][]) => {
    const day = posted.slice(0, 10);
    await q(`INSERT INTO finances_transactions (transaction_id, transaction_type, transaction_status, posted_at, posted_day, description, total_amount, order_id, shipment_id, refund_id, raw) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'{}')`, [id, type, status, posted, day, desc, total, ids.order ?? null, ids.shipment ?? null, ids.refund ?? null]);
    for (const [leaf, line, amount, sku, asin, qty] of lines) await q(`INSERT INTO finances_lines (transaction_id, transaction_type, transaction_status, posted_at, posted_day, order_id, shipment_id, refund_id, sku, asin, quantity, leaf_path, line, amount) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, [id, type, status, posted, day, ids.order ?? null, ids.shipment ?? null, ids.refund ?? null, sku, asin, qty, leaf, line, amount]);
  };
  await tx("zz-t1", "Shipment", "RELEASED", "2026-08-12T10:00:00Z", "Order Payment", 28, { order: "zz-o1", shipment: "s1" }, [["ProductCharges > OurPricePrincipal", "sales", 40, SKU, A, 2], ["PromoRebates > Promotion", "promo", -2, SKU, A, 2], ["AmazonFees > FBAPerUnitFulfillmentFee > Base", "fba_fee", -6, SKU, A, 2], ["AmazonFees > Commission > Base", "referral_fee", -6, SKU, A, 2]]);
  await tx("zz-t1d", "Shipment", "DEFERRED", "2026-08-11T10:00:00Z", "Order Payment", 28, { order: "zz-o1", shipment: "s1" }, [["ProductCharges > OurPricePrincipal", "sales", 40, SKU, A, 2], ["AmazonFees > FBAPerUnitFulfillmentFee > Base", "fba_fee", -6, SKU, A, 2]]); // the RELEASED twin wins per key
  await tx("zz-t4", "Shipment", "RELEASED", "2026-08-13T10:00:00Z", "Order Payment", 24, { order: "zz-o4", shipment: "s4" }, [["ProductCharges > OurPricePrincipal", "sales", 30, SKU2, A2, 3], ["AmazonFees > FBAPerUnitFulfillmentFee > Base", "fba_fee", -3, SKU2, A2, 3], ["AmazonFees > Commission > Base", "referral_fee", -3, SKU2, A2, 3]]);
  await tx("zz-r1", "Refund", "RELEASED", "2026-08-25T10:00:00Z", "Refund", -17.6, { order: "zz-o1", refund: "rf1" }, [["ProductCharges > OurPricePrincipal", "refund_amount", -20, SKU, A, 1], ["AmazonFees > RefundCommission > Base", "refund_commission", -0.6, SKU, A, 1], ["AmazonFees > Commission > Base", "refunded_referral", 3, SKU, A, 1]]);
  await tx("zz-s1", "ServiceFee", "RELEASED", "2026-08-07T11:00:00Z", "FBAStorageBilling", -51.47, {}, [["FBAStorageBilling", "svc:FBAStorageBilling", -51.47, null, null, null]]);
  await q(`INSERT INTO fba_storage_fees (month, asin, fnsku, fc, fee, raw) VALUES ('2026-07', $1, 'X1', 'ABC1', 1.00, '{}'), ('2026-07', $1, 'X1', 'ABC2', 0.25, '{}'), ('2026-07', 'B0OTHER000', 'X2', 'ABC1', 0.47, '{}')`, [A]);
  await tx("zz-s2", "ServiceFee", "RELEASED", "2026-08-09T11:00:00Z", "FBAPostInboundTransportation", -10, { order: "FBAZZTEST1" }, [["FBAPostInboundTransportation", "svc:FBAPostInboundTransportation", -10, null, null, null]]);
  await q(`INSERT INTO sc_inbound_shipments (shipment_id, status, raw) VALUES ('FBAZZTEST1', 'CLOSED', '{}')`);
  await q(`INSERT INTO sc_inbound_items (shipment_id, seller_sku, asin, qty_shipped, qty_received) VALUES ('FBAZZTEST1', $1, $2, 2, 2), ('FBAZZTEST1', $3, $4, 4, 4)`, [SKU, A, SKU2, A2]); // weights 2×2 = 4 vs 4×1 = 4 → 50 / 50
  await tx("zz-s3", "ServiceFee", "RELEASED", "2026-08-10T11:00:00Z", "Subscription", -39.99, {}, [["Subscription", "svc:Subscription", -39.99, null, null, null]]);
  await tx("zz-b1", "FBAInventoryReimbursement", "RELEASED", "2026-08-12T12:00:00Z", "WAREHOUSE_LOST", 7, {}, [["WAREHOUSE_LOST", "reimb:WAREHOUSE_LOST", 7, SKU, A, 1]]);
  await tx("zz-b2", "FBAInventoryReimbursement", "RELEASED", "2026-08-20T12:00:00Z", "COMPENSATED_CLAWBACK", -7, {}, [["COMPENSATED_CLAWBACK", "reimb:COMPENSATED_CLAWBACK", -7, SKU, A, 1]]);
  await q(`INSERT INTO fba_customer_returns (return_at, return_day, order_id, sku, asin, quantity, disposition, lpn, raw) VALUES ('2026-08-28T10:00:00Z', '2026-08-28', 'zz-o1', $1, $2, 1, 'SELLABLE', 'LPN1', '{}'), ('2026-08-29T10:00:00Z', '2026-08-29', 'zz-o1', $1, $2, 1, 'CUSTOMER_DAMAGED', 'LPN2', '{}')`, [SKU, A]);
  await q(`INSERT INTO fba_removals (order_id, sku, disposition, asin, request_at, updated_at, completed_day, order_type, order_status, requested_qty, disposed_qty, raw) VALUES ('zz-rm1', $1, 'Sellable', $2, '2026-08-21T10:00:00Z', '2026-08-28T10:00:00Z', '2026-08-28', 'Disposal', 'Completed', 1, 1, '{}')`, [SKU, A]);
  await q(`INSERT INTO sales_daily (asin_id, sale_date, units_sold, revenue) VALUES ($1, '2026-08-25', 0, 0)`, [aid]);
  return aid;
}

describe("rebuildFinancesDaily + readBreakdown (real schema, rolled back)", () => {
  it("reproduces every line of the model from seeded facts", async () => {
    if (!client) return;
    const q: Q = (sql, params) => client!.query(sql, params);
    await q("BEGIN");
    try {
      const aid = await seed(q);
      await rebuildFinancesDaily("2026-08-01", "2026-08-31", { live: false, q, log: () => {} });
      const S = { prepCost: 1.2, hazmatPrepSurcharge: 1 } as any;
      const b = await readBreakdown("2026-08-01", "2026-08-31", A, q, S);
      const l = (k: string) => b.lines.find((x) => x.line === k)?.amount;
      // Sales: o1 row 40 − 2 = 38; o2 no row, no price → last posted unit price 20 → 20. Units 3 (cancelled o3 out).
      expect(b.totals.sales).toBe(58); expect(b.totals.units).toBe(3); expect(b.totals.orders).toBeNull();
      // Fees: o1 posted −6 / −6; o2 estimated from the last posted per-unit (−3 FBA, 15 % commission × 20 = −3), flagged as estimated.
      const fba = b.lines.find((x) => x.line === "fba_fee")!; expect(fba.amount).toBe(-9); expect(fba.estAmount).toBe(-3); expect(fba.estUnits).toBe(1);
      expect(l("referral_fee")).toBe(-9);
      // COGS by cost period: Aug 10 → PO 1 (10 × 2), Aug 20 → PO 2 (12 × 1) = −32; Prep: 2 Velocity units × 1.20 (the Home PO's unit takes none).
      expect(l("cogs")).toBe(-32); expect(l("prep")).toBe(-2.4);
      // Refunds posted Aug 25.
      expect(b.totals.refunds).toBe(1); expect(l("refund_amount")).toBe(-20); expect(l("refund_commission")).toBe(-0.6); expect(l("refunded_referral")).toBe(3);
      // Allocations: storage July report 1.25 for the ASIN of the −51.47 row; inbound −10 split by weight 50/50.
      expect(l("svc:FBAStorageBilling")).toBe(-1.25); expect(l("svc:FBAPostInboundTransportation")).toBe(-5);
      expect(b.lines.some((x) => x.line === "svc:Subscription")).toBe(false);
      // Lost/damaged: lost 1 × 10 (PO 1 on Aug 12) → −10 − 1.20 prep; found 1 × 12 (PO 2 on Aug 20, Home) → +12: net +0.80. Cash lines stay.
      expect(l("lost_damaged")).toBe(0.8); expect(l("reimb:WAREHOUSE_LOST")).toBe(7); expect(l("reimb:COMPENSATED_CLAWBACK")).toBe(-7);
      // Returns: 1 sellable of 2 on Aug 28 → value 12 (PO 2, Home, no prep); sellable returns 50 %. Disposal Aug 28: −12.
      expect(l("returned_value")).toBe(12); expect(b.totals.sellableReturns).toBe(50); expect(l("disposal_value")).toBe(-12);
      // Identities and the cash payout.
      const sum = (g: string) => Math.round(b.lines.filter((x) => x.group === g).reduce((s, x) => s + x.amount, 0) * 100) / 100;
      expect(b.totals.grossProfit).toBe(Math.round((58 + sum("refund_cost") + sum("amazon_fees") + sum("cost_of_goods")) * 100) / 100);
      expect(b.totals.estPayout).toBe(Math.round((58 + (sum("refund_cost") - 12) + sum("amazon_fees")) * 100) / 100);
      // Account panel: Subscription and the unallocated storage remainder are account-only; Σ ASIN parts + account-only = the row.
      const acct = await readBreakdown("2026-08-01", "2026-08-31", null, q, S);
      const al = (k: string) => acct.lines.find((x) => x.line === k)?.amount;
      expect(al("svc:Subscription")).toBe(-39.99); expect(al("svc:FBAStorageBilling")).toBe(-51.47); expect(al("svc:FBAPostInboundTransportation")).toBe(-10);
      expect(acct.totals.orders).toBe(3);
      const acctRows = (await q(`SELECT asin, SUM(amount)::float8 AS a FROM finances_daily WHERE line = 'svc:FBAStorageBilling' AND day BETWEEN '2026-08-01' AND '2026-08-31' GROUP BY asin ORDER BY asin`)).rows;
      expect(acctRows.map((r: any) => [r.asin, Math.round(r.a * 100) / 100])).toEqual([["", -49.75], ["B0OTHER000", -0.47], [A, -1.25]]); // Σ = −51.47, the row
      // A2: hazmat Velocity → prep 3 × (1.20 + 1.00).
      const b2 = await readBreakdown("2026-08-01", "2026-08-31", A2, q, S);
      expect(b2.lines.find((x) => x.line === "prep")!.amount).toBe(-6.6); expect(b2.lines.find((x) => x.line === "svc:FBAPostInboundTransportation")!.amount).toBe(-5);
      // sales_daily refund columns follow the aggregate.
      expect((await q(`SELECT units_refunded, refund_amount::float8 AS r FROM sales_daily WHERE asin_id = $1 AND sale_date = '2026-08-25'`, [aid])).rows[0]).toEqual({ units_refunded: 1, r: 20 });
      // Idempotent: a second rebuild gives the same rows.
      const before = (await q(`SELECT count(*)::int AS n, SUM(amount)::float8 AS a FROM finances_daily WHERE day BETWEEN '2026-08-01' AND '2026-08-31' AND asin IN ($1, $2, '')`, [A, A2])).rows[0];
      await rebuildFinancesDaily("2026-08-01", "2026-08-31", { live: false, q, log: () => {} });
      expect((await q(`SELECT count(*)::int AS n, SUM(amount)::float8 AS a FROM finances_daily WHERE day BETWEEN '2026-08-01' AND '2026-08-31' AND asin IN ($1, $2, '')`, [A, A2])).rows[0]).toEqual(before);
    } finally { await q("ROLLBACK"); }
    expect((await client.query(`SELECT count(*)::int AS n FROM asins WHERE asin = $1`, [A])).rows[0].n).toBe(0);
  });
});
