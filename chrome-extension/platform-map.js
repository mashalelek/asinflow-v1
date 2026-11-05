// Capture PO v1.4 (Maria 2026-11-05; SPEC §11): the structured reader's mapping half — what platform.js collected
// in the page (schema.org Order JSON-LD, Shopify's checkout object and /cart.js, BigCommerce's storefront cart /
// checkout / order) → the panel's bucket shape (buckets.js emptyBuckets): products {name, qty, price, total, sku},
// totals {subtotal, discount, tax, shipping, total}, promos, order {number, email}. Pure. The first source that
// has lines gives the products (an order / checkout before a cart); totals merge, the order / checkout's figures
// winning. Shopify's cart money is in cents, its checkout's and BigCommerce's in dollars. Plain script: defines
// globalThis.AfPlatform for the service worker (importScripts) and exports it for vitest.
(function (root) {
  function num(v) { if (v == null || v === "") return null; var n = typeof v === "number" ? v : Number(String(v).replace(/[^\d.-]/g, "")); return Number.isFinite(n) ? n : null; }
  function usd(n) { return n == null ? null : (n < 0 ? "-" : "") + "$" + Math.abs(n).toFixed(2); }
  function cents(v) { var n = num(v); return n == null ? null : n / 100; }
  function str(v) { return v == null ? null : String(v).trim() || null; }
  function line(name, qty, unit, total, sku) {
    var q = num(qty), u = unit, t = total;
    if (u == null && t != null && q) u = Math.round((t / q) * 100) / 100;
    if (t == null && u != null && q != null) t = Math.round(u * q * 100) / 100;
    return name ? { name: name, qty: q, price: usd(u), total: usd(t), sku: str(sku) } : null;
  }
  function compact(a) { return a.filter(Boolean); }
  function setTotals(t, k, v) { if (v != null && t[k] == null) t[k] = usd(Math.abs(v)); }

  function fromShopifyCheckout(c) {
    if (!c) return null;
    var products = compact((c.line_items || []).map(function (l) { return line([l.product_title || l.title, l.variant_title && l.variant_title !== "Default Title" ? l.variant_title : null].filter(Boolean).join(" — ") || l.title, l.quantity, num(l.price), num(l.line_price), l.sku); }));
    var totals = {}; setTotals(totals, "subtotal", num(c.subtotal_price)); setTotals(totals, "tax", num(c.total_tax)); setTotals(totals, "shipping", c.shipping_rate ? num(c.shipping_rate.price) : null); setTotals(totals, "discount", c.discount ? num(c.discount.amount) : null); setTotals(totals, "total", num(c.total_price));
    return { products: products, totals: totals, promos: c.discount && c.discount.code ? [c.discount.code + (num(c.discount.amount) ? " −" + usd(num(c.discount.amount)) : "")] : [], order: compactObj({ number: str(c.order_number || c.order_id), email: str(c.email) }) };
  }
  function fromShopifyCart(c) {
    if (!c || !(c.items || []).length) return null;
    var products = compact(c.items.map(function (l) { return line([l.product_title || l.title, l.variant_title && l.variant_title !== "Default Title" ? l.variant_title : null].filter(Boolean).join(" — ") || l.title, l.quantity, cents(l.final_price != null ? l.final_price : l.price), cents(l.final_line_price != null ? l.final_line_price : l.line_price), l.sku); }));
    var totals = {}; setTotals(totals, "subtotal", cents(c.items_subtotal_price)); setTotals(totals, "discount", num(c.total_discount) ? cents(c.total_discount) : null);
    return { products: products, totals: totals, promos: (c.discounts || []).map(function (d) { return d.title + (cents(d.total_allocated_amount) ? " −" + usd(cents(d.total_allocated_amount)) : ""); }).filter(Boolean), order: {} };
  }
  function bcLines(lines) { return compact((lines || []).map(function (l) { return line(l.name, l.quantity, num(l.salePrice != null ? l.salePrice : l.listPrice), num(l.extendedSalePrice != null ? l.extendedSalePrice : l.extendedListPrice), l.sku); })); }
  function bcPromos(coupons) { return (coupons || []).filter(function (x) { return x && x.code; }).map(function (x) { return x.code + (num(x.discountedAmount) ? " −" + usd(num(x.discountedAmount)) : ""); }); }
  function fromBigCommerce(cart, checkout, order) {
    if (order) {
      var t = {}; setTotals(t, "subtotal", num(order.baseAmount)); setTotals(t, "discount", num(order.discountAmount) || null); setTotals(t, "tax", num(order.taxTotal)); setTotals(t, "shipping", num(order.shippingCostTotal)); setTotals(t, "total", num(order.orderAmount));
      return { products: bcLines(order.lines), totals: t, promos: bcPromos(order.coupons), order: compactObj({ number: str(order.orderId), email: str(order.email) }) };
    }
    if (!cart) return null;
    var tc = {}; setTotals(tc, "subtotal", num(checkout && checkout.subtotal != null ? checkout.subtotal : cart.baseAmount)); setTotals(tc, "discount", num(cart.discountAmount) || null);
    if (checkout) { setTotals(tc, "tax", num(checkout.taxTotal)); setTotals(tc, "shipping", num(checkout.shippingCostTotal)); setTotals(tc, "total", num(checkout.grandTotal)); }
    return { products: bcLines(cart.lines), totals: tc, promos: bcPromos(cart.coupons), order: compactObj({ email: str(cart.email) }) };
  }
  function offerName(o) { var it = o && (o.itemOffered || o.orderedItem || o); return it && (it.name || it.description) ? String(it.name || it.description) : null; }
  function fromJsonLd(nodes) {
    var n = (nodes || []).find(function (x) { return x && (x.orderedItem || x.acceptedOffer); }) || (nodes || [])[0];
    if (!n) return null;
    var items = [].concat(n.orderedItem || [], n.acceptedOffer || []);
    var products = compact(items.map(function (o) {
      var it = o.orderedItem || o.itemOffered || {};
      var q = o.orderQuantity != null ? (typeof o.orderQuantity === "object" ? o.orderQuantity.value : o.orderQuantity) : o.eligibleQuantity ? o.eligibleQuantity.value : null;
      var price = num(o.price != null ? o.price : o.priceSpecification && o.priceSpecification.price);
      return line(offerName(o), q, price, null, it.sku || o.sku);
    }));
    var t = {}; var total = num(n.price != null ? n.price : n.totalPaymentDue && (n.totalPaymentDue.value != null ? n.totalPaymentDue.value : n.totalPaymentDue.price));
    setTotals(t, "total", total); setTotals(t, "discount", num(n.discount) || null);
    return { products: products, totals: t, promos: n.discountCode ? [String(n.discountCode)] : [], order: compactObj({ number: str(n.orderNumber), email: str(n.customer && n.customer.email) }) };
  }
  function compactObj(o) { var out = {}; Object.keys(o).forEach(function (k) { if (o[k] != null) out[k] = o[k]; }); return out; }

  /** platform.js's result → { platform, source, buckets } or null when nothing structured was found. Pure. */
  function toBuckets(raw) {
    if (!raw) return null;
    var cands = [
      ["Shopify order data", fromShopifyCheckout(raw.shopifyCheckout)],
      ["BigCommerce order data", raw.bcOrder ? fromBigCommerce(null, null, raw.bcOrder) : null],
      ["BigCommerce cart data", raw.bcCart ? fromBigCommerce(raw.bcCart, raw.bcCheckout, null) : null],
      ["schema.org order data", fromJsonLd(raw.jsonld)],
      ["Shopify cart data", fromShopifyCart(raw.shopifyCart)],
    ].filter(function (c) { return c[1]; });
    if (!cands.length) return null;
    var withLines = cands.find(function (c) { return c[1].products.length; });
    var b = { products: withLines ? withLines[1].products : [], shipping: null, payment: { cards: [], giftCards: [] }, totals: {}, promos: [], order: {} };
    var used = [];
    cands.forEach(function (c) {
      var x = c[1], took = false;
      Object.keys(x.totals).forEach(function (k) { if (b.totals[k] == null) { b.totals[k] = x.totals[k]; took = true; } });
      if (!b.promos.length && x.promos.length) { b.promos = x.promos; took = true; }
      Object.keys(x.order).forEach(function (k) { if (b.order[k] == null) { b.order[k] = x.order[k]; took = true; } });
      if (took || c === withLines) used.push(c[0]);
    });
    var filled = { products: b.products.length > 0, totals: !!(b.totals.subtotal || b.totals.total) };
    if (!filled.products && !filled.totals && !b.order.number) return null;
    return { platform: raw.platform || null, source: used.join(" + "), buckets: b, filled: filled };
  }

  var api = { toBuckets: toBuckets, fromShopifyCheckout: fromShopifyCheckout, fromShopifyCart: fromShopifyCart, fromBigCommerce: fromBigCommerce, fromJsonLd: fromJsonLd };
  root.AfPlatform = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
