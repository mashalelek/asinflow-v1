// Finances ingest (patch commit 2) on the recorded pages under __fixtures__/finances —
// never a live call. Window 1 = the DEFERRED state of order 113-2046126-7989841 plus
// fee / storage / inbound / reimbursement / transfer rows; window 2 = its release
// (RELEASED + the DEFERRED_RELEASED copy with the same id) plus a refund and two fees.
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { classifyLeaf, groupOf, labelOf } from "@shared/finances";
import { fetchTransactions, financesDeps, parseTransaction, storeTransactions, weeklyWindows, type ParsedTx } from "./finances";

const page = (n: string) => JSON.parse(fs.readFileSync(path.join(__dirname, "__fixtures__", "finances", n), "utf8"));
const W1 = [page("window-1-page-1.json"), page("window-1-page-2.json")];
const W2 = [page("window-2-page-1.json")];
const DEFERRED_ID = "M-SKJhuzVkKNt0UMhnnYppjglVO84ge2BDrk6kQ5hqo";
const RELEASED_ID = "g5_sFeN_OIkOyha2SICwZH2rFIROnqnlFgX8Mql4kkE";

describe("classifyLeaf (SPEC §2: SB's lines)", () => {
  it("shipment leaves", () => {
    expect(classifyLeaf("Shipment", "ProductCharges > OurPricePrincipal")).toBe("sales");
    expect(classifyLeaf("Shipment", "AmazonFees > Commission > Base")).toBe("referral_fee");
    expect(classifyLeaf("Shipment", "AmazonFees > FBAPerUnitFulfillmentFee > Promo")).toBe("fba_fee");
    expect(classifyLeaf("Shipment", "AmazonFees > VariableClosingFee > Base")).toBe("vcf");
    expect(classifyLeaf("Shipment", "Tax > MarketplaceFacilitatorTax-Principal")).toBe("tax");
    for (const l of ["Shipping > ShippingPrincipal", "PromoRebates > ShippingDiscount", "AmazonFees > ShippingChargeback > Base"]) expect(classifyLeaf("Shipment", l)).toBe("shipping");
    expect(classifyLeaf("Shipment", "PromoRebates > Promotion")).toBe("promo");
    expect(classifyLeaf("Shipment", "AmazonFees > SomethingNew > Base")).toBe("fee:SomethingNew");
  });
  it("refund leaves", () => {
    expect(classifyLeaf("Refund", "ProductCharges > OurPricePrincipal")).toBe("refund_amount");
    expect(classifyLeaf("Refund", "Shipping > ShippingPrincipal")).toBe("refund_amount");
    expect(classifyLeaf("Refund", "PromoRebates > ShippingDiscount")).toBe("refund_amount");
    expect(classifyLeaf("Refund", "Other > RestockingDeductionPrincipal")).toBe("restocking");
    expect(classifyLeaf("Refund", "AmazonFees > RefundCommission > Base")).toBe("refund_commission");
    expect(classifyLeaf("Refund", "AmazonFees > Commission > Base")).toBe("refunded_referral");
    expect(classifyLeaf("Refund", "AmazonFees > VariableClosingFee > Base")).toBe("refund_vcf");
    expect(classifyLeaf("Refund", "Tax > OurPriceTax")).toBe("tax");
  });
  it("groups and labels", () => {
    expect(groupOf("svc:FBACustomerReturn")).toBe("refund_cost");
    expect(groupOf("svc:FBAStorageBilling")).toBe("amazon_fees");
    expect(groupOf("reimb:WAREHOUSE_LOST")).toBe("amazon_fees");
    expect(groupOf("lost_damaged")).toBe("cost_of_goods");
    expect(labelOf("reimb:CRETURN_WRONG_ITEM")).toBe("Creturn wrong item");
    expect(labelOf("svc:FBAPostInboundTransportation")).toBe("Inbound transportation");
    expect(labelOf("svc:BrandNewFee")).toBe("BrandNewFee");
    expect(labelOf("fba_fee")).toBe("FBA per unit fulfilment fee");
  });
});

