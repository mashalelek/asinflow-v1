// The extension's AI preview (SPEC §11 v1.3, Maria 2026-11-04): one page → one small extraction → the panel's buckets,
// cached per page, every call logged as capture_preview. The model is mocked; the pages are ai-preview/ fixtures.
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { previewKey, extractionToBuckets, capturePreview, _clearPreviewCache, PreviewRequestSchema } from "./capture-preview";
import type { PrefillExtraction } from "./po-prefill";
import { extractBuckets, overlayPreview, applyPage, applyPreview, previewStatus, needsPreview, checkoutEmailForPrefill } from "../chrome-extension/buckets.js";
import { scrubText } from "../chrome-extension/scrub.js";

const FIX = resolve(__dirname, "__fixtures__/capture-pages/ai-preview");
const page = (name: string, step = "other") => ({ step, url: `https://example.com/${name}`, title: name, text: scrubText(readFileSync(resolve(FIX, `${name}.txt`), "utf8")), fields: [] as Array<{ label: string; value: string }> });
const none = { retailer: null, orderId: null, orderDate: null, lines: [], subtotal: null, discount: null, tax: null, shipping: null, total: null, promos: [], payments: [], shipToStreet: null, subscription: { present: false, frequencyWeeks: null }, purchasedEmail: null, notes: [] } satisfies PrefillExtraction;
const lenox = { productName: "Lenox Gold Titanium Utility Knife Blades 5-Pack", retailerSku: "20350GOLD5C", qty: 30, unitsPerPack: 1, unitPrice: 2.66, lineTotal: 79.7, asinGuess: null };
const dhdnyc = { type: "coupon" as const, description: "Code DHDNYC", amount: 10, percent: null, confidence: "high" as const };
// What the model reads from each trigger page (mocked).
const READ: Record<string, PrefillExtraction> = {
  "gordon-cart": { ...none, lines: [
    { productName: "Leviton 5325-W Duplex Receptacle 15A 125V White", retailerSku: "LEV5325W", qty: 4, unitsPerPack: 1, unitPrice: 2.89, lineTotal: 11.56, asinGuess: null },
    { productName: "Hubbell HBL2621 Twist-Lock Receptacle 30A 250V", retailerSku: "HBLHBL2621", qty: 2, unitsPerPack: 1, unitPrice: 28.4, lineTotal: 56.8, asinGuess: null },
  ], subtotal: 68.36, shipping: 9.95, total: 78.31 },
  "acme-checkout": { ...none, lines: [{ ...lenox, unitPrice: 2.99, lineTotal: 89.7 }], subtotal: 89.7, discount: 10, tax: 0, shipping: 6.49, total: 86.19, promos: [dhdnyc] },
  "acme-confirmation": { ...none, orderId: "42838131", lines: [lenox], subtotal: 89.7, discount: 10, tax: 0, shipping: 6.49, total: 86.19, promos: [dhdnyc], purchasedEmail: "Orders@Example.com" },
};

function deps(seen: string[]) {
  return { call: async (_s: string, user: string) => { seen.push(user); const name = Object.keys(READ).find((k) => user.includes(`/${k}`))!; return { parsed: READ[name], input_tokens: 1200, output_tokens: 300 }; } };
}
function fakeQuery() {
  const logs: any[][] = [];
  const q = async (sql: string, params: any[] = []) => { if (/INSERT INTO po_prefill_log/.test(sql)) logs.push(params); return { rows: [{ id: logs.length }], rowCount: 1 }; };
  return { q: q as any, logs };
}

beforeEach(() => _clearPreviewCache());

