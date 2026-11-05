import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { readFileSync } from "node:fs";
import { costPerRetailerUnit, defectAmount, defectMoney, defectSummary, DEFECT_ACTION_ITEM } from "@shared/po-defect";
import { addDefect, editDefect, linkRefund, unlinkRefund, resolveDefect, reopenDefect, removeDefect, loadDefects, loadOpenDefectSummaries } from "./po-defects";
import { addMoneyRow, editMoneyRow, removeMoneyRow } from "./po-money-edit";
import { writeLineItems } from "./line-action-items";
import { ASIN_ACTION_ITEMS_SQL, PO_ACTION_ITEMS_SQL, PO_CLOSE_ACTION_ITEMS_SQL } from "./po-action-items";
import { loadPoAsinRows, REFUND_DUE_SQL, refundsFilterCond } from "./po-queries";
import { poSpendCtes } from "./dashboard";

// Supplier defects (SPEC §22 "Supplier defects", migration 094, Maria 2026-11-05).
describe("the $ owed and what is still owed (pure)", () => {
  it("defaults to qty × the line's stored adjusted product cost (col X), never recomputed", () => {
    expect(defectAmount({ qty: 1, adjustedProductCost: "5.97", price: "5.97" })).toBe(5.97);
    expect(defectAmount({ qty: 2, adjustedProductCost: "4.10", price: "9.99", subtotal: 100, tax: 50 })).toBe(8.2);
  });
  it("without one: price with discount, tax and shipping allocated over the subtotal; plain price without a subtotal; null without a price", () => {
    expect(costPerRetailerUnit({ price: 10, subtotal: 100, discount: 10, tax: 5, shipping: 5 })).toBeCloseTo(10);
    expect(defectAmount({ qty: 3, price: 10, subtotal: 100, discount: 0, tax: 8, shipping: 2 })).toBe(33);
    expect(defectAmount({ qty: 3, price: 10 })).toBe(30);
    expect(defectAmount({ qty: 3, price: null })).toBeNull();
    expect(defectAmount({ qty: 0, price: 10 })).toBeNull();
  });
  it("owed = amount − received; uncovered = amount − every linked refund; fully refunded only on received money", () => {
    expect(defectMoney(5.97, [])).toEqual({ owed: 5.97, uncovered: 5.97, received: 0, fullyRefunded: false });
    expect(defectMoney(5.97, [{ amount: "5.97", status: "due" }])).toEqual({ owed: 5.97, uncovered: 0, received: 0, fullyRefunded: false });
    expect(defectMoney(10, [{ amount: 4, status: "received" }])).toEqual({ owed: 6, uncovered: 6, received: 4, fullyRefunded: false });
    expect(defectMoney(10, [{ amount: 4, status: "received" }, { amount: 6, status: "received" }]).fullyRefunded).toBe(true);
    expect(defectMoney(null, []).owed).toBeNull();
  });
  it("summary text: qty per kind and the $ owed", () => {
    expect(defectSummary([{ qty: 1, kind: "missing", owed: 5.97 }])).toBe("1 missing · $5.97 owed");
    expect(defectSummary([{ qty: 1, kind: "missing", owed: 2 }, { qty: 2, kind: "wrong_item", owed: null }])).toBe("1 missing, 2 wrong item · $2.00 owed");
  });
});

const url = process.env.DATABASE_URL || "postgresql://localhost:5432/asinflow";
let client: pg.Client | null = null;
beforeAll(async () => {
  const c = new pg.Client({ connectionString: url });
  try { await c.connect(); await c.query("SELECT 1 FROM po_line_defects LIMIT 0"); client = c; } catch { await c.end().catch(() => {}); }
});
afterAll(async () => { await client?.end(); });

