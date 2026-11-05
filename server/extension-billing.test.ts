// A billing address never fills Shipping (Capture PO v1.4.1, Maria 2026-11-05): gordonelectricsupply.com's
// Shipping Information page captured the ship-to, then the payment page's "Billing Address:" form (name on card,
// address line 1, city, state, zip) replaced it. The two pages are the production captures (kept samples,
// personal data replaced: the billing address is invented, the ship-to is the Velocity street).
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { extractBuckets, extractShipping, mergeBuckets, emptyBuckets, overlayPreview, applyPage, describeShipping } from "../chrome-extension/buckets.js";
import { scrubText } from "../chrome-extension/core/scrub.js";
import { CapturePageSchema, PREFILL_SYSTEM } from "./po-prefill";

const FIX = resolve(__dirname, "__fixtures__/capture-pages/gordon");
/** A kept-sample fixture (server/capture-samples.ts sampleAsFixture) → one captured page. */
function samplePage(name: string, step: string) {
  const raw = readFileSync(resolve(FIX, `${name}.txt`), "utf8");
  const head = /^=== page 1 · step \S+ · (\S+) · (.*?) · captured /m.exec(raw)!;
  const body = raw.slice(raw.indexOf("\n", raw.indexOf("=== page 1")) + 1);
  const cut = body.lastIndexOf("\n--- fields (");
  const fields = body.slice(body.indexOf("\n", cut + 1) + 1).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { step, url: head[1], title: head[2], text: scrubText(body.slice(0, cut)), fields };
}
const shipping = samplePage("shipping", "shipping");
const payment = samplePage("payment", "other");
const VELOCITY = "805 Grandy Ave";

describe("Gordon: the shipping page, then the payment page with a different billing address", () => {
  it("the shipping page's typed address is a labeled ship-to (Ship-To Name, the page title)", () => {
    expect(extractShipping(shipping)).toMatchObject({ street: VELOCITY, city: "La Grande", zip: "97850", labeled: true });
  });
  it("the payment page's Billing Address form is payment-side: no Shipping from it", () => {
    expect(extractShipping(payment)).toBeNull();
  });
  it("shipping → payment: Shipping keeps the shipping page's address", () => {
    const b = mergeBuckets(mergeBuckets(emptyBuckets(), extractBuckets(shipping)), extractBuckets(payment));
    expect(b.shipping?.street).toBe(VELOCITY);
  });
  it("even when the AI read the billing street on the payment page, the labeled ship-to stays", () => {
    const payAi = overlayPreview(extractBuckets(payment), { ...emptyBuckets(), shipping: { street: "12 Elsewhere St", candidates: [] }, promos: [] });
    expect(payAi.shipping?.street).toBe("12 Elsewhere St"); // that page alone
    expect(mergeBuckets(extractBuckets(shipping), payAi).shipping?.street).toBe(VELOCITY);
  });
  it("through the tab's capture record (applyPage, oldest first), as the panel shows it", () => {
    let cap = applyPage(null, shipping, "www.gordonelectricsupply.com", "2026-11-05T12:43:34Z");
    cap = applyPage(cap, payment, "www.gordonelectricsupply.com", "2026-11-05T12:43:55Z");
    expect(describeShipping(cap.buckets.shipping, { velocityStreet: VELOCITY, homeStreets: [] })[0]).toMatch(/^Velocity · 805 Grandy Ave/);
  });
});

describe("the rules", () => {
  const cardForm = (extra: { label: string; value: string }[] = []) => ({ url: "x", title: "Checkout", text: "Payment", fields: [{ label: "Name on card", value: "Test Buyer" }, { label: "address1", value: "12 Elsewhere St" }, { label: "city", value: "Springfield" }, { label: "zip", value: "62701" }, ...extra] });
  it("address fields beside card fields are the card's billing address", () => {
    expect(extractShipping(cardForm())).toBeNull();
    expect(extractShipping({ ...cardForm(), fields: [{ label: "card_number", value: "•••• 4444" }, ...cardForm().fields.slice(1)] })).toBeNull();
    expect(extractShipping({ url: "x", title: "Checkout", text: "Billing Address:\nfor verification only", fields: cardForm().fields.slice(1) })).toBeNull();
  });
  it("…unless the field itself says shipping (a one-page checkout with both forms)", () => {
    expect(extractShipping(cardForm([{ label: "shipping_address1", value: VELOCITY }]))).toMatchObject({ street: VELOCITY, labeled: true });
  });
  it("a billing / cardholder heading in the text never fills Shipping", () => {
    expect(extractShipping({ url: "x", text: "Billing address\n12 Elsewhere St\nSpringfield, IL 62701", fields: [] })).toBeNull();
    expect(extractShipping({ url: "x", text: "Cardholder address\n12 Elsewhere St", fields: [] })).toBeNull();
  });
  it("a labeled ship-to is replaced only by another labeled one", () => {
    const labeled = extractBuckets({ url: "x", text: "Ship to\n805 Grandy Ave\nLa Grande, OR 97850", fields: [] });
    expect(labeled.shipping).toMatchObject({ street: VELOCITY, labeled: true });
    const bare = extractBuckets({ url: "x", text: "Address\n12 Elsewhere St", fields: [] });
    expect(bare.shipping).toMatchObject({ street: "12 Elsewhere St", labeled: false });
    expect(mergeBuckets(labeled, bare).shipping?.street).toBe(VELOCITY);
    const later = extractBuckets({ url: "x", text: "Delivery address\n12 Elsewhere St", fields: [] });
    expect(mergeBuckets(labeled, later).shipping?.street).toBe("12 Elsewhere St");
    expect(mergeBuckets(bare, labeled).shipping?.street).toBe(VELOCITY); // an unlabeled read is replaced as before
  });
});

describe("the AI preview / prefill prompt", () => {
  it("says a billing / cardholder address is never shipToStreet, and when a later page may replace the ship-to", () => {
    expect(PREFILL_SYSTEM).toMatch(/billing \/ billing address \/ cardholder/);
    expect(PREFILL_SYSTEM).toMatch(/beside card fields/);
    expect(PREFILL_SYSTEM).toMatch(/later page's address replaces an earlier page's ship-to only when the later page also labels it ship-to \/ shipping \/ delivery/);
  });
});

describe("the server scrubs the pages again — the third layer (an extension build before the SECNO_NEW fix)", () => {
  it("a security-code field by a form's own name, an expiry month and a card-number field never pass", () => {
    const p = CapturePageSchema.parse({ url: "x", text: "Security Code 864\nCard 5105 1051 0510 5100", fields: [{ label: "SECNO_NEW", value: "864" }, { label: "EXP.MONTH", value: "02" }, { label: "CCNO", value: "5105105105105100" }, { label: "Zip Code", value: "62701" }] });
    expect(p.fields).toEqual([{ label: "CCNO", value: "•••• 5100" }, { label: "Zip Code", value: "" }]); // a page with a card field: the payment-form rule empties the rest
    expect(p.text).not.toMatch(/864|5105 1051/);
  });
});
