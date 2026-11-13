import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { readFileSync } from "node:fs";
import { claimAmount, claimCounts, claimMoney, claimSummary, costPerIndividualUnit, individualEquivalents } from "@shared/supplier-claim";
import { addClaim, editClaim, linkRefund, unlinkRefund, setOutcome, reopenClaim, dismissClaim, removeClaim, loadClaims, loadOpenClaimSummaries, cancelLines, doneTask, addRefundReceived, confirmSupplier, writeOffRemainder, snoozeTask, loadClaimEvents, recordReply, clearOutcome, editEvent, removeEvent, mergeClaims, recordContact } from "./supplier-claims";
import { loadClaimsPage, sweepClaimTimers, claimDetail, bucketCounts } from "./claim-buckets";
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
      // refund_received is never a plain tick (the refund row is the tick, commit 2); the reopen left it as the one open task
      const task = (await loadClaims(q, { poId: s.po }))[0].tasks.find((t) => t.done_at == null)!;
      expect(task.kind).toBe("refund_received");
      await expect(doneTask(q, task.id, null)).rejects.toMatchObject({ status: 400 });
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

  it("a converted badge claim with no quantity (Maria 2026-11-09): counts toward nothing — Expected, Refunds due, Spend — until the quantity is typed, which completes Enter quantity", async (ctx) => {
    if (!client) return ctx.skip();
    await inTx(async (q) => {
      const s = await seed(q);
      const id = Number((await q(`INSERT INTO supplier_claims (po_id, po_line_item_id, kind, qty, amount_owed, status, found_by, note) VALUES ($1, $2, 'missing', NULL, NULL, 'open', 'maria', 'converted badge') RETURNING id`, [s.po, s.line])).rows[0].id);
      await q(`INSERT INTO supplier_claim_tasks (claim_id, kind, "group", reason) VALUES ($1, 'enter_quantity', 'decide', 'badge carried no qty')`, [id]);
      await setOutcome(q, id, { outcome: "refund_card" }, null); // even a promised refund adds nothing while qty / $ are unknown
      expect(await view(q, s.pa)).toMatchObject({ expected_asin: "6.00", claimed_asin: "0.00", open_claims: 1 });
      expect(await due(q, s.po)).toBe(0);
      const [d] = await loadClaims(q, { poId: s.po });
      expect(d).toMatchObject({ qty: null, amount_owed: null, remaining: null });
      const task = d.tasks.find((t) => t.kind === "enter_quantity")!;
      await expect(doneTask(q, task.id, null)).rejects.toMatchObject({ status: 400 });
      await editClaim(q, id, { qty: 2 }, null); // 2 Individual units → auto $ 11.94, the task closes, Expected drops
      const [after] = await loadClaims(q, { poId: s.po });
      expect(after).toMatchObject({ qty: 2, amount_owed: 11.94, remaining: 11.94 });
      expect(after.tasks.find((t) => t.kind === "enter_quantity")!.done_at).not.toBeNull();
      expect(await view(q, s.pa)).toMatchObject({ expected_asin: "5.00", claimed_asin: "1.00" });
      expect(await due(q, s.po)).toBe(11.94);
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

describe("claims commit 2 on the real schema (rolled back): tasks, buckets, the timer, refunds across claims, write-off remainder", () => {
  it("contact_supplier's tick records the report (date, channel) → Waiting on supplier; 5 business days later the sweep creates follow_up_supplier once; snooze holds it", async (ctx) => {
    if (!client) return ctx.skip();
    await inTx(async (q) => {
      const s = await seed(q);
      const { id } = await addClaim(q, s.po, { po_line_item_id: s.line, kind: "missing", qty: 2, found_at: "2026-10-26" }, null);
      let [row] = await loadClaimsPage(q, { po: "zz-claim-test" }, new Date("2026-10-27T15:00:00Z"));
      expect(row).toMatchObject({ bucket: "needs_attention", next_action: "Contact supplier", step: "Report to supplier" });
      const task = row.tasks.find((t) => t.kind === "contact_supplier")!;
      await doneTask(q, task.id, null, { date: "2026-10-27", channel: "email", note: "asked for 2 singles" });
      [row] = await loadClaimsPage(q, { po: "zz-claim-test" }, new Date("2026-10-30T15:00:00Z")); // Fri: 3 business days
      expect(row).toMatchObject({ bucket: "waiting_supplier", reported_at: "2026-10-27", reported_channel: "email", timed_out: false, step: "Supplier's answer", next_action: "waiting for the supplier's answer" });
      expect(row.bucket_since).toMatch(/^2026-10-27T/);
      // the sweep covers every claim in the database (the local copy has real ones); this test reads its own
      const mine = async (at: Date) => (await sweepClaimTimers(q, at)).filter((x) => x.claim_id === id);
      expect(await mine(new Date("2026-10-30T15:00:00Z"))).toEqual([]);
      // Tue Nov 3 = 5 business days after Tue Oct 27 → follow_up_supplier, once
      expect(await mine(new Date("2026-11-03T16:00:00Z"))).toEqual([{ claim_id: id, kind: "follow_up_supplier", reason: expect.stringMatching(/5 business days: no answer from the supplier/) }]);
      expect(await mine(new Date("2026-11-04T16:00:00Z"))).toEqual([]);
      [row] = await loadClaimsPage(q, { po: "zz-claim-test" }, new Date("2026-11-04T16:00:00Z"));
      expect(row.bucket).toBe("needs_attention");
      expect(bucketCounts([row])).toMatchObject({ needs_attention: 1, waiting_supplier: 0 });
      // snooze: ticked, the timer holds until the snooze ends, then fires again
      const fu = row.tasks.find((t) => t.kind === "follow_up_supplier" && !t.done_at)!;
      const sn = await snoozeTask(q, fu.id, null, 5);
      [row] = await loadClaimsPage(q, { po: "zz-claim-test" }, new Date());
      expect(row.bucket).toBe("waiting_supplier");
      expect(await mine(new Date(Date.parse(sn.snoozed_until) - 60_000))).toEqual([]);
      expect((await mine(new Date(Date.parse(sn.snoozed_until) + 60_000))).map((x) => x.kind)).toEqual(["follow_up_supplier"]);
      expect((await loadClaimEvents(q, id)).map((e) => e.type)).toEqual(["opened", "reported", "timed_out", "snoozed", "timed_out"]);
    });
  });

  it("Set outcome = refund (D6, Maria 2026-11-11): no Refund received tick yet → Waiting on supplier; the timer's follow_up_supplier says 'refund promised, no confirmation'", async (ctx) => {
    if (!client) return ctx.skip();
    await inTx(async (q) => {
      const s = await seed(q);
      const { id } = await addClaim(q, s.po, { po_line_item_id: s.line, kind: "damaged", qty: 1, found_at: "2026-10-26" }, null);
      const t = (await loadClaims(q, { ids: [id] }))[0].tasks[0];
      await doneTask(q, t.id, null, { date: "2026-10-26", channel: "chat" });
      await setOutcome(q, id, { outcome: "refund_card" }, null);
      let [row] = await loadClaimsPage(q, { po: "zz-claim-test" }, new Date("2026-10-29T15:00:00Z"));
      expect(row).toMatchObject({ bucket: "waiting_supplier", outcome: "refund_card", step: "Confirmed by supplier", timed_out: false });
      expect(row.tasks.filter((x) => !x.done_at)).toEqual([]);
      expect(row.next_action).toBe("waiting for the supplier's confirmation");
      // Mon Oct 26 + 5 bd = Mon Nov 2
      expect((await sweepClaimTimers(q, new Date("2026-10-30T15:00:00Z"))).filter((x) => x.claim_id === id)).toEqual([]);
      expect((await sweepClaimTimers(q, new Date("2026-11-02T16:00:00Z"))).filter((x) => x.claim_id === id)).toEqual([{ claim_id: id, kind: "follow_up_supplier", reason: "5 business days: refund promised, no confirmation" }]);
      [row] = await loadClaimsPage(q, { po: "zz-claim-test" }, new Date("2026-11-02T16:00:00Z"));
      expect(row.bucket).toBe("needs_attention");
    });
  });

  it("Confirmed by supplier (hand tick) → Waiting on refund to post with the passive Refund received tick; the timer's check_on_it says 'refund not posted'; the refund closes it", async (ctx) => {
    if (!client) return ctx.skip();
    await inTx(async (q) => {
      const s = await seed(q);
      const { id } = await addClaim(q, s.po, { po_line_item_id: s.line, kind: "damaged", qty: 1, found_at: "2026-10-26" }, null);
      const t = (await loadClaims(q, { ids: [id] }))[0].tasks[0];
      await doneTask(q, t.id, null, { date: "2026-10-26", channel: "chat" });
      await confirmSupplier(q, id, { at: "2026-10-28", outcome: "gift_card" }, null);
      let [row] = await loadClaimsPage(q, { po: "zz-claim-test" }, new Date("2026-10-29T15:00:00Z"));
      expect(row).toMatchObject({ bucket: "waiting_refund", outcome: "gift_card", step: "Received", timed_out: false, next_action: "Refund received" });
      expect(row.steps.find((x) => x.key === "confirmed")).toMatchObject({ done: true });
      expect(row.tasks.filter((x) => !x.done_at).map((x) => x.kind)).toEqual(["refund_received"]);
      // Wed Oct 28 + 5 bd = Wed Nov 4; the passive tick never holds the timer
      expect((await sweepClaimTimers(q, new Date("2026-11-03T15:00:00Z"))).filter((x) => x.claim_id === id)).toEqual([]);
      expect((await sweepClaimTimers(q, new Date("2026-11-04T15:00:00Z"))).filter((x) => x.claim_id === id)).toEqual([{ claim_id: id, kind: "check_on_it", reason: "5 business days: refund not posted" }]);
      // the money arrives (method prefilled by the UI from the payments) → closed, every task done
      const r = await addRefundReceived(q, id, { amount: 5.97, method: "gift_card", refunded_at: "2026-11-05" }, null);
      expect(r.applied).toEqual([{ claim_id: id, amount: 5.97 }]);
      [row] = await loadClaimsPage(q, { po: "zz-claim-test" });
      expect(row).toMatchObject({ bucket: "closed", status: "closed", outcome: "gift_card", remaining: 0, received: 5.97 });
      expect(row.tasks.every((x) => x.done_at)).toBe(true);
      expect(row.steps.every((x) => x.done)).toBe(true);
      const d = await claimDetail(q, id);
      expect(d!.po.refunds).toHaveLength(1);
      expect(d!.events.map((e) => e.type)).toEqual(["opened", "reported", "outcome_set", "supplier_confirmed", "timed_out", "refund_received", "closed"]);
    });
  });

  it("one refund across several claims (Michaels): shares applied per claim, a short share stays owed and waits for the refund to post, Write off remainder closes it", async (ctx) => {
    if (!client) return ctx.skip();
    await inTx(async (q) => {
      const s = await seed(q);
      // emailed cancellations (no Contact supplier step): three canceled claims promised a gift card
      const a = await addClaim(q, s.po, { po_line_item_id: s.line, kind: "canceled", qty: 2 }, null, { noTask: true });   // $11.94
      const b = await addClaim(q, s.po, { po_line_item_id: s.line, kind: "canceled", qty: 1 }, null, { noTask: true });   // $5.97
      const c3 = await addClaim(q, s.po, { po_line_item_id: s.line, kind: "canceled", qty: 1 }, null, { noTask: true });  // $5.97
      await setOutcome(q, a.id, { outcome: "gift_card" }, null); await setOutcome(q, b.id, { outcome: "gift_card" }, null); await setOutcome(q, c3.id, { outcome: "gift_card" }, null);
      expect(await due(q, s.po)).toBe(23.88);
      const det = await claimDetail(q, a.id);
      expect(det!.other_open_claims.map((o) => o.id).sort()).toEqual([b.id, c3.id].sort());
      // one $20 card: $8.06 to a (short by $3.88), $5.97 to b (full), the rest ($5.97) to c3 (full)
      const r = await addRefundReceived(q, a.id, { amount: "20.00", method: "gift_card", refunded_at: "2026-11-06", split: [{ claim_id: b.id, amount: 5.97 }, { claim_id: c3.id, amount: 5.97 }] }, null);
      expect(r.applied).toEqual([{ claim_id: a.id, amount: 8.06 }, { claim_id: b.id, amount: 5.97 }, { claim_id: c3.id, amount: 5.97 }]);
      const rows = await loadClaimsPage(q, { po: "zz-claim-test" }, new Date("2026-11-06T20:00:00Z"));
      const byId = new Map(rows.map((x) => [x.id, x]));
      expect(byId.get(b.id)).toMatchObject({ status: "closed", remaining: 0 });
      expect(byId.get(c3.id)).toMatchObject({ status: "closed", remaining: 0 });
      expect(byId.get(a.id)).toMatchObject({ status: "open", received: 8.06, remaining: 3.88, bucket: "waiting_refund" });
      expect(byId.get(a.id)!.tasks.every((t) => t.done_at)).toBe(true); // the tick happened; the rest waits for the refund to post
      expect(await due(q, s.po)).toBe(3.88);
      expect(Number(await dashDue(q))).toBe(3.88);
      // one refund row, needs_split, no line; the Michaels card's three claims all point at it
      const refundRows = (await q(`SELECT id, amount, needs_split, po_line_item_id FROM po_line_refunds WHERE po_id = $1`, [s.po])).rows;
      expect(refundRows).toHaveLength(1); expect(refundRows[0]).toMatchObject({ amount: "20.00", needs_split: true, po_line_item_id: null });
      expect((await q(`SELECT COUNT(*)::int AS n FROM supplier_claim_refunds WHERE po_line_refund_id = $1`, [refundRows[0].id])).rows[0].n).toBe(3);
      // the shares cannot exceed the refund
      await expect(addRefundReceived(q, a.id, { amount: 1, split: [{ claim_id: b.id, amount: 2 }] }, null)).rejects.toMatchObject({ status: 400 });
      // Maria lets the $3.88 go: closed with its outcome, the remainder written off, Refunds due $0; the coverage sync leaves it closed
      await writeOffRemainder(q, a.id, "Michaels keeps the difference", null);
      const [after] = await loadClaims(q, { ids: [a.id] });
      expect(after).toMatchObject({ status: "closed", outcome: "gift_card", write_off_reason: "Michaels keeps the difference", outcome_amount: 8.06, remaining: 3.88 });
      expect(await due(q, s.po)).toBe(0);
      const { editMoneyRow: edit } = await import("./po-money-edit");
      await edit(q, "po_line_refunds", refundRows[0].id, { note: "touched" }, null); // a refund edit re-syncs coverage
      expect((await loadClaims(q, { ids: [a.id] }))[0].status).toBe("closed");
      await reopenClaim(q, a.id, null);
      expect((await loadClaims(q, { ids: [a.id] }))[0]).toMatchObject({ status: "open", write_off_reason: null, remaining: 3.88 });
    });
  });

  it("review_suggestion: Open accepts (contact_supplier follows), Dismiss dismisses; a refund_received tick without a row is refused; the Claims page filters and the PO's detail header count", async (ctx) => {
    if (!client) return ctx.skip();
    await inTx(async (q) => {
      const s = await seed(q);
      const sug = await addClaim(q, s.po, { po_line_item_id: s.line, kind: "missing", qty: 1, status: "suggested" }, null, { noTask: true });
      await q(`INSERT INTO supplier_claim_tasks (claim_id, kind, "group", reason) VALUES ($1, 'review_suggestion', 'decide', 'AF suggests')`, [sug.id]);
      let [row] = await loadClaimsPage(q, { po: "zz-claim-test" });
      expect(row).toMatchObject({ status: "suggested", bucket: "needs_attention" });
      await doneTask(q, row.tasks[0].id, null, { decision: "open" });
      [row] = await loadClaimsPage(q, { supplier: "zz-test.com" });
      expect(row.status).toBe("open");
      expect(row.tasks.filter((t) => !t.done_at).map((t) => t.kind)).toEqual(["contact_supplier"]);
      await confirmSupplier(q, sug.id, { outcome: "refund_card" }, null); // D6: the tick opens at the confirmation
      const rr = (await loadClaims(q, { ids: [sug.id] }))[0].tasks.find((t) => t.kind === "refund_received")!;
      await expect(doneTask(q, rr.id, null)).rejects.toMatchObject({ status: 400 });
      expect(await loadClaimsPage(q, { kind: "damaged" })).toEqual([]);
      expect((await loadClaimsPage(q, { kind: "missing", po: s.po })).length).toBe(1);
      const sug2 = await addClaim(q, s.po, { po_line_item_id: s.line, kind: "wrong_item", qty: 1, status: "suggested" }, null, { noTask: true });
      await q(`INSERT INTO supplier_claim_tasks (claim_id, kind, "group") VALUES ($1, 'review_suggestion', 'decide')`, [sug2.id]);
      await doneTask(q, (await loadClaims(q, { ids: [sug2.id] }))[0].tasks[0].id, null, { decision: "dismiss", reason: "not ours" });
      expect((await loadClaims(q, { ids: [sug2.id] }))[0]).toMatchObject({ status: "dismissed", dismiss_reason: "not ours" }); // the Dismissed tab's Step (Maria 2026-11-12)
      expect((await loadClaimsPage(q, { po: s.po })).find((r) => r.id === sug2.id)).toMatchObject({ bucket: "dismissed", sentence: "Dismissed · not ours", action: { kind: "reopen", label: "Reopen" } });
      // the confirmed claim's leftover contact_supplier task is moot (one derivation, Maria 2026-11-12): Waiting on refund to post, not Needs attention
      expect(bucketCounts(await loadClaimsPage(q, { po: s.po }))).toMatchObject({ needs_attention: 0, waiting_refund: 1, dismissed: 1 });
    });
  });

  it("Refunds due on the production shape, before and after the switch to claims: $5.97 both ways (the dry-run report's figures; the seeded set: an uncovered $5.97 claim, a reopened claim fully refunded, badge claims with no quantity)", async (ctx) => {
    // The report the migration was approved on records today's figure and the claims figure.
    const report = readFileSync("docs/claims-commit1-dryrun-2026-11-09.md", "utf8");
    const m = /Refunds due[^\n]*today \$([\d.]+)[^\n]*→ after \$([\d.]+)/.exec(report);
    expect(m, "the dry-run report names Refunds due today → after").not.toBeNull();
    expect(m![1]).toBe("5.97"); expect(m![2]).toBe("5.97");
    if (!client) return ctx.skip();
    await inTx(async (q) => {
      const s = await seed(q);
      // the Caress defect: open, $5.97, no refund row
      await addClaim(q, s.po, { po_line_item_id: s.line, kind: "missing", qty: 1 }, null);
      // a reopened "Confirm refund" claim whose sheet refund already covers it in full (kohls 6739984735's shape)
      const k = await addClaim(q, s.po, { po_line_item_id: s.line, kind: "canceled", qty: 2 }, null);
      await setOutcome(q, k.id, { outcome: "refund_card" }, null);
      await addRefundReceived(q, k.id, { amount: 11.94, method: "card", refunded_at: "2026-11-01" }, null);
      await reopenClaim(q, k.id, null); // reopened by the badge conversion (f): refund_received task, $ covered → adds nothing
      // two badge claims with no quantity and no $ (k)
      await q(`INSERT INTO supplier_claims (po_id, po_line_item_id, kind, qty, amount_owed, status, found_by) VALUES ($1, $2, 'missing', NULL, NULL, 'open', 'maria'), ($1, $2, 'missing', NULL, NULL, 'closed', 'maria')`, [s.po, s.line]);
      expect(await due(q, s.po)).toBe(5.97);
      expect(Number(await dashDue(q))).toBe(5.97);
      const rows = await loadClaimsPage(q, { po: s.po });
      expect(rows.filter((r) => r.bucket === "needs_attention" || r.bucket === "waiting_refund" || r.bucket === "waiting_supplier").reduce((t, r) => t + (r.remaining ?? 0), 0)).toBeCloseTo(5.97 + 0, 2);
    });
  });
});

describe("wiring", () => {
  it("commit 2 wiring: claims are never in Action Items — the POs list has a Claims column, the PO page a Claims link, card and Open claim per line; the Payments section is gone; the routes exist", () => {
    const rows = readFileSync("client/src/components/po-asin-rows.tsx", "utf8");
    expect(rows).not.toMatch(/claims=\{a\.claims_open\}/); // not passed into the chips any more
    expect(rows).toMatch(/<LineClaims a=\{a\} line=\{l\}/);
    expect(rows).toMatch(/OpenClaimButton/);
    expect(rows).not.toMatch(/RefundProposalDialog/);
    const pos = readFileSync("client/src/pages/purchase-orders.tsx", "utf8");
    expect(pos).toMatch(/\{ id: "claims", label: "Claims"/);
    expect(pos).toMatch(/<PoClaimsCount claims=\{po\.claims_open\}/);
    expect(pos).toMatch(/data-testid="link-po-claims"/);
    expect(pos).toMatch(/data-testid="po-detail-claims"/);
    expect(pos).toMatch(/select-po-claims/);
    expect(readFileSync("client/src/components/po-money.tsx", "utf8")).not.toMatch(/<PoClaimsSection /);
    expect(readFileSync("client/src/App.tsx", "utf8")).toMatch(/<Route path="\/claims" component=\{Claims\} \/>/);
    expect(readFileSync("client/src/components/layout/top-nav.tsx", "utf8")).toMatch(/\{ path: "\/purchase-orders"[^\n]*\n[^\n]*\n\s*\{ path: "\/claims", label: "Claims"/);
    const routes = readFileSync("server/routes.ts", "utf8");
    for (const r of ['"/api/pos/:id/claims"', '"/api/pos/claims/:id"', '"/api/pos/claims/:id/refunds"', '"/api/pos/claims/:id/outcome"', '"/api/pos/claims/:id/reopen"', '"/api/pos/claims/:id/dismiss"', '"/api/pos/claims/tasks/:id/done"',
      '"/api/pos/claims/tasks/:id/snooze"', '"/api/pos/claims/:id/confirm-supplier"', '"/api/pos/claims/:id/refund-received"', '"/api/pos/claims/:id/write-off-remainder"', '"/api/claims"', '"/api/claims/:id"']) expect(routes).toContain(r);
    expect(routes).not.toMatch(/po_line_defects|\/defects/);
  });
});

describe("commit 2b (§5 amended 2026-11-12): Supplier replied, clear the outcome, edit a timeline entry, merge — on the real schema (rolled back)", () => {
  it("Contacted supplier → Supplier replied (no outcome → Decide: confirm outcome; the timer restarts from the reply) → a reply that tells the outcome sets it; every change leaves an event and a History row", async (ctx) => {
    if (!client) return ctx.skip();
    await inTx(async (q) => {
      const s = await seed(q);
      const { id } = await addClaim(q, s.po, { po_line_item_id: s.line, kind: "missing", qty: 2 }, null);
      await recordContact(q, id, { date: "2026-11-03", channel: "email", note: "asked about the 2 missing" }, null);
      let [row] = await loadClaimsPage(q, { po: s.po }, new Date("2026-11-05T15:00:00Z"));
      expect(row).toMatchObject({ reported_at: "2026-11-03", bucket: "waiting_supplier", sentence: "Reported 11/3 by email · no answer yet" });
      // the supplier replies without saying what they will do → Decide (confirm_outcome), the sentence quotes the reply
      await recordReply(q, id, { date: "2026-11-06", channel: "chat", summary: "remaining 2 ship out tomorrow" }, null);
      [row] = await loadClaimsPage(q, { po: s.po }, new Date("2026-11-06T20:00:00Z"));
      expect(row.last_supplier_reply_at).toMatch(/^2026-11-06/);
      expect(row.bucket).toBe("needs_attention");
      expect(row.tasks.filter((t) => !t.done_at).map((t) => t.kind)).toEqual(["confirm_outcome"]);
      expect(row.sentence).toBe('Supplier replied 11/6: "remaining 2 ship out tomorrow" → outcome?');
      expect(row.action).toMatchObject({ kind: "detail", label: "Confirm outcome" });
      expect(row.group).toBe("decide");
      // a second reply tells the outcome: replacement → the confirm task closes, the outcome is set, the steps change
      await recordReply(q, id, { date: "2026-11-07", channel: "email", summary: "shipping a replacement", outcome: "replacement" }, null);
      [row] = await loadClaimsPage(q, { po: s.po }, new Date("2026-11-09T15:00:00Z"));
      expect(row).toMatchObject({ outcome: "replacement", bucket: "waiting_supplier" });
      expect(row.tasks.filter((t) => !t.done_at).map((t) => t.kind)).toEqual(["replacement_arrived"]);
      expect(row.ui_steps.map((x) => x.key)).toEqual(["found", "reported", "promised", "tell_velocity", "shipped", "arrived", "closed"]);
      const ev = (await loadClaimEvents(q, id)).map((e) => e.type);
      expect(ev).toEqual(["opened", "reported", "supplier_reply", "supplier_reply", "outcome_set"]);
      const h = await history(q, s.po);
      expect(h.map((x: any) => x.field)).toEqual(expect.arrayContaining(["claim reported_at", "supplier replied", "claim outcome"]));
      // clear the outcome: back to "not known yet", the passive tick removed, event + History row; the reply still anchors the timer
      await clearOutcome(q, id, "set while testing", null);
      [row] = await loadClaimsPage(q, { po: s.po }, new Date("2026-11-09T15:00:00Z"));
      expect(row).toMatchObject({ outcome: null, status: "open", bucket: "waiting_supplier" });
      expect(row.tasks.filter((t) => !t.done_at)).toHaveLength(0);
      // the timer runs from the latest of the reply (11/7) and the tick that closed the confirm task (now, in this rolled-back run)
      expect(new Date(row.bucket_since!).getTime()).toBeGreaterThanOrEqual(Date.parse("2026-11-07T12:00:00Z"));
      expect((await loadClaimEvents(q, id)).pop()).toMatchObject({ type: "outcome_set", summary: "outcome cleared — was replacement · set while testing" });
      expect((await history(q, s.po)).pop()).toMatchObject({ field: "claim outcome", new_value: "cleared: set while testing" });
    });
  });
  it("editEvent: a reported entry's date moves reported_at (the timer with it), a reply's date moves last_supplier_reply_at, a summary edit is a History row", async (ctx) => {
    if (!client) return ctx.skip();
    await inTx(async (q) => {
      const s = await seed(q);
      const { id } = await addClaim(q, s.po, { po_line_item_id: s.line, kind: "missing", qty: 2 }, null);
      await recordContact(q, id, { date: "2026-11-03", channel: "email" }, null);
      const reported = (await loadClaimEvents(q, id)).find((e) => e.type === "reported")!;
      await editEvent(q, reported.id, { at: "2026-11-01", summary: "email · 2026-11-01 · typo fixed" }, null);
      let [row] = await loadClaimsPage(q, { po: s.po }, new Date("2026-11-05T15:00:00Z"));
      expect(row.reported_at).toBe("2026-11-01");
      expect(row.bucket_since).toBe("2026-11-01T12:00:00.000Z");
      expect((await loadClaimEvents(q, id)).find((e) => e.id === reported.id)).toMatchObject({ summary: "email · 2026-11-01 · typo fixed" });
      await recordReply(q, id, { date: "2026-11-06", channel: "chat", summary: "looking" }, null);
      const reply = (await loadClaimEvents(q, id)).find((e) => e.type === "supplier_reply")!;
      await editEvent(q, reply.id, { at: "2026-11-04" }, null);
      [row] = await loadClaimsPage(q, { po: s.po }, new Date("2026-11-05T15:00:00Z"));
      expect(row.last_supplier_reply_at).toMatch(/^2026-11-04/);
      expect((await history(q, s.po)).map((x: any) => x.field)).toEqual(expect.arrayContaining(["timeline reported", "timeline reported date", "timeline supplier_reply date"]));
      await expect(editEvent(q, reply.id, { at: "11/04/2026" }, null)).rejects.toThrow(/YYYY-MM-DD/);
    });
  });
  it("removeEvent (Maria 2026-11-12): Contacted → Supplier replied (refund) → Confirmed → Refund received, then Remove this entry on each, back to the report alone; the fact each entry set goes with it, one History row each, no new entry; the claim's own entries are refused", async (ctx) => {
    if (!client) return ctx.skip();
    await inTx(async (q) => {
      const s = await seed(q);
      const { id } = await addClaim(q, s.po, { po_line_item_id: s.line, kind: "missing", qty: 2 }, null);
      await recordContact(q, id, { date: "2026-11-12", channel: "email" }, null);
      await recordReply(q, id, { date: "2026-11-12", channel: "email", summary: "refunding the 2", outcome: "refund_card" }, null);
      await confirmSupplier(q, id, { at: "2026-11-12" }, null);
      const { refund_id } = await addRefundReceived(q, id, { amount: 11.94, method: "card", refunded_at: "2026-11-12" }, null);
      const types = async () => (await loadClaimEvents(q, id)).map((e) => e.type);
      const find = async (t: string) => (await loadClaimEvents(q, id)).filter((e) => e.type === t).pop()!;
      let [row] = await loadClaimsPage(q, { po: s.po }, new Date("2026-11-12T20:00:00Z"));
      expect(row).toMatchObject({ status: "closed", outcome: "refund_card", bucket: "closed" });
      expect(await types()).toEqual(["opened", "reported", "supplier_reply", "outcome_set", "supplier_confirmed", "refund_received", "closed"]);
      const before = (await history(q, s.po)).length;
      // 1. the refund: row unlinked and deleted, the claim open again, the Closed entry gone, the Refund received tick open again (the confirmation stands)
      await removeEvent(q, (await find("refund_received")).id, null);
      [row] = await loadClaimsPage(q, { po: s.po }, new Date("2026-11-12T20:00:00Z"));
      expect(row).toMatchObject({ status: "open", outcome: "refund_card", received: 0, remaining: 11.94, bucket: "waiting_refund" });
      expect(row.supplier_confirmed_at).toMatch(/^2026-11-12/);
      expect(row.tasks.filter((t) => !t.done_at).map((t) => t.kind)).toEqual(["refund_received"]);
      expect((await q(`SELECT count(*)::int AS n FROM po_line_refunds WHERE id = $1`, [refund_id])).rows[0].n).toBe(0);
      expect(await types()).toEqual(["opened", "reported", "supplier_reply", "outcome_set", "supplier_confirmed"]);
      // 2. the confirmation: supplier_confirmed_at cleared, the Refund received tick removed; the outcome stands
      await removeEvent(q, (await find("supplier_confirmed")).id, null);
      [row] = await loadClaimsPage(q, { po: s.po }, new Date("2026-11-12T20:00:00Z"));
      expect(row).toMatchObject({ supplier_confirmed_at: null, outcome: "refund_card", bucket: "waiting_supplier" });
      expect(row.tasks.filter((t) => !t.done_at)).toHaveLength(0);
      // 3. the outcome: not known yet
      await expect(removeEvent(q, (await find("supplier_reply")).id, null)).resolves.toBeTruthy();
      [row] = await loadClaimsPage(q, { po: s.po }, new Date("2026-11-12T20:00:00Z"));
      expect(row.last_supplier_reply_at).toBeNull();
      await removeEvent(q, (await find("outcome_set")).id, null);
      [row] = await loadClaimsPage(q, { po: s.po }, new Date("2026-11-12T20:00:00Z"));
      expect(row).toMatchObject({ outcome: null, outcome_amount: null, reported_at: "2026-11-12", reported_channel: "email", status: "open", bucket: "waiting_supplier", sentence: "Reported 11/12 by email · no answer yet" });
      expect(row.bucket_since).toBe("2026-11-12T12:00:00.000Z");
      expect(await types()).toEqual(["opened", "reported"]);
      const h = await history(q, s.po);
      expect(h.slice(before).map((x: any) => x.field)).toEqual(["timeline refund_received removed", "refund unlinked", "claim reopened", "timeline supplier_confirmed removed", "claim supplier_confirmed_at", "timeline supplier_reply removed", "supplier replied", "timeline outcome_set removed", "claim outcome"]);
      // 4. the report itself: unreported again — Report to supplier, the Contacted tick open, no timer
      await removeEvent(q, (await find("reported")).id, null);
      [row] = await loadClaimsPage(q, { po: s.po }, new Date("2026-11-12T20:00:00Z"));
      expect(row).toMatchObject({ reported_at: null, reported_channel: null, bucket: "needs_attention", sentence: "Report to supplier" });
      expect(row.tasks.filter((t) => !t.done_at).map((t) => t.kind)).toEqual(["contact_supplier"]);
      expect(await types()).toEqual(["opened"]);
      await expect(removeEvent(q, (await find("opened")).id, null)).rejects.toThrow(/claim's own state/);
      // a second report on a reported claim: removing its entry keeps the first report's date and drops the tick it added
      await recordContact(q, id, { date: "2026-11-10", channel: "email" }, null);
      await recordContact(q, id, { date: "2026-11-11", channel: "chat", note: "again" }, null);
      expect((await q(`SELECT count(*)::int AS n FROM supplier_claim_tasks WHERE claim_id = $1 AND kind = 'contact_supplier'`, [id])).rows[0].n).toBe(2);
      await removeEvent(q, (await find("reported")).id, null);
      [row] = await loadClaimsPage(q, { po: s.po }, new Date("2026-11-12T20:00:00Z"));
      expect(row).toMatchObject({ reported_at: "2026-11-10", reported_channel: "email", bucket: "waiting_supplier" });
      expect((await q(`SELECT count(*)::int AS n FROM supplier_claim_tasks WHERE claim_id = $1 AND kind = 'contact_supplier'`, [id])).rows[0].n).toBe(1);
    });
  });
  it("removeEvent: a confirmed outcome is removed confirmation first; removing a reply re-opens the Confirm outcome task it closed and drops the one it opened; a written-off outcome removed reopens the claim", async (ctx) => {
    if (!client) return ctx.skip();
    await inTx(async (q) => {
      const s = await seed(q);
      const { id } = await addClaim(q, s.po, { po_line_item_id: s.line, kind: "missing", qty: 2 }, null);
      await recordContact(q, id, { date: "2026-11-03", channel: "email" }, null);
      await recordReply(q, id, { date: "2026-11-06", channel: "chat", summary: "looking into it" }, null);
      await recordReply(q, id, { date: "2026-11-07", channel: "chat", summary: "refund coming", outcome: "refund_card" }, null);
      await confirmSupplier(q, id, { at: "2026-11-08" }, null);
      const ev = async (t: string) => (await loadClaimEvents(q, id)).filter((e) => e.type === t);
      await expect(removeEvent(q, (await ev("outcome_set"))[0].id, null)).rejects.toThrow(/Confirmed by supplier entry first/);
      await removeEvent(q, (await ev("supplier_confirmed"))[0].id, null);
      await removeEvent(q, (await ev("outcome_set"))[0].id, null);
      // the second reply closed the Confirm outcome task of the first: removing it re-opens that task, the first reply anchors the timer
      await removeEvent(q, (await ev("supplier_reply"))[1].id, null);
      let [row] = await loadClaimsPage(q, { po: s.po }, new Date("2026-11-09T15:00:00Z"));
      expect(row.last_supplier_reply_at).toMatch(/^2026-11-06/);
      expect(row.tasks.filter((t) => !t.done_at).map((t) => [t.kind, t.reason])).toEqual([["confirm_outcome", 'Supplier replied 11/6: "looking into it" → outcome?']]);
      await removeEvent(q, (await ev("supplier_reply"))[0].id, null);
      [row] = await loadClaimsPage(q, { po: s.po }, new Date("2026-11-09T15:00:00Z"));
      expect(row).toMatchObject({ last_supplier_reply_at: null, outcome: null, bucket: "waiting_supplier", bucket_since: "2026-11-03T12:00:00.000Z" });
      expect(row.tasks.filter((t) => !t.done_at)).toHaveLength(0);
      // a write-off: closed → removing its entry reopens the claim with no outcome
      await setOutcome(q, id, { outcome: "write_off", reason: "not worth it" }, null);
      await removeEvent(q, (await ev("outcome_set"))[0].id, null);
      [row] = await loadClaimsPage(q, { po: s.po }, new Date("2026-11-09T15:00:00Z"));
      expect(row).toMatchObject({ status: "open", outcome: null, write_off_reason: null, closed_at: null });
      expect((await loadClaimEvents(q, id)).map((e) => e.type)).toEqual(["opened", "reported"]);
      await expect(removeEvent(q, 0, null)).rejects.toThrow(/not found/);
    });
  });
  it("mergeClaims: the source's refunds and timeline move, the quantities add up, the auto $ owed re-derives, the source is dismissed as merged; a different PO or a dismissed claim is refused", async (ctx) => {
    if (!client) return ctx.skip();
    await inTx(async (q) => {
      const s = await seed(q);
      const a = await addClaim(q, s.po, { po_line_item_id: s.line, kind: "missing", qty: 1 }, null);
      const b = await addClaim(q, s.po, { po_line_item_id: s.line, kind: "missing", qty: 2, note: "second count" }, null);
      await setOutcome(q, b.id, { outcome: "refund_card" }, null);
      await confirmSupplier(q, b.id, { at: "2026-11-05" }, null);
      await addRefundReceived(q, b.id, { amount: 5, method: "card", refunded_at: "2026-11-06" }, null);
      const r = await mergeClaims(q, b.id, a.id, null);
      expect(r).toEqual({ id: a.id, po_id: s.po, merged_from: b.id });
      const rows = await loadClaims(q, { poId: s.po });
      const target = rows.find((x) => x.id === a.id)!, source = rows.find((x) => x.id === b.id)!;
      expect(target).toMatchObject({ qty: 3, amount_owed: 17.91, amount_owed_source: "auto", received: 5, remaining: 12.91, status: "open" });
      expect(target.refunds).toHaveLength(1);
      expect(source).toMatchObject({ status: "dismissed", qty: 2 });
      expect(source.refunds).toHaveLength(0);
      expect(source.note).toContain(`merged into claim #${a.id}`);
      const ev = (await loadClaimEvents(q, a.id)).map((e) => e.type);
      expect(ev).toContain("supplier_confirmed");
      expect(ev).toContain("refund_received");
      expect(ev[ev.length - 1]).toBe("converted");
      expect((await loadClaimEvents(q, b.id)).map((e) => e.type)).toEqual(["dismissed"]);
      await expect(mergeClaims(q, a.id, b.id, null)).rejects.toThrow(/dismissed/);
      const other = (await q(`INSERT INTO purchase_orders (order_id, order_date, supplier, subtotal, order_total) VALUES ('zz-claim-test-2', '2026-10-18', 'zz-test.com', 1, 1) RETURNING id`)).rows[0].id;
      const c = await addClaim(q, other, { kind: "never_received", qty: 1, amount_owed: 1 }, null);
      await expect(mergeClaims(q, c.id, a.id, null)).rejects.toThrow(/same PO/);
    });
  });
});