type Q = (sql: string, params?: any[]) => Promise<any>;
/** The Walmart shape: one ASIN row (2-packs of singles), one line of 12 singles at $5.97; and a second PO that supplied a replacement. */
async function seed(q: Q) {
  const po = (await q(`INSERT INTO purchase_orders (order_id, order_date, supplier, subtotal, order_total) VALUES ('zz-defect-test', '2026-10-18', 'zz-test.com', 71.64, 71.64) RETURNING id`)).rows[0].id as string;
  const pa = (await q(`INSERT INTO po_asins (po_id, asin, qty, units_per_pack, sold_as) VALUES ($1, 'B0ZZDEF00A', 6, 2, 'multi-pack') RETURNING id`, [po])).rows[0].id as string;
  const line = (await q(`INSERT INTO po_line_items (po_id, po_asin_id, position, product_name, qty_ordered, price, adjusted_product_cost, retailer_units_per_product, asin_units_per_pack)
                        VALUES ($1, $2, 0, 'zz soap', 12, 5.97, 5.97, 1, 2) RETURNING id`, [po, pa])).rows[0].id as string;
  const po2 = (await q(`INSERT INTO purchase_orders (order_id, order_date, supplier) VALUES ('zz-defect-test-2', '2026-10-25', 'zz-test.com') RETURNING id`)).rows[0].id as string;
  const pa2 = (await q(`INSERT INTO po_asins (po_id, asin, qty, units_per_pack, sold_as) VALUES ($1, 'B0ZZDEF00A', 5.5, 2, 'multi-pack') RETURNING id`, [po2])).rows[0].id as string;
  const line2 = (await q(`INSERT INTO po_line_items (po_id, po_asin_id, position, product_name, qty_ordered, price) VALUES ($1, $2, 0, 'zz soap', 11, 5.97) RETURNING id`, [po2, pa2])).rows[0].id as string;
  return { po, pa, line, po2, line2 };
}
async function inTx(fn: (q: Q) => Promise<void>) {
  const q: Q = (sql, params) => client!.query(sql, params);
  await q("BEGIN");
  try { await fn(q); } finally { await q("ROLLBACK"); }
  expect((await client!.query(`SELECT count(*)::int AS n FROM purchase_orders WHERE order_id LIKE 'zz-defect-test%'`)).rows[0].n).toBe(0);
}
const items = async (q: Q, sql: string, id: string) => (await q(`SELECT ${sql} AS items FROM ${sql === ASIN_ACTION_ITEMS_SQL ? "po_asins pa WHERE pa.id" : "purchase_orders p WHERE p.id"} = $1`, [id])).rows[0].items as string[];
const due = async (q: Q, po: string) => (await q(`SELECT ${REFUND_DUE_SQL} AS d FROM purchase_orders p WHERE p.id = $1`, [po])).rows[0].d as number;
const dashDue = async (q: Q) => (await q(`WITH ${poSpendCtes("'2026-10-01'::date", "'2026-10-31'::date")} SELECT due FROM po_spend JOIN purchase_orders p ON p.id = po_spend.id WHERE p.order_id = 'zz-defect-test'`)).rows[0].due;
const history = async (q: Q, po: string) => (await q(`SELECT field, new_value FROM po_edit_log WHERE po_id = $1 AND field LIKE 'supplier defect%' ORDER BY id`, [po])).rows;

