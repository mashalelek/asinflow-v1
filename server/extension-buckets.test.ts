import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { extractBuckets, mergeBuckets, emptyBuckets, filled, missing, applyPage, newCapture, captureKey, pagesForPrefill, shipToForPrefill, othersCapturing, describeShipping, extractShipping, extractProducts, extractPromos, debugText, dedupePromos } from "../chrome-extension/buckets.js";
import { scrubText } from "../chrome-extension/scrub.js";

// Capture PO v1.2 (SPEC §11 "Chrome extension — Capture PO"): six data
// buckets, newest value wins per field, nothing dropped; the SELECTED
// address; captures are per tab.
const FIX = resolve(__dirname, "__fixtures__/capture-pages");
const fixture = (name: string, extra: Partial<{ step: string; url: string; fields: { label: string; value: string }[] }> = {}) =>
  ({ step: extra.step ?? "other", url: extra.url ?? `https://example.com/${name}`, title: name, text: scrubText(readFileSync(resolve(FIX, /address/.test(name) ? `addresses/${name}.txt` : `${name}.txt`), "utf8")), fields: extra.fields ?? [] });
const config = { velocityStreet: "805 grandy", homeStreets: ["65 rivercrest"] };

const walmartCart = {
  step: "cart", url: "https://www.walmart.com/cart", title: "Cart",
  text: "Cart (3 items)\nFree shipping, arrives by Thu, Nov 5\n\nGreat Value Creamy Peanut Butter, 40 oz\nMultipack Quantity: 1\n$7.97\n12\n$95.64\n\nHefty Slider Freezer Bags, Gallon, 56 Count\nMultipack Quantity: 1\n$9.48\n6\n$56.88\n\nScotch-Brite Heavy Duty Scrub Sponges, 9 Count\n$5.97\n4\n$23.88\n\nSubtotal (22 items) $176.40\nTaxes $10.58\nEstimated total $186.98\nCustomers also considered\nGreat Value Grape Jelly, 32 oz\n$2.98",
  fields: [{ label: "Multipack Quantity", value: "1" }, { label: "Quantity", value: "12" }, { label: "Multipack Quantity", value: "1" }, { label: "Quantity", value: "6" }, { label: "Quantity", value: "4" }],
};

describe("buckets: extraction (regex-level, no AI)", () => {
  it("Products are the product lines actually parsed — never a count of 'Qty' strings, never 'Multipack Quantity', never the recommendation strip after the totals", () => {
    const b = extractBuckets(walmartCart);
    expect(b.products).toEqual([
      { name: "Great Value Creamy Peanut Butter, 40 oz", qty: 12, price: "$7.97", total: "$95.64", sku: null },
      { name: "Hefty Slider Freezer Bags, Gallon, 56 Count", qty: 6, price: "$9.48", total: "$56.88", sku: null },
      { name: "Scotch-Brite Heavy Duty Scrub Sponges, 9 Count", qty: 4, price: "$5.97", total: "$23.88", sku: null },
    ]);
    expect(b.totals).toEqual({ subtotal: "$176.40", tax: "$10.58", total: "$186.98" });
    expect(b.shipping).toBeNull();
    expect(filled(b)).toEqual({ products: true, shipping: false, payment: false, totals: true, promos: false, order: false });
    expect(missing(b)).toEqual(["Shipping", "Payment", "Promos", "Order"]);
  });
  it("the cart stepper's value is a form field, not page text: qty fields fill the blocks that show a quantity control, in order", () => {
    const page = { ...walmartCart, text: walmartCart.text.replace(/\n12\n/, "\nQuantity\n").replace(/\n6\n/, "\nQuantity\n").replace(/\n4\n/, "\nQuantity\n") };
    expect(extractProducts(page).map((p) => p.qty)).toEqual([12, 6, 4]);
    // v1.2.7: a quantity control with its value inside the input and no field captured — the whole ratio line total ÷ unit price is the quantity (12 × $7.97 = $95.64), as a table row already did.
    expect(extractProducts({ ...page, fields: [] }).map((p) => p.qty)).toEqual([12, 6, 4]);
    // No quantity control and no value anywhere → not product lines (v1.2.1: title + price + quantity, or nothing).
    expect(extractProducts({ ...walmartCart, text: walmartCart.text.replace(/\n12\n|\n6\n|\n4\n/g, "\n"), fields: [] })).toEqual([]);
  });
  it("a pack-size dropdown's options (Multipack Quantity: 1 / 2 on their own lines) are never the quantity; the Quantity fields fill it (the 2026-11-01 browser check)", () => {
    const page = {
      url: "https://www.walmart.com/cart", step: "cart",
      text: "Cart (3 items)\nGreat Value Creamy Peanut Butter, 40 oz\nMultipack Quantity:\n1\n2\n$7.97\nQuantity\n$95.64\nHefty Slider Freezer Bags, Gallon, 56 Count\nMultipack Quantity:\n1\n2\n$9.48\nQuantity\n$56.88\nScotch-Brite Heavy Duty Scrub Sponges, 9 Count\n$5.97\nQuantity\n$23.88\nSubtotal (22 items) $176.40",
      fields: [{ label: "Multipack Quantity: 1 2", value: "1" }, { label: "Quantity", value: "12" }, { label: "Multipack Quantity: 1 2", value: "1" }, { label: "Quantity", value: "6" }, { label: "Quantity", value: "4" }],
    };
    expect(extractProducts(page).map((p) => [p.qty, p.price, p.total])).toEqual([[12, "$7.97", "$95.64"], [6, "$9.48", "$56.88"], [4, "$5.97", "$23.88"]]);
  });
  it("the checked payment radio is the card; the other saved cards the page lists are not", () => {
    const b = extractBuckets({ url: "x", text: "Payment\nVisa ending in 4242\nMastercard ending in 4444", fields: [{ label: "selected: Visa ending in 4242", value: "Visa ending in 4242" }] });
    expect(b.payment.cards).toEqual([{ nickname: "Visa", last4: "4242", amount: null }]);
    expect(extractBuckets({ url: "x", text: "Payment\nVisa ending in 4242\nMastercard ending in 4444" }).payment.cards.map((c) => c.last4)).toEqual(["4242", "4444"]);
  });
  it("single-line items with SKU / UPC, cards by last 4, gift cards, totals, promos and the order # from the fixtures", () => {
    const lake = extractBuckets(fixture("lakeshore-cart"));
    expect(lake.products).toEqual([
      { name: "Classroom Carpet 6x9", qty: 1, price: "$199.00", total: null, sku: "LC1234" },
      { name: "Washable Markers 8-Pack", qty: 3, price: "$12.49", total: null, sku: "LC5678" },
    ]);
    expect(lake.order).toEqual({ number: "2026-1234-5678" });
    expect(lake.payment.cards).toEqual([{ nickname: "Discover", last4: "1117", amount: null }]);
    const mich = extractBuckets(fixture("michaels-review"));
    expect(mich.products.map((p) => [p.name, p.qty, p.price])).toEqual([["Liquitex BASICS Acrylic Paint, 4oz., Blue Gray", 6, "$5.99"], ["Red Heart Super Saver Yarn, Light Blue", 12, "$3.49"]]);
    expect(mich.promos).toEqual(["Promo applied: 30% off with COMEBACK47Z5", "Michaels Rewards applied: -$5.00"]);
    expect(mich.totals).toEqual({ subtotal: "$77.82", discount: "-$23.35", tax: "$3.81", shipping: "$0.00", total: "$53.28" });
    expect(describeShipping(mich.shipping, config)).toEqual(["Home · 65 Rivercrest Dr"]);
    const bbb = extractBuckets(fixture("bbb-confirmation"));
    expect(bbb.payment).toEqual({ cards: [{ nickname: "Mastercard", last4: "4444", amount: null }], giftCards: [{ last4: "1234", amount: "$50.00" }] });
    expect(bbb.promos).toEqual([]);
    expect(bbb.order.number).toBe("123456789012");
    const wal = extractBuckets(fixture("walmart-payment"));
    expect(wal.totals.shipping).toBe("Free");
    expect(wal.payment.giftCards).toEqual([{ last4: "9012", amount: null }]);
    expect(describeShipping(wal.shipping, config)).toEqual(["Velocity · 805 Grandy Ave"]);
    expect(describeShipping({ street: "12 Elsewhere St", candidates: ["12 Elsewhere St"], selected: true }, config)).toEqual(["Unknown: 12 Elsewhere St"]);
  });
  it("Order: date and subscription (from the selected option, or a subscription line with a frequency)", () => {
    const b = extractBuckets({ url: "x", text: "Order# 2000123-45678901\nOrder placed: Nov 1, 2026\nSubscribe & Save\nDeliver every 4 weeks", fields: [{ label: "selected: Subscribe & Save", value: "Subscribe & Save\nDeliver every 4 weeks\nSave 5%" }] });
    expect(b.order).toEqual({ number: "2000123-45678901", date: "Nov 1, 2026", subscription: { on: true, every: "every 4 weeks" } });
    expect(extractBuckets({ url: "x", text: "One-time purchase", fields: [{ label: "selected: One-time purchase", value: "One-time purchase" }] }).order).toEqual({ subscription: { on: false, every: null } });
  });
});

