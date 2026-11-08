// Capture PO 2.0.4 (Maria 2026-11-07, shop.lospoblanos.com N7CMJ7ZCF, 3 pages): "Open in AF" failed with
// "capture: pages.1.fields.41.label: Too big: expected string to have <=200 characters", and the AI preview of that page
// was refused three times (po_prefill_log 2294–2296, http 400) while the panel said only "AI read 2 of 3". The pages
// below are written in the shape of that checkout (Shopify; a selected radio whose label runs past 200 characters; the
// Lavender Lip Salve with its SKU on one page only) — synthetic text and prices, no customer data. Replace them with
// the real pages ("Copy page text") when Maria sends them.
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import vm from "vm";
import { clipPage, LIMITS, applyPage, applyPreview, previewError, previewStatus, previewFailures, mergeBuckets, emptyBuckets, pagesForPrefill, sameProduct } from "../chrome-extension/buckets.js";
import { clipCapture, CaptureSchema, CAPTURE_LIMITS } from "./po-prefill";
import { PreviewRequestSchema } from "./capture-preview";

const LONG_LABEL = "selected: " + "Standard Shipping (5-8 business days) — orders containing Los Poblanos lavender products ship from our farm in Los Ranchos de Albuquerque; ".repeat(2).slice(0, 200);
const field = (label: string, value = "x") => ({ label, value });
const fields42 = [...Array.from({ length: 41 }, (_, i) => field(`Field ${i + 1}`)), field(LONG_LABEL + " and a little more", "Standard Shipping\n$12.00")];
const page1 = { step: "cart", url: "https://shop.lospoblanos.com/cart", title: "Your Shopping Cart", text: "Your cart\nLavender Lip Salve\nSKU 2400022124001\nQuantity 10\n$9.00\n$90.00\nSubtotal $90.00", fields: [field("Quantity", "10")] };
const page2 = { step: "review", url: "https://shop.lospoblanos.com/checkouts/cn/zz-synthetic", title: "Checkout", text: "Contact\nShip to\nShipping method\nStandard Shipping $12.00\nLavender Lip Salve\n10\n$90.00\nSubtotal $90.00\nShipping $12.00\nTotal $102.00", fields: fields42 };
const page3 = { step: "review", url: "https://shop.lospoblanos.com/checkouts/cn/zz-synthetic/thank-you", title: "Thank you", text: "Order N7CMJ7ZCF\nThank you\nLavender Lip Salve × 10\n$90.00\nTotal $102.00", fields: [] };

describe("one long string never rejects a capture", () => {
  it("the extension clips every string to the server's limits and marks the cut (clipPage); limits match the server's", () => {
    expect(LIMITS).toMatchObject({ url: CAPTURE_LIMITS.url, title: CAPTURE_LIMITS.title, text: CAPTURE_LIMITS.text, label: CAPTURE_LIMITS.label, value: CAPTURE_LIMITS.value, fields: CAPTURE_LIMITS.fields });
    const c = clipPage(page2);
    expect(c.fields[41].label.length).toBe(200);
    expect(c.fields[41].truncated).toBe(true);
    expect(c.fields[40]).toEqual(field("Field 41")); // untouched fields stay as they were
    expect(c.truncated).toBeUndefined(); // title / text / url fit
    const big = clipPage({ ...page1, text: "a".repeat(200_005), title: "t".repeat(501), fields: Array.from({ length: 501 }, () => field("q", "v".repeat(2001))) });
    expect([big.text.length, big.title.length, big.fields.length, big.fields[0].value.length, big.fields[0].truncated]).toEqual([200_000, 500, 500, 2000, true]);
    expect(big.truncated).toEqual(["title", "text", "fields"]);
    expect(clipPage(page1)).toEqual(page1);
  });
  it("the server clips with a warning naming the page instead of a 400 — /api/pos/prefill and /api/pos/capture-preview (an extension before 2.0.4 sends the long label)", () => {
    const body = { retailerHost: "shop.lospoblanos.com", pages: [page1, page2, page3] };
    expect(CaptureSchema.safeParse(body).success).toBe(false); // what happened on 2026-11-07
    const r = clipCapture(body);
    expect(r.warnings).toEqual(["Page 2: field 42's label was 228 characters — cut to 200"]);
    const parsed = CaptureSchema.safeParse(r.body);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.pages.length).toBe(3);
    const pv = clipCapture({ retailerHost: "shop.lospoblanos.com", page: page2, structured: { platform: "Shopify checkout data and then some more words", products: true, totals: true } }, { pageKey: "page" });
    expect(pv.warnings).toEqual(["The page: field 42's label was 228 characters — cut to 200", "The platform name was 46 characters — cut to 40"]);
    expect(PreviewRequestSchema.safeParse(pv.body).success).toBe(true);
  });
  it("every other limit in the capture schema clips too: too many pages keeps the newest 12, fields the first 500, the ship-to, an over-long email is left out", () => {
    const many = Array.from({ length: 14 }, (_, i) => ({ ...page1, title: `p${i + 1}` }));
    const r = clipCapture({ retailerHost: "h".repeat(260), pages: many, shipTo: { street: "1".repeat(210), candidates: Array.from({ length: 8 }, () => "805 Grandy Ave") }, checkoutEmail: `${"a".repeat(250)}@example.com` });
    const parsed = CaptureSchema.safeParse(r.body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.pages.map((p) => p.title)).toEqual(many.slice(2).map((p) => p.title));
    expect(parsed.data.shipTo?.candidates.length).toBe(6);
    expect(parsed.data.checkoutEmail).toBeUndefined();
    expect(r.warnings).toEqual([
      "The retailer host was 260 characters — cut to 253", "14 pages — the newest 12 kept",
      "The ship-to street was 210 characters — cut to 200", "The checkout email was too long to be an email — left out",
    ]);
  });
  it("capture.js keeps a selected radio's label within 200 characters, the \"selected:\" prefix included", () => {
    const radio: any = { tagName: "INPUT", attrs: { type: "radio", "aria-label": "Standard Shipping ".repeat(15) }, checked: true, name: "", id: "", value: "on", getAttribute(k: string) { return this.attrs[k] ?? null; }, getBoundingClientRect: () => ({ width: 10, height: 10 }), closest: () => null, parentElement: { innerText: "Standard Shipping (5-8 business days) $12.00", parentElement: null } };
    const ctx: any = { document: { title: "Checkout", body: { innerText: "Checkout" }, querySelectorAll: () => [radio], querySelector: () => null }, location: { origin: "https://shop.lospoblanos.com", pathname: "/checkouts/cn/x" }, getComputedStyle: () => ({ visibility: "visible", display: "block" }), CSS: { escape: (s: string) => s }, Element: Object };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(readFileSync(resolve(__dirname, "../chrome-extension/core/scrub.js"), "utf8"), ctx);
    const out = vm.runInContext(readFileSync(resolve(__dirname, "../chrome-extension/capture.js"), "utf8"), ctx) as { fields: { label: string; value: string }[] };
    expect(out.fields[0].label.startsWith("selected: Standard Shipping")).toBe(true);
    expect(out.fields[0].label.length).toBe(200);
  });
});

