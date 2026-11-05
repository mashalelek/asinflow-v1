// Capture PO's "This PO" and past promos (Maria 2026-11-05; docs/claude_cogs-rule.md, SPEC §11 "Purchase history").
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promoCode, promoShown, codesUsed, moneyOf, captureAsinUnits, capturePaymentPct, thisPoCost, thisPoFor, CapturePoSchema, HistoryQuerySchema, type AsinHistory } from "./extension-history";
import { calculateProfit, settingsSchema } from "@shared/schema";
import * as HV from "../chrome-extension/core/history-view.js";
const { thisPoLines, thisPoTotals, codeLines, historyLines, vsLast } = ((HV as any).default ?? HV) as typeof HV;

const lists = { methods: ["Walmart card", "Amex Gold"], aliases: { "OnePay Cash": "Walmart card" }, last4: { "Walmart card": "4321" } };
const po = (x: Partial<Record<string, unknown>>) => CapturePoSchema.parse({ lines: [], ...x });

describe("This PO: COGS per ASIN unit (the PO form's allocation, shared/po-cost.ts)", () => {
  it("Equal Exchange: cart 5 × 12-pack, $158.40; the ASIN is a 6-pack → 10 units → $15.84 (an estimate: no totals, no payment)", () => {
    const p = po({ lines: [{ qty: 5, price: "$31.68", total: "$158.40" }] });
    const units = captureAsinUnits(5, 12, 6);
    expect(units).toEqual({ units: 10, notes: [] });
    const c = thisPoCost(p, 0, units, capturePaymentPct(p, lists, null, null));
    expect(c).toMatchObject({ cogs: 15.84, asinUnits: 10, estimate: true });
    expect(c.notes).toEqual(["Totals not captured — line total only", "Payment not captured — no gift-card / reward %"]);
  });
  it("tax and shipping allocated over the line totals, the coupon subtracted, the card reward taken off once Payment is captured — no longer an estimate", () => {
    // Two lines $100 + $50, a $15 coupon, $9 tax, $6 shipping → total $150; Walmart card pays it all at 5 %.
    const p = po({ lines: [{ qty: 2, price: "50.00", total: "100.00" }, { qty: 1, price: "50", total: "50" }], totals: { subtotal: "150.00", discount: "-$15.00", tax: "9.00", shipping: "6.00", total: "150.00" }, cards: [{ nickname: "OnePay Cash", last4: "4321", amount: null }] });
    const pay = capturePaymentPct(p, lists, { "Walmart card": 5 }, null);
    expect(pay).toEqual({ pct: 5, parts: ["Walmart card reward 5%"], unknown: [] });
    const c = thisPoCost(p, 0, captureAsinUnits(2, null, 1), pay);
    // 100 × (150 − 15 + 9 + 6) ÷ 150 = 100 → ÷ 2 units = 50 × 0.95 = 47.50
    expect(c).toMatchObject({ cogs: 47.5, estimate: false, notes: [] });
  });
  it("a discount the line totals already carry is not subtracted again (the reflected rule)", () => {
    const p = po({ lines: [{ qty: 12, price: "7.97", total: "95.64" }], totals: { discount: "36.12", tax: "0", shipping: "0", total: "95.64" }, cards: [{ nickname: "Amex Gold", last4: null, amount: "95.64" }] });
    expect(thisPoCost(p, 0, captureAsinUnits(12, null, 1), capturePaymentPct(p, lists, {}, null)).cogs).toBe(7.97);
  });
  it("a gift card's % comes from the supplier's last gift-card PO; without one it is named as not known (still an estimate)", () => {
    const p = po({ lines: [{ qty: 1, price: "100", total: "100" }], totals: { total: "100" }, giftCards: [{ last4: "1111", amount: "100" }] });
    expect(capturePaymentPct(p, lists, null, 4)).toEqual({ pct: 4, parts: ["gift card 4% (last gift-card PO)"], unknown: [] });
    const u = capturePaymentPct(p, lists, null, null);
    expect(u.unknown).toEqual(["gift-card %"]);
    expect(thisPoCost(p, 0, captureAsinUnits(1, null, 1), u)).toMatchObject({ cogs: 100, estimate: true });
  });
  it("pack sizes: an unknown one counts as a single and says so; no qty → no COGS", () => {
    expect(captureAsinUnits(4, null, 6).notes).toEqual(["listing pack size not in its name — counted as a single"]);
    expect(captureAsinUnits(4, 2, null)).toEqual({ units: 8, notes: ["ASIN pack size not known — counted as a single"] });
    expect(captureAsinUnits(null, 2, 1).units).toBeNull();
  });
  it("money: $ and commas, a leading minus, parentheses", () => {
    expect([moneyOf("$1,234.56"), moneyOf("-$39.60"), moneyOf("($5.00)"), moneyOf(""), moneyOf("n/a"), moneyOf(12)]).toEqual([1234.56, -39.6, -5, null, null, 12]);
  });
});

