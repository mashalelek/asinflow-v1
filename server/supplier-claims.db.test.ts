import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { readFileSync } from "node:fs";
import { claimAmount, claimCounts, claimMoney, claimSummary, costPerIndividualUnit, individualEquivalents } from "@shared/supplier-claim";
import { addClaim, editClaim, linkRefund, unlinkRefund, setOutcome, reopenClaim, dismissClaim, removeClaim, loadClaims, loadOpenClaimSummaries, cancelLines, doneTask } from "./supplier-claims";
import { addMoneyRow, editMoneyRow, removeMoneyRow } from "./po-money-edit";
import { evaluateAutoClose } from "./po-close";
import { loadPoAsinRows, REFUND_DUE_SQL, refundsFilterCond } from "./po-queries";
import { poSpendCtes } from "./dashboard";
import { cancelPo } from "./po-guards";

// Supplier claims (SPEC §22 "Supplier claims", migration 101, claims commit 1).
describe("the $ owed, the counting rule and the equivalents (pure)", () => {
  it("auto $ owed = Individual units × the line's cost per Individual unit (adjusted product cost ÷ the Product pack, else price allocated)", () => {
    expect(costPerIndividualUnit({ adjustedProductCost: "31.70", productPack: 6 })).toBeCloseTo(5.2833, 4);
    expect(claimAmount({ qty: 1, productPack: 1, adjustedProductCost: "5.97", price: "5.97" })).toBe(5.97);
    expect(claimAmount({ qty: 3, productPack: 6, adjustedProductCost: "31.70" })).toBe(15.85); // 3 Individual of a six-pack bought at 31.70
    expect(claimAmount({ qty: 3, price: 10, subtotal: 100, discount: 0, tax: 8, shipping: 2 })).toBe(33);
    expect(claimAmount({ qty: 3, price: null })).toBeNull();
  });
  it("remaining = owed − Σ applied (a link with no amount_applied takes the whole row); covered at 1¢", () => {
    expect(claimMoney(5.97, [])).toEqual({ owed: 5.97, received: 0, remaining: 5.97, fullyCovered: false });
    expect(claimMoney(10, [{ amount: 36.11, amount_applied: 4 }])).toEqual({ owed: 10, received: 4, remaining: 6, fullyCovered: false });
    expect(claimMoney(10, [{ amount: 4 }, { amount: 6 }]).fullyCovered).toBe(true);
    expect(claimMoney(null, []).remaining).toBeNull();
  });
  it("§3.6: a closed claim counts unless replaced; an open one counts when canceled or promised money / written off; suggested / dismissed never", () => {
    expect(claimCounts({ status: "closed", kind: "missing", outcome: "refund_card" })).toBe(true);
    expect(claimCounts({ status: "closed", kind: "missing", outcome: "replacement" })).toBe(false);
    expect(claimCounts({ status: "closed", kind: "returned", outcome: null })).toBe(true);
    expect(claimCounts({ status: "open", kind: "canceled", outcome: null })).toBe(true);
    expect(claimCounts({ status: "open", kind: "missing", outcome: null })).toBe(false);
    expect(claimCounts({ status: "open", kind: "missing", outcome: "gift_card" })).toBe(true);
    expect(claimCounts({ status: "open", kind: "missing", outcome: "write_off" })).toBe(true);
    expect(claimCounts({ status: "suggested", kind: "canceled", outcome: null })).toBe(false);
    expect(claimCounts({ status: "dismissed", kind: "canceled", outcome: null })).toBe(false);
  });
  it("D16: the Product / ASIN equivalents of a typed Individual quantity; the chip text", () => {
    expect(individualEquivalents(12, 6, 2)).toEqual({ product: 2, asin: 6 });
    expect(individualEquivalents(11, 1, 2)).toEqual({ product: 11, asin: 5.5 });
    expect(individualEquivalents(3, null, null)).toEqual({ product: null, asin: null });
    expect(claimSummary([{ qty: 1, kind: "missing", remaining: 5.97 }])).toBe("1 missing · $5.97 owed");
  });
});

const url = process.env.DATABASE_URL || "postgresql://localhost:5432/asinflow";
let client: pg.Client | null = null;
beforeAll(async () => {
  const c = new pg.Client({ connectionString: url });
  try { await c.connect(); await c.query("SELECT 1 FROM supplier_claims LIMIT 0"); client = c; } catch { await c.end().catch(() => {}); }
});
afterAll(async () => { await client?.end(); });