describe("supplier defects on the real schema (rolled back)", () => {
  it("the stopgap conversion: a defect linked to its due row — the badge with qty and $, Refunds due counted once", async (ctx) => {
    if (!client) return ctx.skip();
    await inTx(async (q) => {
      const s = await seed(q);
      const r = await addMoneyRow(q, "po_line_refunds", s.po, { po_line_item_id: s.line, qty: "1", amount: "5.97", status: "due", note: "1 single missing from supplier delivery" }, null);
      expect(await due(q, s.po)).toBe(5.97);
      const { id } = await addDefect(q, s.po, { po_line_item_id: s.line, kind: "missing", qty: 1, note: "1 single missing from supplier delivery", refund_ids: [r.id] }, null);
      const [d] = await loadDefects(q, { poId: s.po });
      expect(d).toMatchObject({ id, kind: "missing", qty: 1, amount: 5.97, status: "open", owed: 5.97, uncovered: 0, asin: "B0ZZDEF00A", line_no: 1 });
      expect(d.refunds).toEqual([expect.objectContaining({ id: r.id, amount: 5.97, status: "due" })]);
      // no double count: the PO row and the Dashboard both say 5.97, not 11.94
      expect(await due(q, s.po)).toBe(5.97);
      expect(Number(await dashDue(q))).toBe(5.97);
      expect(await items(q, PO_ACTION_ITEMS_SQL, s.po)).toContain(DEFECT_ACTION_ITEM);
      expect(await items(q, PO_CLOSE_ACTION_ITEMS_SQL, s.po)).toContain(DEFECT_ACTION_ITEM);
      expect(await items(q, ASIN_ACTION_ITEMS_SQL, s.pa)).toContain(DEFECT_ACTION_ITEM);
      const [row] = await loadPoAsinRows(q as any, [s.po]);
      expect(row.lines[0].action_items).toContain(DEFECT_ACTION_ITEM);
      const sum = await loadOpenDefectSummaries(q, [s.po]);
      expect(sum.byAsinRow.get(String(s.pa))!.map((x) => [x.qty, x.owed])).toEqual([[1, 5.97]]);
      expect(await history(q, s.po)).toEqual([
        { field: "supplier defect added", new_value: "1 missing × $5.97 — 1 single missing from supplier delivery" },
        { field: "supplier defect refund linked", new_value: "$5.97 (due)" },
      ]);
      // the refund arrives: Mark received → the defect resolves by refund, the badge goes, nothing is due
      await editMoneyRow(q, "po_line_refunds", r.id, { status: "received", refunded_at: "2026-11-06" }, null);
      expect((await loadDefects(q, { poId: s.po }))[0]).toMatchObject({ status: "resolved", resolution: "refund", owed: 0 });
      expect(await items(q, PO_ACTION_ITEMS_SQL, s.po)).not.toContain(DEFECT_ACTION_ITEM);
      expect(await due(q, s.po)).toBe(0);
      // the refund row removed → reopened, owed again, and Refunds due carries the uncovered $
      await removeMoneyRow(q, "po_line_refunds", r.id, null);
      expect((await loadDefects(q, { poId: s.po }))[0]).toMatchObject({ status: "open", resolution: null, owed: 5.97, uncovered: 5.97, refunds: [] });
      expect(await due(q, s.po)).toBe(5.97);
      expect((await q(`SELECT 1 FROM purchase_orders p WHERE p.id = $1 AND ${refundsFilterCond("due")}`, [s.po])).rows.length).toBe(1);
      expect((await q(`SELECT 1 FROM purchase_orders p WHERE p.id = $1 AND ${refundsFilterCond("none")}`, [s.po])).rows.length).toBe(0);
      // no quantity or cost on the line moved
      expect((await q(`SELECT qty_ordered, qty_received, adjusted_product_cost FROM po_line_items WHERE id = $1`, [s.line])).rows[0]).toEqual({ qty_ordered: "12.00", qty_received: null, adjusted_product_cost: "5.97" });
    });
  });

  it("a partial refund leaves the rest open; a second refund completes it", async (ctx) => {
    if (!client) return ctx.skip();
    await inTx(async (q) => {
      const s = await seed(q);
      const { id } = await addDefect(q, s.po, { po_line_item_id: s.line, kind: "damaged", qty: 2 }, null);
      expect((await loadDefects(q, { poId: s.po }))[0].amount).toBe(11.94);
      const r1 = await addMoneyRow(q, "po_line_refunds", s.po, { po_line_item_id: s.line, amount: "5.97", refunded_at: "2026-11-06" }, null);
      await linkRefund(q, id, r1.id, null);
      expect((await loadDefects(q, { poId: s.po }))[0]).toMatchObject({ status: "open", owed: 5.97, received: 5.97 });
      expect(await due(q, s.po)).toBe(5.97);
      const r2 = await addMoneyRow(q, "po_line_refunds", s.po, { po_line_item_id: s.line, amount: "5.97", refunded_at: "2026-11-07" }, null);
      await linkRefund(q, id, r2.id, null);
      expect((await loadDefects(q, { poId: s.po }))[0]).toMatchObject({ status: "resolved", resolution: "refund", owed: 0 });
      await unlinkRefund(q, id, r2.id, null);
      expect((await loadDefects(q, { poId: s.po }))[0]).toMatchObject({ status: "open", owed: 5.97 });
      // a refund of another PO cannot be linked
      const other = await addMoneyRow(q, "po_line_refunds", s.po2, { amount: "1.00" }, null);
      await expect(linkRefund(q, id, other.id, null)).rejects.toMatchObject({ status: 400 });
    });
  });

  it("replacement (by the other PO's order #) and write-off (reason required); reopen; edit and remove log History", async (ctx) => {
    if (!client) return ctx.skip();
    await inTx(async (q) => {
      const s = await seed(q);
      const { id } = await addDefect(q, s.po, { po_line_item_id: s.line, kind: "missing", qty: 1 }, null);
      await resolveDefect(q, id, { resolution: "replacement", replacement_order_id: "zz-defect-test-2" }, null);
      const [d] = await loadDefects(q, { poId: s.po });
      expect(d).toMatchObject({ status: "resolved", resolution: "replacement", replacement_po_line_item_id: s.line2 });
      expect(d.replacement).toMatchObject({ order_id: "zz-defect-test-2", asin: "B0ZZDEF00A", line_no: 1 });
      expect(await items(q, PO_ACTION_ITEMS_SQL, s.po)).not.toContain(DEFECT_ACTION_ITEM);
      expect(await due(q, s.po)).toBe(0);
      await expect(resolveDefect(q, id, { resolution: "write_off", reason: "x" }, null)).rejects.toMatchObject({ status: 400 });
      await reopenDefect(q, id, null);
      await expect(resolveDefect(q, id, { resolution: "write_off", reason: "  " }, null)).rejects.toMatchObject({ status: 400 });
      await expect(resolveDefect(q, id, { resolution: "replacement", replacement_order_id: "zz-no-such" }, null)).rejects.toMatchObject({ status: 400 });
      await resolveDefect(q, id, { resolution: "write_off", reason: "under $10, not worth chasing" }, null);
      expect((await loadDefects(q, { poId: s.po }))[0]).toMatchObject({ resolution: "write_off", write_off_reason: "under $10, not worth chasing" });
      await reopenDefect(q, id, null);
      await editDefect(q, id, { qty: 2, amount: "10.00", note: "two" }, null);
      expect((await loadDefects(q, { poId: s.po }))[0]).toMatchObject({ qty: 2, amount: 10, note: "two" });
      await expect(editDefect(q, id, { qty: 13 }, null)).rejects.toMatchObject({ status: 400 });
      await expect(addDefect(q, s.po, { po_line_item_id: s.line2, kind: "missing", qty: 1 }, null)).rejects.toMatchObject({ status: 400 });
      await expect(addDefect(q, s.po, { po_line_item_id: s.line, kind: "lost", qty: 1 }, null)).rejects.toMatchObject({ status: 400 });
      await removeDefect(q, id, null);
      expect(await loadDefects(q, { poId: s.po })).toEqual([]);
      expect((await history(q, s.po)).map((h: any) => h.field)).toEqual([
        "supplier defect added", "supplier defect resolved", "supplier defect reopened", "supplier defect resolved", "supplier defect reopened",
        "supplier defect qty", "supplier defect amount", "supplier defect note", "supplier defect removed",
      ]);
    });
  });

  it("the badge: an editor's echo adds nothing, adding it by hand without a defect is refused, a stored manual badge stays and can be removed", async (ctx) => {
    if (!client) return ctx.skip();
    await inTx(async (q) => {
      const s = await seed(q);
      await expect(writeLineItems(q, s.po, [s.line], [DEFECT_ACTION_ITEM], null)).rejects.toMatchObject({ status: 400 });
      await addDefect(q, s.po, { po_line_item_id: s.line, kind: "missing", qty: 1 }, null);
      await writeLineItems(q, s.po, [s.line], [DEFECT_ACTION_ITEM, "See comments"], null);
      expect((await q(`SELECT item FROM po_line_action_items WHERE po_line_item_id = $1 AND cleared_at IS NULL`, [s.line])).rows).toEqual([{ item: "See comments" }]);
      // a badge stored before defects existed (the six on production) stays as it is
      await q(`INSERT INTO po_line_action_items (po_line_item_id, item, source) VALUES ($1, $2, 'manual')`, [s.line2, DEFECT_ACTION_ITEM]);
      await writeLineItems(q, s.po2, [s.line2], [DEFECT_ACTION_ITEM, "See comments"], null);
      expect((await q(`SELECT item FROM po_line_action_items WHERE po_line_item_id = $1 AND cleared_at IS NULL ORDER BY item`, [s.line2])).rows.map((r: any) => r.item)).toEqual([DEFECT_ACTION_ITEM, "See comments"]);
      await writeLineItems(q, s.po2, [s.line2], ["See comments"], null);
      expect((await q(`SELECT item FROM po_line_action_items WHERE po_line_item_id = $1 AND cleared_at IS NULL`, [s.line2])).rows).toEqual([{ item: "See comments" }]);
    });
  });
});

describe("wiring", () => {
  it("the client chips carry the defects' qty and $ owed on the PO row, the ASIN row and the line", () => {
    const rows = readFileSync("client/src/components/po-asin-rows.tsx", "utf8");
    expect(rows).toMatch(/defects=\{a\.defects_open\}/);
    expect(rows).toMatch(/defects=\{a\.defects_open\?\.filter\(\(d\) => d\.po_line_item_id === l\.id\)\}/);
    expect(readFileSync("client/src/pages/purchase-orders.tsx", "utf8")).toMatch(/defects=\{po\.defects_open\}/);
    expect(readFileSync("client/src/components/po-money.tsx", "utf8")).toMatch(/<PoDefectsSection /);
  });
});
