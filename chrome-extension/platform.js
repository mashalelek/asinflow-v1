// Capture PO v1.4 (Maria 2026-11-05; SPEC §11): the structured reader's page half. Runs in the page's own world
// (executeScript world MAIN — window.Shopify / BCData are page globals), read-only, and returns ONLY the picked
// fields below — titles, SKUs, quantities, prices, discounts / codes, shipping, tax, totals, order #, email. No
// payment object is read. The service worker maps them to the panel's buckets (platform-map.js) and scrubs every
// string (scrub.js) before anything is stored. Same-origin GETs only: Shopify's /cart.js, BigCommerce's
// /api/storefront/{carts,checkouts,orders} — what the store's own page reads. Never throws; 3 s per request.
(async function () {
  function pick(o, keys) { var out = {}; if (!o || typeof o !== "object") return null; keys.forEach(function (k) { if (o[k] !== undefined) out[k] = o[k]; }); return out; }
  async function getJson(url) {
    try {
      var ctl = new AbortController(); var t = setTimeout(function () { ctl.abort(); }, 3000);
      var r = await fetch(url, { credentials: "same-origin", headers: { Accept: "application/json" }, signal: ctl.signal });
      clearTimeout(t);
      return r.ok ? await r.json() : null;
    } catch (e) { return null; }
  }
  var LINE_SHOPIFY = ["title", "product_title", "variant_title", "sku", "quantity", "price", "line_price", "final_price", "final_line_price", "original_line_price"];
  var out = { platform: null, jsonld: [], shopifyCheckout: null, shopifyCart: null, bcCart: null, bcCheckout: null, bcOrder: null };
  try {
    // schema.org Order / Offer JSON-LD (any platform)
    document.querySelectorAll('script[type="application/ld+json"]').forEach(function (s) {
      try {
        var j = JSON.parse(s.textContent || "null");
        (Array.isArray(j) ? j : j && j["@graph"] ? j["@graph"] : [j]).forEach(function (n) {
          if (n && /Order\b|Invoice/.test(String(n["@type"] || ""))) out.jsonld.push(JSON.parse(JSON.stringify(n, function (k, v) { return /payment|card|billing/i.test(k) ? undefined : v; })));
        });
      } catch (e) { /* malformed JSON-LD */ }
    });
    var w = window;
    var shopify = !!(w.Shopify && (w.Shopify.shop || w.Shopify.checkout || w.Shopify.routes)) || !!document.querySelector('meta[name="shopify-checkout-api-token"], meta[name="shopify-digital-wallet"], script[src*="cdn.shopify.com"], link[href*="cdn.shopify.com"]');
    var bigcommerce = !!(w.BCData || w.stencilBootstrap) || !!document.querySelector('script[src*="bigcommerce.com"], link[href*="bigcommerce.com"]');
    if (shopify) {
      out.platform = "Shopify";
      var c = w.Shopify && w.Shopify.checkout;
      if (c && typeof c === "object") {
        out.shopifyCheckout = pick(c, ["order_id", "order_number", "email", "subtotal_price", "total_price", "total_tax", "currency"]);
        out.shopifyCheckout.line_items = (c.line_items || []).map(function (l) { return pick(l, LINE_SHOPIFY); });
        out.shopifyCheckout.shipping_rate = pick(c.shipping_rate, ["title", "price"]);
        out.shopifyCheckout.discount = pick(c.discount, ["code", "amount"]);
      }
      var cart = await getJson("/cart.js");
      if (cart && Array.isArray(cart.items)) {
        out.shopifyCart = pick(cart, ["item_count", "items_subtotal_price", "total_price", "total_discount", "currency"]);
        out.shopifyCart.items = cart.items.map(function (l) { return pick(l, LINE_SHOPIFY); });
        out.shopifyCart.discounts = (cart.cart_level_discount_applications || []).map(function (d) { return pick(d, ["title", "total_allocated_amount"]); });
      }
    } else if (bigcommerce) {
      out.platform = "BigCommerce";
      var BC_LINE = ["name", "sku", "quantity", "listPrice", "salePrice", "extendedListPrice", "extendedSalePrice"];
      var bcLines = function (li) { return li ? [].concat(li.physicalItems || [], li.digitalItems || []).map(function (l) { return pick(l, BC_LINE); }) : []; };
      var m = /\/order-confirmation\/(\d+)/.exec(location.pathname);
      if (m) {
        var o = await getJson("/api/storefront/orders/" + m[1] + "?include=lineItems.physicalItems.options,lineItems.digitalItems.options");
        if (o) { out.bcOrder = pick(o, ["orderId", "baseAmount", "discountAmount", "taxTotal", "shippingCostTotal", "orderAmount", "currency"]); out.bcOrder.lines = bcLines(o.lineItems); out.bcOrder.coupons = (o.coupons || []).map(function (x) { return pick(x, ["code", "discountedAmount"]); }); out.bcOrder.email = o.billingAddress && o.billingAddress.email || null; }
      } else {
        var carts = await getJson("/api/storefront/carts?include=lineItems.physicalItems.options,lineItems.digitalItems.options");
        var bc = Array.isArray(carts) ? carts[0] : null;
        if (bc) {
          out.bcCart = pick(bc, ["id", "baseAmount", "discountAmount", "cartAmount", "email"]); out.bcCart.lines = bcLines(bc.lineItems);
          out.bcCart.coupons = (bc.coupons || []).map(function (x) { return pick(x, ["code", "discountedAmount"]); });
          if (/checkout/i.test(location.pathname)) {
            var co = await getJson("/api/storefront/checkouts/" + encodeURIComponent(bc.id));
            if (co) out.bcCheckout = pick(co, ["subtotal", "taxTotal", "shippingCostTotal", "grandTotal", "handlingCostTotal"]);
          }
        }
      }
    } else if (out.jsonld.length) out.platform = "schema.org";
  } catch (e) { /* the structured reader never breaks a capture */ }
  return out;
})();