// v1.2.1 (Maria 2026-11-01): the first real Walmart PO — 42–58 "products" on a 1-item cart, "Unknown: 100 ct" addresses, Total from "You saved", "Have a promo code?" as a promo.
describe("buckets: the first real Walmart PO (synthetic cart + confirmation pair, walmart-po/)", () => {
  const po = (name: string, extra: Partial<{ step: string; fields: { label: string; value: string }[] }> = {}) =>
    ({ step: extra.step ?? "other", url: `https://www.walmart.com/${name}`, title: name, text: scrubText(readFileSync(resolve(FIX, `walmart-po/${name}.txt`), "utf8")), fields: extra.fields ?? [] });
  const cart = po("cart", { step: "cart", fields: [{ label: "Multipack Quantity: 1 2", value: "1" }, { label: "Quantity", value: "12" }, { label: "selected: 100 ct", value: "100 ct" }, { label: "selected: 12 Ct", value: "12 Ct" }] });
  const confirmation = po("confirmation", { step: "review" });
  it("cart: one product (title + price + the quantity control), none from the rollback / Bought N times / recommendation strips; totals from the labelled lines, the promo prompt ignored", () => {
    const b = extractBuckets(cart);
    expect(b.products).toEqual([{ name: "Great Value Creamy Peanut Butter, 40 oz", qty: 12, price: "$7.97", total: null, sku: null }]);
    expect(b.totals).toEqual({ subtotal: "$95.64", total: "$95.64" }); // "Taxes / Calculated at checkout" is no amount
    expect(b.promos).toEqual([]);
    expect(b.shipping).toBeNull(); // the size-variant radios "100 ct" / "12 Ct" are not addresses
  });
  it("confirmation: the one real address (Velocity), Total from 'Order total' not from 'You saved' (a discount candidate), the order #, the card — and the 'My Items' strip is not products", () => {
    const b = extractBuckets(confirmation);
    expect(b.shipping).toEqual({ street: "805 Grandy Ave", candidates: ["805 Grandy Ave"], selected: false });
    expect(b.totals).toEqual({ subtotal: "$95.64", discount: "$36.12", tax: "$5.74", total: "$101.38" });
    expect(b.order.number).toBe("200012345678902");
    expect(b.payment.cards).toEqual([{ nickname: "Visa", last4: "1111", amount: null }]);
    // v1.2.4: "Qty 12" + one money: 95.64 ÷ 12 = 7.97 exactly → the money is the line total, the unit price derived
    expect(b.products).toEqual([{ name: "Great Value Creamy Peanut Butter, 40 oz", qty: 12, price: "$7.97", total: "$95.64", sku: null }]);
    expect(b.promos).toEqual([]);
  });
  it("merged: one product with the cart's unit price and the confirmation's line total, Ships to Velocity with no ambiguity, Open in AF enabled", () => {
    let c = applyPage(null, cart, "www.walmart.com", "2026-11-01T20:00:00Z");
    c = applyPage(c, confirmation, "www.walmart.com", "2026-11-01T20:01:00Z");
    expect(c.buckets.products).toEqual([{ name: "Great Value Creamy Peanut Butter, 40 oz", qty: 12, price: "$7.97", total: "$95.64", sku: null }]);
    expect(describeShipping(c.buckets.shipping, config)).toEqual(["Velocity · 805 Grandy Ave"]);
    expect(shipToForPrefill(c)).toEqual({ street: "805 Grandy Ave", candidates: ["805 Grandy Ave"] });
    expect(c.buckets.totals.total).toBe("$101.38");
    expect(missing(c.buckets)).toEqual(["Promos"]);
  });
  it("a promo line carries a code, an amount or a percent; a question or an empty prompt is not one", () => {
    const b = extractBuckets({ url: "x", text: "Have a promo code?\nPromo code\nApply\nPromo applied: 30% off with COMEBACK47Z5\nRewards: $5.00 applied\nCoupon SAVE20 applied" });
    expect(b.promos).toEqual(["Promo applied: 30% off with COMEBACK47Z5", "Rewards: $5.00 applied", "Coupon SAVE20 applied"]);
  });
});