// A fake QueryLike for thisPoFor.
function fakeDb(est: any, settings: Array<{ key: string; value: unknown }>, gc: any = null) {
  return (async (sql: string) => {
    if (/SELECT key, value FROM settings/.test(sql)) return { rows: settings };
    if (/weighted_gc_discount_pct/.test(sql)) return { rows: gc ? [gc] : [] };
    if (/FROM asins a LEFT JOIN asin_estimates e/.test(sql)) return { rows: est ? [est] : [] };
    throw new Error(`unexpected SQL: ${sql.slice(0, 80)}`);
  }) as any;
}
const hist: AsinHistory = { asin: "B004WZ4CLW", title: "Cocoa", asinPack: 6, last: { cogs: 19.8, orderDate: "2026-10-10", orderId: "S1", supplier: "shop.equalexchange.coop" }, avg365: null, pos365: 1, units365: 10, recent: [], conversion: null };
const est = { weight_lb: "3.1", category: "Grocery", is_hazmat: false, is_dangerous_good: false, lowest_fba_price: "38.49", buy_box_price: "39.99", buy_box_fulfillment: "FBA", lowest_price: null, fba_fee: "5.93", referral_fee: "5.77", fees_estimate_price: "38.49", storage_override: null, fetched_at: "2026-11-05T19:00:00Z" };
const settingRows = [{ key: "prep_cost", value: "1" }, { key: "inbound_shipping_per_lb", value: "0.5" }, { key: "include_inbound_shipping", value: true }, { key: "tracking.velocity_street", value: "805 grandy" }, { key: "tracking.home_streets", value: ["65 rivercrest"] }];
const q = (po: object, extra: Record<string, string> = {}) => HistoryQuerySchema.parse({ supplier: "shop.equalexchange.coop", asin: "B004WZ4CLW", po: JSON.stringify(po), line: "0", ...extra });
const cart = { lines: [{ qty: 5, price: "$31.68", total: "$158.40" }] };

describe("This PO: profit through calculateProfit (the ASIN page's function, same inputs)", () => {
  it("$15.84 · −20% vs last; Lowest FBA price with its age; profit / ROI / margin equal calculateProfit's", async () => {
    const t = (await thisPoFor(fakeDb(est, settingRows), "shop.equalexchange.coop", hist, 12, q(cart)))!;
    expect(t).toMatchObject({ cogs: 15.84, asinUnits: 10, vsLast: -0.2, sale: { price: 38.49, label: "Lowest FBA", typed: false, fetchedAt: "2026-11-05T19:00:00.000Z" }, prep: { value: 1, why: "ship-to not captured — Velocity prep" }, missing: [] });
    const s = settingsSchema.parse({ prepCost: 1, inboundShippingCost: 0.5 });
    const c = calculateProfit(38.49, 15.84, 5.93, 5.77, 38.49, 3.1, 1, s.storageFee, s, true, false, "Grocery");
    expect([t.profit, t.roi, t.margin]).toEqual([Math.round(c.profit * 100) / 100, Math.round(c.roi * 100) / 100, Math.round(c.margin * 100) / 100]);
  });
  it("prep from the ship-to: Home → $0", async () => {
    const t = (await thisPoFor(fakeDb(est, settingRows), "x", hist, 12, q({ ...cart, street: "65 Rivercrest Dr" })))!;
    expect(t.prep).toEqual({ value: 0, why: "ships to Home" });
  });
  it("a what-if sale price is used as typed (not saved anywhere)", async () => {
    const t = (await thisPoFor(fakeDb(est, settingRows), "x", hist, 12, q(cart, { sale: "45" })))!;
    expect(t.sale).toEqual({ price: 45, label: "your price", typed: true, fetchedAt: null });
  });
  it("no price or no fees → no profit, with what is missing — never a guess", async () => {
    const noPrice = (await thisPoFor(fakeDb({ ...est, lowest_fba_price: null, buy_box_price: null }, settingRows), "x", hist, 12, q(cart)))!;
    expect(noPrice).toMatchObject({ profit: null, roi: null, margin: null, sale: null, missing: ["no sale price in AF (no Lowest FBA, Buy Box or offer price)"] });
    const noFee = (await thisPoFor(fakeDb({ ...est, fba_fee: null }, settingRows), "x", hist, 12, q(cart)))!;
    expect(noFee).toMatchObject({ profit: null, cogs: 15.84, missing: ["no FBA fee in AF yet"] });
  });
  it("the Buy Box when there is no Lowest FBA (getSelectedPrice's fallback, labelled)", async () => {
    const t = (await thisPoFor(fakeDb({ ...est, lowest_fba_price: null }, settingRows), "x", hist, 12, q(cart)))!;
    expect(t.sale).toMatchObject({ price: 39.99, label: "BB (no FBA)" });
  });
  it("a bad po= parameter gives no This PO, not an error", async () => {
    expect(await thisPoFor(fakeDb(est, settingRows), "x", hist, 12, HistoryQuerySchema.parse({ supplier: "x", asin: "B004WZ4CLW", po: "{not json" }))).toBeNull();
  });
});

