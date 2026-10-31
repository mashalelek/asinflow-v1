// Capture PO — scrubbing (AsinFlow Chrome extension; patch
// docs/claude_spec-patch-po-ai-prefill.md §4.3). Runs INSIDE the page
// before anything leaves the browser, on every captured text and form value:
//   - any run of 13–19 digits (spaces / dashes allowed) that passes Luhn →
//     "•••• " + its last 4 (card numbers; gift cards that are card-like too)
//   - a 3–4 digit value whose label says cvv / cvc / security code → removed
//   - an expiry (MM/YY, MM/YYYY) within 40 characters of "exp" / "valid" → removed
//   - a gift-card / e-gift / gift-certificate number (8+ digits, by label or
//     within 40 characters after such a label) → its last 4 kept
//   - email addresses are kept (the form's "email used"); password inputs
//     are never read by the capture script in the first place.
// Plain script (no bundler): defines globalThis.AfScrub for capture.js and
// exports the same object for the vitest fixtures (server/extension-scrub.test.ts).
(function (root) {
  "use strict";

  function luhn(digits) {
    var sum = 0, alt = false;
    for (var i = digits.length - 1; i >= 0; i--) {
      var d = digits.charCodeAt(i) - 48;
      if (alt) { d *= 2; if (d > 9) d -= 9; }
      sum += d; alt = !alt;
    }
    return digits.length >= 13 && sum % 10 === 0;
  }

  var CARD_RUN = /(?<![\d])(?:\d[ -]?){12,18}\d(?![\d])/g;
  var CVV_LABEL = /\b(cvv2?|cvc2?|cid|security\s*code|card\s*verification)\b/i;
  var EXP_LABEL = /\b(exp(?:iry|iration|ires)?\.?|valid(?:\s*thru|\s*through)?)\b/i;
  var EXPIRY = /\b(0[1-9]|1[0-2])\s*\/\s*(\d{2}|\d{4})\b/g;
  var GIFT_LABEL = /\b(e-?gift|gift\s*card|gift\s*certificate|egc)\b/i;

  /** Card-number runs → "•••• 1234". Pure. */
  function maskCardRuns(text) {
    return String(text == null ? "" : text).replace(CARD_RUN, function (m) {
      var digits = m.replace(/\D/g, "");
      return luhn(digits) ? "•••• " + digits.slice(-4) : m;
    });
  }

  /** Expiry dates within 40 characters after an "exp" / "valid" word → removed. Pure. */
  function removeExpiries(text) {
    var s = String(text == null ? "" : text);
    var out = "", last = 0, re = new RegExp(EXPIRY.source, "g"), m;
    while ((m = re.exec(s))) {
      // The window never reaches back past the previous expiry: "Expiration 09/28 · Arrives 11/06" keeps the arrival date.
      var before = s.slice(Math.max(last, m.index - 40), m.index);
      if (EXP_LABEL.test(before)) { out += s.slice(last, m.index) + "[expiry removed]"; last = m.index + m[0].length; }
    }
    return out + s.slice(last);
  }

  /** "CVV: 123" / "Security code 1234" → removed. Pure. */
  function removeCvvs(text) {
    return String(text == null ? "" : text).replace(/\b(cvv2?|cvc2?|cid|security\s*code|card\s*verification)\b([^\d\n]{0,20})(\d{3,4})(?!\d)/gi, function (_m, label, sep) {
      return label + sep + "[removed]";
    });
  }

  /** Gift-card numbers (8+ digits) within 40 characters after a gift-card label → last 4 kept. Pure. */
  function maskGiftCards(text) {
    return String(text == null ? "" : text).replace(/\b(e-?gift|gift\s*card|gift\s*certificate|egc)\b([^\n]{0,40}?)((?:\d[ -]?){7,}\d)(?!\d)/gi, function (_m, label, sep, num) {
      var digits = num.replace(/\D/g, "");
      return label + sep + "•••• " + digits.slice(-4);
    });
  }

  /** The page's rendered text, scrubbed. Pure. */
  function scrubText(text) {
    return maskGiftCards(removeCvvs(removeExpiries(maskCardRuns(text))));
  }

  /** One form field by label + value. Pure. Returns null when the field must not be kept at all. */
  function scrubField(label, value) {
    var l = String(label == null ? "" : label), v = String(value == null ? "" : value);
    if (CVV_LABEL.test(l) && /^\s*\d{3,4}\s*$/.test(v)) return null;
    if (EXP_LABEL.test(l) && /^\s*(0?[1-9]|1[0-2])\s*\/?\s*\d{2,4}\s*$/.test(v)) return null;
    if (GIFT_LABEL.test(l)) { var d = v.replace(/\D/g, ""); if (d.length >= 8) return { label: l, value: "•••• " + d.slice(-4) }; }
    return { label: l, value: scrubText(v) };
  }

  var api = { luhn: luhn, maskCardRuns: maskCardRuns, removeExpiries: removeExpiries, removeCvvs: removeCvvs, maskGiftCards: maskGiftCards, scrubText: scrubText, scrubField: scrubField };
  root.AfScrub = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