describe("parseTransaction", () => {
  const all = [...W1, ...W2].flatMap((p) => p.payload.transactions);
  const by = (id: string) => all.find((t) => t.transactionId === id);
  it("a DEFERRED shipment keeps its own fee lines (SPEC §3 source 2); tax leaves are stored as 'tax'", () => {
    const p = parseTransaction(by(DEFERRED_ID)) as ParsedTx;
    expect(p.transaction_status).toBe("DEFERRED");
    expect(p.order_id).toBe("113-2046126-7989841"); expect(p.shipment_id).toBe("490397203170301");
    const sum = (line: string) => p.lines.filter((l) => l.line === line).reduce((s, l) => s + l.amount, 0);
    expect(sum("sales")).toBe(34.86); expect(sum("fba_fee")).toBe(-4.35); expect(sum("referral_fee")).toBe(-5.23); expect(sum("tax")).toBe(0);
    expect(p.lines[0].sku).toBe("AMG-BP-LOT-COC-003"); expect(p.lines[0].asin).toBe("B0001EKWNK"); expect(p.lines[0].quantity).toBe(1);
  });
  it("the RELEASED twin names the deferred transaction; the DEFERRED_RELEASED copy is a release marker, not a row", () => {
    const r = parseTransaction(by(RELEASED_ID)) as ParsedTx;
    expect(r.transaction_status).toBe("RELEASED"); expect(r.deferred_transaction_id).toBe(DEFERRED_ID);
    const copy = W2[0].payload.transactions.find((t: any) => t.transactionStatus === "DEFERRED_RELEASED");
    expect(copy.transactionId).toBe(DEFERRED_ID);
    const m = parseTransaction(copy) as any;
    expect(m.lines).toBeUndefined(); expect(m.release_transaction_id).toBe(RELEASED_ID);
  });
  it("a refund: amount, commission, referral back; the REFUND_ID key", () => {
    const p = parseTransaction(W2[0].payload.transactions.find((t: any) => t.transactionType === "Refund")) as ParsedTx;
    expect(p.refund_id).toBe("amzn1:crow:eF6FnQdyT1urCoyzZIHvZg");
    const sum = (line: string) => Math.round(p.lines.filter((l) => l.line === line).reduce((s, l) => s + l.amount, 0) * 100) / 100;
    expect(sum("refund_amount")).toBe(-38.11); // principal −38.11, shipping −3.34, shipping discount +3.34
    expect(sum("refund_commission")).toBe(-1.14); expect(sum("refunded_referral")).toBe(5.72);
  });
  it("service fees are one line per transaction under the fee type; reimbursements one per item under the reason; transfers have no line", () => {
    const svc = parseTransaction(all.find((t) => t.description === "FBAPostInboundTransportation")) as ParsedTx;
    expect(svc.lines).toEqual([expect.objectContaining({ line: "svc:FBAPostInboundTransportation", amount: -12.54 })]); expect(svc.order_id).toBe("FBA19K9HJ64S");
    const st = parseTransaction(all.find((t) => t.description === "FBAStorageBilling")) as ParsedTx;
    expect(st.lines[0]).toMatchObject({ line: "svc:FBAStorageBilling", amount: -51.47 });
    const rb = parseTransaction(all.find((t) => t.transactionType === "FBAInventoryReimbursement")) as ParsedTx;
    expect(rb.lines).toEqual([expect.objectContaining({ line: "reimb:REVERSAL_REIMBURSEMENT", asin: "B01MQ0IP8F", quantity: 1, amount: 38.46 })]);
    const tr = parseTransaction(all.find((t) => t.transactionType === "Transfer")) as ParsedTx;
    expect(tr.lines).toEqual([]); expect(tr.total_amount).toBe(727.98); expect(tr.settlement_id).toBeTruthy();
  });
  it("resolves an item's ASIN from the SKU when the context has none", () => {
    const tx = JSON.parse(JSON.stringify(by(DEFERRED_ID))); tx.items[0].contexts[0].asin = null;
    const p = parseTransaction(tx, (sku) => (sku === "AMG-BP-LOT-COC-003" ? "B0001EKWNK" : null)) as ParsedTx;
    expect(p.lines[0].asin).toBe("B0001EKWNK");
  });
});

describe("fetchTransactions pages with nextToken; weeklyWindows", () => {
  it("resends the window with the token and concatenates the pages", async () => {
    const calls: any[] = [];
    financesDeps.get = async (params) => { calls.push(params); return params.nextToken ? W1[1] : W1[0]; };
    const r = await fetchTransactions("2026-07-29T00:00:00Z", "2026-08-05T00:00:00Z");
    expect(r.calls).toBe(2); expect(r.transactions.length).toBe(6);
    expect(calls[1]).toMatchObject({ nextToken: "tok-2", postedAfter: "2026-07-29T00:00:00Z", postedBefore: "2026-08-05T00:00:00Z", marketplaceId: "ATVPDKIKX0DER" });
  });
  it("weekly windows cover the range end to end", () => {
    const w = weeklyWindows(new Date("2026-08-01T00:00:00Z"), new Date("2026-08-20T00:00:00Z"));
    expect(w.map((x) => x.from.slice(0, 10))).toEqual(["2026-08-01", "2026-08-08", "2026-08-15"]); expect(w[2].to).toBe("2026-08-20T00:00:00.000Z");
  });
});

describe("storeTransactions (SQL recorded; the real-schema test is finances.db.test.ts)", () => {
  const sql: { text: string; params: any[] }[] = [];
  beforeEach(() => { sql.length = 0; financesDeps.transaction = async (fn) => fn(async (text, params) => { sql.push({ text, params: params ?? [] }); return { rows: [], rowCount: /UPDATE finances_transactions SET superseded_at/.test(text) ? 1 : 0 }; }); });
  it("stores a DEFERRED row with its lines; window 2 stores the RELEASED row, skips the copy and supersedes the deferred id", async () => {
    const r1 = await storeTransactions(W1.flatMap((p) => p.payload.transactions), new Map());
    expect(r1.stored).toBe(6); expect(r1.released).toBe(0);
    const ins1 = sql.filter((s) => /INSERT INTO finances_transactions/.test(s.text)).map((s) => s.params[0]);
    expect(ins1).toContain(DEFERRED_ID);
    const r2 = await storeTransactions(W2.flatMap((p) => p.payload.transactions), new Map());
    expect(r2.stored).toBe(4); expect(r2.released).toBe(1); expect(r2.superseded).toBe(3); // the shipment: once by the RELEASED pointer, once by the copy (idempotent in SQL); the released refund names its own deferred id
    const ins2 = sql.filter((s) => /INSERT INTO finances_transactions/.test(s.text)).map((s) => s.params[0]);
    expect(ins2).toContain(RELEASED_ID); expect(ins2.filter((id) => id === DEFERRED_ID).length).toBe(1); // only window 1's insert
    const sup = sql.filter((s) => /SET superseded_at/.test(s.text)).map((s) => s.params[0]);
    expect(sup.filter((id) => id === DEFERRED_ID)).toEqual([DEFERRED_ID, DEFERRED_ID]); expect(sup.length).toBe(3);
  });
});