describe("the panel's This PO lines (core/history-view.js)", () => {
  const now = Date.parse("2026-11-05T21:00:00Z");
  const t = { cogs: 15.84, asinUnits: 10, estimate: true, notes: ["Totals not captured — line total only"], paymentParts: [], vsLast: -0.2, sale: { price: 38.49, label: "Lowest FBA", typed: false, fetchedAt: "2026-11-05T19:00:00Z" }, prep: { value: 1, why: "ships to Velocity" }, fees: { fba: 5.93, referral: 5.77 }, profit: 9.05, roi: 57.14, margin: 23.51, missing: [] };
  it("'$15.84 · −20% vs last · estimate', the price and its age, profit · ROI · margin", () => {
    expect(thisPoLines(t, now).map((l) => `${l.k}: ${l.v}`)).toEqual([
      "COGS: $15.84 · −20% vs last · estimate",
      ": Totals not captured — line total only",
      "Sale price: Lowest FBA $38.49 · 2h ago",
      "Profit: $9.05 · ROI 57% · Margin 24%",
      ": fees FBA $5.93 + referral $5.77 · prep $1.00 (ships to Velocity)",
    ]);
    expect([vsLast(0), vsLast(0.05), vsLast(null)]).toEqual(["same as last", "+5% vs last", ""]);
  });
  it("missing price → '—' and the reason", () => {
    const l = thisPoLines({ ...t, sale: null, profit: null, roi: null, margin: null, missing: ["no sale price in AF"] }, now);
    expect(l.slice(2).map((x) => `${x.k}: ${x.v}`)).toEqual(["Sale price: —", "Profit: —", ": no sale price in AF"]);
  });
  it("several ASINs: totals of units, COGS and profit (profit only when every line is priced)", () => {
    expect(thisPoTotals([t, { ...t, asinUnits: 4, cogs: 10, profit: 2 }])).toEqual({ units: 14, cogs: 198.4, profit: 98.5, priced: 2, of: 2, estimate: true });
    expect(thisPoTotals([t, { ...t, profit: null }])!.profit).toBeNull();
    expect(thisPoTotals([t])).toBeNull();
  });
});

