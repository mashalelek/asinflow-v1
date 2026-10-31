// purchase_orders.payment_method (free text, 222 distinct values on 2,494 POs
// at the 2026-10-30 probe) → po_payments rows (patch po-ai-prefill §8.2,
// migration 075). Pure. Shapes seen:
//   "Gift cards"                         one row, no amount
//   "Amex (1001)" / "Visa 7927"          card nickname + last 4
//   "Amex (1001) (through PayPal)"       the card, charged through PayPal → paypal
//   "Gift cards: $200, Amex (1001): $9.35"   several, each with an amount
//   "Gift Cards ($167.19), Visa 7927 ($6.39)"  the same with parentheses
//   "Gift cards: 7204, 9283, 7246"       one gift card per last 4
//   "Walmart balance: $37.96", "Rewards: $25.35", "Walmart cash: $0.75" → store_credit
//   "?", "Check after it's processed…"   other, needs_review
// Anything that does not parse becomes ONE `other` row holding the text,
// flagged needs_review — nothing is dropped and nothing is guessed.

export type PaymentMethod = "card" | "gift_card" | "store_credit" | "paypal" | "other";
export interface PaymentDraft {
  method: PaymentMethod;
  nickname: string | null;
  last4: string | null;
  amount: string | null;   // "123.45"; null = not recorded
  needs_review: boolean;
}

const money = (s: string | undefined | null): string | null | "bad" => {
  const v = String(s ?? "").replace(/[$,\s]/g, "");
  if (v === "") return null;
  return /^\d+(\.\d{1,2})?$/.test(v) ? Number(v).toFixed(2) : "bad";
};

/** The method a payment name stands for; null when nothing in it is recognisable. */
export function methodForName(name: string): PaymentMethod | null {
  const n = name.toLowerCase();
  if (/gift ?cards?/.test(n)) return "gift_card";
  if (/paypal/.test(n)) return "paypal";
  if (/rewards?|balance|\bcash\b|credit|refund/.test(n)) return "store_credit";
  if (/\bcard\b|visa|amex|chase|citi|discover|capital ?one|mastercard|master card/.test(n)) return "card";
  return null;
}

/** One "Name (1234)" / "Name 1234" part → draft (amount attached by the caller). */
function fromName(raw: string, amount: string | null, badAmount: boolean): PaymentDraft {
  let name = raw.trim();
  let viaPaypal = false;
  if (/\(through paypal\)/i.test(name)) { viaPaypal = true; name = name.replace(/\s*\(through paypal\)\s*/i, " ").trim(); }
  let last4: string | null = null;
  const m = /^(.*?)\s*\(?\s*(\d{4})\s*\)?\s*$/.exec(name);
  if (m && m[1].trim() !== "") { last4 = m[2]; name = m[1].trim(); }
  const method = viaPaypal ? "paypal" : methodForName(name);
  return { method: method ?? "other", nickname: name || null, last4, amount, needs_review: method == null || badAmount };
}

export function parsePaymentMethod(text: string | null | undefined): PaymentDraft[] {
  const s0 = String(text ?? "").trim();
  if (s0 === "") return [];
  // "Gift cards: 7204, 9283, 7246" — one gift card per last 4.
  const gcList = /^gift ?cards?\s*:\s*((?:\d{4}\s*(?:,\s*)?)+)$/i.exec(s0);
  if (gcList) return gcList[1].match(/\d{4}/g)!.map((l4) => ({ method: "gift_card" as const, nickname: "Gift cards", last4: l4, amount: null, needs_review: false }));
  // A missing separator after an amount ("…: $7.12Gift cards: $65,") gets one.
  const s = s0.replace(/(\$[\d,]*\.?\d+)(?=[A-Za-z])/g, "$1, ").replace(/,\s*$/, "");
  // Split into parts on commas that start a new name (not the thousands comma inside "$1,000").
  const parts = s.split(/,\s*(?=[A-Za-z?])/).map((p) => p.trim()).filter(Boolean);
  const out: PaymentDraft[] = [];
  for (const part of parts) {
    let m: RegExpExecArray | null;
    if ((m = /^(.+?)\s*:\s*(.*)$/.exec(part))) {
      const amt = money(m[2]);
      out.push(fromName(m[1], amt === "bad" ? null : amt, amt === "bad"));
    } else if ((m = /^(.+?)\s*\(\s*(\$[\d,]*\.?\d*)\s*\)\s*$/.exec(part))) {
      const amt = money(m[2]);
      out.push(fromName(m[1], amt === "bad" ? null : amt, amt === "bad"));
    } else {
      out.push(fromName(part, null, false));
    }
  }
  // A text that parsed into nothing recognisable at all: ONE other row holding it verbatim.
  if (out.length > 0 && out.every((d) => d.method === "other")) return [{ method: "other", nickname: s0, last4: null, amount: null, needs_review: true }];
  return out;
}