describe("buckets: the SELECTED address, not the first address block", () => {
  it("a review page with a shipping block and a billing block → the shipping street only", () => {
    const s = extractShipping(fixture("walmart-review-two-addresses"));
    expect(s).toEqual({ street: "805 Grandy Ave", candidates: ["805 Grandy Ave"], selected: false });
  });
  it("an address picker with two options → the checked radio's option wins (its 'selected:' field), whichever block comes first", () => {
    const page = fixture("michaels-address-picker", { fields: [{ label: "selected: Accounts Payable 65 Rivercrest Dr", value: "Accounts Payable\n65 Rivercrest Dr, Chesapeake, VA 23320" }] });
    expect(extractShipping(page)).toEqual({ street: "65 Rivercrest Dr", candidates: ["65 Rivercrest Dr"], selected: true });
    expect(describeShipping(extractShipping(page), config)).toEqual(["Home · 65 Rivercrest Dr"]);
    // Nothing checked → the address under the "Choose a shipping address" heading, as on a review page (v1.2.1 scopes text detection to deliver / ship / address headings).
    expect(extractShipping(fixture("michaels-address-picker"))).toEqual({ street: "805 Grandy Ave", candidates: ["805 Grandy Ave"], selected: false });
  });
  it("ambiguous — two selected address options, or two ship-to blocks — shows both and leaves the street blank (the form's Ships to stays empty)", () => {
    const two = extractShipping({ url: "x", text: "Checkout", fields: [{ label: "selected: ship", value: "Coastal Quality Goods\n805 Grandy Ave, Norfolk, VA" }, { label: "selected: pickup", value: "Accounts Payable\n65 Rivercrest Dr, Chesapeake, VA" }] });
    expect(two).toEqual({ street: null, candidates: ["805 Grandy Ave", "65 Rivercrest Dr"], selected: true });
    expect(describeShipping(two, config)).toEqual(["Velocity · 805 Grandy Ave", "Home · 65 Rivercrest Dr"]);
    const text = extractShipping({ url: "x", text: "Ship to\n805 Grandy Ave\nNorfolk\nDeliver to\n12 Elsewhere St\nAnytown" });
    expect(text).toEqual({ street: null, candidates: ["805 Grandy Ave", "12 Elsewhere St"], selected: false });
    expect(filled(mergeBuckets(null, { shipping: two })).shipping).toBe(true);
  });
  it("a billing-address radio never counts as the ship-to", () => {
    expect(extractShipping({ url: "x", text: "", fields: [{ label: "selected: Billing address", value: "Accounts Payable\n65 Rivercrest Dr" }] })).toBeNull();
  });
});

describe("buckets: merge — newest wins per field, nothing replaced wholesale, nothing dropped", () => {
  const cart = extractBuckets(walmartCart);
  const review = extractBuckets({
    step: "review", url: "https://www.walmart.com/checkout/review", title: "Review",
    text: "Review your order\nShipping address\nCoastal Quality Goods\n805 Grandy Ave\nNorfolk, VA 23504\nPayment\nVisa ending in 4242\nGreat Value Creamy Peanut Butter, 40 oz   Qty: 10   $7.97\nItems subtotal $160.46\nTaxes $9.63\nTotal $170.09",
  });
  it("a product seen again is updated in place (qty 12 → 10), the others stay; totals update per field; a bucket the page lacks is kept", () => {
    const m = mergeBuckets(cart, review);
    expect(m.products.map((p) => [p.name, p.qty])).toEqual([["Great Value Creamy Peanut Butter, 40 oz", 10], ["Hefty Slider Freezer Bags, Gallon, 56 Count", 6], ["Scotch-Brite Heavy Duty Scrub Sponges, 9 Count", 4]]);
    expect(m.products[0].total).toBe("$95.64"); // the review line's "Qty: 10 / $7.97" is a unit price (0.797 is no price, v1.2.4) → no line total → the cart's stays
    expect(m.totals).toEqual({ subtotal: "$160.46", tax: "$9.63", total: "$170.09" });
    expect(m.shipping?.street).toBe("805 Grandy Ave");
    expect(m.payment.cards).toEqual([{ nickname: "Visa", last4: "4242", amount: null }]);
    // A later page with none of it (a bare payment page) clears nothing.
    const later = mergeBuckets(m, extractBuckets({ url: "x", text: "Payment\nVisa ending in 4242\nAdd a gift card" }));
    expect(later.products).toHaveLength(3);
    expect(later.totals).toEqual(m.totals);
    expect(later.shipping).toEqual(m.shipping);
    expect(later.payment.cards).toHaveLength(1);
  });
  it("cards merge by last 4, gift cards by last 4 or amount, promos are a set, order fields per key", () => {
    const a = mergeBuckets(null, { payment: { cards: [{ nickname: "Visa", last4: "4242", amount: null }], giftCards: [{ last4: "1234", amount: null }] }, promos: ["Promo applied: 30% off"], order: { number: "A1" } });
    const b = mergeBuckets(a, { payment: { cards: [{ nickname: "Walmart Visa", last4: "4242", amount: "$186.98" }, { nickname: "Amex", last4: "1005", amount: null }], giftCards: [{ last4: "1234", amount: "$50.00" }] }, promos: ["Promo applied: 30% off", "Rewards: $5.00 applied"], order: { date: "Nov 1, 2026" } });
    expect(b.payment.cards).toEqual([{ nickname: "Walmart Visa", last4: "4242", amount: "$186.98" }, { nickname: "Amex", last4: "1005", amount: null }]);
    expect(b.payment.giftCards).toEqual([{ last4: "1234", amount: "$50.00" }]);
    expect(b.promos).toEqual(["Promo applied: 30% off", "Rewards: $5.00 applied"]);
    expect(b.order).toEqual({ number: "A1", date: "Nov 1, 2026" });
    expect(mergeBuckets(null, null)).toEqual(emptyBuckets());
  });
});

