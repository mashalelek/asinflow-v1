// One tracking number on several POs + the shipped-qty split (Maria 2026-11-04; migration 086).
import { describe, it, expect } from "vitest";
import { shippedQtyFromEmail, splitShippedQty, attachTrackingToPos } from "./tracking-attach";
import { matchOrderId, posNamedInText } from "./order-number";
import { findPos, findPosByOrderDigits } from "./tracking-match";
import { findPoForConfirmation, compareConfirmation } from "./po-confirm-reconcile";
import { queueTab, gmailMessageUrl } from "./tracking-routes";
import { HEADER_FIELDS } from "./po-edit";

describe("the shipped quantity an email states", () => {
  it("SupplyHouse \"7 of 20 units\"; parsed items win; none stated → null", () => {
    expect(shippedQtyFromEmail("3\" White Plastic Louvered Replacement Wall Vent SKU: 290W 7 of 20 units $5.72 each", null)).toBe(7);
    expect(shippedQtyFromEmail("anything", [{ qty: 10 }])).toBe(10);
    expect(shippedQtyFromEmail("Your order has shipped", null)).toBeNull();
  });
  it("fills the first PO up to its capacity, the remainder to the next; no qty → none split", () => {
    expect(Array.from(splitShippedQty(7, [{ po_id: "a", capacity: 15 }, { po_id: "b", capacity: 5 }]))).toEqual([["a", 7], ["b", 0]]);
    expect(Array.from(splitShippedQty(18, [{ po_id: "a", capacity: 15 }, { po_id: "b", capacity: 5 }]))).toEqual([["a", 15], ["b", 3]]);
    expect(Array.from(splitShippedQty(null, [{ po_id: "a", capacity: 15 }, { po_id: "b", capacity: 5 }]))).toEqual([["a", null], ["b", null]]);
  });
});

describe("attachTrackingToPos", () => {
  function db() {
    const writes: Array<{ sql: string; params: any[] }> = [];
    const query = async (sql: string, params?: any[]) => {
      if (sql.startsWith("SELECT * FROM po_tracking")) return { rows: [{ id: 763, carrier: "UPS", tracking_number: "1Z8550V20366226675", items_json: null }] };
      if (sql.includes("FROM purchase_orders p WHERE p.id = $1")) return { rows: [{ id: params![0], supplier: "supplyhouse.com", order_id: params![0] === "p1" ? "28686630" : "28686630_1", capacity: params![0] === "p1" ? 15 : 5 }] };
      writes.push({ sql, params: params ?? [] });
      return { rows: [] };
    };
    return { query: query as any, writes };
  }
  it("the queued row goes to the first PO, a split row (split_of) to each further one, with the qty split", async () => {
    const d = db();
    const r = await attachTrackingToPos(d.query, 763, ["p1", "p2"], { emailText: "7 of 20 units" });
    expect(r.pos).toEqual([{ po_id: "p1", order_id: "28686630", qty: 7, split: false }, { po_id: "p2", order_id: "28686630_1", qty: 0, split: true }]);
    expect(d.writes[0].sql).toMatch(/UPDATE po_tracking SET po_id = \$2[\s\S]*status = 'matched'[\s\S]*source = 'manual'[\s\S]*qty = \$4/);
    expect(d.writes[0].params).toEqual([763, "p1", "supplyhouse.com", 7]);
    expect(d.writes[1].sql).toMatch(/INSERT INTO po_tracking[\s\S]*split_of, qty[\s\S]*ON CONFLICT \(split_of, po_id\) WHERE split_of IS NOT NULL/);
    expect(d.writes[1].params).toEqual([763, "p2", "supplyhouse.com", 0]);
  });
  it("dry run writes nothing; one PO and no email → no qty", async () => {
    const d = db();
    const r = await attachTrackingToPos(d.query, 763, ["p1"], { dryRun: true });
    expect(r.pos).toEqual([{ po_id: "p1", order_id: "28686630", qty: null, split: false }]);
    expect(d.writes).toHaveLength(0);
  });
});

describe("alternate order #s (purchase_orders.alt_order_ids)", () => {
  const ADV = { id: "adv", supplier: "theadventurechallenge.com", order_id: "18936582013059", alt_order_ids: "3029684" };
  it("every matcher reads them with the order #", () => {
    expect(matchOrderId(ADV)).toBe("18936582013059 / 3029684");
    expect(matchOrderId({ order_id: "x", alt_order_ids: " " })).toBe("x");
    expect(findPos("theadventurechallenge.com", "3029684", [ADV])).toEqual([ADV]);
    expect(findPosByOrderDigits("#3029684", [ADV])).toEqual([ADV]);
    expect(posNamedInText("A shipment from order #3029684 is on the way", [ADV], "supplier")).toEqual([ADV]);
    const po = { ...ADV, order_total: 360, line_count: 1 };
    const conf = { isConfirmation: true, orderIds: ["3029684"], total: 360, lineCount: 1, senderDomain: "theadventurechallenge.com" };
    expect(findPoForConfirmation(conf, [po], "theadventurechallenge.com")).toEqual([po]);
    expect(compareConfirmation(conf, po)).toEqual([]); // the same order, not a difference
  });
  it("the editor stores them comma-separated", () => {
    expect(HEADER_FIELDS.alt_order_ids("3029684 / 123;456")).toEqual({ ok: true, value: "3029684, 123, 456" });
    expect(HEADER_FIELDS.alt_order_ids("")).toEqual({ ok: true, value: null });
  });
});

describe("the Unmatched panel's tabs and Gmail link (2026-11-04)", () => {
  const row = (x: any) => ({ tracking_number: "1Z", sender_domain: "d", retailer_order_id: "1", email_subject: "s", match_reason: null, ...x });
  it("No number in email: the AI found none, or a placeholder naming no single PO; everything else Needs you", () => {
    expect(queueTab(row({ match_reason: "ai_no_tracking", tracking_number: "email:d:1" }), null)).toBe("no_number");
    expect(queueTab(row({ match_reason: "ai_disabled", tracking_number: "email:d:1" }), () => null)).toBe("no_number");
    expect(queueTab(row({ match_reason: "ai_disabled", tracking_number: "email:d:1" }), () => ({ po_id: "p" }))).toBe("needs_you");
    expect(queueTab(row({ match_reason: "no_po" }), () => null)).toBe("needs_you");
  });
  it("opens the message in the orders@ mailbox; none for a row typed by hand", () => {
    expect(gmailMessageUrl("19a2b3c4d5e6f708", "orders@coastalqualitygoods.com")).toBe("https://mail.google.com/mail/?authuser=orders%40coastalqualitygoods.com#all/19a2b3c4d5e6f708");
    expect(gmailMessageUrl("manual")).toBeNull();
    expect(gmailMessageUrl(null)).toBeNull();
  });
});
