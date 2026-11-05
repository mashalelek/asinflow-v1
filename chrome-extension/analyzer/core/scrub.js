// Capture PO — scrubbing (AsinFlow Chrome extension; patch
// docs/claude_spec-patch-po-ai-prefill.md §4.3). Runs INSIDE the page
// before anything leaves the browser, on every captured text and form value:
//   - any run of 13–19 digits (spaces / dashes allowed) that passes Luhn AND
//     starts like a card (2221–2720, or 3–6: Amex, Visa, Mastercard, Discover,
//     JCB, Diners, UnionPay, Maestro) → "•••• " + its last 4 (card numbers;
//     gift cards that are card-like too). Never a run right after an order /
//     confirmation / invoice / tracking label: 2026-11-04, Walmart order
//     #200015468871641 passes Luhn (one number in ten does) and was masked,
//     so neither the panel nor the prefill saw its order #.
//   - a 3–4 digit value whose label says cvv / cvc / security code → removed;
//     field labels are read with _ . - as spaces, so a form's own names count
//     ("SECNO_NEW", "card_cvv", "EXP.MONTH", "CCNO" — 2026-11-05, Gordon's
//     payment form sent its security code through under SECNO_NEW)
//   - an expiry month / year field (1–2 or 4 digits) → removed; a card-number
//     field (ccno, card number) with 8+ digits → its last 4 kept
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
  /** The first digits of a card network (ISO/IEC 7812 issuer ranges in use for payment cards). */
  function cardPrefix(digits) {
    var f = digits.charAt(0), p4 = Number(digits.slice(0, 4));
    return f === "3" || f === "4" || f === "5" || f === "6" || (p4 >= 2221 && p4 <= 2720);
  }
  // An order / confirmation / invoice / tracking / reference label just before the run: an id, never a card.
  var ID_LABEL_BEFORE = /\b(?:order|confirmation|invoice|tracking|reference|ref|receipt|transaction)\s*(?:#|number|no\.?|id|num)?\s*[:#]?\s*#?\s*$/i;
  var CVV_LABEL = /\b(cvv2?|cvc2?|cid|security\s*code|card\s*verification)\b/i;
  var EXP_LABEL = /\b(exp(?:iry|iration|ires)?\.?|valid(?:\s*thru|\s*through)?)\b/i;
  var EXPIRY = /\b(0[1-9]|1[0-2])\s*\/\s*(\d{2}|\d{4})\b/g;
  var GIFT_LABEL = /\b(e-?gift|gift\s*card|gift\s*certificate|egc)\b/i;
  // Field labels only (a form's name / id as well as its visible label).
  var CVV_FIELD = /\b(cvv2?|cvc2?|cvn|cv2|csc|cid|sec(?:urity)?\s*(?:no|num(?:ber)?|code|cd)|card\s*verification|verification\s*(?:code|value|number))\b/i;
  var CARD_NO_FIELD = /\b(cc\s*(?:no|num(?:ber)?)|ccno|card\s*(?:no|num(?:ber)?)|credit\s*card)\b/i;
  /** A field label with its separators read as spaces ("SECNO_NEW" → "SECNO NEW", "EXP.MONTH" → "EXP MONTH"). */
  function fieldWords(l) { return String(l).replace(/[_.\-]+/g, " "); }

  /** Card-number runs → "•••• 1234". Pure. */
  function maskCardRuns(text) {
    var s = String(text == null ? "" : text);
    return s.replace(CARD_RUN, function (m, offset) {
      var digits = m.replace(/\D/g, "");
      if (!luhn(digits) || !cardPrefix(digits)) return m;
      if (ID_LABEL_BEFORE.test(s.slice(Math.max(0, offset - 30), offset))) return m;
      return "•••• " + digits.slice(-4);
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
    var w = fieldWords(l);
    if ((CVV_LABEL.test(w) || CVV_FIELD.test(w)) && /^\s*\d{3,4}\s*$/.test(v)) return null;
    if (EXP_LABEL.test(w) && /^\s*(?:(0?[1-9]|1[0-2])\s*\/?\s*\d{2,4}|\d{1,2}|\d{4})\s*$/.test(v)) return null;
    if (CARD_NO_FIELD.test(w)) { var cd = v.replace(/\D/g, ""); if (cd.length >= 8) return { label: l, value: "•••• " + cd.slice(-4) }; }
    if (GIFT_LABEL.test(w)) { var d = v.replace(/\D/g, ""); if (d.length >= 8) return { label: l, value: "•••• " + d.slice(-4) }; }
    return { label: l, value: scrubText(v) };
  }

  var api = { luhn: luhn, cardPrefix: cardPrefix, maskCardRuns: maskCardRuns, removeExpiries: removeExpiries, removeCvvs: removeCvvs, maskGiftCards: maskGiftCards, scrubText: scrubText, scrubField: scrubField };
  root.AfScrub = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