type Q = (sql: string, params?: any[]) => Promise<any>;
/** The Caress shape (Walmart 200015557295492): one ASIN row, 2-packs of singles, one line of 12 singles at $5.97 → stored 12 Individual units (6 ASIN units). */
async function seed(q: Q) {
  const po = (await q(`INSERT INTO purchase_orders (order_id, order_date, supplier, subtotal, order_total) VALUES ('zz-claim-test', '2026-10-18', 'zz-test.com', 71.64, 71.64) RETURNING id`)).rows[0].id as string;
  const pa = (await q(`INSERT INTO po_asins (po_id, asin, qty, units_per_pack, sold_as, qty_basis) VALUES ($1, 'B0ZZCLM00A', 12, 2, 'multi-pack', 'individual') RETURNING id`, [po])).rows[0].id as string;
  const line = (await q(`INSERT INTO po_line_items (po_id, po_asin_id, position, product_name, qty_ordered, price, adjusted_product_cost, retailer_units_per_product, asin_units_per_pack, qty_basis)
                        VALUES ($1, $2, 0, 'zz soap', 12, 5.97, 5.97, 1, 2, 'individual') RETURNING id`, [po, pa])).rows[0].id as string;
  return { po, pa, line };
}
async function inTx(fn: (q: Q) => Promise<void>) {
  const q: Q = (sql, params) => client!.query(sql, params);
  await q("BEGIN");
  try { await fn(q); } finally { await q("ROLLBACK"); }
  expect((await client!.query(`SELECT count(*)::int AS n FROM purchase_orders WHERE order_id LIKE 'zz-claim-test%'`)).rows[0].n).toBe(0);
}
const due = async (q: Q, po: string) => (await q(`SELECT ${REFUND_DUE_SQL} AS d FROM purchase_orders p WHERE p.id = $1`, [po])).rows[0].d as number;
const dashDue = async (q: Q) => (await q(`WITH ${poSpendCtes("'2026-10-01'::date", "'2026-10-31'::date")} SELECT due FROM po_spend JOIN purchase_orders p ON p.id = po_spend.id WHERE p.order_id = 'zz-claim-test'`)).rows[0].due;
const history = async (q: Q, po: string) => (await q(`SELECT field, new_value FROM po_edit_log WHERE po_id = $1 AND entity = 'claim' ORDER BY id`, [po])).rows;
const view = async (q: Q, pa: string) => (await q(`SELECT * FROM po_asin_expected WHERE id = $1`, [pa])).rows[0];

