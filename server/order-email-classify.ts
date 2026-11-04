// Order email → document type by subject (SPEC §26 "PO documents ingest";
// Maria 2026-11-04 — the ShagTools PO 4126643 got no document). Pure: no
// I/O. The rules come from a 90-day sample of orders@ across the top 30
// suppliers by PO count (12,265 messages, promotions included), wording
// common across retailers rather than one store's:
//
//   confirmation  "we've received your order", "your Zoro order # has been
//                 received", "got it! your order # confirmation",
//                 "confirmation for your order", "here's your Staples order",
//                 "thanks for your order", "order placed / confirmed";
//   invoice       "[ShagTools] Invoice 4126643 for order 4126643", "Zoro: your
//                 receipt for order #";
//   shipped       "has shipped", "is shipped", "on its way", "heading your
//                 way", "left our warehouse", "shipping confirmation",
//                 "your ShagTools order is now complete";
//   delivered     "has been delivered", "your order has arrived", "items
//                 have arrived from order #" (Target), "Arrived: …" (Walmart),
//                 "success! order # has arrived" (Walgreens), "your package
//                 has arrived" (Petco, Chewy).
//
// Never a document: cancellations, refunds, returns; cart reminders
// ("complete your order"); review and survey requests; "new arrivals" and
// other marketing (an "arrived" needs an order / package / item word);
// in-between notices ("out for delivery", "arrives tomorrow", "ready to
// ship", "delayed"). A subject no rule names and no exclusion stops is
// "unknown" — the AI fallback's input (server/po-documents.ts), asked only
// when the email already names exactly one PO.
//
// Order: exclusions, then delivered, shipped, invoice, confirmation — the
// later stage wins over the earlier one's leftover words ("Thanks for your
// order — it has shipped" is shipped; "Your order shipped: Receipt #" too).
import type { PoDocumentType } from "@shared/po-documents";

export type EmailDocType = Exclude<PoDocumentType, "invoice_manual">;
export type SubjectClass = { type: EmailDocType; rule: string } | { type: "excluded"; rule: string } | { type: "unknown" };

const W = "(?:[\\w.&'’-]+\\s+){0,4}?"; // up to four words (a store's name: "your ShagTools order", "your Pyramyd AIR order")

