// Capture PO — page capture (AsinFlow Chrome extension; patch
// docs/claude_spec-patch-po-ai-prefill.md §4.2). Injected on demand by the
// background worker (chrome.scripting.executeScript, after scrub.js) when
// Maria clicks "Capture this page"; its return value is the capture of the
// current page, ALREADY SCRUBBED (scrub.js runs here, inside the page, so
// nothing card-like ever leaves the browser). Never raw HTML, never a
// screenshot: document.title, the URL without its query string, the
// rendered text (innerText of body, hidden elements excluded by the browser)
// and the current values of input / select / textarea elements with their
// labels — password inputs are never read. A checked radio / checkbox gives
// the text of the option it sits in as a "selected: <label>" field (v1.2),
// so the SELECTED shipping address, payment method and subscription choice
// reach the buckets and the AI, not the first block on the page.
(function () {
  "use strict";
  var S = globalThis.AfScrub;
  if (!S) return { error: "scrub.js did not load" };

  function labelFor(el) {
    var t = [];
    if (el.id) { var l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l) t.push(l.innerText); }
    var wrap = el.closest("label"); if (wrap) t.push(wrap.innerText);
    if (el.getAttribute("aria-label")) t.push(el.getAttribute("aria-label"));
    if (el.getAttribute("placeholder")) t.push(el.getAttribute("placeholder"));
    if (el.name) t.push(el.name);
    if (el.id) t.push(el.id);
    var lab = t.map(function (x) { return String(x || "").replace(/\s+/g, " ").trim(); }).filter(Boolean)[0] || "";
    return lab.slice(0, 200);
  }

  function visible(el) {
    if (!(el instanceof Element)) return false;
    var r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    var cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none";
  }

  /** The text of the option a checked radio / checkbox sits in (its label or the nearest ancestor with 12–400 characters of text): the SELECTED shipping address, payment method or subscription choice, not the first block on the page. */
  function selectionContext(el) {
    var node = el.closest("label") || el.parentElement;
    for (var depth = 0; node && depth < 6; depth++, node = node.parentElement) {
      var t = String(node.innerText || "").replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim();
      if (t.length > 400) break;
      if (t.length >= 12) return t;
    }
    return "";
  }

  function fields() {
    var out = [];
    var els = document.querySelectorAll("input, select, textarea");
    for (var i = 0; i < els.length && out.length < 500; i++) {
      var el = els[i];
      var type = (el.getAttribute("type") || el.tagName).toLowerCase();
      if (type === "password" || type === "hidden" || type === "submit" || type === "button" || type === "file" || type === "image") continue;
      if (!visible(el)) continue;
      var value;
      if (type === "checkbox" || type === "radio") {
        if (!el.checked) continue;
        var ctx = selectionContext(el);
        var sel = S.scrubField("selected: " + labelFor(el), (ctx || (el.value && el.value !== "on" ? el.value : "checked")).slice(0, 600));
        if (sel) out.push(sel);
        continue;
      }
      else if (el.tagName === "SELECT") { var o = el.options[el.selectedIndex]; value = o ? (o.text || o.value) : ""; }
      else value = el.value;
      value = String(value == null ? "" : value).trim();
      if (!value) continue;
      var f = S.scrubField(labelFor(el), value.slice(0, 2000));
      if (f) out.push(f);
    }
    return out;
  }

  function stepGuess() {
    var u = (location.pathname + " " + document.title + " " + (document.querySelector("h1") ? document.querySelector("h1").innerText : "")).toLowerCase();
    if (/thank|confirm|receipt|order (placed|summary|details)|review/.test(u)) return "review";
    if (/pay|billing|credit card/.test(u)) return "payment";
    if (/ship|deliver|address/.test(u)) return "shipping";
    if (/cart|basket|bag/.test(u)) return "cart";
    return "other";
  }

  var text = S.scrubText((document.body && document.body.innerText) || "");
  return {
    url: location.origin + location.pathname,
    title: String(document.title || "").slice(0, 500),
    step: stepGuess(),
    text: text.slice(0, 200000),
    fields: fields(),
    chars: text.length,
  };
})();