describe("the same product across pages is one line", () => {
  const withSku = { name: "Lavender Lip Salve", qty: 10, price: "$9.00", total: "$90.00", sku: "2400022124001" };
  const noSku = { name: "Lavender Lip Salve", qty: 10, price: "$9.00", total: "$90.00", sku: null };
  it("same name, qty and price: merged, the SKU from whichever page has it (either order)", () => {
    expect(mergeBuckets({ ...emptyBuckets(), products: [withSku] }, { ...emptyBuckets(), products: [noSku] }).products).toEqual([withSku]);
    expect(mergeBuckets({ ...emptyBuckets(), products: [noSku] }, { ...emptyBuckets(), products: [withSku] }).products).toEqual([withSku]);
    // A confirmation showing only the line total ($90.00 for 10) is the same item.
    expect(sameProduct(withSku, { ...noSku, price: "$90.00", total: null })).toBe(true);
  });
  it("a different qty or price with a SKU on one side only stays a second line; two different SKUs stay two lines", () => {
    expect(mergeBuckets({ ...emptyBuckets(), products: [withSku] }, { ...emptyBuckets(), products: [{ ...noSku, qty: 4, total: "$36.00" }] }).products).toHaveLength(2);
    expect(mergeBuckets({ ...emptyBuckets(), products: [withSku] }, { ...emptyBuckets(), products: [{ ...noSku, price: "$7.50", total: "$75.00" }] }).products).toHaveLength(2);
    expect(mergeBuckets({ ...emptyBuckets(), products: [withSku] }, { ...emptyBuckets(), products: [{ ...withSku, sku: "2400022124002" }] }).products).toHaveLength(2);
  });
  it("the three pages give one Lavender Lip Salve line, with its SKU", () => {
    let c: any = null;
    [page1, page2, page3].forEach((p, i) => { c = applyPage(c, p, "shop.lospoblanos.com", `2026-11-07T23:4${i}:00Z`); });
    const lip = c.buckets.products.filter((p: any) => /lavender lip salve/i.test(p.name));
    expect(lip).toHaveLength(1);
    expect(lip[0]).toMatchObject({ qty: 10, sku: "2400022124001" });
  });
});

describe("the panel names the page the AI could not read, and why", () => {
  const at = (i: number) => `2026-11-07T23:4${i}:00Z`;
  const three = () => [page1, page2, page3].reduce((c: any, p, i) => applyPage(c, { ...p, previewKey: `k${i + 1}` }, "shop.lospoblanos.com", at(i)), null);
  const ERR = "AI preview failed (400: preview: page.fields.41.label: Too big: expected string to have <=200 characters)";
  it("page 2 refused, page 3 read afterwards: the failure stays, named (before 2.0.4 page 3's answer wiped it)", () => {
    let c = applyPreview(three(), "k1", { ...emptyBuckets() }, null);
    c = applyPreview(c, "k2", null, ERR);
    c = applyPreview(c, "k3", { ...emptyBuckets() }, null);
    expect(previewFailures(c)).toEqual([{ n: 2, step: "review", path: "/checkouts/cn/zz-synthetic", error: ERR }]);
    expect(previewError(c)).toBe(`Page 2 (review · /checkouts/cn/zz-synthetic) not read: ${ERR}`);
    expect(previewStatus(c)).toBe(ERR);
    // Read on a later try: the line goes.
    const ok = applyPreview(c, "k2", { ...emptyBuckets() }, null);
    expect(previewError(ok)).toBeNull();
    expect(previewStatus(ok)).toBe("AI read");
  });
  it("the prefill pages are clipped too (a record captured before 2.0.4 still holds the long label)", () => {
    const c = applyPage(null, page2, "shop.lospoblanos.com", at(0));
    expect(pagesForPrefill(c)[0].fields[41].label.length).toBe(200);
  });
});
