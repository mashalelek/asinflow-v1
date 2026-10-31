import { describe, it, expect } from "vitest";
import { parseConfirmationEmail, extractTotal, extractLineCount, findPoForConfirmation, compareConfirmation, reconcileConfirmations } from "./po-confirm-reconcile";

// §6.7 (no AI): an order-confirmation email for an AF PO → compare order #, total, line count → "Confirm order details" with the diff.
const walmart = { subject: "Thanks for your delivery order, Maria", fromDomain: "walmart.com", text: "Order# 2000152-48695719\nArrives Thu\nQty: 2 Lysol Wipes $11.98\nQty: 1 Sharpies $5.44\nSubtotal $17.42\nTax $1.05\nTotal $18.47" };
const jcp = { subject: "Thank you for your JCPenney.com order #2026-2846-1345-0906", fromDomain: "jcp.com", text: "Order total: $53.28\nItem x 3" };
const bbb = { subject: "Your Bed Bath & Beyond order is confirmed.", fromDomain: "bedbathandbeyond.com", text: "Order number: 123456789012\nQuantity 1\nGrand total $137.19" };
const shipped = { subject: "Your order #12345 has shipped", fromDomain: "shop.example.com", text: "Order #12345 shipped" };

describe("parseConfirmationEmail", () => {
  it("recognises the probe's confirmation formats, not shipping mail; reads the order #, total and line count", () => {
    expect(parseConfirmationEmail(walmart)).toEqual({ isConfirmation: true, orderIds: ["2000152-48695719"], total: 18.47, lineCount: 2, senderDomain: "walmart.com" });
    expect(parseConfirmationEmail(jcp)).toMatchObject({ isConfirmation: true, orderIds: ["2026-2846-1345-0906"], total: 53.28, lineCount: 1 }); // "Item x 3" is one line
    expect(parseConfirmationEmail(bbb)).toMatchObject({ isConfirmation: true, orderIds: ["123456789012"], total: 137.19, lineCount: 1 });
    expect(parseConfirmationEmail(shipped).isConfirmation).toBe(false);
    expect(extractTotal("Subtotal $10.00\nTotal savings $2.00\nTotal $8.00")).toBe(8);
    expect(extractLineCount("nothing here")).toBeNull();
  });
  it("finds the PO by order # (dashes ignored, _N suffix by base id), narrowing by the sender's supplier when ids collide; compares the three facts", () => {
    const pos = [
      { id: "w", supplier: "walmart.com", order_id: "200015248695719", order_total: 18.47, line_count: 2 },
      { id: "t", supplier: "target.com", order_id: "200015248695719", order_total: 99, line_count: 1 },
      { id: "s", supplier: "staples.com", order_id: "9929903576_1", order_total: 10, line_count: 1 },
    ];
    const p = parseConfirmationEmail(walmart);
    expect(findPoForConfirmation(p, pos, "walmart.com").map((x) => x.id)).toEqual(["w"]);
    expect(findPoForConfirmation(p, pos, null).map((x) => x.id)).toEqual(["w", "t"]); // ambiguous without the sender
    expect(findPoForConfirmation({ ...p, orderIds: ["9929903576"] }, pos, null).map((x) => x.id)).toEqual(["s"]);
    expect(compareConfirmation(p, pos[0])).toEqual([]);
    expect(compareConfirmation(p, { ...pos[0], order_total: 20, line_count: 3 })).toEqual(["total $20.00 in AF, $18.47 in the email", "3 lines in AF, 2 in the email"]);
    expect(compareConfirmation({ ...p, orderIds: ["9929903576"], total: null, lineCount: null }, pos[2])).toEqual(["order # 9929903576_1 in AF, 9929903576 in the email"]);
  });
  it("reconcileConfirmations: raises 'Confirm order details' on every line of a differing PO (reason = the diff), counts the rest; a dry run writes nothing", async () => {
    const calls: Array<{ sql: string; params: any[] }> = [];
    const q = async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      if (/FROM purchase_orders p$/.test(sql.trim())) return { rows: [{ id: "w", supplier: "walmart.com", order_id: "200015248695719", order_total: 20, line_count: 2 }], rowCount: 1 };
      if (/FROM settings WHERE key/.test(sql)) return { rows: [], rowCount: 0 };
      if (/SELECT id FROM po_line_items WHERE po_id/.test(sql)) return { rows: [{ id: "l1" }, { id: "l2" }], rowCount: 2 };
      return { rows: [], rowCount: 1 };
    };
    const msgs: Record<string, any> = { a: { id: "a", threadId: null, date: new Date(), labelIds: [], from: "", trackLinks: [], ...walmart }, b: { id: "b", threadId: null, date: new Date(), labelIds: [], from: "", trackLinks: [], ...shipped } };
    const deps = { gmail: {} as any, list: async () => ["a", "b"], get: async (_g: any, id: string) => msgs[id] };
    const dry = await reconcileConfirmations({ query: q, deps, dryRun: true, since: null, now: new Date("2026-10-31T05:00:00Z") });
    expect(dry).toMatchObject({ scanned: 2, confirmations: 1, matched: 1, agreed: 0, differed: 1, raised: 0, unmatched: 0, ambiguous: 0, dryRun: true });
    expect(dry.diffs).toEqual([{ po_id: "w", supplier: "walmart.com", order_id: "200015248695719", differences: ["total $20.00 in AF, $18.47 in the email"] }]);
    expect(calls.some((c) => /INSERT/.test(c.sql))).toBe(false);
    const live = await reconcileConfirmations({ query: q, deps, since: null, now: new Date("2026-10-31T05:00:00Z") });
    expect(live.raised).toBe(1);
    const ins = calls.filter((c) => /INSERT INTO po_line_action_items/.test(c.sql));
    expect(ins.map((c) => [c.params[0], c.params[1], c.params[2], c.params[3]])).toEqual([["l1", ["Confirm order details"], "auto", "total $20.00 in AF, $18.47 in the email"], ["l2", ["Confirm order details"], "auto", "total $20.00 in AF, $18.47 in the email"]]);
    expect(calls.some((c) => /INSERT INTO settings/.test(c.sql) && c.params[0] === "confirm.gmail_watermark")).toBe(true);
  });
});
