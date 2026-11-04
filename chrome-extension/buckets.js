// Capture PO — data buckets (AsinFlow Chrome extension v1.2, SPEC §11
// "Chrome extension — Capture PO"). Pure, regex-level, no AI: every captured
// page is read into six buckets — Products, Shipping, Payment, Totals,
// Promos, Order — and merged into the tab's capture so Maria can see what
// the captures found before the one AI call runs server side. Merge rule:
// newest value wins PER FIELD; a page that lacks a value never clears it;
// a product / card / promo once seen is never dropped. Anything the regexes
// cannot read with confidence is simply not shown (the AI reads the whole
// text). v1.3 (Maria 2026-11-04): each captured page is ALSO read by one
// small AI extraction server side (/api/pos/capture-preview, the prefill's
// schema) — instead of more per-site rules. Its buckets replace that page's
// rule-based ones when they answer (overlayPreview: the AI's products,
// payment, totals and promos; the rules keep the SELECTED ship-to; the order
// fields merge), cached in the record by page key (previews) so recapturing
// the same page never calls again. The checkout email (order.email) comes
// from the AI or a filled email field and goes to the prefill.
// Plain script (no bundler): defines globalThis.AfBuckets for the
// service worker (importScripts) and the side panel, and exports the same
// object for the vitest fixtures (server/extension-buckets.test.ts).
// v1.2.2 (a shagtools.com cart): a TABLE-STYLE cart row — one line whose
// cells (innerText joins a <tr>'s cells with tabs) hold a title, a price and
// a quantity stepper / input / count as siblings — is a product; promos are
// deduped by code (case-insensitive; a code-less line joins the code whose
// amount or percent it repeats, else its normalized wording), keeping the
// line with the most detail (code + amount + percent).
// v1.2.3 (shagtools.com cart + checkout, Maria 2026-11-02): (a) a product
// whose quantity is plain text — "× N", "x N", "N ×" (or "Qty: N") anywhere in
// the row, on the title line or on a line of its own — with a line total and
// no unit price: the unit price is derived as total ÷ N; (b) a table row whose
// cells are title / unit price / quantity / line total in any order, the
// quantity an input (its value is not in the text), a stepper cell ("− +",
// "− 15 +"), a bare number or nothing visible at all: two monies whose ratio
// is a whole number give the quantity, price and total. debugText() is the
// panel's "Copy page text" (options page, debug): the captured text and
// fields exactly as the parser saw them.
// v1.2.4 (Maria 2026-11-02): "Qty: N" with ONE money derives the unit price too
// — when the money is N × a plausible unit price, i.e. money ÷ N is a whole
// number of cents (Walmart's confirmation "Qty 12 / $95.64" → 12 × $7.97);
// otherwise the money stays the unit price ("Qty: 10 / $7.97" — 0.797 is no
// price). canOpen() is gone: the buckets are a preview, not a gate.
// v1.2.6 / v1.2.7 (shagtools.com, Maria 2026-11-03, the first real captures):
// the checkout row read "× 10" / "Available on backorder" / $89.30 — the
// availability line looked like a new title and cut the block before its
// money, so Products stayed empty; availability lines (available, backorder,
// usually ships, low stock, only N left) are noise now, and up to two other
// note lines (a colour, a SKU, a status) may sit between the quantity and the
// line total. The cart table (name / $8.93 / − 10 + / $89.30, WooCommerce)
// never parsed: the row's text joins a "REMOVE" link, the two monies and the
// stepper's "−" / "+" on one tab-joined line after the title line, and the
// quantity input's label is "<product name> quantity" — a stepper cell in a
// joined line marks the block, a quantity field whose label CONTAINS qty /
// quantity fills it, and two monies in a whole ratio give the quantity when the
// block shows a control. Totals carried Shipping $24.77 — the Ground rate
// selected on an EARLIER cart capture — into a checkout that lists no
// shipping ("Enter your address to view shipping options") and into the next
// cart: the buckets were merged incrementally per capture, so a value from a
// page since replaced survived. Now the buckets are REBUILT from the pages on
// every capture (the latest capture of a step replaces that step's values)
// and the newest page's Totals replace the whole figure — a field the newest
// page lacks is gone. The cart's shipping radios ("Ground: $24.77" / "2 Day:
// $120.02" / "Next Day: $180.02", each with a "(Delivery by …)" line) resolve
// by the checked radio (a "selected:" field), else by the one that reconciles
// with Total, else stay empty — never the first option's price.
// v1.2.5 (shagtools.com/checkout, Maria 2026-11-02): the address was in form
// fields (street, city, state select, ZIP), not in the text — Shipping now
// also builds a candidate from the captured fields whose labels / names say
// street | address | city | state | zip | postal (billing, email and phone
// fields excluded; a checked radio still wins), and the street is matched
// against the two known addresses the same way (normStreet).
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
  // Street number + at least one street-name word + a suffix: "805 Grandy Ave". "100 ct" / "12 Ct" (a size variant) is not an address.
  var STREET = /\b(\d{1,6}[A-Za-z]?)\s+((?:[A-Za-z][A-Za-z0-9.'-]*\s+){1,4}?)(st|street|ave|avenue|rd|road|dr|drive|ln|lane|blvd|boulevard|ct|court|way|pl|place|cir|circle|pkwy|parkway|hwy|highway|ter|terrace|trl|trail|loop|run)\b\.?/i;
  // Address detection is scoped to blocks under a deliver / ship / address heading (v1.2.1).
  var SHIP_HEADING = /\b(?:shipping|delivery|deliver(?:s|ed|ing)?\s+to|ships?\s+to|address)\b/i;
  var BILLING = /\b(?:billing|payment|card)\b/i;
  var TOTALS_START = /\b(?:sub\s*total|order\s+total|estimated\s+total|grand\s+total)\b/i;
  var HEADER_ROW = /\b(?:product|item|price|quantity|qty)\b/i;
  var TOTAL_LINE = /^(?:items?\s+)?(?:sub\s*total|order\s+total|estimated\s+total|grand\s+total|total|tax(?:es)?|estimated\s+tax|sales\s+tax|shipping|estimated\s+shipping|discount|savings|promotion)\b/i;
  var NOISE = /^(?:now\$|now\s+\$|bought\s+\d|free\s+delivery|snap\b|best\s+seller|manufacturer\s+offer|saved\s+for\s+later|notify\s+me|skip\s+to|rollback|was\s+\$|sold\s+(?:and|&)\s+shipped|ships?\s+from|my\s+items|buy\s+again|reorder|add\s+to|cart|your\s+cart|basket|bag|items?\b|review|checkout|order\b|subtotal|total|tax|shipping|delivery|deliver|arrives|free\s+shipping|payment|pay\b|place\s+order|continue|edit|remove|save\s+for\s+later|move\s+to|change|add\b|apply|promo|coupon|gift|rewards|contact|email|phone|account|sign|secure|qty|quantity|price|each|sold\s+by|ship|pickup|in\s+stock|out\s+of\s+stock|available\b|backorder|usually\s+ships|ready\s+to\s+ship|low\s+stock|limited\s+stock|only\s+\d|select|choose|see\b|view|learn|earn|get\b|you\b|your\b|we\b|thank|hello|hi\b|name|address|city|state|zip|united\s+states|usa\b|visa|mastercard|amex|discover|card\b|ending\s+in|••••|\*\*\*\*|exp\b|cvv|billing|summary|details|estimated|protect|warranty|plan\b|add-on|recommended|also\b|customers|people|frequently|sponsored|more\b|multipack|subscri|one-?time|\d)/i;
  var PROMO = /\b(?:promo(?:tion)?(?:\s*code)?|coupon|discount\s+code|code\s+applied|%\s*off|rewards?\s+applied|rewards?:|applied:?\s*-?\$)/i;
  // A promo line carries a code, an amount or a percent; "Have a promo code?" is a form prompt (v1.2.1).
  var PROMO_VALUE = /\$\s?\d|\d+(?:\.\d+)?\s*%|\b[A-Z0-9]{5,}\b/;
  var STEPPER = /^[−–\-+]$/;
  // A quantity shown as plain text: "× 15", "x 15", "(x15)", "15 ×" — tested after MULT, so "12 × $7.97" / "$7.97 × 12" keep their unit price (v1.2.3).
  var QTY_MARK = /(?:^|[\s(])[×x]\s*(\d{1,4})\b|\b(\d{1,4})\s*[×x](?=[\s)]|$)/i;
  // The mark at the end / start of a title line: "Shag Carpet Kicker … × 15".
  var NAME_MARK = /\s[×x]\s*(\d{1,4})$|^(\d{1,4})\s*[×x]\s+/i;
  var QTY_LABEL = /^(?:qty|quantity)\s*:?$/i;
  var CARDISH = /••••|\*{4}|\bending\s+(?:in|with)\b|\b(?:visa|mastercard|amex|american\s+express|discover|paypal|affirm|klarna|afterpay)\b/i;
  var CARD_LAST4 = /^(.*?)\s*(?:•••• ?|\*{4} ?|x{4} ?|ending\s+(?:in|with)\s+|ending\s+)(\d{4})\b/i;
  var GIFT = /\b(?:e-?gift|gift\s*card|gift\s*certificate|egc|store\s+credit)\b/i;
  var SUBSCRIBE = /\b(?:subscri(?:be|ption)|auto-?ship|autoship|repeat\s+delivery|deliver\s+every)\b/i;
  var ONE_TIME = /\bone-?\s?time\b/i;
  var EVERY = /\bevery\s+(\d+)\s+(week|month)s?\b|\b(monthly|weekly|bi-?weekly|every\s+(?:week|month))\b/i;
  var ORDER_NO_LINE = /\border\s*(?:#|number|no\.?|id|confirmation)/i;
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
  /** "$133.95" ÷ 15 → "$8.93" (v1.2.3: a unit price derived from a line total). */
  function unitOf(total, qty) { return "$" + (Math.round((toNum(total) / qty) * 100) / 100).toFixed(2); }
  /** v1.2.4: total ÷ qty when it is a whole number of cents (a plausible unit price), else null. */
  function unitIfExact(total, qty) { var u = toNum(total) / qty; return qty > 1 && Math.abs(u * 100 - Math.round(u * 100)) < 1e-6 ? "$" + u.toFixed(2) : null; }
  /** Two monies where one is the other × qty → { price, total }, either order; qty 1 needs two equal monies. */
  function pairFor(monies, qty) {
    for (var i = 0; i < monies.length; i++) for (var j = 0; j < monies.length; j++) {
      if (i === j) continue;
      if (Math.abs(toNum(monies[j]) - toNum(monies[i]) * qty) < 0.011) return { price: monies[i], total: monies[j] };
    }
    return null;
  }
  /** Two monies whose ratio is a whole number 1–999 → { qty, price, total } (the quantity is not in the text: an input, an icon stepper). The first money is tried as the unit price first. */
  function ratioPair(monies) {
    for (var i = 0; i < monies.length; i++) for (var j = 0; j < monies.length; j++) {
      if (i === j) continue;
      var a = toNum(monies[i]), b = toNum(monies[j]);
      if (!(a > 0) || !(b > 0) || b < a) continue;
      var n = Math.round(b / a);
      if (n >= 1 && n <= 999 && Math.abs(b - a * n) < 0.011) return { qty: n, price: monies[i], total: monies[j] };
    }
    return null;
  }
  /** A stepper cell: "−", "+", "− +", "− 15 +", "-15+" → { qty } (null when the value is not in the text). */
  function stepperCell(c) {
    if (!/[−–\-+]/.test(c) || !/^[−–\-+\s\d]+$/.test(c)) return null;
    var d = c.match(/\d{1,4}/g);
    if (d && d.length > 1) return null;
    return { qty: d ? Number(d[0]) : null };
  }
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
  // v1.2.5: an address typed into form fields (street / city / state / ZIP). Labels are what capture.js labelFor() gives: a <label>, aria-label, placeholder, name or id — so "shipping_address_line1", "Street address", "address1", "zip", "postal_code". Billing / email / phone fields are skipped; a second line, apt / suite / unit never is the street; the value must look like a street ("805 Grandy Ave", or "65 Rivercrest" without a suffix).
  var ADDR_SKIP = /bill|email|e-mail|phone|tel\b|company|search|name/i;
  var ADDR_LINE2 = /line[ _-]?2|address[ _-]?2|addr2|street[ _-]?2|\b2\b|apt|suite|unit|floor|type/i;
  function addressFromFields(page) {
    var street = null, city = null, state = null, zip = null;
    fieldsOf(page).forEach(function (f) {
      var lab = String(f.label || ""), val = String(f.value || "").replace(/\s+/g, " ").trim();
      if (!val || /^selected:/i.test(lab) || ADDR_SKIP.test(lab)) return;
      if (street == null && /street|address|addr/i.test(lab) && !ADDR_LINE2.test(lab) && /^\d{1,6}[A-Za-z]?\s+[A-Za-z]/.test(val)) street = streetIn(val) || val.slice(0, 80);
      else if (city == null && /city|town/i.test(lab)) city = val.slice(0, 60);
      else if (state == null && /state|province|region/i.test(lab)) state = val.slice(0, 40);
      else if (zip == null && /zip|postal|postcode/i.test(lab)) { var z = /\d{5}(?:-\d{4})?/.exec(val); zip = z ? z[0] : val.slice(0, 12); }
    });
    if (!street) return null;
    return { street: street, candidates: [street], selected: false, fromFields: true, city: city, state: state, zip: zip };
  }
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
    var typed = addressFromFields(page);
    if (typed) return typed;
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
    if (l.length < 12 || l.length > 160) return false;
    if (!/[A-Za-z]{3}/.test(l) || !/\S\s+\S/.test(l)) return false;
    if (MONEY.test(l) || /^\d+$/.test(l)) return false;
    if (QTY.test(l) || NOISE.test(l) || TOTAL_LINE.test(l) || PROMO.test(l)) return false;
    if (STREET.test(l) || CARDISH.test(l)) return false;
    return true;
  }
  function singleLineItem(l) {
    // "Name   Item #LC1234   Qty 1   $199.00" / "Name   Qty: 6   $5.99" / "Name × 6 $5.99" / "Name 12 × $7.97" / "Name  × 15  $133.95" (v1.2.3: the mark, the price derived)
    if (!MONEY.test(l)) return null;
    var q = QTY.exec(l), mu = MULT.exec(l), mk = !mu && QTY_MARK.exec(l);
    if (!q && !mu && !mk) return null;
    var cut = l.length;
    [QTY, SKU, MULT, MONEY].concat(mk ? [QTY_MARK] : []).forEach(function (re) { var m = re.exec(l); if (m && m.index < cut) cut = m.index; });
    var name = l.slice(0, cut).replace(/[\s|,:·•-]+$/, "").trim();
    if (!nameLike(name)) return null;
    var p = { name: name, qty: q ? Number(q[1]) : mu ? Number(mu[1] || mu[4]) : Number(mk[1] || mk[2]), price: null, total: null, sku: null };
    var sk = SKU.exec(l); if (sk) p.sku = sk[1];
    var monies = l.match(MONEY_G).map(function (m) { return m.replace(/\s/g, ""); });
    if (mu) { p.price = (mu[2] || mu[3]).replace(/\s/g, ""); }
    else if (mk && !q && monies.length === 1 && p.qty > 0) { p.total = monies[0]; p.price = unitOf(monies[0], p.qty); }
    else if (q && monies.length === 1 && unitIfExact(monies[0], p.qty)) { p.total = monies[0]; p.price = unitIfExact(monies[0], p.qty); } // v1.2.4: "Qty: N" + one money that is N × a cent-exact price
    else p.price = monies[0];
    if (monies.length > 1 && p.qty != null) { var pt = pairFor(monies, p.qty); if (pt) { p.price = pt.price; p.total = pt.total; } }
    return p;
  }
  /** A table / grid row (v1.2.2, widened in v1.2.3): cells side by side on one line, in any order — a title cell, a unit price and / or a line total, and a quantity cell: a stepper ("−" / "+", "− 15 +"), a "Qty" label, a "Qty N", a "× N" / "N ×" mark, a bare count, or nothing visible (an input's value is not in the text — then two monies whose ratio is a whole number give the quantity). The stepper's value comes from the page's quantity fields when the text lacks it. */
  function rowItem(l) {
    if (!MONEY.test(l)) return null;
    var cells = l.split(/\s{2,}/).map(function (c) { return c.trim(); }).filter(Boolean);
    if (cells.length < 3) return null;
    var p = { name: null, qty: null, price: null, total: null, sku: null, control: false, mark: false, qtyLabel: false, monies: [], ints: [] }, sawQty = false;
    for (var k = 0; k < cells.length; k++) {
      var c = cells[k];
      if (p.name == null && nameLike(c)) { p.name = c; continue; }
      var st = stepperCell(c);
      if (st) { p.control = true; sawQty = true; if (st.qty != null && p.qty == null) p.qty = st.qty; continue; }
      if (QTY_LABEL.test(c)) { p.control = true; sawQty = true; continue; }
      var q = QTY.exec(c); if (q) { if (p.qty == null) p.qty = Number(q[1]); p.control = true; p.qtyLabel = true; sawQty = true; continue; }
      var mu = MULT.exec(c);
      if (mu) { if (p.qty == null) p.qty = Number(mu[1] || mu[4]); p.control = true; sawQty = true; p.monies.push((mu[2] || mu[3]).replace(/\s/g, "")); continue; }
      var mk = QTY_MARK.exec(c);
      if (mk) { if (p.qty == null) p.qty = Number(mk[1] || mk[2]); p.control = true; p.mark = true; sawQty = true; c = c.replace(QTY_MARK, " ").trim(); if (!c) continue; }
      if (/^\d{1,4}$/.test(c)) {
        sawQty = true;
        var near = function (x) { return x != null && (!!stepperCell(x) || QTY_LABEL.test(x)); };
        if (near(cells[k - 1]) || near(cells[k + 1])) { p.control = true; if (p.qty == null) p.qty = Number(c); } else p.ints.push(Number(c));
        continue;
      }
      var sk = SKU.exec(c); if (sk && !p.sku) p.sku = sk[1];
      var mm = c.match(MONEY_G); if (mm && !/\b(?:was|reg\.?|regular|list|save|saved|savings)\b/i.test(c)) p.monies = p.monies.concat(mm.map(function (m) { return m.replace(/\s/g, ""); }));
    }
    // One bare count in the row confirmed by a total cell equal to price × count, either order (a count of 1 makes them equal — explicit here, unlike a block's repeated price).
    if (p.qty == null && p.ints.length === 1 && p.monies.length >= 2 && pairFor(p.monies, p.ints[0])) p.qty = p.ints[0];
    // (b) No quantity in the text (an input, an icon stepper): a unit price and a line total whose ratio is a whole number.
    if (p.qty == null && p.monies.length >= 2) { var rp = ratioPair(p.monies); if (rp) { p.qty = rp.qty; p.price = rp.price; p.total = rp.total; p.control = true; sawQty = true; } }
    // (a) A "× N" mark with a lone money: the line total; the unit price is derived.
    if (p.mark && p.qty > 0 && p.monies.length === 1 && p.price == null) { p.total = p.monies[0]; p.price = unitOf(p.monies[0], p.qty); }
    // v1.2.4: "Qty: N" with a lone money that is N × a cent-exact price: the line total, the unit price derived.
    if (p.qtyLabel && !p.mark && p.monies.length === 1 && p.price == null) { var ue = unitIfExact(p.monies[0], p.qty); if (ue) { p.total = p.monies[0]; p.price = ue; } }
    return p.name && p.monies.length && sawQty ? p : null;
  }
  function extractProducts(page) {
    var L = lines(page.text);
    // v1.2.7: the cart table's header row ("PRODUCT  PRICE  QUANTITY  SUBTOTAL") is not where the totals start — the rows come after it.
    var stop = L.findIndex(function (l) { return TOTALS_START.test(l) && !HEADER_ROW.test(l); });
    var region = stop > 0 ? L.slice(0, stop) : L;
    var out = parseRegion(region);
    if (!out.length && stop > 0) out = parseRegion(L);
    // The cart stepper's value is a form field, not page text: the page's qty fields fill the blocks that show a quantity control, in order, when the counts match.
    // v1.2.7: the label may END with the word ("Mapei Keracaulk … quantity" — WooCommerce's screen-reader label); a pack-size field never counts.
    var qtyFields = fieldsOf(page).filter(function (f) { var lab = String(f.label || ""); return /\b(?:qty|quantity)\b/i.test(lab) && !PACK_LABEL.test(lab) && /^\d{1,4}$/.test(String(f.value || "").trim()); }).map(function (f) { return Number(f.value); });
    var controlled = out.filter(function (p) { return p.control && p.qty == null; });
    if (qtyFields.length && qtyFields.length === controlled.length) controlled.forEach(function (p, i) { p.qty = qtyFields[i]; });
    out.forEach(function (p) {
      var monies = p.monies || [], ints = p.ints || [];
      // A bare integer between two money lines where the second is price × n ("$7.97 / 12 / $95.64") is the quantity.
      if (p.qty == null && ints.length && monies.length > 1) { var n = ints.filter(function (k) { return monies.some(function (m) { return Math.abs(toNum(m) - toNum(monies[0]) * k) < 0.011 && m !== monies[0]; }); })[0]; if (n != null) p.qty = n; }
      if (p.qty == null && p.control && ints.length) p.qty = ints[0];
      // v1.2.7: a block with a quantity control (or a page with quantity fields) and no quantity in its text: two monies in a whole ratio — the unit price and the line total (the cart table's "$8.93 … $89.30" with the value inside the input).
      if (p.qty == null && (p.control || qtyFields.length) && monies.length >= 2) { var rp = ratioPair(monies); if (rp) { p.qty = rp.qty; p.price = rp.price; p.total = rp.total; } }
      // (a) A "× N" mark and one money: the money is the line total, the unit price is derived (v1.2.3).
      if (p.price == null && p.mark && p.qty > 0 && monies.length === 1) { p.total = monies[0]; p.price = unitOf(monies[0], p.qty); }
      // v1.2.4: "Qty N" and one money that is N × a cent-exact price (Walmart's confirmation "Qty 12 / $95.64"): the line total, the unit price derived.
      if (p.price == null && p.qtyLabel && monies.length === 1) { var ue = unitIfExact(monies[0], p.qty); if (ue) { p.total = monies[0]; p.price = ue; } }
      // Price and line total from the block's money lines, once the qty is known: unit price first, a later money equal to price × qty is the line total (or the other way round).
      if (p.price == null && monies.length) {
        p.price = monies[0];
        if (p.qty != null && monies.length > 1) {
          var t = monies.slice(1).filter(function (m) { return Math.abs(toNum(m) - toNum(p.price) * p.qty) < 0.011; })[0];
          if (t) p.total = t;
          else if (Math.abs(toNum(monies[0]) - toNum(monies[1]) * p.qty) < 0.011) { p.total = monies[0]; p.price = monies[1]; }
        }
      }
    });
    // A product line has a title AND a price AND a quantity (a "Qty N", a stepper, a quantity field) in its own container; a strip's name + price is not one (v1.2.1).
    return out.filter(function (p) { return p.price != null && p.qty != null; }).map(function (p) { return { name: p.name, qty: p.qty, price: p.price, total: p.total, sku: p.sku }; });
  }
  function parseRegion(L) {
    var out = [], i = 0;
    while (i < L.length) {
      var l = L[i];
      var single = singleLineItem(l);
      if (single) { out.push(single); i++; continue; }
      var row = rowItem(l);
      if (row) { out.push(row); i++; continue; }
      // The title line may end with the quantity mark ("… Adjustable Head × 15", v1.2.3).
      var nm = NAME_MARK.exec(l), title = nm ? l.replace(nm[0], " ").trim() : l;
      if (!nameLike(title)) { i++; continue; }
      var p = { name: title, qty: nm ? Number(nm[1] || nm[2]) : null, price: null, total: null, sku: null, control: !!nm, mark: !!nm, qtyLabel: false, monies: [], ints: [] }, j = i + 1, packInts = false, notes = 0;
      for (; j < L.length && j <= i + 14; j++) {
        var x = L[j];
        if (TOTAL_LINE.test(x) || singleLineItem(x) || rowItem(x)) break;
        // v1.2.7: up to two note lines (a colour, a status, a SKU line) may sit between the quantity and the line total; a third, or any title once the money is in, starts the next product.
        if (nameLike(x) && !SKU.test(x)) { if (p.control && !p.monies.length && notes < 2) { notes++; continue; } break; }
        if (PROMO.test(x) || GIFT.test(x) || CARDISH.test(x)) continue;
        // v1.2.7: the cart row's stepper in a tab-joined line ("REMOVE  $8.93  −  +  $89.30", "− 10 +"): the cells mark the quantity control and may carry the value.
        var stepCells = x.indexOf("  ") >= 0 ? x.split(/\s{2,}/).map(stepperCell).filter(Boolean) : [];
        if (stepCells.length) { p.control = true; var sv = stepCells.filter(function (c) { return c.qty != null; })[0]; if (sv && p.qty == null) p.qty = sv.qty; }
        var mu = MULT.exec(x);
        if (mu) { p.qty = Number(mu[1] || mu[4]); p.control = true; p.monies.push((mu[2] || mu[3]).replace(/\s/g, "")); continue; }
        var q = QTY.exec(x); if (q) { p.control = true; p.qtyLabel = true; if (p.qty == null) p.qty = Number(q[1]); }
        // "× 15" on a line of its own (or with the total on the same line): the quantity as plain text (v1.2.3).
        var mk = !q && QTY_MARK.exec(x);
        if (mk) { p.control = true; p.mark = true; if (p.qty == null) p.qty = Number(mk[1] || mk[2]); x = x.replace(QTY_MARK, " ").trim(); if (!x) continue; }
        if (QTY_LABEL.test(x)) { p.control = true; packInts = false; continue; }
        // A pack-size dropdown ("Multipack Quantity:" then its options 1, 2 on their own lines) is never the order's quantity.
        if (PACK_LABEL.test(x)) { packInts = true; continue; }
        if (/^\d{1,4}$/.test(x)) {
          if (packInts) continue;
          var stepper = (j > 0 && STEPPER.test(L[j - 1])) || (j + 1 < L.length && STEPPER.test(L[j + 1]));
          if (stepper) { p.control = true; if (p.qty == null) p.qty = Number(x); } else p.ints.push(Number(x));
          continue;
        }
        if (STEPPER.test(x)) { p.control = true; continue; }
        packInts = false;
        var sk = SKU.exec(x); if (sk && !p.sku) p.sku = sk[1];
        var mm = x.match(MONEY_G); if (mm && !/\b(?:was|reg\.?|regular|list|save|saved|savings)\b/i.test(x)) p.monies = p.monies.concat(mm.map(function (m) { return m.replace(/\s/g, ""); }));
      }
      if (p.monies.length) out.push(p);
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
        if (!m || ORDER_NO_LINE.test(l)) return; // an order number that happens to pass Luhn is masked by the scrubber — never a card
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
    // The label starts its line; the amount is the first money on that line or on the next one ("Subtotal (12 items)" / "$95.64" — Walmart puts them on two lines). "Shipping Free" → Free.
    var m = new RegExp("(?:^|\\n)[ \\t]*" + label + "\\b[^\\n$]{0,30}?(?:\\n[^\\n$]{0,12}?)?(" + MONEY_SRC + "|\\bfree\\b)", "i").exec(all);
    return m ? (/^free$/i.test(m[1]) ? "Free" : m[1].replace(/\s/g, "")) : null;
  }
  var SHIP_LABEL = /^(?:estimated\s+)?shipping(?:\s*(?:&|and)\s*handling)?\b/i;
  var METHOD_WORD = /\b(?:shipping|delivery|flat\s+rate|ground|express|standard|economy|expedited|priority|overnight|next[\s-]day|two[\s-]day|2[\s-]day|pickup|pick\s+up|ups|usps|fedex|dhl|freight|local|free)\b/i;
  /** A shipping-method line: words plus a price or "free" — "Flat rate: $24.77", "Free shipping", "UPS Ground  $9.99". */
  function methodLine(l) { return !!l && /[A-Za-z]{3}/.test(l) && METHOD_WORD.test(l) && (MONEY.test(l) || /\bfree\b/i.test(l)) && !TOTAL_LINE.test(l) && !PROMO.test(l); }
  function methodAmount(l) { var m = money(l); return m ? m : (/\bfree\b/i.test(l) ? "Free" : null); }
  /** v1.2.6: the shipping amount. "Shipping  $12.00" / "Shipping Free" / the amount on the next line read as before. When the label is followed by shipping METHODS instead ("Flat rate: $24.77" / "Free shipping" — WooCommerce lists its radios in the Shipping row), one method is its amount; several resolve by the checked radio (a "selected:" field naming the method), else by the method whose amount reconciles with Total (subtotal − discount + tax + shipping), else none — never the first option's price. */
  function shippingAmount(page, all, t) {
    var L = lines(all);
    for (var i = 0; i < L.length; i++) {
      if (!SHIP_LABEL.test(L[i])) continue;
      var rest = L[i].replace(SHIP_LABEL, "").replace(/^[\s:·•|-]+/, "").trim();
      if (rest && !methodLine(rest)) { var a = methodAmount(rest); if (a) return a; continue; }
      var methods = [];
      if (rest) methods.push(rest);
      for (var j = i + 1; j < L.length && j <= i + 5; j++) {
        if (!methods.length && !rest) { var a2 = methodAmount(L[j]); if (a2 && !methodLine(L[j]) && L[j].length <= 14) return a2; } // "Shipping" / "$12.00" on two lines (Walmart)
        if (/^\(.*\)$/.test(L[j]) || /^(?:delivery|arrives|est\.?|estimated)\b/i.test(L[j])) continue; // "(Delivery by November 10, 2026)" under each option
        if (!methodLine(L[j])) break;
        methods.push(L[j]);
      }
      if (!methods.length) continue;
      if (methods.length === 1) return methodAmount(methods[0]);
      // Several methods: the checked radio names one of them.
      var sel = selectedFields(page).map(function (f) { return normName(String(f.label || "").replace(/^selected:\s*/i, "")); }).filter(Boolean);
      var chosen = methods.filter(function (m) { var k = normName(m); return sel.some(function (s) { return s.indexOf(k) >= 0 || k.indexOf(s) >= 0; }); });
      if (chosen.length === 1) return methodAmount(chosen[0]);
      // Else the one whose amount reconciles with Total.
      if (t.total && t.subtotal) {
        var base = toNum(t.subtotal) - (t.discount ? Math.abs(toNum(t.discount)) : 0) + (t.tax ? toNum(t.tax) : 0), total = toNum(t.total);
        var fits = methods.filter(function (m) { var a3 = methodAmount(m); return a3 != null && Math.abs(base + (a3 === "Free" ? 0 : toNum(a3)) - total) < 0.011; });
        if (fits.length === 1) return methodAmount(fits[0]);
      }
      return null;
    }
    return null;
  }
  function extractTotals(page) {
    var all = String(page.text || "");
    var t = {};
    var sub = amount(all, "(?:items?\\s+)?sub\\s*total"); if (sub) t.subtotal = sub;
    // "You saved $36.12 today" is a discount candidate, never the total.
    var disc = amount(all, "(?:(?:total\\s+)?(?:discounts?|savings)|you\\s+saved?)"); if (disc) t.discount = disc;
    var tax = amount(all, "(?:estimated\\s+|sales\\s+)?tax(?:es)?"); if (tax) t.tax = tax;
    var tot = amount(all, "(?:order\\s+|estimated\\s+|grand\\s+)?total(?!\\s*(?:savings|saved))"); if (tot) t.total = tot;
    var ship = shippingAmount(page, all, t); if (ship) t.shipping = ship;
    return t;
  }

  // ── Promos ──
  function extractPromos(page) {
    return dedupePromos(lines(page.text).filter(function (l) { return PROMO.test(l) && PROMO_VALUE.test(l) && !/\?\s*$/.test(l) && !TOTAL_LINE.test(l) && !GIFT.test(l) && l.length <= 100; }));
  }
  // The code on a promo line: a token of 5+ letters and digits, any case ("SHAGTOOLS10", "shagtools10", "COMEBACK47Z5"), else an all-caps word that is not a label ("COUPON", "APPLIED").
  var PROMO_LABEL_WORD = /^(?:COUPON|CODE|PROMO|PROMOTION|APPLIED|DISCOUNT|SAVINGS|SAVE|REWARD|REWARDS|OFF|FREE|SHIPPING|ORDER|TOTAL|GET|YOUR|WITH|USE|ENTER|CHECKOUT|CART|SALE|OFFER|DEAL|TODAY|ONLY|NOW|FIRST|EXTRA|BONUS|MEMBER|MEMBERS)$/;
  function promoCode(l) {
    var toks = String(l || "").match(/\b[A-Za-z0-9]{5,}\b/g) || [];
    var mixed = toks.filter(function (t) { return /[A-Za-z]/.test(t) && /\d/.test(t); });
    if (mixed.length) return mixed[0];
    return toks.filter(function (t) { return /^[A-Z]+$/.test(t) && !PROMO_LABEL_WORD.test(t); })[0] || null;
  }
  function promoPercents(l) { return (String(l || "").match(/\d+(?:\.\d+)?\s*%/g) || []).map(function (x) { return String(Number(x.replace(/[^\d.]/g, ""))); }); }
  function promoMonies(l) { return (String(l || "").match(MONEY_G) || []).map(function (x) { return x.replace(/[^\d.]/g, ""); }); }
  function promoDesc(l) { return String(l || "").toLowerCase().replace(MONEY_G, " ").replace(/\d+(?:\.\d+)?\s*%/g, " ").replace(/[^a-z]+/g, " ").trim(); }
  /** One entry per promo (v1.2.2): lines sharing a code (case-insensitive) are one; a code-less line joins the coded promo whose amount or percent it repeats ("GET 10% OFF" → SHAGTOOLS10), else lines with the same wording are one; the line with the most detail (code, amount, percent — then the longer) is kept, in first-seen order. */
  function dedupePromos(list) {
    var items = (list || []).map(function (l, i) {
      var code = promoCode(l), pct = promoPercents(l), money = promoMonies(l);
      return { l: l, i: i, code: code ? code.toLowerCase() : null, pct: pct, money: money, desc: promoDesc(l), score: (code ? 1 : 0) + (money.length ? 1 : 0) + (pct.length ? 1 : 0) };
    });
    var groups = [];
    items.filter(function (it) { return it.code; }).forEach(function (it) {
      var g = groups.filter(function (g) { return g.code === it.code; })[0];
      if (!g) { g = { code: it.code, desc: null, items: [] }; groups.push(g); }
      g.items.push(it);
    });
    items.filter(function (it) { return !it.code; }).forEach(function (it) {
      var g = groups.filter(function (g) { return g.code && g.items.some(function (x) { return it.pct.some(function (v) { return x.pct.indexOf(v) >= 0; }) || it.money.some(function (v) { return x.money.indexOf(v) >= 0; }); }); })[0]
        || groups.filter(function (g) { return !g.code && g.desc === it.desc; })[0];
      if (!g) { g = { code: null, desc: it.desc, items: [] }; groups.push(g); }
      g.items.push(it);
    });
    return groups.map(function (g) {
      var best = g.items.reduce(function (b, x) { return x.score > b.score || (x.score === b.score && x.l.length > b.l.length) ? x : b; });
      return { first: Math.min.apply(null, g.items.map(function (x) { return x.i; })), l: best.l };
    }).sort(function (a, b) { return a.first - b.first; }).map(function (g) { return g.l; });
  }

  // ── Order ──
  var EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
  function extractOrder(page) {
    var all = String(page.text || ""), o = {};
    var n = ORDER_NO.exec(all); if (n) o.number = n[1];
    var d = ORDER_DATE.exec(all); if (d) o.date = d[1];
    // v1.3: the checkout email — a filled email field (the form's "Email used" beats the supplier default with it).
    var em = fieldsOf(page).filter(function (f) { return /e-?mail/i.test(String(f.label || "")) && EMAIL_RE.test(String(f.value || "").trim()); })[0];
    if (em) o.email = String(em.value).trim().toLowerCase();
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
  /** A confirmation line shows one money per item — the line total ("Qty 12 / $95.64"): when the newer price is the known unit price × qty, it is the total, not a new price. */
  function reconcileProduct(existing, incoming) {
    var p = Object.assign({}, incoming);
    if (existing.price != null && p.price != null && p.qty != null && p.qty > 1 && Math.abs(toNum(p.price) - toNum(existing.price) * p.qty) < 0.011) { p.total = p.price; p.price = existing.price; }
    return p;
  }
  function mergeBuckets(prev, next) {
    var a = prev || emptyBuckets(), b = next || {};
    var prevProducts = a.products || [];
    var incoming = (b.products || []).map(function (p) { var e = prevProducts.filter(function (x) { return productKey(x) === productKey(p); })[0]; return e ? reconcileProduct(e, p) : p; });
    return {
      products: upsert(prevProducts, incoming, productKey),
      shipping: b.shipping ? b.shipping : (a.shipping || null),
      payment: {
        cards: upsert((a.payment || {}).cards || [], (b.payment || {}).cards || [], function (c) { return c.last4 || normName(c.nickname); }),
        giftCards: upsert((a.payment || {}).giftCards || [], (b.payment || {}).giftCards || [], function (g) { return g.last4 || g.amount; }),
      },
      // v1.2.7: the newest page that shows totals replaces the whole figure — a field it lacks (a checkout that says "Enter your address to view shipping options") is gone, not kept from an older page.
      totals: Object.assign({}, (b.totals && (b.totals.subtotal || b.totals.total)) ? b.totals : (a.totals || {})),
      promos: dedupePromos((a.promos || []).concat(b.promos || [])),
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
  // canOpen() is gone (v1.2.4): the buckets are a preview, not a gate — Open in AF is always enabled.

  // ── The per-tab capture record (chrome.storage.session, key capture:<tabId>) ──
  function captureKey(tabId) { return "capture:" + tabId; }
  function newCapture(host) { return { host: host, pages: {}, others: [], count: 0, updatedAt: null, buckets: emptyBuckets(), previews: {}, previewPending: [], previewError: null }; }
  /** v1.3: does this page still need its AI preview? (false when the record already holds one for its key) */
  function needsPreview(cap, key) { return !!key && !(cap && cap.previews && cap.previews[key]); }
  /** The pages the prefill endpoint receives: one per checkout step (the latest capture of a step) plus up to six "other" pages — as before 1.2. */
  function pagesOf(cap) { return [].concat(Object.keys((cap && cap.pages) || {}).map(function (k) { return cap.pages[k]; }), (cap && cap.others) || []); }
  /**
   * v1.3: one page's buckets with its AI preview laid over the rules. The AI's products (when it read any), payment
   * (when it read any), totals (when it read a subtotal or total) and promos (whenever it answered — it tells a real
   * code from a category link) win; the rules keep the SELECTED ship-to (the checked radio), the AI's street fills
   * in when they found none; the order fields merge, the AI's newest. Pure.
   */
  function overlayPreview(rule, ai) {
    if (!ai) return rule;
    var r = rule || emptyBuckets();
    var aiPay = ai.payment || { cards: [], giftCards: [] };
    var shipFilled = !!(r.shipping && (r.shipping.street || (r.shipping.candidates || []).length));
    return {
      products: (ai.products || []).length ? ai.products : r.products,
      shipping: shipFilled ? r.shipping : (ai.shipping || r.shipping || null),
      payment: ((aiPay.cards || []).length || (aiPay.giftCards || []).length) ? aiPay : r.payment,
      totals: ai.totals && (ai.totals.subtotal || ai.totals.total) ? ai.totals : r.totals,
      promos: Array.isArray(ai.promos) ? ai.promos : r.promos,
      order: assignNewer(Object.assign({}, r.order || {}), ai.order || {}),
    };
  }
  function pageBuckets(cap, p) {
    var ai = p.previewKey && cap && cap.previews ? cap.previews[p.previewKey] : null;
    return overlayPreview(extractBuckets(p), ai || null);
  }
  function rebuild(cap) {
    return pagesOf(cap).slice().sort(function (p, q) { return String(p.capturedAt || "").localeCompare(String(q.capturedAt || "")); }).reduce(function (b, p) { return mergeBuckets(b, pageBuckets(cap, p)); }, emptyBuckets());
  }
  /** v1.3: the AI preview of one page arrived (or failed: buckets null) — store it under the page key, rebuild. Pure. */
  function applyPreview(cur, key, buckets, error) {
    if (!cur) return cur;
    var c = JSON.parse(JSON.stringify(cur));
    c.previews = c.previews || {};
    if (buckets) c.previews[key] = buckets;
    c.previewPending = (c.previewPending || []).filter(function (k) { return k !== key; });
    c.previewError = buckets ? null : (error || "the AI preview failed");
    c.buckets = rebuild(c);
    return c;
  }
  /** v1.3: the panel's AI line — "reading…" while a page waits, "off" / the error when it failed, "read" when every page has one. */
  function previewStatus(cap) {
    if (!cap || !cap.count) return null;
    if ((cap.previewPending || []).length) return "AI reading…";
    if (cap.previewError) return cap.previewError;
    var all = pagesOf(cap), read = all.filter(function (p) { return p.previewKey && cap.previews && cap.previews[p.previewKey]; }).length;
    return read ? (read === all.length ? "AI read" : "AI read " + read + " of " + all.length) : null;
  }
  /** Add one captured page to a tab's capture. Pure: returns the new record. v1.2.7: the buckets are rebuilt from the pages (oldest first, newest wins) on every capture, so re-capturing a step replaces that step's values — nothing from a page since replaced survives. */
  function applyPage(cur, page, host, now) {
    var c = cur ? JSON.parse(JSON.stringify(cur)) : newCapture(host);
    var entry = Object.assign({}, page, { capturedAt: now });
    if (page.step === "other" || !page.step) c.others = (c.others || []).filter(function (p) { return p.url !== page.url; }).concat([entry]).slice(-6);
    else { c.pages = c.pages || {}; c.pages[page.step] = entry; }
    c.host = host; c.updatedAt = now;
    c.count = Object.keys(c.pages || {}).length + (c.others || []).length;
    // v1.3: previews of pages no longer in the record go; a page whose preview is already here needs no call.
    var keys = pagesOf(c).map(function (p) { return p.previewKey; }).filter(Boolean);
    c.previews = Object.keys(c.previews || {}).reduce(function (o, k) { if (keys.indexOf(k) >= 0) o[k] = c.previews[k]; return o; }, {});
    if (page.previewKey && !c.previews[page.previewKey] && (c.previewPending || []).indexOf(page.previewKey) < 0) c.previewPending = (c.previewPending || []).concat([page.previewKey]);
    c.previewPending = (c.previewPending || []).filter(function (k) { return keys.indexOf(k) >= 0; });
    c.buckets = rebuild(c);
    return c;
  }
  /** "Copy page text" (v1.2.3, options page → debug): every captured page of the tab, oldest first — step, URL, title, time, size, the scrubbed innerText EXACTLY as stored (tabs included — the header counts the tab-joined lines so a paste that lost them is recognisable) and every field as one JSON line. */
  function debugText(cap, now) {
    var pages = pagesOf(cap).slice().sort(function (p, q) { return String(p.capturedAt || "").localeCompare(String(q.capturedAt || "")); });
    var tabbed = pages.reduce(function (n, p) { return n + String(p.text || "").split("\n").filter(function (l) { return l.indexOf("\t") >= 0; }).length; }, 0);
    var out = ["AsinFlow capture · " + String((cap && cap.host) || "—") + " · " + pages.length + " page" + (pages.length === 1 ? "" : "s") + " · " + tabbed + " tab-joined line" + (tabbed === 1 ? "" : "s") + " · copied " + (now || new Date().toISOString()) + " · card numbers were masked in the page"];
    pages.forEach(function (p, i) {
      var f = Array.isArray(p.fields) ? p.fields : [];
      out.push("", "=== page " + (i + 1) + " · step " + String(p.step || "other") + " · " + String(p.url || "") + " · " + String(p.title || "").replace(/\s+/g, " ") + " · captured " + String(p.capturedAt || "") + " · " + String(p.text || "").length + " chars ===", String(p.text || ""), "--- fields (" + f.length + ") ---");
      f.forEach(function (x) { out.push(JSON.stringify(x)); });
    });
    return out.join("\n");
  }
  function pagesForPrefill(cap) { return pagesOf(cap).map(function (p) { return { step: p.step, url: p.url, title: p.title, text: p.text, fields: p.fields || [] }; }); }
  /** v1.3: the checkout email the buckets found, for the prefill (beats the supplier default); null when none. */
  function checkoutEmailForPrefill(cap) { var e = cap && cap.buckets && cap.buckets.order && cap.buckets.order.email; return e && EMAIL_RE.test(e) ? e : null; }
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
    // v1.2.5: a typed address shows its city / state / ZIP after the street.
    var tail = shipping.fromFields ? [shipping.city, [shipping.state, shipping.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ") : "";
    if (shipping.street) return [one(shipping.street) + (tail ? " (" + tail + ")" : "")];
    return (shipping.candidates || []).map(one);
  }

  var api = {
    BUCKETS: BUCKETS, LABELS: LABELS, emptyBuckets: emptyBuckets, extractBuckets: extractBuckets, mergeBuckets: mergeBuckets,
    extractProducts: extractProducts, extractShipping: extractShipping, extractPayment: extractPayment, extractTotals: extractTotals, extractPromos: extractPromos, dedupePromos: dedupePromos, extractOrder: extractOrder,
    filled: filled, missing: missing, streetIn: streetIn, normStreet: normStreet, addressFromFields: addressFromFields,
    captureKey: captureKey, newCapture: newCapture, applyPage: applyPage, overlayPreview: overlayPreview, applyPreview: applyPreview, previewStatus: previewStatus, needsPreview: needsPreview, checkoutEmailForPrefill: checkoutEmailForPrefill, pagesForPrefill: pagesForPrefill, shipToForPrefill: shipToForPrefill, othersCapturing: othersCapturing, debugText: debugText,
    shipToKind: shipToKind, describeShipping: describeShipping,
  };
  root.AfBuckets = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