const EXCLUDE: Array<[string, RegExp]> = [
  ["cancel_refund_return", /\b(cancel+(?:ed|ation)?|refund(?:ed)?|returns?|returned|exchange)\b/i],
  ["cart", /\b(complete your (?:order|purchase|checkout)|ready to complete|(?:left|still) in your (?:cart|bag)|your (?:cart|bag)\b|forget something|still (?:interested|thinking))/i],
  ["review", /\b(review|rate (?:your|us)|how (?:was|did|are|do|is)|what (?:do|did) you think|meet your expectations|opinion matters|voice matters|feedback|survey|tell us|share your)\b/i],
  ["account", /\b(coupon|gift card|subscription|reminder|substitution|out of stock|couldn'?t complete|could not complete|replacement request|credit applied)\b/i],
  ["marketing_arrival", /\b(new arrivals?|just (?:arrived|dropped|landed)|has arrived[^.]*\b(?:sale|collection|deals?|season|holiday|savings)|(?:sale|collection|deals?|season|holiday) (?:is|has) (?:here|arrived))\b/i],
  ["in_between", /\b(out for delivery|arriv(?:e|es|ing) (?:today|tomorrow|soon|on|by|in)|(?:will|should|estimated to) arrive|almost here|(?:be )?there soon|scheduled for delivery|(?:new|updated) (?:estimated )?delivery date|running behind|delivery attempted|multiple shipments|about to ship|ready to ship|getting ready to ship|delay(?:ed)?|on hold|ready for (?:pick\s?up|purchase)|pick(?:ed)?\s?up|backorder(?:ed)?|payment (?:failed|declined|due|issue)|action (?:needed|required)|update your payment)\b/i],
];

const DELIVERED: Array<[string, RegExp]> = [
  ["delivered", /\b(?:has|have|was|were|been|is|are)\s+(?:now\s+|been\s+)?delivered\b|^\s*(?:\W*\s*)?delivered\b|\bdelivered\s*[:!]|\bdelivery (?:confirmation|complete)\b/i],
  ["arrived", new RegExp(`(?:\\b(?:order|package|parcel|item|items|shipment|delivery|box)\\b[^!?.]*\\b(?:has|have)\\s+arrived\\b|\\b(?:has|have)\\s+arrived\\b[^!?.]*\\b(?:from )?order\\b|^\\s*(?:\\W*\\s*)?arrived\\s*:)`, "i")],
];

const SHIPPED: Array<[string, RegExp]> = [
  ["shipped", /\bshipped\b/i],
  ["on_its_way", /\bon (?:the|its|their) way\b|\bheading (?:your|to you|its) way\b|\bon the move\b|\bin transit\b|\b(?:now )?with the carrier\b/i],
  ["left_warehouse", /\b(?:left|leaving|shipped from) (?:our|the) (?:warehouse|facility|store)\b/i],
  ["shipping_confirmation", /\bship(?:ping|ment) (?:confirmation|notification|notice|update)\b|\bshipment (?:from|of|for) (?:your )?order\b|\bhere(?:'s|’s| is) your tracking\b|\btracking (?:number|info(?:rmation)?) for\b/i],
  ["order_complete", new RegExp(`\\b(?:your\\s+${W})?order\\s+(?:#?\\s*[A-Z0-9-]*\\d[A-Z0-9-]*\\s+)?(?:is\\s+|has been\\s+)?(?:now\\s+)?(?:complete|completed|fulfilled)\\b`, "i")],
];

const INVOICE: Array<[string, RegExp]> = [
  ["invoice_for_order", /\binvoice\b[^!?]*\b(?:for|of|from)\s+(?:your\s+)?order\b|^\s*(?:\[[^\]]+\]\s*)?invoice\s+#?\s*[A-Z0-9-]*\d|\byour\s+(?:\S+\s+)?invoice\b/i],
  ["receipt_for_order", new RegExp(`\\border receipt\\b|\\breceipt\\s+(?:for|of)\\s+(?:your\\s+)?${W}order\\b|\\byour\\s+${W}receipt\\b(?!\\s+#)`, "i")],
];

const CONFIRMATION: Array<[string, RegExp]> = [
  ["received", new RegExp(`\\bwe(?:'ve|’ve|\\s+have)?\\s+(?:got|received)\\s+your\\s+${W}order\\b|\\bgot it!|\\byour\\s+${W}order\\s+(?:#?\\s*[A-Z0-9-]*\\d[A-Z0-9-]*\\s+)?(?:has been|was|is)\\s+(?:received|placed|confirmed)\\b|\\border\\s+(?:#?\\s*[A-Z0-9-]*\\d[A-Z0-9-]*\\s+)?(?:has been\\s+)?(?:received|placed|confirmed)\\b`, "i")],
  ["confirmation", new RegExp(`\\border\\b[^!?]{0,60}\\bconfirm(?:ed|ation)\\b|\\bconfirm(?:ation|ed)\\s+(?:for|of)\\s+(?:your\\s+)?${W}order\\b|\\bpurchase confirmation\\b`, "i")],
  ["thanks", new RegExp(`\\bthanks?\\s+(?:you\\s+)?for\\s+(?:your\\s+)?${W}(?:order|ordering|purchase|shopping)\\b`, "i")],
  ["heres_your_order", new RegExp(`\\bhere(?:'s|’s| is)\\s+your\\s+${W}order\\b`, "i")],
];

/** Pure: the document type a subject names, an exclusion, or unknown. */
export function classifySubject(subject: string): SubjectClass {
  const s = (subject ?? "").replace(/^\s*(?:(?:fwd?|re)\s*:\s*)+/i, "");
  for (const [rule, re] of EXCLUDE) if (re.test(s)) return { type: "excluded", rule };
  for (const [type, rules] of [["delivered", DELIVERED], ["shipped", SHIPPED], ["invoice", INVOICE], ["order_confirmation", CONFIRMATION]] as const) {
    for (const [rule, re] of rules) if (re.test(s)) return { type, rule };
  }
  return { type: "unknown" };
}
