// Capture PO v1.4 (Maria 2026-11-05; SPEC §11): structured readers above the AI, the request log, kept samples,
// the monthly AI spend. Synthetic data only (public-looking test values, no real card numbers).
import { describe, it, expect } from "vitest";
import { toBuckets, fromShopifyCheckout, fromShopifyCart, fromBigCommerce, fromJsonLd } from "../chrome-extension/platform-map.js";
import { applyPage, applyPreview, applyStructured, layersOf, previewError, previewStatus, overlayStructured, emptyBuckets } from "../chrome-extension/buckets.js";
import { emptyAfterLayers, previewRequestLog, capturePreview, _clearPreviewCache, PreviewRequestSchema } from "./capture-preview";
import { shapeAiSpend, AI_SPEND_KINDS } from "@shared/ai-spend";
import { AI_SPEND_SQL } from "./ai-spend";
import { AI } from "./config/ai";
import { readFileSync } from "fs";
import { resolve } from "path";

describe("structured readers → buckets (platform-map.js)", () => {
  it("Shopify cart.js (cents): lines with variant, unit and line price; subtotal; a cart-level discount", () => {
    const b = fromShopifyCart({ items_subtotal_price: 2598, total_discount: 260, items: [{ product_title: "Zz Decaf Coffee", variant_title: "12 oz", sku: "ZZ-12", quantity: 2, final_price: 1299, final_line_price: 2598 }], discounts: [{ title: "WELCOME10", total_allocated_amount: 260 }] });
    expect(b.products).toEqual([{ name: "Zz Decaf Coffee — 12 oz", qty: 2, price: "$12.99", total: "$25.98", sku: "ZZ-12" }]);
    expect(b.totals).toEqual({ subtotal: "$25.98", discount: "$2.60" });
    expect(b.promos).toEqual(["WELCOME10 −$2.60"]);
    expect(fromShopifyCart({ items: [] })).toBeNull(); // a thank-you page's emptied cart is no reading
  });
  it("Shopify checkout object (dollars): lines, subtotal / tax / shipping / discount / total, the code, order # and email; 'Default Title' is no variant", () => {
    const b = fromShopifyCheckout({ order_number: 1042, email: "zz@example.com", subtotal_price: "40.00", total_tax: "2.40", total_price: "47.39", shipping_rate: { price: "9.99" }, discount: { code: "ZZSAVE", amount: "5.00" }, line_items: [{ title: "Zz Supplement", variant_title: "Default Title", quantity: 5, price: "8.00", line_price: "40.00", sku: null }] });
    expect(b.products).toEqual([{ name: "Zz Supplement", qty: 5, price: "$8.00", total: "$40.00", sku: null }]);
    expect(b.totals).toEqual({ subtotal: "$40.00", tax: "$2.40", shipping: "$9.99", discount: "$5.00", total: "$47.39" });
    expect(b.promos).toEqual(["ZZSAVE −$5.00"]);
    expect(b.order).toEqual({ number: "1042", email: "zz@example.com" });
  });
  it("BigCommerce: a checkout's cart + checkout totals; an order confirmation's order", () => {
    const cart = { id: "c1", baseAmount: 30, discountAmount: 0, email: "zz@example.com", lines: [{ name: "Zz Relay", sku: "ZR-1", quantity: 3, salePrice: 10, extendedSalePrice: 30 }], coupons: [{ code: "ZZ5", discountedAmount: 5 }] };
    const b = fromBigCommerce(cart, { subtotal: 30, taxTotal: 1.5, shippingCostTotal: 7, grandTotal: 33.5 }, null);
    expect(b.products).toEqual([{ name: "Zz Relay", qty: 3, price: "$10.00", total: "$30.00", sku: "ZR-1" }]);
    expect(b.totals).toEqual({ subtotal: "$30.00", tax: "$1.50", shipping: "$7.00", total: "$33.50" });
    expect(b.promos).toEqual(["ZZ5 −$5.00"]);
    const o = fromBigCommerce(null, null, { orderId: 777, baseAmount: 30, taxTotal: 0, shippingCostTotal: 0, orderAmount: 30, lines: cart.lines, coupons: [], email: null });
    expect(o.order).toEqual({ number: "777" }); expect(o.totals.total).toBe("$30.00");
  });
  it("schema.org Order JSON-LD: acceptedOffer / orderedItem lines, the price as total, the order #", () => {
    const b = fromJsonLd([{ "@type": "Order", orderNumber: "ZZ-9", price: 21, acceptedOffer: [{ itemOffered: { name: "Zz Candle", sku: "ZC" }, price: 10.5, eligibleQuantity: { value: 2 } }] }]);
    expect(b.products).toEqual([{ name: "Zz Candle", qty: 2, price: "$10.50", total: "$21.00", sku: "ZC" }]);
    expect(b.totals).toEqual({ total: "$21.00" }); expect(b.order).toEqual({ number: "ZZ-9" });
  });
  it("toBuckets: an order / checkout's lines before a cart's; totals merge (order first); the source names what was used; nothing structured → null", () => {
    const r = toBuckets({ platform: "Shopify", jsonld: [], shopifyCheckout: { order_number: 5, subtotal_price: "8.00", total_price: "8.00", line_items: [{ title: "A", quantity: 1, price: "8.00", line_price: "8.00" }] }, shopifyCart: { items_subtotal_price: 999, items: [{ title: "B", quantity: 1, final_price: 999, final_line_price: 999 }] } })!;
    expect(r.buckets.products.map((p: any) => p.name)).toEqual(["A"]);
    expect(r).toMatchObject({ platform: "Shopify", source: "Shopify order data", filled: { products: true, totals: true } });
    expect(toBuckets({ platform: null, jsonld: [] })).toBeNull();
    expect(toBuckets({ platform: "Shopify", jsonld: [], shopifyCart: { items: [] } })).toBeNull();
  });
});