describe("past promos", () => {
  it("the code from a promo's description; deals (B1G1, BOGO) are not codes", () => {
    const cases: Array<[string, string | null]> = [
      ["20% off with FAIRTHANKS20", "FAIRTHANKS20"],
      ["Email Subscriber discount with MPSEMAIL5", "MPSEMAIL5"],
      ["SAVE10 order discount", "SAVE10"],
      ["$10 off with DHDNYC", "DHDNYC"],
      ["B1G1 50% with 2110 (limit 1)", "2110"],
      ["$20 Rewards + 30% off with SUPER30", "SUPER30"],
      ["Reduced price, was $95.64", null],
      ["BOGO 50% off", null],
      ["Box Up & Save 13%", null],
    ];
    for (const [d, c] of cases) expect({ d, c: promoCode(d) }).toEqual({ d, c });
  });
  it("each PO's promo as shown: 'FAIRTHANKS20 · 20% · −$39.60', 'Sale −$12.00'", () => {
    expect(promoShown({ type: "coupon", description: "20% off with FAIRTHANKS20", amount: "39.60", percent: "20.00" }).label).toBe("FAIRTHANKS20 · 20% · −$39.60");
    expect(promoShown({ type: "sale", description: "Reduced prices", amount: "12", percent: null }).label).toBe("Sale −$12.00");
    expect(promoShown({ type: "sale", description: "Box Up & Save 13%", amount: null, percent: "13" }).label).toBe("Sale · 13%");
  });
  it("recent purchases show their promos or 'no promos'", () => {
    const h = { asin: "B1", last: null, pos365: 0, recent: [{ orderDate: "2026-11-05", orderId: "S1", how: "12-pack × 5", asinUnits: 10, cogs: 15.84, promos: [{ label: "FAIRTHANKS20 · 20% · −$39.60" }] }, { orderDate: "2026-10-10", orderId: "S0", how: "× 1", asinUnits: 1, cogs: 1, promos: [] }] };
    expect(historyLines(h, false, 2026).filter((l) => l.recent).map((l) => l.promos)).toEqual(["FAIRTHANKS20 · 20% · −$39.60", "no promos"]);
  });
  it("codes used here before: distinct, most recent first, type / value of the latest use, last date, PO count; sales without a code left out", async () => {
    const rows = [
      { po_id: "p3", order_date: "2026-11-05", type: "coupon", description: "20% off with FAIRTHANKS20", amount: "39.60", percent: "20" },
      { po_id: "p2", order_date: "2026-10-10", type: "coupon", description: "15% off with FAIRFALL26", amount: null, percent: "15" },
      { po_id: "p2", order_date: "2026-10-10", type: "sale", description: "Reduced price", amount: "5", percent: null },
      { po_id: "p1", order_date: "2026-09-01", type: "coupon", description: "fairfall26 at checkout with FAIRFALL26", amount: "3", percent: null },
    ];
    const db = (async (sql: string, params: any[]) => { expect(sql).toMatch(/WHERE p\.supplier = \$1/); expect(params).toEqual(["shop.equalexchange.coop"]); return { rows }; }) as any;
    expect(await codesUsed(db, "shop.equalexchange.coop")).toEqual([
      { code: "FAIRTHANKS20", type: "coupon", percent: 20, amount: 39.6, lastDate: "2026-11-05", pos: 1 },
      { code: "FAIRFALL26", type: "coupon", percent: 15, amount: null, lastDate: "2026-10-10", pos: 2 },
    ]);
  });
  it("a code the current capture applied is marked 'applied', not hidden", () => {
    const c = codeLines([{ code: "FAIRTHANKS20", type: "coupon", percent: 20, amount: 39.6, lastDate: "2026-11-05", pos: 1 }, { code: "FAIRFALL26", type: "coupon", percent: 15, amount: null, lastDate: "2026-10-10", pos: 2 }], "Promo code fairthanks20 applied −$39.60", 2026);
    expect(c).toEqual([
      { code: "FAIRTHANKS20", v: "Coupon · 20% · −$39.60 · last Nov 5 · 1 PO", applied: true },
      { code: "FAIRFALL26", v: "Coupon · 15% · last Oct 10 · 2 POs", applied: false },
    ]);
    expect(codeLines([{ code: "BLOSSOM", type: "coupon", percent: 20, amount: null, lastDate: "2025-04-15", pos: 2 }], "", 2026)[0].v).toBe("Coupon · 20% · last Apr 15, 2025 · 2 POs");
  });
});

describe("one profit function", () => {
  it("the history endpoint calls calculateProfit and the PO form's allocateAsinCosts — no formula of its own", () => {
    const src = readFileSync(join(__dirname, "extension-history.ts"), "utf8");
    expect(src).toMatch(/calculateProfit\(/);
    expect(src).toMatch(/allocateAsinCosts\(/);
    expect(src).not.toMatch(/referral\s*\*|fba\s*\+\s*referral|salePrice\s*-\s*cogs/i);
    const view = readFileSync(join(__dirname, "../chrome-extension/core/history-view.js"), "utf8");
    expect(view).not.toMatch(/price\s*-\s*t\.cogs|sale\.price\s*-/); // the panel shows the server's numbers
  });
});