describe("supplier claims on the real schema (rolled back)", () => {
  it("Caress: a missing claim (1 Individual unit, $5.97 auto), Refunds due counted once, the view's Expected, auto-close blocked by the open claim, the refund closes it", async (ctx) => {
    if (!client) return ctx.skip();
    await inTx(async (q) => {
      const s = await seed(q);
      const { id } = await addClaim(q, s.po, { po_line_item_id: s.line, kind: "missing", qty: 1, note: "1 single missing from supplier delivery" }, null);
      const [d] = await loadClaims(q, { poId: s.po });
      expect(d).toMatchObject({ id, kind: "missing", qty: 1, amount_owed: 5.97, amount_owed_source: "auto", status: "open", remaining: 5.97, asin: "B0ZZCLM00A", line_no: 1, product_pack: 1, asin_pack: 2 });
      expect(d.tasks.map((t) => t.kind)).toEqual(["contact_supplier"]);
      expect(await due(q, s.po)).toBe(5.97);
      expect(Number(await dashDue(q))).toBe(5.97);
      // D14: a missing claim without an outcome does not yet leave Expected; Σ open claims shows on the row
      let v = await view(q, s.pa);
      expect(v).toMatchObject({ ordered_asin: "6.00", ordered_individual: "12.00", expected_asin: "6.00", open_claims: 1 });
      const [row] = await loadPoAsinRows(q as any, [s.po]);
      expect(row).toMatchObject({ qty: 6, qty_individual: 12, open_claims: 1 });
      expect(row.lines[0]).toMatchObject({ qty_ordered: 12, qty_ordered_individual: 12, qty_expected: 12 });
      const sum = await loadOpenClaimSummaries(q, [s.po]);
      expect(sum.byAsinRow.get(String(s.pa))!.map((x) => [x.qty, x.remaining])).toEqual([[1, 5.97]]);
      // D15: everything shipped, but the open claim keeps the PO open
      await q(`INSERT INTO po_asin_shipments (po_asin_id, velocity_shipment_id, fba_shipment_ids, qty_shipped, source, sc_match) VALUES ($1, 'manual:zz', '{}', 12, 'manual', 'none')`, [s.pa]);
      expect((await evaluateAutoClose(s.po, q as any)).closed).toBe(false);
      // the supplier promises a refund → the units leave Expected (6 ASIN → 5.5); the refund arrives → the claim closes, the PO can close
      await setOutcome(q, id, { outcome: "refund_card" }, null);
      v = await view(q, s.pa);
      expect(v).toMatchObject({ expected_asin: "5.50", expected_individual: "11.00", claimed_asin: "0.50" });
      const r = await addMoneyRow(q, "po_line_refunds", s.po, { po_line_item_id: s.line, qty: "1", amount: "5.97", refunded_at: "2026-11-06" }, null);
      await linkRefund(q, id, r.id, null);
      expect((await loadClaims(q, { poId: s.po }))[0]).toMatchObject({ status: "closed", outcome: "refund_card", remaining: 0 });
      expect(await due(q, s.po)).toBe(0);
      expect((await evaluateAutoClose(s.po, q as any)).closed).toBe(true);
      // the refund row removed → reopened, owed again
      await removeMoneyRow(q, "po_line_refunds", r.id, null);
      expect((await loadClaims(q, { poId: s.po }))[0]).toMatchObject({ status: "open", remaining: 5.97, refunds: [] });
      expect(await due(q, s.po)).toBe(5.97);
      expect((await q(`SELECT 1 FROM purchase_orders p WHERE p.id = $1 AND ${refundsFilterCond("due")}`, [s.po])).rows.length).toBe(1);
      expect((await q(`SELECT 1 FROM purchase_orders p WHERE p.id = $1 AND ${refundsFilterCond("none")}`, [s.po])).rows.length).toBe(0);
      // no quantity or cost on the line moved
      expect((await q(`SELECT qty_ordered, qty_received, adjusted_product_cost FROM po_line_items WHERE id = $1`, [s.line])).rows[0]).toEqual({ qty_ordered: "12.00", qty_received: null, adjusted_product_cost: "5.97" });
      expect((await history(q, s.po)).map((h: any) => h.field)).toEqual(["claim opened", "claim outcome", "refund linked", "claim closed", "claim reopened"]);
    });
  });

  it("a partial refund (amount_applied) leaves the rest owed; a second refund completes it; a refund of another PO cannot be linked; the task ticks", async (ctx) => {
    if (!client) return ctx.skip();
    await inTx(async (q) => {
      const s = await seed(q);
      const { id } = await addClaim(q, s.po, { po_line_item_id: s.line, kind: "damaged", qty: 2 }, null);
      expect((await loadClaims(q, { poId: s.po }))[0].amount_owed).toBe(11.94);
      const r1 = await addMoneyRow(q, "po_line_refunds", s.po, { po_line_item_id: s.line, amount: "36.11", refunded_at: "2026-11-06", method: "gift_card" }, null);
      await linkRefund(q, id, r1.id, null, { amountApplied: 5.97 });
      expect((await loadClaims(q, { poId: s.po }))[0]).toMatchObject({ status: "open", remaining: 5.97, received: 5.97 });
      expect(await due(q, s.po)).toBe(5.97);
      const r2 = await addMoneyRow(q, "po_line_refunds", s.po, { po_line_item_id: s.line, amount: "5.97", refunded_at: "2026-11-07" }, null);
      await linkRefund(q, id, r2.id, null);
      expect((await loadClaims(q, { poId: s.po }))[0]).toMatchObject({ status: "closed", outcome: "gift_card", remaining: 0 });
      await unlinkRefund(q, id, r2.id, null);
      expect((await loadClaims(q, { poId: s.po }))[0]).toMatchObject({ status: "open", remaining: 5.97 });
      const po2 = (await q(`INSERT INTO purchase_orders (order_id, order_date, supplier) VALUES ('zz-claim-test-2', '2026-10-25', 'zz-test.com') RETURNING id`)).rows[0].id;
      const other = await addMoneyRow(q, "po_line_refunds", po2, { amount: "1.00" }, null);
      await expect(linkRefund(q, id, other.id, null)).rejects.toMatchObject({ status: 400 });
      const task = (await loadClaims(q, { poId: s.po }))[0].tasks.find((t) => t.done_at == null)!;
      await doneTask(q, task.id, null);
      expect((await loadClaims(q, { poId: s.po }))[0].tasks.find((t) => t.id === task.id)!.done_at).not.toBeNull();
    });
  });

  it("write-off (reason required) closes at once; replacement stays open until arrived; reopen; dismiss; edit (manual $ sticks, qty re-derives auto $); remove", async (ctx) => {
    if (!client) return ctx.skip();
    await inTx(async (q) => {
      const s = await seed(q);
      const { id } = await addClaim(q, s.po, { po_line_item_id: s.line, kind: "missing", qty: 1 }, null);
      await expect(setOutcome(q, id, { outcome: "write_off", reason: "  " }, null)).rejects.toMatchObject({ status: 400 });
      await setOutcome(q, id, { outcome: "replacement" }, null);
      expect((await loadClaims(q, { poId: s.po }))[0]).toMatchObject({ status: "open", outcome: "replacement" });
      expect((await view(q, s.pa)).expected_asin).toBe("6.00"); // a replacement keeps the units expected
      await setOutcome(q, id, { outcome: "replacement", arrived: true }, null);
      expect((await loadClaims(q, { poId: s.po }))[0]).toMatchObject({ status: "closed", outcome: "replacement" });
      expect((await view(q, s.pa)).expected_asin).toBe("6.00"); // closed by replacement: still never leaves Expected
      await reopenClaim(q, id, null);
      await setOutcome(q, id, { outcome: "write_off", reason: "under $10, not worth chasing" }, null);
      expect((await loadClaims(q, { poId: s.po }))[0]).toMatchObject({ status: "closed", outcome: "write_off", write_off_reason: "under $10, not worth chasing" });
      expect((await view(q, s.pa)).expected_asin).toBe("5.50"); // written off: the unit is gone
      await reopenClaim(q, id, null);
      await editClaim(q, id, { qty: 2, amount_owed: "10.00", note: "two" }, null);
      expect((await loadClaims(q, { poId: s.po }))[0]).toMatchObject({ qty: 2, amount_owed: 10, amount_owed_source: "manual", note: "two" });
      await editClaim(q, id, { qty: 3 }, null); // manual $ sticks
      expect((await loadClaims(q, { poId: s.po }))[0].amount_owed).toBe(10);
      await editClaim(q, id, { amount_owed: "" }, null); // back to auto: 3 × 5.97
      expect((await loadClaims(q, { poId: s.po }))[0]).toMatchObject({ amount_owed: 17.91, amount_owed_source: "auto" });
      await expect(editClaim(q, id, { qty: 13 }, null)).rejects.toMatchObject({ status: 400 });
      await expect(addClaim(q, s.po, { po_line_item_id: s.line, kind: "lost", qty: 1 }, null)).rejects.toMatchObject({ status: 400 });
      await dismissClaim(q, id, null, "not ours");
      expect((await loadClaims(q, { poId: s.po }))[0].status).toBe("dismissed");
      expect((await view(q, s.pa)).open_claims).toBe(0);
      await removeClaim(q, id, null);
      expect(await loadClaims(q, { poId: s.po })).toEqual([]);
    });
  });

  it("Cancel PO / cancel lines (D14): an open canceled claim per line for its expected units, Ordered untouched, Expected drops, the PO stays open", async (ctx) => {
    if (!client) return ctx.skip();
    await inTx(async (q) => {
      const s = await seed(q);
      const r = await cancelPo(q, s.po, null);
      expect(r.linesCanceled).toBe(1);
      const [c] = await loadClaims(q, { poId: s.po });
      expect(c).toMatchObject({ kind: "canceled", qty: 12, status: "open", amount_owed: 71.64 });
      expect(c.tasks.map((t) => t.kind)).toEqual(["refund_received"]);
      expect((await q(`SELECT qty_ordered FROM po_line_items WHERE id = $1`, [s.line])).rows[0].qty_ordered).toBe("12.00");
      expect(await view(q, s.pa)).toMatchObject({ ordered_asin: "6.00", expected_asin: "0.00", canceled_asin: "6.00", fully_canceled: true });
      expect(r.close.closed).toBe(false);
      // a second cancel finds nothing left expected
      expect(await cancelLines(q, s.po, [s.line], null, "again")).toEqual([]);
    });
  });
});