describe("the panel's layers: rules at once, the AI when it lands, the structured reader on top", () => {
  const page = { step: "cart", url: "https://zz.example/cart", title: "Cart", text: "Your cart\nProduct image\nZz Widget\nQty 2\n$5.00\nSubtotal $10.00", fields: [], previewKey: "k1" };
  const ai = { ...emptyBuckets(), products: [{ name: "Zz Widget", qty: 2, price: "$5.00", total: "$10.00", sku: null }], totals: { subtotal: "$10.00", tax: "$0.60", total: "$10.60" } };
  const st = { platform: "Shopify", source: "Shopify cart data", filled: { products: true, totals: true }, buckets: { ...emptyBuckets(), products: [{ name: "Zz Widget — Blue", qty: 2, price: "$5.00", total: "$10.00", sku: "ZW-B" }], totals: { subtotal: "$10.00" } } };
  it("the structured products win; its totals win per field and the AI's tax / total stay", () => {
    const b = overlayStructured(ai, st);
    expect(b.products[0].sku).toBe("ZW-B");
    expect(b.totals).toEqual({ subtotal: "$10.00", tax: "$0.60", total: "$10.60" });
  });
  it("layersOf names the layer per bucket as each lands; a failed preview is the red line, not the grey status", () => {
    let cap = applyPage(null, page, "zz.example", "2026-11-05T12:00:00Z");
    expect(layersOf(cap).products).toMatch(/rules|null/);
    cap = applyPreview(cap, "k1", ai, null);
    expect(layersOf(cap)).toEqual({ products: "AI", totals: "AI" });
    cap = applyStructured(cap, "k1", st);
    expect(layersOf(cap)).toEqual({ products: "Shopify cart data", totals: "Shopify cart data" });
    expect(cap.buckets.products[0].sku).toBe("ZW-B");
    const failed = applyPreview(applyPage(null, { ...page, previewKey: "k2" }, "zz.example", "2026-11-05T12:01:00Z"), "k2", null, "AI preview failed (409: AF was updated — reload this page)");
    expect(previewError(failed)).toBe("AI preview failed (409: AF was updated — reload this page)");
    expect(previewStatus(failed)).toBe("AI preview failed (409: AF was updated — reload this page)"); // the status still knows; the panel shows it red
    expect(previewError(cap)).toBeNull();
  });
  it("background.js reads the page's own world, scrubs the reader's strings and sends what it filled with the preview", () => {
    const bg = readFileSync(resolve(__dirname, "../chrome-extension/background.js"), "utf8");
    expect(bg).toMatch(/files: \["platform\.js"\], world: "MAIN"/);
    expect(bg).toMatch(/scrubDeep\(mapped\)/);
    expect(bg).toMatch(/structured: \{ platform: structured\?\.platform/);
    const pj = readFileSync(resolve(__dirname, "../chrome-extension/platform.js"), "utf8");
    expect(pj).not.toMatch(/payment_due|credit_card|gateway|billing_address/); // no payment object is read
    expect(pj).not.toMatch(/method:\s*"(POST|PUT|DELETE)"/); // read-only
  });
});

function fakeQuery() {
  const calls: Array<{ sql: string; params: any[] }> = [];
  const q = (async (sql: string, params: any[] = []) => { calls.push({ sql, params }); return { rows: /RETURNING id/.test(sql) ? [{ id: 41 }] : [] }; }) as any;
  return { q, calls };
}
function fakeReqRes(body: any, status: number, json: any) {
  const handlers: Record<string, () => void> = {};
  const req: any = { body, session: { userId: 2 } };
  const res: any = { statusCode: status, locals: {}, json(b: any) { return b; }, on(ev: string, f: () => void) { handlers[ev] = f; } };
  return { req, res, finish: () => { res.json(json); handlers.finish(); } };
}

describe("every preview request leaves a log row (migration 092)", () => {
  it("a rejection (401 / 400 / 409 / 503) is a row of its own: status, reason, cost 0; the route's model-call row gets its status", async () => {
    for (const [status, msg] of [[401, { error: "unauthenticated" }], [400, { message: "preview: page.step: Invalid option" }], [503, { message: "AI prefill is off" }]] as const) {
      const { q, calls } = fakeQuery();
      const { req, res, finish } = fakeReqRes({ retailerHost: "zz.example", page: { text: "abc" } }, status, msg);
      previewRequestLog(q)(req, res, () => {}); finish(); await new Promise((r) => setTimeout(r, 0));
      expect(calls).toHaveLength(1);
      expect(calls[0].sql).toMatch(/INSERT INTO po_prefill_log .*'capture_preview'/);
      expect(calls[0].params).toEqual([2, "zz.example", 3, false, status, String((msg as any).message ?? (msg as any).error), AI.model]);
    }
    const { q, calls } = fakeQuery();
    const { req, res, finish } = fakeReqRes({ retailerHost: "zz.example", page: { text: "abc" } }, 200, { logId: 41, buckets: {} });
    previewRequestLog(q)(req, res, () => {}); finish(); await new Promise((r) => setTimeout(r, 0));
    expect(calls[0]).toEqual({ sql: expect.stringMatching(/^UPDATE po_prefill_log SET http_status/), params: [41, 200, null] });
    const hit = fakeQuery(), x = fakeReqRes({ retailerHost: "zz.example", page: { text: "abc" } }, 200, { cached: true, buckets: {} });
    previewRequestLog(hit.q)(x.req, x.res, () => {}); x.finish(); await new Promise((r) => setTimeout(r, 0));
    expect(hit.calls[0].params.slice(4, 6)).toEqual([200, "cache hit"]);
  });
});

describe("pages kept for fixtures: Products or Totals still empty after every layer (30 days, admin-only)", () => {
  it("emptyAfterLayers: the structured reader or the AI filling a bucket keeps it off the list", () => {
    const aiEmpty = { products: [], shipping: null, payment: { cards: [], giftCards: [] }, totals: {}, promos: [], order: {} };
    expect(emptyAfterLayers(aiEmpty)).toEqual(["products", "totals"]);
    expect(emptyAfterLayers(aiEmpty, { products: true, totals: false })).toEqual(["totals"]);
    expect(emptyAfterLayers({ ...aiEmpty, products: [{ name: "x", qty: 1, price: null, total: null, sku: null }], totals: { total: "$1.00" } })).toEqual([]);
    expect(emptyAfterLayers(null)).toEqual(["products", "totals"]);
  });
  it("capturePreview keeps the page when the AI read no products, purges rows past 30 days first; a full reading keeps nothing", async () => {
    _clearPreviewCache();
    const none = { retailer: null, orderId: null, orderDate: null, lines: [], subtotal: null, discount: null, tax: null, shipping: null, total: 12, promos: [], payments: [], shipToStreet: null, subscription: { present: false, frequencyWeeks: null }, purchasedEmail: null, notes: [] };
    const deps = { call: async () => ({ parsed: none, input_tokens: 100, output_tokens: 20 }) } as any;
    const { q, calls } = fakeQuery();
    const req = PreviewRequestSchema.parse({ retailerHost: "perfectlyhealthy.com", page: { step: "review", url: "https://perfectlyhealthy.com/thank-you", text: "Thank you zz", fields: [] }, structured: { platform: "Shopify", products: false, totals: false } });
    const r = await capturePreview(q, req, 2, deps);
    expect(r.sampled).toEqual(["products"]);
    expect(calls.map((c) => c.sql.split(" ").slice(0, 3).join(" "))).toEqual(["INSERT INTO po_prefill_log", "DELETE FROM capture_page_samples", "INSERT INTO capture_page_samples"]);
    expect(calls[2].params.slice(1, 4)).toEqual(["perfectlyhealthy.com", r.key, "review"]);
    expect(calls[2].params[8]).toEqual(["products"]);
  });
  it("the samples routes sit under /api/admin behind requireRole('admin')", () => {
    const src = readFileSync(resolve(__dirname, "capture-samples.ts"), "utf8");
    expect(src).toMatch(/router\.use\("\/api\/admin\/capture-samples", requireRole\("admin"\)\)/);
    expect(src).toMatch(/interval '30 days'/);
  });
});

describe("Settings → AI spend", () => {
  it("per month (newest first) every kind, model calls and cost; the warning past $20", () => {
    const s = shapeAiSpend([
      { month: "2026-11", kind: "capture_preview", calls: 300, cost: 18.5 }, { month: "2026-11", kind: "tracking_fallback", calls: 10, cost: 2.004 },
      { month: "2026-10", kind: "capture", calls: 5, cost: 0.4 }, { month: "2026-10", kind: "unknown_kind", calls: 1, cost: 99 },
    ], AI.monthlyWarnUsd);
    expect(s.months.map((m) => [m.month, m.total, m.over])).toEqual([["2026-11", 20.5, true], ["2026-10", 0.4, false]]);
    expect(Object.keys(s.months[0].byKind)).toEqual([...AI_SPEND_KINDS]);
    expect(s.months[0].byKind.supplier_check).toEqual({ calls: 0, cost: 0 });
    expect(AI.monthlyWarnUsd).toBe(20);
  });
  it("the SQL counts only rows with tokens as calls (a logged rejection or cache hit costs 0) and groups by the Eastern month", () => {
    expect(AI_SPEND_SQL).toMatch(/FILTER \(WHERE COALESCE\(input_tokens, 0\) \+ COALESCE\(output_tokens, 0\) > 0\)/);
    expect(AI_SPEND_SQL).toMatch(/AT TIME ZONE 'America\/New_York', 'YYYY-MM'/);
  });
});

describe("platform.js in a sandboxed page (fake Shopify / BigCommerce; no live site)", () => {
  const src = readFileSync(resolve(__dirname, "../chrome-extension/platform.js"), "utf8");
  async function run(win: any, sel: (q: string) => boolean, routes: Record<string, any>, path = "/cart") {
    const vm = await import("vm");
    const fetched: string[] = [];
    const ctx: any = {
      window: win, location: { pathname: path }, AbortController, setTimeout, clearTimeout, JSON,
      document: { querySelectorAll: () => [], querySelector: (q: string) => (sel(q) ? {} : null) },
      fetch: async (u: string, o: any) => { fetched.push(`${o?.method ?? "GET"} ${u}`); const b = Object.entries(routes).find(([k]) => u.startsWith(k)); return { ok: !!b, json: async () => (b ? b[1] : null) }; },
    };
    vm.createContext(ctx);
    const out = await vm.runInContext(src, ctx);
    return { out, fetched };
  }
  it("Shopify: detected from its CDN, reads /cart.js (GET only) and the checkout object's picked fields", async () => {
    const { out, fetched } = await run({ Shopify: { shop: "zz.myshopify.com", checkout: { order_number: 7, email: "zz@example.com", subtotal_price: "8.00", total_price: "8.00", total_tax: "0.00", credit_card: { number: "4111111111111111" }, billing_address: { street: "1 Zz St" }, line_items: [{ title: "Zz", quantity: 1, price: "8.00", line_price: "8.00", properties: { secret: 1 } }] } } },
      (q) => /cdn\.shopify\.com/.test(q), { "/cart.js": { items_subtotal_price: 800, items: [{ title: "Zz", quantity: 1, final_price: 800, final_line_price: 800 }] } });
    expect(out.platform).toBe("Shopify");
    expect(fetched).toEqual(["GET /cart.js"]);
    expect(JSON.stringify(out)).not.toMatch(/4111|credit_card|billing|secret/);
    expect(toBuckets(out)).toMatchObject({ source: "Shopify order data", filled: { products: true, totals: true } });
  });
  it("BigCommerce checkout: cart then checkout totals, GET only", async () => {
    const { out, fetched } = await run({ BCData: {} }, () => false, {
      "/api/storefront/carts": [{ id: "c9", baseAmount: 20, lineItems: { physicalItems: [{ name: "Zz", sku: "Z", quantity: 2, salePrice: 10, extendedSalePrice: 20 }] }, coupons: [] }],
      "/api/storefront/checkouts/c9": { subtotal: 20, taxTotal: 1, shippingCostTotal: 5, grandTotal: 26 },
    }, "/checkout");
    expect(fetched.every((f) => f.startsWith("GET /api/storefront/"))).toBe(true);
    expect(toBuckets(out)!.buckets.totals).toEqual({ subtotal: "$20.00", tax: "$1.00", shipping: "$5.00", total: "$26.00" });
  });
  it("no platform and no JSON-LD → nothing structured, no request", async () => {
    const { out, fetched } = await run({}, () => false, {});
    expect(fetched).toEqual([]); expect(toBuckets(out)).toBeNull();
  });
});
