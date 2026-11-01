import { describe, it, expect } from "vitest";
import { parsePaymentMethod } from "./po-payments-parse";
import { frequencyWeeksFromText, subscriptionStatusFromText, addWeeks, planAsinPack, packFromSheetCells, packKey, planRefund } from "./po-model-backfill";

// Migration-075 backfills (patch po-ai-prefill §8, amended 2026-10-31).
describe("parsePaymentMethod", () => {
  it("name-only, nickname + last 4, and the PayPal variant", () => {
    expect(parsePaymentMethod("Gift cards")).toEqual([{ method: "gift_card", nickname: "Gift cards", last4: null, amount: null, needs_review: false }]);
    expect(parsePaymentMethod("Amex (1001)")).toEqual([{ method: "card", nickname: "Amex", last4: "1001", amount: null, needs_review: false }]);
    expect(parsePaymentMethod("Visa 6120")).toEqual([{ method: "card", nickname: "Visa", last4: "6120", amount: null, needs_review: false }]);
    expect(parsePaymentMethod("Chase (9647) (through PayPal)")).toEqual([{ method: "paypal", nickname: "Chase", last4: "9647", amount: null, needs_review: false }]);
    expect(parsePaymentMethod("Webstaurant Visa")).toEqual([{ method: "card", nickname: "Webstaurant Visa", last4: null, amount: null, needs_review: false }]);
  });
  it("several payments with amounts — colon and parenthesis shapes, thousands commas, a missing separator", () => {
    expect(parsePaymentMethod("Gift cards: $1,000, Chase (9647): $6.76")).toEqual([
      { method: "gift_card", nickname: "Gift cards", last4: null, amount: "1000.00", needs_review: false },
      { method: "card", nickname: "Chase", last4: "9647", amount: "6.76", needs_review: false },
    ]);
    expect(parsePaymentMethod("Gift Cards ($167.19), Visa 7927 ($6.39)")).toEqual([
      { method: "gift_card", nickname: "Gift Cards", last4: null, amount: "167.19", needs_review: false },
      { method: "card", nickname: "Visa", last4: "7927", amount: "6.39", needs_review: false },
    ]);
    expect(parsePaymentMethod("Chase (6120): $7.12Gift cards: $65,").map((d) => [d.method, d.amount])).toEqual([["card", "7.12"], ["gift_card", "65.00"]]);
    expect(parsePaymentMethod("Walmart balance: $37.96, Gift cards: $292.52").map((d) => d.method)).toEqual(["store_credit", "gift_card"]);
    expect(parsePaymentMethod("Gift cards: $, Discover: $6.17")[0]).toMatchObject({ method: "gift_card", amount: null, needs_review: false });
  });
  it("a list of gift-card last 4s, and texts that cannot be read become one `other` row for review", () => {
    expect(parsePaymentMethod("Gift cards: 7204, 9283, 7246").map((d) => d.last4)).toEqual(["7204", "9283", "7246"]);
    expect(parsePaymentMethod("?")).toEqual([{ method: "other", nickname: "?", last4: null, amount: null, needs_review: true }]);
    expect(parsePaymentMethod("Check after it's processed, then pay")).toMatchObject([{ method: "other", needs_review: true }]);
    expect(parsePaymentMethod("")).toEqual([]);
    expect(parsePaymentMethod("Rewards balance (from returns)")).toEqual([{ method: "store_credit", nickname: "Rewards balance (from returns)", last4: null, amount: null, needs_review: false }]);
  });
});

describe("subscriptions from the sheet's notes", () => {
  it("frequency in weeks (months × 4), status from cancel words, next date arithmetic", () => {
    expect(frequencyWeeksFromText("Every 12 weeks")).toBe(12);
    expect(frequencyWeeksFromText("Every 3 months")).toBe(12);
    expect(frequencyWeeksFromText("Monthly delivery. Unsubscribe.")).toBe(4);
    expect(frequencyWeeksFromText("3-month subscription/autoship")).toBe(12);
    expect(frequencyWeeksFromText("60-days subscription")).toBe(9);
    expect(frequencyWeeksFromText("Didn't get an email.")).toBeNull();
    expect(subscriptionStatusFromText("Every 12 weeks - canceled")).toBe("canceled");
    expect(subscriptionStatusFromText("Every month on the 1st")).toBe("active");
    expect(addWeeks("2026-09-19", 4)).toBe("2026-10-17");
    expect(addWeeks("2026-12-20", 2)).toBe("2027-01-03");
  });
});

