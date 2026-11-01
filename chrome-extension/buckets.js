// Capture PO — data buckets (AsinFlow Chrome extension v1.2, SPEC §11
// "Chrome extension — Capture PO"). Pure, regex-level, no AI: every captured
// page is read into six buckets — Products, Shipping, Payment, Totals,
// Promos, Order — and merged into the tab's capture so Maria can see what
// the captures found before the one AI call runs server side. Merge rule:
// newest value wins PER FIELD; a page that lacks a value never clears it;
// a product / card / promo once seen is never dropped. Anything the regexes
// cannot read with confidence is simply not shown (the AI reads the whole
// text). Plain script (no bundler): defines globalThis.AfBuckets for the
// service worker (importScripts) and the side panel, and exports the same
// object for the vitest fixtures (server/extension-buckets.test.ts).
(function (root) {
  "use strict";

  var BUCKETS = ["products", "shipping", "payment", "totals", "promos", "order"];
  var LABELS = { products: "Products", shipping: "Shipping", payment: "Payment", totals: "Totals", promos: "Promos", order: "Order" };

  var MONEY_SRC = "-?\\$\\s?\\d[\\d,]*\\.\\d{2}";
  var MONEY = new RegExp(MONEY_SRC);
  var MONEY_G = new RegExp(MONEY_SRC, "g");
  // "Qty 12", "Quantity: 12" — never "Multipack Quantity: 1" (a pack count, not the order's quantity).
  var QTY = /(?<!multipack\s)(?<!pack\s)\b(?:qty|quantity)\s*:?\s*(\d{1,4})\b/i;
  var MULT = /(?:^|\s)(\d{1,4})\s*[×x]\s*(\$\s?\d[\d,]*\.\d{2})|(\$\s?\d[\d,]*\.\d{2})\s*[×x]\s*(\d{1,4})\b/i;
  var PACK_LABEL = /\b(?:multipack|pack\s+(?:quantity|count|size)|case\s+(?:quantity|count|size))\b/i;
  var SKU = /\b(?:item\s*(?:#|no\.?|number)|sku|upc|model\s*(?:#|no\.?)|product\s*(?:code|id))\s*:?\s*#?\s*([A-Za-z0-9][A-Za-z0-9-]{3,23})\b/i;
  var STREET = /\b(\d{1,6}[A-Za-z]?)\s+((?:[A-Za-z][A-Za-z0-9.'-]*\s+){0,4}?)(st|street|ave|avenue|rd|road|dr|drive|ln|lane|blvd|boulevard|ct|court|way|pl|place|cir|circle|pkwy|parkway|hwy|highway|ter|terrace|trl|trail|loop|run)\b\.?/i;
  var SHIP_HEADING = /^(?:shipping|delivery|ship(?:ping)?\s+to|deliver(?:s|y|ing)?\s+to|delivery\s+address|shipping\s+address|deliver\s+to|ships?\s+to)\b/i;
  var BILLING = /\b(?:billing|payment|card)\b/i;
  var TOTALS_START = /\b(?:sub\s*total|order\s+total|estimated\s+total|grand\s+total)\b/i;
  var TOTAL_LINE = /^(?:items?\s+)?(?:sub\s*total|order\s+total|estimated\s+total|grand\s+total|total|tax(?:es)?|estimated\s+tax|sales\s+tax|shipping|estimated\s+shipping|discount|savings|promotion)\b/i;
  var NOISE = /^(?:cart|your\s+cart|basket|bag|items?\b|review|checkout|order\b|subtotal|total|tax|shipping|delivery|deliver|arrives|free\s+shipping|payment|pay\b|place\s+order|continue|edit|remove|save\s+for\s+later|move\s+to|change|add\b|apply|promo|coupon|gift|rewards|contact|email|phone|account|sign|secure|qty|quantity|price|each|sold\s+by|ship|pickup|in\s+stock|out\s+of\s+stock|select|choose|see\b|view|learn|earn|get\b|you\b|your\b|we\b|thank|hello|hi\b|name|address|city|state|zip|united\s+states|usa\b|visa|mastercard|amex|discover|card\b|ending\s+in|••••|\*\*\*\*|exp\b|cvv|billing|summary|details|estimated|protect|warranty|plan\b|add-on|recommended|also\b|customers|people|frequently|sponsored|more\b|multipack|subscri|one-?time|\d)/i;
  var PROMO = /\b(?:promo(?:tion)?(?:\s*code)?|coupon|discount\s+code|code\s+applied|%\s*off|rewards?\s+applied|rewards?:|applied:?\s*-?\$)/i;
  var CARDISH = /••••|\*{4}|\bending\s+(?:in|with)\b|\b(?:visa|mastercard|amex|american\s+express|discover|paypal|affirm|klarna|afterpay)\b/i;
  var CARD_LAST4 = /^(.*?)\s*(?:•••• ?|\*{4} ?|x{4} ?|ending\s+(?:in|with)\s+|ending\s+)(\d{4})\b/i;
  var GIFT = /\b(?:e-?gift|gift\s*card|gift\s*certificate|egc|store\s+credit)\b/i;
  var SUBSCRIBE = /\b(?:subscri(?:be|ption)|auto-?ship|autoship|repeat\s+delivery|deliver\s+every)\b/i;
  var ONE_TIME = /\bone-?\s?time\b/i;
  var EVERY = /\bevery\s+(\d+)\s+(week|month)s?\b|\b(monthly|weekly|bi-?weekly|every\s+(?:week|month))\b/i;
  var ORDER_NO = /\border\s*(?:#|number|no\.?|id|confirmation(?:\s*(?:#|number))?)\s*:?\s*#?\s*([A-Z0-9][A-Z0-9-]{4,})/i;
  var ORDER_DATE = /\b(?:order(?:ed)?\s*(?:date|placed|on)?|placed\s*(?:on)?|date)\s*:?\s*((?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{2,4}|\d{4}-\d{2}-\d{2})/i;

  function lines(text) {
    return String(text == null ? "" : text).split(/\r?\n/).map(function (s) { return s.replace(/\t|[ ]{3,}/g, "  ").trim(); }).filter(Boolean);
  }
  function normName(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
  /** "805 Grandy Ave, Norfolk" → "805 grandy" (the same key the tracking router uses). */
  function normStreet(s) { var m = /\b(\d{1,6})\s+([A-Za-z][A-Za-z'-]*)/.exec(String(s || "")); return m ? m[1] + " " + m[2].toLowerCase() : null; }
  function money(s) { var m = MONEY.exec(String(s || "")); return m ? m[0].replace(/\s/g, "") : null; }
  function toNum(s) { return s == null ? null : Number(String(s).replace(/[^\d.-]/g, "")); }
  function uniq(arr, key) { var out = [], seen = {}; arr.forEach(function (x) { var k = key ? key(x) : x; if (k == null || seen[k]) return; seen[k] = true; out.push(x); }); return out; }
  function fieldsOf(page) { return Array.isArray(page && page.fields) ? page.fields : []; }
  function selectedFields(page) { return fieldsOf(page).filter(function (f) { return /^selected:/i.test(String(f.label || "")); }); }

  function emptyBuckets() { return { products: [], shipping: null, payment: { cards: [], giftCards: [] }, totals: {}, promos: [], order: {} }; }

  /** The street in a text block: "805 Grandy Ave" (street number + name + suffix), or null. */
  function streetIn(text) {
    var m = STREET.exec(String(text || ""));
    if (!m) return null;
    return (m[1] + " " + m[2] + m[3]).replace(/\s+/g, " ").trim();
  }

  // ── Shipping: the SELECTED address, never just the first address block ──
  function extractShipping(page) {
    var sel = [];
    selectedFields(page).forEach(function (f) {
      var blob = String(f.label || "") + "\n" + String(f.value || "");
      if (/\bbilling\b/i.test(blob)) return;
      var st = streetIn(f.value) || streetIn(f.label);
      if (st) sel.push(st);
    });
    sel = uniq(sel, normStreet);
    if (sel.length) return { street: sel.length === 1 ? sel[0] : null, candidates: sel, selected: true };
    var L = lines(page.text), cands = [];
    for (var i = 0; i < L.length; i++) {
      var l = L[i];
      if (!SHIP_HEADING.test(l) || /\bbilling\b/i.test(l)) continue;
      var st = streetIn(l.replace(SHIP_HEADING, ""));
      for (var j = i + 1; !st && j <= i + 4 && j < L.length; j++) { if (BILLING.test(L[j]) || TOTAL_LINE.test(L[j])) break; st = streetIn(L[j]); }
      if (st) cands.push(st);
    }
    cands = uniq(cands, normStreet);
    if (!cands.length) return null;
    return { street: cands.length === 1 ? cands[0] : null, candidates: cands, selected: false };
  }

  // ── Products: one line per product actually parsed (never a count of "Qty" strings) ──
  function nameLike(l) {
    if (l.length < 6 || l.length > 160) return false;
    if (!/[A-Za-z]{3}/.test(l)) return false;
    if (MONEY.test(l) || /^\d+$/.test(l)) return false;
    if (QTY.test(l) || NOISE.test(l) || TOTAL_LINE.test(l) || PROMO.test(l)) return false;
    if (STREET.test(l) || CARDISH.test(l)) return false;
    return true;
  }
  function singleLineItem(l) {
    // "Name   Item #LC1234   Qty 1   $199.00" / "Name   Qty: 6   $5.99" / "Name × 6 $5.99" / "Name 12 × $7.97"
    if (!MONEY.test(l)) return null;
    var q = QTY.exec(l), mu = MULT.exec(l);
    if (!q && !mu) return null;
    var cut = l.length;
    [QTY, SKU, MULT, MONEY].forEach(function (re) { var m = re.exec(l); if (m && m.index < cut) cut = m.index; });
    var name = l.slice(0, cut).replace(/[\s|,:·•-]+$/, "").trim();
    if (!nameLike(name)) return null;
    var p = { name: name, qty: q ? Number(q[1]) : Number(mu[1] || mu[4]), price: null, total: null, sku: null };
    var sk = SKU.exec(l); if (sk) p.sku = sk[1];
    var monies = l.match(MONEY_G).map(function (m) { return m.replace(/\s/g, ""); });
    if (mu) { p.price = (mu[2] || mu[3]).replace(/\s/g, ""); }
    else p.price = monies[0];
    if (monies.length > 1 && p.qty != null) { var t = monies.filter(function (m) { return Math.abs(toNum(m) - toNum(p.price) * p.qty) < 0.011; })[0]; if (t && t !== p.price) p.total = t; }
    return p;
  }
  function extractProducts(page) {
    var L = lines(page.text);
    var stop = L.findIndex(function (l) { return TOTALS_START.test(l); });
    var region = stop > 0 ? L.slice(0, stop) : L;
    var out = parseRegion(region);
    if (!out.length && stop > 0) out = parseRegion(L);
    // The cart stepper's value is a form field, not page text: align the page's qty fields with the lines in order when the counts match.
    var qtyFields = fieldsOf(page).filter(function (f) { return /^(?:qty|quantity)\b/i.test(String(f.label || "")) && /^\d{1,4}$/.test(String(f.value || "").trim()); }).map(function (f) { return Number(f.value); });
    // A name + price with no quantity anywhere on the page is not a product line (recommendation strips show prices, never quantities).
    if (!qtyFields.length && !out.some(function (p) { return p.qty != null; })) return [];
    if (qtyFields.length && qtyFields.length === out.length) out.forEach(function (p, i) { if (p.qty == null) p.qty = qtyFields[i]; });
    // Price and line total from the block's money lines, once the qty is known: unit price first, a later money equal to price × qty is the line total (or the other way round).
    out.forEach(function (p) {
      var monies = p.monies || []; delete p.monies;
      if (p.price != null || !monies.length) return;
      p.price = monies[0];
      if (p.qty != null && monies.length > 1) {
        var t = monies.slice(1).filter(function (m) { return Math.abs(toNum(m) - toNum(p.price) * p.qty) < 0.011; })[0];
        if (t) p.total = t;
        else if (Math.abs(toNum(monies[0]) - toNum(monies[1]) * p.qty) < 0.011) { p.total = monies[0]; p.price = monies[1]; }
      }
    });
    return out;
  }
  function parseRegion(L) {
    var out = [], i = 0;
    while (i < L.length) {
      var l = L[i];
      var single = singleLineItem(l);
      if (single) { out.push(single); i++; continue; }
      if (!nameLike(l)) { i++; continue; }
      var p = { name: l, qty: null, price: null, total: null, sku: null }, monies = [], j = i + 1, packInts = false;
      for (; j < L.length && j <= i + 6; j++) {
        var x = L[j];
        if (TOTAL_LINE.test(x) || singleLineItem(x) || (nameLike(x) && !SKU.test(x))) break;
        if (PROMO.test(x) || GIFT.test(x) || CARDISH.test(x)) continue;
        var mu = MULT.exec(x);
        if (mu) { p.qty = Number(mu[1] || mu[4]); monies.push((mu[2] || mu[3]).replace(/\s/g, "")); continue; }
        var q = QTY.exec(x); if (q && p.qty == null) p.qty = Number(q[1]);
        // A pack-size dropdown ("Multipack Quantity:" then its options 1, 2 on their own lines) is never the order's quantity.
        if (PACK_LABEL.test(x)) { packInts = true; continue; }
        if (/^\d{1,4}$/.test(x)) { if (!packInts && p.qty == null) p.qty = Number(x); continue; }
        packInts = false;
        var sk = SKU.exec(x); if (sk && !p.sku) p.sku = sk[1];
        var mm = x.match(MONEY_G); if (mm && !/\b(?:was|reg\.?|regular|list|save|saved|savings)\b/i.test(x)) monies = monies.concat(mm.map(function (m) { return m.replace(/\s/g, ""); }));
      }
      if (monies.length) { p.monies = monies; out.push(p); }
      i = j > i + 1 ? j : i + 1;
    }
    return out;
  }

  // ── Payment ──
  function extractPayment(page) {
    var cards = [], selectedCards = [], gifts = [];
    var scan = function (t, into) {
      lines(t).forEach(function (l) {
        var m = CARD_LAST4.exec(l);
        if (GIFT.test(l)) {
          var g = { last4: m ? m[2] : null, amount: money(l) };
          if (g.last4 || g.amount) gifts.push(g);
          return;
        }
        if (!m) return;
        var nick = m[1].replace(/^selected:\s*/i, "").replace(/\b(?:payment\s+method|card\s+number|number|pay\s+with|paying\s+with|selected)\b/gi, "").replace(/[\s:·•|-]+$/, "").replace(/^[\s:·•|-]+/, "").trim();
        nick = nick.split(/\s{2,}/).pop().split(/\s+/).slice(-3).join(" ");
        into.push({ nickname: nick || "Card", last4: m[2], amount: money(l.slice(m.index + m[0].length)) });
      });
    };
    scan(page.text, cards);
    fieldsOf(page).forEach(function (f) { scan(String(f.label || "") + ": " + String(f.value || ""), /^selected:/i.test(String(f.label || "")) ? selectedCards : cards); });
    // The checked payment radio is the card; the other saved cards the page lists are not.
    var chosen = selectedCards.length ? selectedCards : cards;
    return { cards: uniq(chosen, function (c) { return c.last4; }), giftCards: uniq(gifts, function (g) { return g.last4 || g.amount; }) };
  }

  // ── Totals ──
  function amount(all, label) {
    // "Subtotal (22 items) $176.40", "Shipping Free": the amount is the first money on the label's line.
    var m = new RegExp("\\b" + label + "\\b[^\\n$]{0,30}?(" + MONEY_SRC + "|\\bfree\\b)", "i").exec(all);
    return m ? (/^free$/i.test(m[1]) ? "Free" : m[1].replace(/\s/g, "")) : null;
  }
  function extractTotals(page) {
    var all = String(page.text || "");
    var t = {};
    var sub = amount(all, "(?:items?\\s+)?sub\\s*total"); if (sub) t.subtotal = sub;
    var disc = amount(all, "(?:discounts?|savings|you\\s+save)"); if (disc) t.discount = disc;
    var tax = amount(all, "(?:estimated\\s+|sales\\s+)?tax(?:es)?"); if (tax) t.tax = tax;
    var ship = amount(all, "(?:estimated\\s+)?shipping(?:\\s*(?:&|and)\\s*handling)?"); if (ship) t.shipping = ship;
    var tot = amount(all, "(?:order\\s+|estimated\\s+|grand\\s+)?total(?!\\s+savings)"); if (tot) t.total = tot;
    return t;
  }

  // ── Promos ──
  function extractPromos(page) {
    return uniq(lines(page.text).filter(function (l) { return PROMO.test(l) && !TOTAL_LINE.test(l) && !GIFT.test(l) && l.length <= 100; }));
  }

  // ── Order ──
  function extractOrder(page) {
    var all = String(page.text || ""), o = {};
    var n = ORDER_NO.exec(all); if (n) o.number = n[1];
    var d = ORDER_DATE.exec(all); if (d) o.date = d[1];
    var sel = selectedFields(page).map(function (f) { return String(f.label || "") + " " + String(f.value || ""); });
    var on = sel.filter(function (s) { return SUBSCRIBE.test(s); })[0];
    var off = sel.filter(function (s) { return ONE_TIME.test(s); })[0];
    if (on) o.subscription = { on: true, every: everyIn(on) };
    else if (off) o.subscription = { on: false, every: null };
    else {
      var line = lines(all).filter(function (l) { return SUBSCRIBE.test(l) && EVERY.test(l); })[0];
      if (line) o.subscription = { on: true, every: everyIn(line) };
    }
    return o;
  }
  function everyIn(s) {
    var m = EVERY.exec(s);
    if (!m) return null;
    if (m[1]) return "every " + m[1] + " " + m[2] + (Number(m[1]) === 1 ? "" : "s");
    return m[3].toLowerCase();
  }

  /** One page → the buckets it fills (only what it shows). */
  function extractBuckets(page) {
    return { products: extractProducts(page), shipping: extractShipping(page), payment: extractPayment(page), totals: extractTotals(page), promos: extractPromos(page), order: extractOrder(page) };
  }

  function productKey(p) { return p.sku ? "sku:" + String(p.sku).toLowerCase() : "name:" + normName(p.name); }
  function assignNewer(into, from) { Object.keys(from).forEach(function (k) { if (from[k] != null && from[k] !== "") into[k] = from[k]; }); return into; }
  function upsert(list, items, key) {
    var out = list.map(function (x) { return Object.assign({}, x); });
    items.forEach(function (it) {
      var k = key(it), idx = -1;
      for (var i = 0; i < out.length; i++) if (key(out[i]) === k) { idx = i; break; }
      if (idx >= 0) assignNewer(out[idx], it); else out.push(Object.assign({}, it));
    });
    return out;
  }

  /** prev + next → merged: newest value wins per field; nothing is replaced wholesale, nothing is dropped. Pure. */
  function mergeBuckets(prev, next) {
    var a = prev || emptyBuckets(), b = next || {};
    return {
      products: upsert(a.products || [], b.products || [], productKey),
      shipping: b.shipping ? b.shipping : (a.shipping || null),
      payment: {
        cards: upsert((a.payment || {}).cards || [], (b.payment || {}).cards || [], function (c) { return c.last4 || normName(c.nickname); }),
        giftCards: upsert((a.payment || {}).giftCards || [], (b.payment || {}).giftCards || [], function (g) { return g.last4 || g.amount; }),
      },
      totals: assignNewer(Object.assign({}, a.totals || {}), b.totals || {}),
      promos: uniq((a.promos || []).concat(b.promos || [])),
      order: assignNewer(Object.assign({}, a.order || {}), b.order || {}),
    };
  }

  function filled(b) {
    b = b || emptyBuckets();
    return {
      products: (b.products || []).length > 0,
      shipping: !!(b.shipping && (b.shipping.street || (b.shipping.candidates || []).length)),
      payment: !!(b.payment && (((b.payment.cards || []).length) || ((b.payment.giftCards || []).length))),
      totals: !!(b.totals && (b.totals.subtotal || b.totals.total)),
      promos: (b.promos || []).length > 0,
      order: !!(b.order && b.order.number),
    };
  }
  function missing(b) { var f = filled(b); return BUCKETS.filter(function (k) { return !f[k]; }).map(function (k) { return LABELS[k]; }); }
  /** Open in AF needs Products and Totals; the rest is optional. */
  function canOpen(b) { var f = filled(b); return f.products && f.totals; }

  // ── The per-tab capture record (chrome.storage.session, key capture:<tabId>) ──
  function captureKey(tabId) { return "capture:" + tabId; }
  function newCapture(host) { return { host: host, pages: {}, others: [], count: 0, updatedAt: null, buckets: emptyBuckets() }; }
  /** The pages the prefill endpoint receives: one per checkout step (the latest capture of a step) plus up to six "other" pages — as before 1.2. */
  function pagesOf(cap) { return [].concat(Object.keys((cap && cap.pages) || {}).map(function (k) { return cap.pages[k]; }), (cap && cap.others) || []); }
  function rebuild(cap) {
    return pagesOf(cap).slice().sort(function (p, q) { return String(p.capturedAt || "").localeCompare(String(q.capturedAt || "")); }).reduce(function (b, p) { return mergeBuckets(b, extractBuckets(p)); }, emptyBuckets());
  }
  /** Add one captured page to a tab's capture. Pure: returns the new record. Buckets merge newest-wins; the step entry is replaced as before. */
  function applyPage(cur, page, host, now) {
    var c = cur ? JSON.parse(JSON.stringify(cur)) : newCapture(host);
    if (!c.buckets) c.buckets = rebuild(c);
    var entry = Object.assign({}, page, { capturedAt: now });
    if (page.step === "other" || !page.step) c.others = (c.others || []).filter(function (p) { return p.url !== page.url; }).concat([entry]).slice(-6);
    else { c.pages = c.pages || {}; c.pages[page.step] = entry; }
    c.host = host; c.updatedAt = now;
    c.count = Object.keys(c.pages || {}).length + (c.others || []).length;
    c.buckets = mergeBuckets(c.buckets, extractBuckets(page));
    return c;
  }
  function pagesForPrefill(cap) { return pagesOf(cap).map(function (p) { return { step: p.step, url: p.url, title: p.title, text: p.text, fields: p.fields || [] }; }); }
  /** The selected ship-to for the prefill payload: null when no page showed an address. */
  function shipToForPrefill(cap) {
    var s = cap && cap.buckets && cap.buckets.shipping;
    if (!s || !(s.street || (s.candidates || []).length)) return null;
    return { street: s.street || null, candidates: s.candidates || [] };
  }
  /** The other tabs with a capture in progress, from the whole session store (key → record). */
  function othersCapturing(store, tabId) {
    return Object.keys(store || {}).filter(function (k) { return /^capture:/.test(k) && k !== captureKey(tabId) && store[k] && store[k].count; })
      .map(function (k) { return { tabId: Number(k.slice(8)), host: String(store[k].host || "").replace(/^www\./, ""), count: store[k].count }; });
  }

  /** Velocity / Home from the configured streets (the same tracking.velocity_street / home_streets the router uses). */
  function shipToKind(street, config) {
    if (!config || !street) return null;
    var n = normStreet(street);
    if (!n) return null;
    if (n === normStreet(config.velocityStreet)) return "Velocity";
    if ((config.homeStreets || []).some(function (h) { return normStreet(h) === n; })) return "Home";
    return null;
  }
  /** The Shipping bucket's lines: ["Velocity · 805 Grandy Ave"], ["Unknown: 12 Elsewhere St"], or both candidates when the pages are ambiguous. */
  function describeShipping(shipping, config) {
    if (!shipping) return [];
    var one = function (st) { var k = shipToKind(st, config); return k ? k + " · " + st : "Unknown: " + st; };
    if (shipping.street) return [one(shipping.street)];
    return (shipping.candidates || []).map(one);
  }

  var api = {
    BUCKETS: BUCKETS, LABELS: LABELS, emptyBuckets: emptyBuckets, extractBuckets: extractBuckets, mergeBuckets: mergeBuckets,
    extractProducts: extractProducts, extractShipping: extractShipping, extractPayment: extractPayment, extractTotals: extractTotals, extractPromos: extractPromos, extractOrder: extractOrder,
    filled: filled, missing: missing, canOpen: canOpen, streetIn: streetIn, normStreet: normStreet,
    captureKey: captureKey, newCapture: newCapture, applyPage: applyPage, pagesForPrefill: pagesForPrefill, shipToForPrefill: shipToForPrefill, othersCapturing: othersCapturing,
    shipToKind: shipToKind, describeShipping: describeShipping,
  };
  root.AfBuckets = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