describe("capture preview: the server side", () => {
  it("the page key is the host + text + fields — not the URL, title or step", () => {
    const a = page("acme-checkout");
    expect(previewKey("www.acmetools.com", a)).toBe(previewKey("acmetools.com", { ...a, url: "https://x", title: "y" } as any));
    expect(previewKey("acmetools.com", a)).not.toBe(previewKey("acmetools.com", { ...a, text: a.text + " " }));
    expect(previewKey("acmetools.com", a)).not.toBe(previewKey("acmetools.com", { ...a, fields: [{ label: "Qty", value: "30" }] }));
  });
  it("one call per page, logged as capture_preview with its cost; the same page again is a cache hit — no call, no log row", async () => {
    const seen: string[] = [], { q, logs } = fakeQuery();
    const req = PreviewRequestSchema.parse({ retailerHost: "www.acmetools.com", page: page("acme-confirmation", "review") });
    const r1 = await capturePreview(q, req, 7, deps(seen));
    expect(r1).toMatchObject({ cached: false, schema_ok: true, cost_estimate: 0.00027 });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("Qty 30");
    expect(logs.map((l) => [l[0], l[1], l[2], l[9]])).toEqual([[7, "capture_preview", "www.acmetools.com", true]]);
    const r2 = await capturePreview(q, req, 7, deps(seen));
    expect(r2).toMatchObject({ cached: true, cost_estimate: 0, buckets: r1.buckets });
    expect(seen).toHaveLength(1);
    expect(logs).toHaveLength(1);
  });
  it("a failed call is logged (schema_ok false) and returns no buckets — the panel keeps the rules; nothing is cached", async () => {
    const { q, logs } = fakeQuery();
    const req = PreviewRequestSchema.parse({ retailerHost: "acmetools.com", page: page("acme-checkout") });
    const r = await capturePreview(q, req, null, { call: async () => { throw new Error("overloaded"); } });
    expect(r).toMatchObject({ buckets: null, cached: false, schema_ok: false, error: "overloaded" });
    expect(logs.map((l) => [l[1], l[9], l[10]])).toEqual([["capture_preview", false, "overloaded"]]);
    expect((await capturePreview(q, req, null, deps([]))).cached).toBe(false);
  });
  it("extraction → buckets: money as $, the discount positive, the email lower-cased, a card only with a nickname or last 4", () => {
    const b = extractionToBuckets({ ...READ["acme-confirmation"], payments: [{ method: "card", nickname: "Amex Gold", last4: "1005", amount: 86.19 }, { method: "gift_card", nickname: null, last4: "4444", amount: 5 }, { method: "other", nickname: null, last4: null, amount: null }] });
    expect(b).toEqual({
      products: [{ name: "Lenox Gold Titanium Utility Knife Blades 5-Pack", qty: 30, price: "$2.66", total: "$79.70", sku: "20350GOLD5C" }],
      shipping: null,
      payment: { cards: [{ nickname: "Amex Gold", last4: "1005", amount: "$86.19" }], giftCards: [{ last4: "4444", amount: "$5.00" }] },
      totals: { subtotal: "$89.70", discount: "$10.00", tax: "$0.00", shipping: "$6.49", total: "$86.19" },
      promos: ["Code DHDNYC −$10.00"],
      order: { number: "42838131", email: "orders@example.com" },
    });
  });
});