describe("packFromSheetCells / planAsinPack (Maria 2026-11-01: the sheet's AX/AY literally, blank = no information)", () => {
  it("blank AX is null, never individual; individual is 1 per pack; other values take AY, blank AY → unknown units", () => {
    expect(packFromSheetCells("", "")).toBeNull();
    expect(packFromSheetCells(undefined, "3")).toBeNull();
    expect(packFromSheetCells("individual", "")).toEqual({ sold_as: "individual", units_per_pack: 1 });
    expect(packFromSheetCells("Multi-pack", "6")).toEqual({ sold_as: "multi-pack", units_per_pack: 6 });
    expect(packFromSheetCells("bundle", "")).toEqual({ sold_as: "bundle", units_per_pack: null });
    expect(packKey({ sold_as: "bundle", units_per_pack: null })).toBe("bundle×?");
  });
  it("agreeing rows set the ASIN from the newest row; disagreeing rows are a possible mismatch with PO numbers; rows without a value are no-info, and never count as individual", () => {
    const plan = planAsinPack([
      { asin: "B001", title: "Agree", po: "a.com 3 (2026-10-01)", pack: { sold_as: "multi-pack", units_per_pack: 6 } },
      { asin: "B001", title: "Agree", po: "a.com 2 (2026-09-01)", pack: null },
      { asin: "B001", title: "Agree", po: "a.com 1 (2026-08-01)", pack: { sold_as: "multi-pack", units_per_pack: 6 } },
      { asin: "B002", title: "Disagree", po: "b.com 9 (2026-10-01)", pack: { sold_as: "individual", units_per_pack: 1 } },
      { asin: "B002", title: "Disagree", po: "b.com 8 (2026-09-01)", pack: { sold_as: "multi-pack", units_per_pack: 2 } },
      { asin: "B003", title: "Blank", po: "c.com 7 (2026-10-01)", pack: null },
      { asin: "B003", title: "Blank", po: "c.com 6 (2026-09-01)", pack: null },
    ]);
    expect(plan.set).toEqual([{ asin: "B001", sold_as: "multi-pack", units_per_pack: 6, from_po: "a.com 3 (2026-10-01)", rows: 2 }]);
    expect(plan.mismatches).toEqual([{ asin: "B002", title: "Disagree", values: [
      { key: "individual×1", sold_as: "individual", units_per_pack: 1, pos: ["b.com 9 (2026-10-01)"] },
      { key: "multi-pack×2", sold_as: "multi-pack", units_per_pack: 2, pos: ["b.com 8 (2026-09-01)"] },
    ] }]);
    expect(plan.noInfo).toEqual([{ asin: "B003", title: "Blank", rows: 2 }]);
  });
});

describe("planRefund", () => {
  it("one line → on it; several lines with one returned → that line; otherwise a PO-level placeholder needs_split", () => {
    expect(planRefund({ po_id: "p1", refund_amount: "12.50", lines: [{ id: "l1", qty_returned: 2 }] })).toEqual({ po_id: "p1", po_line_item_id: "l1", qty: 2, amount: "12.50", needs_split: false });
    expect(planRefund({ po_id: "p2", refund_amount: "9", lines: [{ id: "l1", qty_returned: 0 }, { id: "l2", qty_returned: 1 }] })).toMatchObject({ po_line_item_id: "l2", qty: 1, needs_split: false });
    expect(planRefund({ po_id: "p3", refund_amount: "9", lines: [{ id: "l1", qty_returned: null }, { id: "l2", qty_returned: null }] })).toMatchObject({ po_line_item_id: null, needs_split: true });
    expect(planRefund({ po_id: "p4", refund_amount: "0", lines: [{ id: "l1", qty_returned: 1 }] })).toBeNull();
  });
});