// v1.2.2 / v1.2.3 (Maria 2026-11-02): a shagtools.com cart — table-style rows (one <tr> per product; innerText joins the cells with tabs) left Products empty, and one coupon counted as four promos. v1.2.3: still empty on the real cart (name / $8.93 / stepper / line total in separate cells) and on the checkout (title, "× N" as plain text under it, the line subtotal — no unit price, no quantity input). The shagtools fixtures are transcribed from Maria's screenshots of 2026-11-03 (cart with the Driftwood caulk × 10 on backorder, cart-alabaster × 5, the checkout before an address is entered) — the "Copy page text" paste, when it lands, replaces them verbatim.
const DRIFTWOOD = "Mapei Keracaulk S Sanded Siliconized Acrylic Caulk (10.5 oz.) - 5105 Driftwood", ALABASTER = "Mapei Keracaulk S Sanded Siliconized Acrylic Caulk (10.5 oz.) - 5001 Alabaster";
const shagCart = { step: "cart", url: "https://www.shagtools.com/cart/", title: "Cart", text: scrubText(readFileSync(resolve(FIX, "shagtools/cart.txt"), "utf8")), fields: [{ label: DRIFTWOOD + " quantity", value: "10" }, { label: "selected: Ground: $24.77", value: "Ground: $24.77\n(Delivery by November 10, 2026)" }] };
const shagCartAlabaster = { step: "cart", url: "https://www.shagtools.com/cart/", title: "Cart", text: scrubText(readFileSync(resolve(FIX, "shagtools/cart-alabaster.txt"), "utf8")), fields: [{ label: ALABASTER + " quantity", value: "5" }, { label: "selected: Ground: $22.99", value: "Ground: $22.99\n(Delivery by November 10, 2026)" }] };
const shagCheckout = { step: "review", url: "https://www.shagtools.com/checkout/", title: "Checkout", text: scrubText(readFileSync(resolve(FIX, "shagtools/checkout.txt"), "utf8")), fields: [{ label: "First name", value: "Maria" }, { label: "Last name", value: "Peters" }, { label: "Country / Region", value: "United States (US)" }, { label: "Street address", value: "805 Grandy Ave" }, { label: "Town / City", value: "La Grande" }, { label: "State", value: "Select an option..." }, { label: "ZIP Code", value: "97850" }] };
const driftwood10 = { name: DRIFTWOOD, qty: 10, price: "$8.93", total: "$89.30", sku: null };
const alabaster5 = { name: ALABASTER, qty: 5, price: "$8.93", total: "$44.65", sku: null };
describe("buckets: v1.2.3 — product rows with a plain-text quantity or no quantity text at all (shagtools cart + checkout)", () => {
  const cart = shagCart, checkout = shagCheckout;
  const kicker = { name: "Shag Carpet Kicker Pro 12 Inch Adjustable Head", qty: 15, price: "$8.93", total: "$133.95", sku: null };
  const pg = (text: string) => ({ step: "other", url: "https://www.shagtools.com/x", title: "x", text, fields: [] as { label: string; value: string }[] });
  const rowOf = (cells: string) => `Product\tPrice\tQuantity\tTotal\n${cells}\nSubtotal\t$133.95\n`;
  it("(b) cart: the real table — title line, the backorder note, then REMOVE / $8.93 / − / + / $89.30 tab-joined — is one product; the quantity comes from the '… quantity' field, and without one from the total ÷ price; the header row, the shipping-policy line and the free-shipping meter are not products", () => {
    const b = extractBuckets(cart);
    expect(b.products).toEqual([driftwood10]);
    expect(extractProducts({ ...cart, fields: [] })).toEqual([driftwood10]);
    expect(b.totals).toEqual({ subtotal: "$89.30", shipping: "$24.77", total: "$114.07" }); // "TAX  Taxes will be calculated at checkout" is no amount
    expect(b.promos).toEqual(["GET 10% OFF your first order"]);
    expect(extractBuckets(shagCartAlabaster).products).toEqual([alabaster5]);
    expect(extractBuckets(shagCartAlabaster).totals).toEqual({ subtotal: "$44.65", shipping: "$22.99", total: "$67.64" });
  });
  it("(b) the quantity cell in every rendering: '− 15 +' as three cells or one, a bare 15, a 'Qty' cell + 15, '× 15', 'Qty: 15', an input with nothing visible — and the cells in any order", () => {
    const title = "Shag Carpet Kicker Pro 12 Inch Adjustable Head";
    for (const cells of [
      `${title}\t$8.93\t−\t15\t+\t$133.95`, `${title}\t$8.93\t− 15 +\t$133.95`, `${title}\t$8.93\t-15+\t$133.95`, `${title}\t$8.93\t− +\t$133.95`,
      `${title}\t$8.93\t15\t$133.95`, `${title}\t$8.93\tQty\t15\t$133.95`, `${title}\t$8.93\t× 15\t$133.95`, `${title}\t$8.93\tQty: 15\t$133.95`,
      `${title}\t$8.93\t$133.95`, `$133.95\t${title}\t15\t$8.93`, `${title}\t15\t$133.95\t$8.93`,
    ]) expect(extractProducts(pg(rowOf(cells))), cells).toEqual([kicker]);
    // a row with one money and no quantity anywhere is still not a product (a strip); a bare count that the monies do not confirm is not the quantity
    expect(extractProducts(pg(rowOf(`${title}\t$133.95`)))).toEqual([]);
    expect(extractProducts(pg(rowOf(`${title}\t$8.93\t7\t$133.95`)))).toEqual([kicker]); // 7 is not it; 133.95 ÷ 8.93 = 15 is
  });
  it("(a) checkout: title, '× 10' under it, 'Available on backorder' and the line total $89.30 on one tab-joined line — qty 10, unit price derived as total ÷ 10; the typed address is the Shipping bucket; no shipping figure (\"Enter your address to view shipping options\")", () => {
    const b = extractBuckets(checkout);
    expect(b.products).toEqual([driftwood10]);
    expect(b.shipping).toMatchObject({ street: "805 Grandy Ave", fromFields: true, city: "La Grande", zip: "97850" });
    expect(b.payment.cards).toEqual([]);
    expect(b.totals).toEqual({ subtotal: "$89.30", tax: "$0.00", total: "$89.30" });
  });
  it("(a) the mark in every spelling and position: 'x 15', '15 ×', '(x15)', on the title line, on the total's line, in one tab-joined row; two monies keep the printed unit price", () => {
    const title = "Shag Carpet Kicker Pro 12 Inch Adjustable Head";
    const block = (lines: string) => `Order summary\n${lines}\nSubtotal\t$133.95\n`;
    for (const lines of [`${title}\n× 15\n$133.95`, `${title}\nx 15\n$133.95`, `${title}\n15 ×\n$133.95`, `${title}\n(x15)\n$133.95`, `${title} × 15\n$133.95`, `15 × ${title}\n$133.95`, `${title}\n× 15  $133.95`, `${title}  × 15  $133.95`, `${title}\t× 15\t$133.95`, `${title}\n× 15\n$8.93\n$133.95`, `${title}\n× 15\n$133.95\n$8.93`])
      expect(extractProducts(pg(block(lines))), lines).toEqual([kicker]);
    // a mark with a unit price adjacent is the old "12 × $7.97" form: the money is the unit price, not a total
    expect(extractProducts(pg(block(`${title}\n15 × $8.93`)))).toEqual([{ ...kicker, total: null }]);
    // v1.2.4: "Qty: N" with one money derives too when the money is N × a cent-exact price (133.95 ÷ 15 = 8.93); otherwise the money stays the unit price (7.97 ÷ 10 = 0.797 is no price — the Walmart review line)
    expect(extractProducts(pg(block(`${title}\nQty: 15\n$133.95`)))).toEqual([kicker]);
    expect(extractProducts(pg(block(`${title}  Qty: 15  $133.95`)))).toEqual([kicker]);
    expect(extractProducts(pg(`Product\tPrice\tQuantity\tTotal\n${title}\tQty: 15\t$133.95\nSubtotal\t$133.95\n`))).toEqual([kicker]);
    expect(extractProducts(pg(block(`${title}\nQty: 10\n$7.97`)))).toEqual([{ ...kicker, qty: 10, price: "$7.97", total: null }]);
    expect(extractProducts(pg(block(`${title}  Qty: 10  $7.97`)))).toEqual([{ ...kicker, qty: 10, price: "$7.97", total: null }]);
    expect(extractProducts(pg(block(`${title}\nQty: 1\n$8.93`)))).toEqual([{ ...kicker, qty: 1, price: "$8.93", total: null }]); // N = 1: nothing to derive
  });
  it("cart then checkout merge to one product; the promo is one entry; the checkout's totals replace the cart's (no shipping figure survives)", () => {
    const m = mergeBuckets(extractBuckets(cart), extractBuckets(checkout));
    expect(m.products).toEqual([driftwood10]);
    expect(m.promos).toEqual(["GET 10% OFF your first order"]);
    expect(m.shipping).toMatchObject({ street: "805 Grandy Ave" });
    expect(m.totals).toEqual({ subtotal: "$89.30", tax: "$0.00", total: "$89.30" });
  });
  it("promos: the banner, the 'GET 10% OFF' line, the cart notice and the COUPON: row dedupe by code (case-insensitive), a code-less line joins the code whose amount or percent it repeats, else by wording; distinct promos stay", () => {
    expect(dedupePromos(["Use code SHAGTOOLS10 at checkout", "Coupon shagtools10 applied", "GET 10% OFF your first order", "COUPON: SHAGTOOLS10 (10% off)  −$13.39"])).toEqual(["COUPON: SHAGTOOLS10 (10% off)  −$13.39"]);
    expect(dedupePromos(["Promo applied: 30% off with COMEBACK47Z5", "Rewards: $5.00 applied", "Coupon SAVE20 applied", "Promo applied: 30% off with comeback47z5"])).toEqual(["Promo applied: 30% off with COMEBACK47Z5", "Rewards: $5.00 applied", "Coupon SAVE20 applied"]);
    expect(dedupePromos(["Promo applied: 30% off", "Promo applied: 30% off"])).toEqual(["Promo applied: 30% off"]);
    expect(dedupePromos(["Rewards: $5.00 applied", "rewards: $5.00 APPLIED"])).toEqual(["Rewards: $5.00 applied"]);
    expect(dedupePromos(["Rewards: $5.00 applied", "Rewards: $5.00 applied today"])).toHaveLength(2);
  });
  it("debugText — 'Copy page text': every page oldest first with step / URL / title / time / size, the text verbatim (tabs kept, counted in the header) and the fields as JSON lines", () => {
    let c = applyPage(null, checkout, "www.shagtools.com", "2026-11-02T22:00:02.000Z");
    c = applyPage(c, cart, "www.shagtools.com", "2026-11-02T22:00:01.000Z");
    const d = debugText(c, "2026-11-02T22:05:00.000Z");
    const L = d.split("\n");
    expect(L[0]).toBe("AsinFlow capture · www.shagtools.com · 2 pages · 11 tab-joined lines · copied 2026-11-02T22:05:00.000Z · card numbers were masked in the page");
    expect(L[2]).toBe("=== page 1 · step cart · https://www.shagtools.com/cart/ · Cart · captured 2026-11-02T22:00:01.000Z · " + cart.text.length + " chars ===");
    expect(d).toContain("\n" + cart.text + "\n--- fields (2) ---\n" + cart.fields.map((f) => JSON.stringify(f)).join("\n") + "\n");
    expect(d).toContain("=== page 2 · step review · https://www.shagtools.com/checkout/ · Checkout · captured 2026-11-02T22:00:02.000Z");
    expect(d).toContain("\n" + checkout.text + "\n--- fields (7) ---");
    expect(debugText({ host: "x.com", pages: {}, others: [], count: 0 }, "t")).toBe("AsinFlow capture · x.com · 0 pages · 0 tab-joined lines · copied t · card numbers were masked in the page");
  });
  it("Open in AF is never gated (v1.2.4): no canOpen anywhere, the button is enabled with zero pages, and the background opens /pos/new?supplier=<host> with no model call when nothing is captured", () => {
    const panel = readFileSync(resolve(__dirname, "../chrome-extension/capture-panel.js"), "utf8");
    const bg = readFileSync(resolve(__dirname, "../chrome-extension/background.js"), "utf8");
    const buckets = readFileSync(resolve(__dirname, "../chrome-extension/buckets.js"), "utf8");
    expect(panel).not.toMatch(/canOpen|needs Products and Totals/);
    expect(buckets).not.toMatch(/function canOpen/);
    expect(panel).toMatch(/openBtn\.disabled = false/);
    expect(bg).toMatch(/if \(!cur \|\| !cur\.count\) \{\s*\n\s*\/\/ v1\.2\.4/);
    expect(bg).toMatch(/\/pos\/new\$\{host \? `\?supplier=\$\{encodeURIComponent\(host\)\}` : ""\}/);
    expect(bg).toMatch(/sendResponse\(\{ success: true, blank: true, host \}\)/);
    const poNew = readFileSync(resolve(__dirname, "../client/src/pages/po-new.tsx"), "utf8");
    expect(poNew).toMatch(/get\("supplier"\)/);
    expect(poNew).toMatch(/initialSupplier=\{supplier\}/);
  });
  it("the panel's Copy page text button is shown only with the options page's debug toggle and copies debugText(); nothing is sent anywhere", () => {
    const panel = readFileSync(resolve(__dirname, "../chrome-extension/capture-panel.js"), "utf8");
    expect(panel).toMatch(/B\.debugText\(current\)/);
    expect(panel).toMatch(/navigator\.clipboard\.writeText\(payload\)/);
    expect(panel).toMatch(/chrome\.storage\.sync\.get\(\["debugCapture"\]/);
    expect(panel).not.toMatch(/fetch\(/);
    expect(readFileSync(resolve(__dirname, "../chrome-extension/sidepanel.html"), "utf8")).toMatch(/<button id="capture-copy-btn"[^>]*style="display:none;"/);
    const options = readFileSync(resolve(__dirname, "../chrome-extension/options.js"), "utf8");
    expect(options).toMatch(/chrome\.storage\.sync\.set\(\{ serverUrl, autoOpen, debugCapture \}/);
    expect(readFileSync(resolve(__dirname, "../chrome-extension/options.html"), "utf8")).toMatch(/id="debug-capture"/);
  });
});

// v1.2.7 (Maria 2026-11-03, three findings from the real shagtools.com captures): (1) a status line between "× 10" and the total; (2) the cart table never parsed — its header row ("PRODUCT PRICE QUANTITY SUBTOTAL") was read as the start of the totals, the stepper's "−" / "+" and the "REMOVE" link share the row's tab-joined line, and the quantity input's label is "<product> quantity"; (3) Shipping $24.77 — the Ground rate selected on an earlier cart — survived into a checkout that lists no shipping and into the next cart: the buckets merged incrementally per capture instead of being rebuilt from the pages.
describe("buckets: v1.2.7 — note lines inside a row, the cart table, and buckets rebuilt from the pages on every capture", () => {
  const pg = (text: string, fields: { label: string; value: string }[] = []) => ({ step: "cart", url: "https://www.shagtools.com/cart/", title: "Cart", text, fields });
  const title = "Shag Carpet Kicker Pro 12 Inch Adjustable Head";
  const kicker15 = { name: title, qty: 15, price: "$8.93", total: "$133.95", sku: null };
  it("(1) up to two note lines (a status, a colour, a SKU line) may sit between the quantity and the line total; a third starts the next product; a title after the money always does", () => {
    expect(extractProducts(pg(`${title}\n× 15\nColor: Sandstone Beige\nShips from our Ohio warehouse\n$133.95`))).toEqual([kicker15]);
    expect(extractProducts(pg(`${title}\n× 15\nColor: Sandstone Beige\nItem # KP-1200\n$133.95`))).toEqual([{ ...kicker15, sku: "KP-1200" }]);
    expect(extractProducts(pg(`${title}\n× 15\nColor: Sandstone Beige\nFinish: Brushed Nickel\nPattern: Herringbone Weave\n$133.95`))).toEqual([]); // three notes: not one row
    expect(extractProducts(pg(`${title}\n× 15\n$133.95\nColor: Sandstone Beige\nAnother Product Entirely Named\n× 2\n$10.00`))).toEqual([kicker15, { name: "Another Product Entirely Named", qty: 2, price: "$5.00", total: "$10.00", sku: null }]);
  });
  it("(2) the cart table: the header row is not where the totals start; the row's tab-joined line carries REMOVE, the two monies and the stepper; the quantity from the '… quantity' field, the stepper's value, or the whole ratio total ÷ price", () => {
    const row = (cells: string) => `PRODUCT\tPRICE\tQUANTITY\tSUBTOTAL\n${DRIFTWOOD}\nAvailable on backorder\n${cells}\nCART TOTALS\nSUBTOTAL\t$89.30\nTOTAL\t$114.07`;
    const qtyField = [{ label: DRIFTWOOD + " quantity", value: "10" }];
    expect(extractProducts(pg(row("REMOVE\t$8.93\t−\t+\t$89.30"), qtyField))).toEqual([driftwood10]);
    expect(extractProducts(pg(row("REMOVE\t$8.93\t−\t+\t$89.30")))).toEqual([driftwood10]); // no field: 89.30 ÷ 8.93 = 10
    expect(extractProducts(pg(row("REMOVE\t$8.93\t− 10 +\t$89.30")))).toEqual([driftwood10]); // the value in the text
    expect(extractProducts(pg(row("$8.93\t\t$89.30"), qtyField))).toEqual([driftwood10]); // an icon stepper: no text at all, the field decides
    expect(extractProducts(pg(row("REMOVE\t$8.93\t−\t+\t$89.30"), [{ label: "Multipack quantity", value: "3" }]))).toEqual([driftwood10]); // a pack-size field is not the quantity
    // the field count must match the controlled rows; a mismatch falls back to the ratio
    expect(extractProducts(pg(row("REMOVE\t$8.93\t−\t+\t$89.30"), [{ label: "quantity", value: "4" }, { label: "quantity", value: "7" }]))).toEqual([driftwood10]);
    // a totals line that really is one still ends the region
    expect(extractProducts(pg(`SUBTOTAL\t$89.30\n${DRIFTWOOD}\nREMOVE\t$8.93\t−\t+\t$89.30`, qtyField))).toEqual([driftwood10]); // (nothing before it → the whole page is read, as before)
  });
  it("(2) the cart's shipping radios: 'Ground: $24.77' / '(Delivery by …)' / '2 Day: $120.02' / '(Delivery by …)' / 'Next Day: $180.02' — the checked one (a selected: field) is the shipping; without it the one that reconciles with Total; never the first by default", () => {
    const text = (total: string) => `SUBTOTAL\t$89.30\nSHIPPING\nGround: $24.77\n(Delivery by November 10, 2026)\n2 Day: $120.02\n(Delivery by November 6, 2026)\nNext Day: $180.02\n(Delivery by November 5, 2026)\nShipping to 805 Grandy Ave, La Grande, OR 97850.\nTAX\tTaxes will be calculated at checkout\nTOTAL\t${total}`;
    expect(extractBuckets(pg(text("$114.07"), [{ label: "selected: Ground: $24.77", value: "checked" }])).totals).toEqual({ subtotal: "$89.30", shipping: "$24.77", total: "$114.07" });
    expect(extractBuckets(pg(text("$209.32"), [{ label: "selected: 2 Day: $120.02", value: "checked" }])).totals).toMatchObject({ shipping: "$120.02" });
    expect(extractBuckets(pg(text("$269.32"))).totals).toMatchObject({ shipping: "$180.02" });
    expect(extractBuckets(pg(text("$1.00"))).totals).toEqual({ subtotal: "$89.30", total: "$1.00" });
  });
  it("(3) applyPage rebuilds the buckets from the pages: a checkout that lists no shipping drops the cart's figure; re-capturing the cart replaces its values; a cleared record (null) starts empty", () => {
    let c = applyPage(null, shagCart, "www.shagtools.com", "2026-11-03T20:00:00.000Z");
    expect(c.buckets.totals).toEqual({ subtotal: "$89.30", shipping: "$24.77", total: "$114.07" });
    c = applyPage(c, shagCheckout, "www.shagtools.com", "2026-11-03T20:01:00.000Z");
    expect(c.buckets.totals).toEqual({ subtotal: "$89.30", tax: "$0.00", total: "$89.30" }); // "Enter your address to view shipping options" — no $24.77 kept
    expect(c.buckets.products).toEqual([driftwood10]);
    // the cart captured again (a different cart now): its step entry and its values are replaced, the checkout's product stays — same order, 2 pages
    c = applyPage(c, shagCartAlabaster, "www.shagtools.com", "2026-11-03T20:02:00.000Z");
    expect(c.count).toBe(2);
    expect(c.buckets.totals).toEqual({ subtotal: "$44.65", shipping: "$22.99", total: "$67.64" });
    expect(c.buckets.products).toEqual([driftwood10, alabaster5]);
    // Clear removes the tab's record; the next capture starts from nothing
    const fresh = applyPage(null, shagCartAlabaster, "www.shagtools.com", "2026-11-03T20:03:00.000Z");
    expect(fresh.count).toBe(1);
    expect(fresh.buckets.products).toEqual([alabaster5]);
    expect(fresh.buckets.totals).toEqual({ subtotal: "$44.65", shipping: "$22.99", total: "$67.64" });
    expect(filled(newCapture("www.shagtools.com").buckets)).toEqual({ products: false, shipping: false, payment: false, totals: false, promos: false, order: false });
    // a page that shows no totals at all (a product page) leaves the figure alone; a stored record without buckets is rebuilt too
    const other = applyPage(fresh, { step: "other", url: "https://www.shagtools.com/product/x", title: "x", text: "Some Product Page Title Here\nAdd to cart", fields: [] }, "www.shagtools.com", "2026-11-03T20:04:00.000Z");
    expect(other.buckets.totals).toEqual({ subtotal: "$44.65", shipping: "$22.99", total: "$67.64" });
    const { buckets: _b, ...noBuckets } = fresh;
    expect(applyPage(noBuckets as typeof fresh, shagCheckout, "www.shagtools.com", "2026-11-03T20:05:00.000Z").buckets.totals).toEqual({ subtotal: "$89.30", tax: "$0.00", total: "$89.30" });
  });
  it("(3) mergeBuckets: the newer page's totals replace the whole figure when it shows totals; otherwise the older figure stays; order fields still merge per field", () => {
    const a = { ...emptyBuckets(), totals: { subtotal: "$89.30", shipping: "$24.77", total: "$114.07" }, order: { number: "1001" } };
    expect(mergeBuckets(a, { ...emptyBuckets(), totals: { subtotal: "$89.30", tax: "$0.00", total: "$89.30" } }).totals).toEqual({ subtotal: "$89.30", tax: "$0.00", total: "$89.30" });
    expect(mergeBuckets(a, { ...emptyBuckets(), totals: { shipping: "$5.00" } }).totals).toEqual({ subtotal: "$89.30", shipping: "$24.77", total: "$114.07" });
    expect(mergeBuckets(a, { ...emptyBuckets(), order: { date: "2026-11-03" } }).order).toEqual({ number: "1001", date: "2026-11-03" });
  });
});

// v1.2.6 (Maria 2026-11-03, the first real "Copy page text" from shagtools.com/checkout): the product row read "× 10" / "Available on backorder" / $89.30 and Products stayed empty — the availability line looked like a new title. Totals showed Shipping $24.77 on a page whose Total was $89.30: the Shipping row lists the shipping methods (WooCommerce radios) and the old rule took the first money after the label.
describe("buckets: v1.2.6 — availability lines are noise; a shipping-method list resolves by the checked radio or by Total", () => {
  const pg = (text: string, fields: { label: string; value: string }[] = []) => ({ step: "review", url: "https://www.shagtools.com/checkout", title: "Checkout", text, fields });
  const title = "Shag Carpet Kicker Pro 12 Inch Adjustable Head";
  const ten = { name: title, qty: 10, price: "$8.93", total: "$89.30", sku: null };
  it("the real row: title × 10, 'Available on backorder', $89.30 — in every line / tab arrangement — is one product, qty 10, unit price derived", () => {
    for (const rows of [`${title} × 10\nAvailable on backorder\n$89.30`, `${title}\n× 10\nAvailable on backorder\n$89.30`, `${title} × 10\nAvailable on backorder\t$89.30`, `${title}\nAvailable on backorder\n× 10\n$89.30`, `Product\tSubtotal\n${title} × 10\nAvailable on backorder\t$89.30`])
      expect(extractProducts(pg(`Your order\n${rows}\nSubtotal\t$89.30\nTotal\t$89.30`)), rows).toEqual([ten]);
    // every availability wording is noise — never a title, never the end of a block
    for (const avail of ["Available on backorder", "Backordered", "Usually ships in 2-3 days", "Ships in 5 business days", "Low stock", "Only 3 left in stock", "In stock", "Out of stock"])
      expect(extractProducts(pg(`Your order\n${title} × 10\n${avail}\n$89.30\nSubtotal\t$89.30`)), avail).toEqual([ten]);
  });
  it("Totals: the Shipping row lists the methods — the one whose amount reconciles with Total wins (Free when Total = Subtotal), a checked radio decides first, an unresolvable list leaves Shipping empty, one method is its amount", () => {
    const woo = (total: string, order = "Flat rate: $24.77\nFree shipping") => `Subtotal\t$89.30\nShipping\t${order}\nTaxes\t$0.00\nTotal\t${total}`;
    expect(extractBuckets(pg(woo("$89.30"))).totals).toEqual({ subtotal: "$89.30", tax: "$0.00", total: "$89.30", shipping: "Free" });
    expect(extractBuckets(pg(woo("$89.30", "Free shipping\nFlat rate: $24.77"))).totals).toMatchObject({ shipping: "Free" });
    expect(extractBuckets(pg(woo("$114.07"))).totals).toMatchObject({ shipping: "$24.77" });
    expect(extractBuckets(pg(`Subtotal\t$89.30\nShipping\nFlat rate: $24.77\nFree shipping\nTotal\t$89.30`)).totals).toMatchObject({ shipping: "Free" }); // the label on its own line
    // the checked radio names the method, whatever Total says
    expect(extractBuckets(pg(woo("$89.30"), [{ label: "selected: Flat rate: $24.77", value: "checked" }])).totals).toMatchObject({ shipping: "$24.77" });
    expect(extractBuckets(pg(woo("$114.07"), [{ label: "selected: Free shipping", value: "checked" }])).totals).toMatchObject({ shipping: "Free" });
    // nothing decides → no Shipping figure, never the first option's price
    expect(extractBuckets(pg(`Shipping\nFlat rate: $24.77\nFree shipping\nTotal\t$1.00`)).totals).toEqual({ total: "$1.00" });
    expect(extractBuckets(pg(`Subtotal\t$89.30\nShipping\nFlat rate: $24.77\nUPS Ground $9.99\nTotal\t$100.00`)).totals).not.toHaveProperty("shipping");
    // one method listed is the shipping
    expect(extractBuckets(pg(`Subtotal\t$89.30\nShipping\tGround $12.00\nTotal\t$101.30`)).totals).toMatchObject({ shipping: "$12.00" });
    // with a discount in the reconciliation
    expect(extractBuckets(pg(`Discount code SHAGTOOLS10\t−$13.39\nSubtotal\t$133.95\nShipping\tFree shipping\nFlat rate: $24.77\nTaxes\t$0.00\nTotal\t$120.56`)).totals).toMatchObject({ discount: "$13.39", shipping: "Free", total: "$120.56" });
  });
  it("Totals: a plain shipping amount reads exactly as before — on the label's line, 'Free', '& handling', Walmart's two lines, 'Shipping method' heading ignored", () => {
    expect(extractBuckets(pg(`Subtotal\t$89.30\nShipping\t$12.00\nTotal\t$101.30`)).totals).toMatchObject({ shipping: "$12.00" });
    expect(extractBuckets(pg(`Subtotal\t$89.30\nShipping\tFree\nTotal\t$89.30`)).totals).toMatchObject({ shipping: "Free" });
    expect(extractBuckets(pg(`Subtotal\t$89.30\nShipping & handling: $5.00\nTotal\t$94.30`)).totals).toMatchObject({ shipping: "$5.00" });
    expect(extractBuckets(pg(`Subtotal (12 items)\n$95.64\nShipping\n$12.00\nTotal\n$107.64`)).totals).toMatchObject({ subtotal: "$95.64", shipping: "$12.00", total: "$107.64" });
    expect(extractBuckets(pg(`Shipping method\nGround $12.00\nSubtotal\t$89.30\nShipping\t$12.00\nTotal\t$101.30`)).totals).toMatchObject({ shipping: "$12.00" });
    expect(extractBuckets(pg(`Free shipping on orders over $199\nSubtotal\t$89.30\nTotal\t$89.30`)).totals).toEqual({ subtotal: "$89.30", total: "$89.30" });
  });
});

// v1.2.5 (Maria 2026-11-02): shagtools.com/checkout had the address in form fields (street, city, state select, ZIP), not in the text — the Shipping bucket missed it.
describe("buckets: v1.2.5 — the Shipping bucket from form fields", () => {
  const text = "Shag Tools\nCheckout\nContact\nShipping address\nShipping method\nGround $12.00\nSubtotal $133.95";
  it("street / city / state / ZIP fields → the typed address; the street is matched like any other (Velocity); city, state and ZIP ride along; email, billing and phone fields are ignored", () => {
    const fields = [{ label: "Email address", value: "buyer@example.com" }, { label: "First name", value: "Coastal" }, { label: "Street address", value: "805 Grandy Ave" }, { label: "Apartment, suite, etc.", value: "Unit B" }, { label: "City", value: "Norfolk" }, { label: "State", value: "Virginia" }, { label: "ZIP code", value: "23504" }, { label: "Phone", value: "7575550100" }, { label: "billing_address1", value: "1 Other St" }];
    const s = extractShipping({ url: "x", text, fields });
    expect(s).toEqual({ street: "805 Grandy Ave", candidates: ["805 Grandy Ave"], selected: false, fromFields: true, city: "Norfolk", state: "Virginia", zip: "23504" });
    expect(describeShipping(s, config)).toEqual(["Velocity · 805 Grandy Ave (Norfolk, Virginia 23504)"]);
    expect(filled(extractBuckets({ url: "x", text, fields })).shipping).toBe(true);
    expect(shipToForPrefill({ ...newCapture("www.shagtools.com"), buckets: { ...emptyBuckets(), shipping: s } })).toEqual({ street: "805 Grandy Ave", candidates: ["805 Grandy Ave"] });
  });
  it("labels as capture.js gives them (name / id / placeholder): shipping_address_line1, address1, zip, postal_code; a street without a suffix is kept as typed; a line-2 field is never the street; an unknown street says so", () => {
    expect(extractShipping({ url: "x", text, fields: [{ label: "shipping_address_line1", value: "65 Rivercrest" }, { label: "shipping_address_line2", value: "12 Fake Rd" }, { label: "postal_code", value: "23456-1234" }] })).toMatchObject({ street: "65 Rivercrest", zip: "23456-1234", fromFields: true });
    expect(describeShipping(extractShipping({ url: "x", text, fields: [{ label: "address1", value: "65 Rivercrest Dr" }, { label: "zip", value: "23456" }] }), config)).toEqual(["Home · 65 Rivercrest Dr (23456)"]);
    expect(describeShipping(extractShipping({ url: "x", text, fields: [{ label: "Address", value: "12 Elsewhere St" }, { label: "City", value: "Reno" }, { label: "State", value: "NV" }] }), config)).toEqual(["Unknown: 12 Elsewhere St (Reno, NV)"]);
    expect(extractShipping({ url: "x", text, fields: [{ label: "Address", value: "Elsewhere" }, { label: "Email address", value: "805 Grandy Ave" }] })).toBeNull();
  });
  it("a checked address radio still wins over typed fields; the text block is read only when neither exists; the merge keeps the newer", () => {
    const fields = [{ label: "selected: ship", value: "Coastal Quality Goods\n65 Rivercrest Dr, Norfolk, VA 23456" }, { label: "Street address", value: "805 Grandy Ave" }];
    expect(extractShipping({ url: "x", text, fields })).toEqual({ street: "65 Rivercrest Dr", candidates: ["65 Rivercrest Dr"], selected: true });
    expect(extractShipping({ url: "x", text: "Shipping address\n805 Grandy Ave\nNorfolk, VA 23504", fields: [{ label: "City", value: "Norfolk" }] })).toEqual({ street: "805 Grandy Ave", candidates: ["805 Grandy Ave"], selected: false });
    const m = mergeBuckets(extractBuckets({ url: "x", text: "Cart\nSubtotal $1.00" }), extractBuckets({ url: "x", text, fields: [{ label: "Street address", value: "805 Grandy Ave" }] }));
    expect(m.shipping?.street).toBe("805 Grandy Ave");
  });
});

describe("buckets: captures are per tab", () => {
  const now = (n: number) => `2026-11-01T20:00:0${n}.000Z`;
  it("two tabs keep separate records under capture:<tabId>; the panel's 'Also capturing' lists the other tabs; the prefill pages are the tab's own", () => {
    const store: Record<string, any> = {};
    const put = (tabId: number, page: any, host: string, n: number) => { const k = captureKey(tabId); store[k] = applyPage(store[k] ?? null, page, host, now(n)); };
    put(11, walmartCart, "www.walmart.com", 1);
    put(22, fixture("michaels-review", { step: "review", url: "https://www.michaels.com/checkout/review" }), "www.michaels.com", 2);
    put(22, fixture("michaels-address-picker", { step: "shipping", url: "https://www.michaels.com/checkout/shipping" }), "www.michaels.com", 3);
    put(11, { step: "review", url: "https://www.walmart.com/checkout/review", title: "Review", text: "Shipping address\n805 Grandy Ave\nItems subtotal $176.40" }, "www.walmart.com", 4);
    expect(Object.keys(store).sort()).toEqual(["capture:11", "capture:22"]);
    expect(store["capture:11"].count).toBe(2);
    expect(store["capture:11"].buckets.products.map((p: any) => p.name)).toEqual(walmartCart.text.match(/Great Value Creamy[^\n]*|Hefty[^\n]*|Scotch-Brite[^\n]*/g));
    expect(store["capture:11"].buckets.shipping.street).toBe("805 Grandy Ave");
    expect(store["capture:22"].count).toBe(2);
    expect(store["capture:22"].buckets.products.map((p: any) => p.name)).toEqual(["Liquitex BASICS Acrylic Paint, 4oz., Blue Gray", "Red Heart Super Saver Yarn, Light Blue"]);
    expect(store["capture:22"].buckets.shipping.street).toBe("805 Grandy Ave"); // the picker page's heading block (nothing checked) is the newer value
    expect(othersCapturing(store, 11)).toEqual([{ tabId: 22, host: "michaels.com", count: 2 }]);
    expect(othersCapturing(store, 22)).toEqual([{ tabId: 11, host: "walmart.com", count: 2 }]);
    expect(othersCapturing(store, 33)).toHaveLength(2);
    expect(pagesForPrefill(store["capture:11"]).map((p) => p.step)).toEqual(["cart", "review"]);
    expect(shipToForPrefill(store["capture:11"])).toEqual({ street: "805 Grandy Ave", candidates: ["805 Grandy Ave"] });
    expect(shipToForPrefill(null)).toBeNull();
  });
  it("re-capturing a step replaces that page for the prefill AND its values in the buckets (v1.2.7: rebuilt from the pages — the earlier capture's products are gone with its page)", () => {
    let c = applyPage(null, walmartCart, "www.walmart.com", now(1));
    c = applyPage(c, { ...walmartCart, text: "Cart (1 item)\nScotch-Brite Heavy Duty Scrub Sponges, 9 Count\n$5.97\n5\n$29.85\nSubtotal (5 items) $29.85", fields: [] }, "www.walmart.com", now(2));
    expect(c.count).toBe(1);
    expect(pagesForPrefill(c)).toHaveLength(1);
    expect(c.buckets.products.map((p: any) => [p.name.split(" ")[0], p.qty])).toEqual([["Scotch-Brite", 5]]);
    expect(c.buckets.totals.subtotal).toBe("$29.85");
  });
  it("a record stored before 1.2 (no buckets) is rebuilt from its pages on the next capture", () => {
    const old = { host: "www.walmart.com", pages: { cart: { ...walmartCart, capturedAt: now(1) } }, others: [], count: 1, updatedAt: now(1) } as any;
    const c = applyPage(old, { url: "https://www.walmart.com/checkout/payment", step: "payment", text: "Payment\nVisa ending in 4242" }, "www.walmart.com", now(2));
    expect(c.buckets.products).toHaveLength(3);
    expect(c.buckets.payment.cards[0].last4).toBe("4242");
  });
  it("background.js stores through these functions (one record per tab id)", () => {
    const bg = readFileSync(resolve(__dirname, "../chrome-extension/background.js"), "utf8");
    expect(bg).toMatch(/importScripts\("buckets\.js"\)/);
    expect(bg).toMatch(/AfBuckets\.applyPage\(/);
    expect(bg).toMatch(/AfBuckets\.captureKey\(tab\.id\)/);
    expect(bg).toMatch(/AfBuckets\.othersCapturing\(/);
    expect(bg).toMatch(/AfBuckets\.pagesForPrefill\(/);
  });
});