describe("capture preview: the panel's buckets (the three trigger pages)", () => {
  const ai = (name: string) => extractionToBuckets(READ[name]);
  it("gordonelectricsupply.com cart (Qty column first, \"$2.89 / ea\", Sub Total / Estimated Freight / Estimated Total): Products and Totals from the AI", () => {
    const b = overlayPreview(extractBuckets(page("gordon-cart", "cart")), ai("gordon-cart"));
    expect(b.products.map((p: any) => [p.qty, p.sku, p.price, p.total])).toEqual([[4, "LEV5325W", "$2.89", "$11.56"], [2, "HBLHBL2621", "$28.40", "$56.80"]]);
    expect(b.totals).toEqual({ subtotal: "$68.36", shipping: "$9.95", total: "$78.31" });
  });
  it("acmetools.com checkout: one product (not the PPE & SAFETY category link), the totals, one promo (DHDNYC); Payment stays empty (processor iframe)", () => {
    const b = overlayPreview(extractBuckets(page("acme-checkout")), ai("acme-checkout"));
    expect(b.products).toHaveLength(1);
    expect(b.products[0]).toMatchObject({ qty: 30, sku: "20350GOLD5C" });
    expect(b.totals).toEqual({ subtotal: "$89.70", discount: "$10.00", tax: "$0.00", shipping: "$6.49", total: "$86.19" });
    expect(b.promos).toEqual(["Code DHDNYC −$10.00"]);
    expect(b.payment).toEqual({ cards: [], giftCards: [] });
  });
  it("acmetools.com confirmation: 30 × Lenox, line total $79.70; Promos 1; the order # and the checkout email", () => {
    const b = overlayPreview(extractBuckets(page("acme-confirmation", "review")), ai("acme-confirmation"));
    expect(b.products).toEqual([{ name: "Lenox Gold Titanium Utility Knife Blades 5-Pack", qty: 30, price: "$2.66", total: "$79.70", sku: "20350GOLD5C" }]);
    expect(b.promos).toHaveLength(1);
    expect(b.order).toMatchObject({ number: "42838131", email: "orders@example.com" });
  });
  it("the rules keep the SELECTED ship-to; the AI's street only fills in when they found none; the order fields merge", () => {
    const rule = { products: [], shipping: { street: "805 Grandy Ave", candidates: [] }, payment: { cards: [], giftCards: [] }, totals: {}, promos: ["x"], order: { date: "2026-11-04" } };
    const b = overlayPreview(rule, { ...ai("acme-confirmation"), shipping: { street: "65 Rivercrest", candidates: [] } });
    expect(b.shipping.street).toBe("805 Grandy Ave");
    expect(b.order).toEqual({ date: "2026-11-04", number: "42838131", email: "orders@example.com" });
    expect(overlayPreview({ ...rule, shipping: null }, { ...ai("acme-confirmation"), shipping: { street: "65 Rivercrest", candidates: [] } }).shipping.street).toBe("65 Rivercrest");
    expect(overlayPreview(rule, null)).toBe(rule);
  });
});

describe("capture preview: the tab's record (rules at once, the AI when it lands, cached per page)", () => {
  it("capture → pending (rules shown) → the preview lands (AI buckets) → the same page again needs no call; a failure keeps the rules with its reason", () => {
    const p = { ...page("acme-checkout", "review"), previewKey: "k1" };
    let cap = applyPage(null, p, "www.acmetools.com", "2026-11-04T10:00:00Z");
    expect(cap.previewPending).toEqual(["k1"]);
    expect(previewStatus(cap)).toBe("AI reading…");
    expect(cap.buckets.promos).toEqual([]); // the rules at once: no code read, no discount
    expect(cap.buckets.totals.discount).toBeUndefined();
    cap = applyPreview(cap, "k1", extractionToBuckets(READ["acme-checkout"]), null);
    expect(previewStatus(cap)).toBe("AI read");
    expect(cap.buckets.promos).toEqual(["Code DHDNYC −$10.00"]);
    expect(cap.buckets.totals.total).toBe("$86.19");
    expect(cap.buckets.totals.discount).toBe("$10.00");
    expect(needsPreview(cap, "k1")).toBe(false);
    const again = applyPage(cap, { ...p }, "www.acmetools.com", "2026-11-04T10:05:00Z");
    expect(again.previewPending).toEqual([]);
    expect(again.buckets.promos).toEqual(["Code DHDNYC −$10.00"]);
    // A different page (step replaced): its old preview goes, the new one is pending.
    const next = applyPage(again, { ...page("acme-confirmation", "review"), previewKey: "k2" }, "www.acmetools.com", "2026-11-04T10:06:00Z");
    expect(Object.keys(next.previews ?? {})).toEqual([]);
    expect(next.previewPending).toEqual(["k2"]);
    const failed = applyPreview(next, "k2", null, "AI preview is off");
    expect(previewStatus(failed)).toBe("AI preview is off");
    expect(failed.buckets.products.length).toBeGreaterThanOrEqual(0);
  });
  it("the checkout email: from the AI, or a filled email field — sent with the prefill", () => {
    const withField = { ...page("acme-checkout"), fields: [{ label: "Email address", value: "Orders@Example.com" }], previewKey: "k3" };
    const cap = applyPage(null, withField, "acmetools.com", "2026-11-04T10:00:00Z");
    expect(cap.buckets.order.email).toBe("orders@example.com");
    expect(checkoutEmailForPrefill(cap)).toBe("orders@example.com");
    expect(checkoutEmailForPrefill(applyPage(null, { ...page("gordon-cart"), previewKey: "k4" }, "gordonelectricsupply.com", "2026-11-04T10:00:00Z"))).toBeNull();
  });
});
