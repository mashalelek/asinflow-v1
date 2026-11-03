import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { extractBuckets, mergeBuckets, emptyBuckets, filled, missing, canOpen, applyPage, captureKey, pagesForPrefill, shipToForPrefill, othersCapturing, describeShipping, extractShipping, extractProducts, extractPromos, debugText, dedupePromos } from "../chrome-extension/buckets.js";
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
    expect(canOpen(b)).toBe(true);
  });
  it("the cart stepper's value is a form field, not page text: qty fields fill the blocks that show a quantity control, in order", () => {
    const page = { ...walmartCart, text: walmartCart.text.replace(/\n12\n/, "\nQuantity\n").replace(/\n6\n/, "\nQuantity\n").replace(/\n4\n/, "\nQuantity\n") };
    expect(extractProducts(page).map((p) => p.qty)).toEqual([12, 6, 4]);
    // No quantity value anywhere → not product lines (v1.2.1: title + price + quantity, or nothing).
    expect(extractProducts({ ...page, fields: [] })).toEqual([]);
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
    expect(b.products.map((p) => p.name)).toEqual(["Great Value Creamy Peanut Butter, 40 oz"]);
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
    expect(canOpen(c.buckets)).toBe(true);
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
    expect(m.products[0].total).toBe("$95.64"); // the review line shows no line total → the cart's stays
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

// v1.2.2 / v1.2.3 (Maria 2026-11-02): a shagtools.com cart — table-style rows (one <tr> per product; innerText joins the cells with tabs) left Products empty, and one coupon counted as four promos. v1.2.3: still empty on the real cart (name / $8.93 / stepper (15) / $133.95 in separate cells) and on the checkout (title, "× 15" as plain text under it, line subtotal $133.95 — no unit price, no quantity input). The fixtures are SYNTHETIC, shaped from Maria's description, until the real "Copy page text" paste replaces them.
describe("buckets: v1.2.3 — product rows with a plain-text quantity or no quantity text at all (shagtools cart + checkout)", () => {
  const cart = { step: "cart", url: "https://www.shagtools.com/cart", title: "cart", text: scrubText(readFileSync(resolve(FIX, "shagtools/cart.txt"), "utf8")), fields: [{ label: "quantity", value: "15" }] };
  const checkout = { step: "review", url: "https://www.shagtools.com/checkout", title: "Checkout", text: scrubText(readFileSync(resolve(FIX, "shagtools/checkout.txt"), "utf8")), fields: [] };
  const kicker = { name: "Shag Carpet Kicker Pro 12 Inch Adjustable Head", qty: 15, price: "$8.93", total: "$133.95", sku: null };
  const pg = (text: string) => ({ step: "other", url: "https://www.shagtools.com/x", title: "x", text, fields: [] as { label: string; value: string }[] });
  const rowOf = (cells: string) => `Product\tPrice\tQuantity\tTotal\n${cells}\nSubtotal\t$133.95\n`;
  it("(b) cart: a table row whose cells are title / unit price / stepper / line total is a product; the quantity comes from the quantity field, and without one from the total ÷ price; the header row and the 'You may also like' row are not products", () => {
    const b = extractBuckets(cart);
    expect(b.products).toEqual([kicker]);
    expect(extractProducts({ ...cart, fields: [] })).toEqual([kicker]);
    expect(b.totals).toMatchObject({ subtotal: "$133.95", shipping: "$12.00", tax: "$0.00", total: "$132.56" });
    expect(b.promos).toEqual(["COUPON: SHAGTOOLS10 (10% off)  −$13.39"]);
    expect(canOpen(b)).toBe(true);
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
  it("(a) checkout: title, '× 15' on the line under it, the line total — qty 15, unit price derived as total ÷ 15; the address, shipping method and card lines around it are not products", () => {
    const b = extractBuckets(checkout);
    expect(b.products).toEqual([kicker]);
    expect(b.shipping).toMatchObject({ street: "805 Grandy Ave" });
    expect(b.payment.cards[0]).toMatchObject({ last4: "4242" });
    expect(b.totals).toMatchObject({ subtotal: "$133.95", shipping: "$12.00", total: "$132.56" });
  });
  it("(a) the mark in every spelling and position: 'x 15', '15 ×', '(x15)', on the title line, on the total's line, in one tab-joined row; two monies keep the printed unit price", () => {
    const title = "Shag Carpet Kicker Pro 12 Inch Adjustable Head";
    const block = (lines: string) => `Order summary\n${lines}\nSubtotal\t$133.95\n`;
    for (const lines of [`${title}\n× 15\n$133.95`, `${title}\nx 15\n$133.95`, `${title}\n15 ×\n$133.95`, `${title}\n(x15)\n$133.95`, `${title} × 15\n$133.95`, `15 × ${title}\n$133.95`, `${title}\n× 15  $133.95`, `${title}  × 15  $133.95`, `${title}\t× 15\t$133.95`, `${title}\n× 15\n$8.93\n$133.95`, `${title}\n× 15\n$133.95\n$8.93`])
      expect(extractProducts(pg(block(lines))), lines).toEqual([kicker]);
    // a mark with a unit price adjacent is the old "12 × $7.97" form: the money is the unit price, not a total
    expect(extractProducts(pg(block(`${title}\n15 × $8.93`)))).toEqual([{ ...kicker, total: null }]);
    // "Qty: 15" with one money keeps that money as the unit price (the Walmart review line is that shape; the merge turns a confirmation's line total into the total)
    expect(extractProducts(pg(block(`${title}\nQty: 15\n$133.95`)))).toEqual([{ ...kicker, price: "$133.95", total: null }]);
  });
  it("cart then checkout merge to one product with the cart's unit price and the line total; the promo is one entry", () => {
    const m = mergeBuckets(extractBuckets(cart), extractBuckets(checkout));
    expect(m.products).toEqual([kicker]);
    expect(m.promos).toEqual(["COUPON: SHAGTOOLS10 (10% off)  −$13.39"]);
    expect(m.shipping).toMatchObject({ street: "805 Grandy Ave" });
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
    expect(L[0]).toBe("AsinFlow capture · www.shagtools.com · 2 pages · 15 tab-joined lines · copied 2026-11-02T22:05:00.000Z · card numbers were masked in the page");
    expect(L[2]).toBe("=== page 1 · step cart · https://www.shagtools.com/cart · cart · captured 2026-11-02T22:00:01.000Z · " + cart.text.length + " chars ===");
    expect(d).toContain("\n" + cart.text + "\n--- fields (1) ---\n" + JSON.stringify({ label: "quantity", value: "15" }) + "\n");
    expect(d).toContain("=== page 2 · step review · https://www.shagtools.com/checkout · Checkout · captured 2026-11-02T22:00:02.000Z");
    expect(d).toContain("\n" + checkout.text + "\n--- fields (0) ---");
    expect(debugText({ host: "x.com", pages: {}, others: [], count: 0 }, "t")).toBe("AsinFlow capture · x.com · 0 pages · 0 tab-joined lines · copied t · card numbers were masked in the page");
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
  it("re-capturing a step replaces that page for the prefill, but the buckets keep what the earlier capture found", () => {
    let c = applyPage(null, walmartCart, "www.walmart.com", now(1));
    c = applyPage(c, { ...walmartCart, text: "Cart (1 item)\nScotch-Brite Heavy Duty Scrub Sponges, 9 Count\n$5.97\n5\n$29.85\nSubtotal (5 items) $29.85", fields: [] }, "www.walmart.com", now(2));
    expect(c.count).toBe(1);
    expect(pagesForPrefill(c)).toHaveLength(1);
    expect(c.buckets.products.map((p: any) => [p.name.split(" ")[0], p.qty])).toEqual([["Great", 12], ["Hefty", 6], ["Scotch-Brite", 5]]);
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