describe("wiring", () => {
  it("the Payments tab renders the claims section; the ASIN rows carry the open claims; the cancel actions route through claims", () => {
    const rows = readFileSync("client/src/components/po-asin-rows.tsx", "utf8");
    expect(rows).toMatch(/claims=\{a\.claims_open\}/);
    expect(rows).toMatch(/claims=\{a\.claims_open\?\.filter\(\(d\) => d\.po_line_item_id === l\.id\)\}/);
    expect(rows).not.toMatch(/RefundProposalDialog/);
    expect(readFileSync("client/src/pages/purchase-orders.tsx", "utf8")).toMatch(/claims=\{po\.claims_open\}/);
    expect(readFileSync("client/src/components/po-money.tsx", "utf8")).toMatch(/<PoClaimsSection /);
    const routes = readFileSync("server/routes.ts", "utf8");
    for (const r of ['"/api/pos/:id/claims"', '"/api/pos/claims/:id"', '"/api/pos/claims/:id/refunds"', '"/api/pos/claims/:id/outcome"', '"/api/pos/claims/:id/reopen"', '"/api/pos/claims/:id/dismiss"', '"/api/pos/claims/tasks/:id/done"']) expect(routes).toContain(r);
    expect(routes).not.toMatch(/po_line_defects|\/defects/);
  });
});
