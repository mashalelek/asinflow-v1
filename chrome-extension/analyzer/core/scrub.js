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
//   - 2.0.2 (Maria 2026-11-05): payment-form values never leave the browser.
//     capture.js asks isCardInput() about every input; inside the form (or
//     fieldset) of one, paymentFormField() keeps only what AF stores — a card
//     number's last 4 and a card / payment-method nickname ("Master Card") —
//     and every other value (name on card, billing address, security code,
//     expiry, however the form names them) is emptied; labels and page text
//     stay. isSecretInput(): a password or an autocomplete cc-csc / cc-exp* /
//     cc-number / cc-name input, on any page, in any form. The label rules
//     here are the second layer; the server's re-scrub the third.
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

  // ── 2.0.2: payment forms (the capture script's first layer) ──
  var CC_AUTOCOMPLETE = /(?:^|\s)cc-[a-z-]+/i;
  var SECRET_AUTOCOMPLETE = /(?:^|\s)cc-(?:csc|exp(?:-month|-year)?|number|name|given-name|family-name|additional-name)(?:\s|$)/i;
  var CARD_HINT = /card\s*(?:no|num(?:ber)?)|\bccno\b|\bcc\s*(?:no|num(?:ber)?)\b|\bcvv2?\b|\bcvc2?\b|\bcsc\b|\bcvn\b|security\s*code|\bsec\s*no\b|\bsecno\b|name\s*on\s*card|card\s*holder|cardholder|card\s*verification/i;
  var CARD_NO_HINT = /card\s*(?:no|num(?:ber)?)|\bccno\b|\bcc\s*(?:no|num(?:ber)?)\b/i;
  var NICKNAME_LABEL = /\b(?:card\s*type|cc\s*type|card\s*brand|brand|payment\s*(?:method|type)|nickname)\b/i;
  var CARD_BRAND = /^(?:visa|master\s*card|mastercard|amex|american\s*express|discover|jcb|diners(?:\s*club)?|union\s*pay|maestro|paypal|apple\s*pay|google\s*pay|gift\s*card|store\s*credit)$/i;
  function digitsOf(v) { return String(v == null ? "" : v).replace(/\D/g, ""); }
  /** A card-number-shaped value: 13–19 digits with only spaces / dashes between them, a card network's prefix, Luhn-valid. */
  function cardShaped(value) { var v = String(value == null ? "" : value).trim(), d = digitsOf(v); return /^[\d \-]+$/.test(v) && d.length >= 13 && d.length <= 19 && cardPrefix(d) && luhn(d); }
  /** An input that marks its form as a payment form: autocomplete cc-*, a card label (by its words or the form's own name), or a card-number-shaped value. Pure. */
  function isCardInput(label, autocomplete, value) {
    return CC_AUTOCOMPLETE.test(String(autocomplete || "")) || CARD_HINT.test(fieldWords(label || "")) || cardShaped(value);
  }
  /** A password, or an autocomplete cc-csc / cc-exp / cc-number / cc-name input — its value never leaves, on any page. Pure. */
  function isSecretInput(type, autocomplete) { return String(type || "").toLowerCase() === "password" || SECRET_AUTOCOMPLETE.test(String(autocomplete || "")); }
  /** A field inside a payment form (or a secret input anywhere): only a card number's last 4 and a card / payment-method nickname keep a value. Pure. */
  function paymentFormField(label, value, autocomplete) {
    var l = String(label == null ? "" : label), v = String(value == null ? "" : value).trim(), w = fieldWords(l), ac = String(autocomplete || "");
    var cardNo = /(?:^|\s)cc-number(?:\s|$)/i.test(ac) || CARD_NO_HINT.test(w) || cardShaped(v);
    if (cardNo) { var d = digitsOf(v); return { label: l, value: d.length >= 4 && (d.length >= 12 || /•|\*/.test(v)) ? "•••• " + d.slice(-4) : "" }; }
    if (!SECRET_AUTOCOMPLETE.test(ac) && v.length <= 40 && !/\d/.test(v) && (CARD_BRAND.test(v) || /(?:^|\s)cc-type(?:\s|$)/i.test(ac) || (NICKNAME_LABEL.test(w) && !CARD_HINT.test(w)))) return { label: l, value: v };
    return { label: l, value: "" };
  }

  /** Stored fields (no DOM left) scrubbed again: the label rules, and when any field is a card input, the payment-form rule on every field but the checked options. Pure. */
  function rescrubFields(fields) {
    var fs = (fields || []).map(function (f) { return scrubField(f && f.label, f && f.value); }).filter(Boolean);
    var payment = fs.some(function (f) { return !/^selected:/i.test(f.label) && isCardInput(f.label, "", f.value); });
    return payment ? fs.map(function (f) { return /^selected:/i.test(f.label) ? f : paymentFormField(f.label, f.value, ""); }) : fs;
  }

  var api = { luhn: luhn, cardPrefix: cardPrefix, maskCardRuns: maskCardRuns, removeExpiries: removeExpiries, removeCvvs: removeCvvs, maskGiftCards: maskGiftCards, scrubText: scrubText, scrubField: scrubField, isCardInput: isCardInput, isSecretInput: isSecretInput, paymentFormField: paymentFormField, cardShaped: cardShaped, rescrubFields: rescrubFields };
  root.AfScrub = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
