// Cancellation emails → suggested canceled claims (SPEC §22 "Supplier claims" §3.1 "canceled"; claims patch commit 5;
// the cancellations patch §4 classifier + retailer parsers, its po_cancellations table superseded — a cancellation
// lands directly as a SUGGESTED canceled claim with the email's items, qty (Individual units) and refund amount,
// source_email_id + source_items_json on the claim, the review_suggestion task under Needs attention → Decide).
//   classify   an email is a candidate when it carries cancellation language in its subject or the first part of its
//              body ("has been canceled", "Canceled: …", "items canceled", "out of stock … removed", "couldn't complete
//              your order", "unable to process your order", "cancellation notice / summary / confirmation", …) and is
//              not a subscription / membership / auto-refill cancel, a "delayed" notice (D4), a declined-payment or
//              payment-pending notice, or a gift card that is not Michaels' order credit.
//   forwarded  "---------- Forwarded message ---------" (Kohl's via maria@): sender, date and subject come from the
//              forwarded header block, the body is what follows it.
//   parse      one parser per retailer family (fixtures under server/__fixtures__/cancellation-emails/, scrubbed):
//              Walmart, Target (full order # when printed, else the last-4 rule), Sephora, Bath & Body Works,
//              BigBadToyStore, Oracle "Order Cancellation Summary", SupplyHouse, DK Hardware, Jellycat, the Shopify
//              "Refunded Items" template (Fenty, Ole Henriksen, Only Natural Pet), Urban Outfitters, Macy's, Staples,
//              Fleet Farm, Walgreens "adjusted and has shipped" (its Canceled section), Michaels' gift card, Kohl's,
//              Tennessee Valley Bicycles; a generic fallback (order #, scope from the wording, "Qty:" items); Haiku for
//              free text (source 'ai', one call per email, ≤ 25 per pass, logged in po_prefill_log kind 'cancellation',
//              never on a dry run).
//   match      the PO by supplier (sender domain → tracking.supplier_domain_map → aliases; a platform sender by the
//              order # alone) + normalised order #; Target's last 4 → the one Target PO of the last 60 days ending so;
//              no order # (BigBadToyStore) → the one open PO of the supplier whose line names share the item's words.
//              Exactly one PO → the claim; none / several → listed with the reason, never guessed.
//   line       one line → it; else the one line whose name shares ≥ 2 distinctive words with the item; else a whole-PO
//              claim (line NULL) with the items in source_items_json. qty = the email's Product units × the line's
//              Individual units per Product unit (NULL when it exceeds Ordered — a combined order — or the pack is
//              not known: an enter_quantity task asks). Refund amount if stated.
import { z } from "zod/v4";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { gmail_v1 } from "googleapis";
import { AI, aiAvailable, anthropicClient, estimateCost } from "./config/ai";
import { logPrefill } from "./po-prefill";
import { listMessageIds, getMessage, type GmailMessage } from "./gmail-client";
import { resolveSupplier, registrable, DOMAIN_MAP_KEY, PLATFORM_SENDERS_KEY, DEFAULT_PLATFORM_SENDERS, findPos, type PoRef } from "./tracking-match";
import { suggestClaim, existingClaims, type Suggestion, type SuggestOutcome } from "./claim-suggestions";
import type { QueryLike } from "./scheduler/types";

export const WATERMARK_KEY = "claims.cancellation_watermark";
export const CANCELLATION_AI_MAX_CALLS = 25;
const OVERLAP_MS = 6 * 3600 * 1000;

export interface CancellationItem { name: string; qty: number | null }
export interface CancellationParse {
  retailer: string;
  orderId: string | null;
  /** Target prints only the last 4 of the order # in some emails. */
  orderLast4: string | null;
  scope: "full" | "partial" | null;
  items: CancellationItem[];
  refundAmount: number | null;
  refundMethod: string | null;
  reason: string | null;
  source: "regex" | "ai";
  /** The cancellation language the classifier matched (the report shows it). */
  matched: string;
}

// ── Text ─────────────────────────────────────────────────────────────────────
/** Pure: invisible padding (&zwnj;, zero-width characters) and runs of blanks collapsed; one item per line. */
export function cleanText(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/&zwnj;|&nbsp;|&#\d+;|[͏​‌‍ ⠀]/g, " ").replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{2,}/g, "\n").trim();
}
const lines = (t: string): string[] => t.split("\n").map((l) => l.trim()).filter(Boolean);
const money = (s: string | null | undefined): number | null => { const m = /\$\s?([\d,]+\.\d{2})/.exec(s ?? ""); return m ? Number(m[1].replace(/,/g, "")) : null; };
const intOf = (s: string | null | undefined): number | null => { const m = /\d+/.exec(s ?? ""); return m ? Number(m[0]) : null; };

// ── Forwarded emails ─────────────────────────────────────────────────────────
export interface EmailFacts { from: string; fromDomain: string | null; date: Date; subject: string; text: string; forwarded: boolean }
/** Pure: a forwarded email's real sender, date, subject and body (the forwarded header block); else the envelope's. */
export function unwrapForwarded(msg: Pick<GmailMessage, "from" | "fromDomain" | "date" | "subject" | "text">): EmailFacts {
  const t = cleanText(msg.text);
  const m = /-{3,}\s*Forwarded message\s*-{3,}\n/i.exec(t);
  const envelope: EmailFacts = { from: msg.from, fromDomain: msg.fromDomain ?? null, date: msg.date, subject: msg.subject, text: t, forwarded: false };
  if (!m) return envelope;
  // the header block: the From / Date / Subject / To lines right after the marker
  const after = t.slice(m.index + m[0].length).split("\n");
  let n = 0; const block: string[] = [];
  while (n < after.length && n < 8 && /^(From|Date|Subject|To|Cc):/i.test(after[n])) block.push(after[n++]);
  const header = (k: string) => block.find((l) => new RegExp(`^${k}:`, "i").test(l))?.replace(/^[^:]+:\s*/, "").trim() ?? null;
  const from = header("From"); const subject = header("Subject"); const date = header("Date");
  if (!from) return envelope;
  const addr = /<([^>]+)>/.exec(from)?.[1] ?? from;
  const parsedDate = date ? Date.parse(date.replace(/\s+at\s+/, " ")) : NaN;
  return {
    from, fromDomain: addr.includes("@") ? addr.split("@")[1].toLowerCase() : msg.fromDomain ?? null,
    date: Number.isFinite(parsedDate) ? new Date(parsedDate) : msg.date,
    subject: subject ?? msg.subject.replace(/^(fwd?|fw):\s*/i, ""), text: after.slice(n).join("\n").trim(), forwarded: true,
  };
}

// ── Classifier ───────────────────────────────────────────────────────────────
const CANCEL_LANGUAGE = [
  /\b(?:has|have|had|was|were|is|are)\s+(?:been\s+)?cancel+ed\b/i, /^cancel+ed:/im, /\bcancel+ed:\s/i, /\bitems?\s+(?:was|were|have been|has been)?\s*cancel+ed\b/i,
  /\bcancel+ed\s+items?\b/i, /\bcancel+ation\s+(?:notice|summary|confirmation)\b/i, /\border\s+cancel+ation\b/i, /\bcancel+ed\s+(?:due to|at your request|your|the)\b/i,
  /\bwe(?:'ve| have)\s+cancel+ed\b/i, /\bwe had to cancel\b/i, /\bout of stock\b[^.\n]{0,80}\b(?:removed|cancel)/i, /\bcouldn'?t complete your\b/i,
  /\bunable to (?:process|complete|fulfill) your order\b/i, /\bpayment (?:has been |was )?cancel+ed\b/i, /\bcancel+ed your (?:delivery|order|payment)/i, /\bwill not be (?:shipped|billed)\b/i,
  // Walgreens "adjusted and has shipped": a "Canceled" section heading over an out-of-stock item
  /^cancel+ed\n(?:product image\n)?out of stock\b/im,
];
const NOT_CANCELLATION = /\b(?:subscription|auto-?refill|membership|trial|loyalty)\b/i;
const DELAYED = /\bdelayed\b/i;
const PAYMENT_NOTICE = /\bdeclined payment\b|\bpayment pending\b/i;
const FUTURE_CANCEL = /\b(?:will be|would be|may be|could be|if (?:your|the) order is|otherwise,? your order will be)\s+cancel+ed\b|\b(?:cannot|can't|can not|not) be cancel+ed\b|\bcancel+ed your (?:subscription|membership|auto-?refill)/i;
const GIFT_CARD_SUBJECT = /\byou received a gift card\b/i;

/** Pure: is this email a cancellation candidate — the language it matched, or null (and why not). */
export function classifyCancellation(f: Pick<EmailFacts, "subject" | "text" | "fromDomain">): { candidate: true; matched: string } | { candidate: false; why: string } {
  const subject = f.subject ?? "", head = f.text.slice(0, 8000); // Walgreens' Canceled section sits ~3K characters in
  if (NOT_CANCELLATION.test(subject)) return { candidate: false, why: "subscription / membership cancel" };
  if (DELAYED.test(subject)) return { candidate: false, why: "delayed notice (D4)" };
  if (PAYMENT_NOTICE.test(subject)) return { candidate: false, why: "payment notice, not a cancellation" };
  if (GIFT_CARD_SUBJECT.test(subject)) return registrable(f.fromDomain ?? "") === "michaels.com" ? { candidate: true, matched: "Michaels gift card from a return / cancellation" } : { candidate: false, why: "gift card notice" };
  for (const re of CANCEL_LANGUAGE) {
    const m = re.exec(subject) ?? re.exec(head);
    if (!m) continue;
    // "will be cancelled" / "if your order is canceled" is a confirmation's small print or a threat, not a cancellation
    const around = (re.exec(subject) ? subject : head).slice(Math.max(0, m.index - 40), m.index + m[0].length + 60);
    if ((FUTURE_CANCEL.test(around) || NOT_CANCELLATION.test(around)) && !re.exec(subject)) continue;
    return { candidate: true, matched: m[0].trim() };
  }
  return { candidate: false, why: "no cancellation language" };
}

// ── Retailer parsers ─────────────────────────────────────────────────────────
type Parser = (f: EmailFacts, L: string[]) => Partial<CancellationParse> | null;
const ORDER_IN_SUBJECT = /(?:order|#)\s*#?\s*:?\s*([A-Z]{0,4}-?\d{5,}(?:-\d{2,})?)/i;
/** "Name\nQty: N" pairs (the line before each Qty line), skipping obvious non-names. */
function qtyPairs(L: string[], from = 0, to = L.length, qtyRe = /^(?:qty|quantity)\s*:?\s*(\d+)\b/i): CancellationItem[] {
  const out: CancellationItem[] = [];
  for (let i = from; i < to; i++) {
    const m = qtyRe.exec(L[i]);
    if (!m) continue;
    let j = i - 1;
    while (j >= from && /^(?:\$|item\s*:|item \d|size|color|style|upc|sku|price|product image|out of stock|sold by|sold and|\d+ items?|canceled|cancelled)/i.test(L[j])) j--;
    if (j >= from) out.push({ name: L[j].replace(/\s*\(.*?\)\s*$/, "").slice(0, 160), qty: Number(m[1]) });
  }
  return out;
}
const idx = (L: string[], re: RegExp, from = 0): number => { for (let i = from; i < L.length; i++) if (re.test(L[i])) return i; return -1; };

const walmart: Parser = (f, L) => {
  const order = /order number:\s*([\d-]{10,})/i.exec(f.text)?.[1] ?? null;
  const full = /your (?:delivery|order) was cancel+ed|cancel your (?:delivery )?order\b/i.test(f.text);
  const refund = /started a refund of\s*\$([\d,.]+)/i.exec(f.text);
  const method = refund ? L[idx(L, /refund initiated/i) + 1] ?? null : null;
  const start = idx(L, /items? cancel+ed$|^items cancel+ed/i);
  const end = idx(L, /temporary hold released|shop anywhere/i, Math.max(start, 0));
  const items = start >= 0 ? qtyPairs(L, start, end > 0 ? end : L.length) : [];
  const reason = /out of stock/i.test(f.text) ? "out of stock" : /flagged by our policy/i.test(f.text) ? "policy flag" : /delayed items/i.test(f.text) ? "delayed items canceled" : /as requested/i.test(f.text) ? "customer request" : /unexpected issue/i.test(f.text) ? "unexpected issue" : null;
  return { orderId: order, scope: full ? "full" : "partial", items, refundAmount: refund ? Number(refund[1].replace(/,/g, "")) : null, refundMethod: method && !/credited/i.test(method) ? method : null, reason };
};
const target: Parser = (f, L) => {
  const order = /order\s*#\s*(\d{12,})/i.exec(f.text)?.[1] ?? null;
  const last4 = /ending in\s*(\d{4})/i.exec(f.subject)?.[1] ?? null;
  const start = idx(L, /^cancel+ed items$/i);
  const end = idx(L, /would these work instead/i, Math.max(start, 0));
  return { orderId: order, orderLast4: last4, scope: "partial", items: start >= 0 ? qtyPairs(L, start, end > 0 ? end : L.length) : [], reason: "customer request" };
};
const sephora: Parser = (f, L) => {
  if (!/cancel+ed/i.test(f.subject)) return null;
  const order = /order\s*#?\s*(\d{10,})/i.exec(f.subject)?.[1] ?? null;
  // "Name\nITEM nnn\nSIZE …\n$price\nqty"
  const items: CancellationItem[] = [];
  for (let i = 0; i + 3 < L.length; i++) if (/^ITEM \d+/.test(L[i + 1]) && /^\$[\d.,]+$/.test(L[i + 3] ?? "") && /^\d+$/.test(L[i + 4] ?? "")) items.push({ name: L[i], qty: Number(L[i + 4]) });
  for (let i = 0; i + 2 < L.length; i++) if (/^ITEM \d+/.test(L[i + 1]) && /^\$[\d.,]+$/.test(L[i + 2]) && /^\d+$/.test(L[i + 3] ?? "") && !items.some((x) => x.name === L[i])) items.push({ name: L[i], qty: Number(L[i + 3]) });
  return { orderId: order, scope: "full", items, refundAmount: money(/TOTAL:\s*(\$[\d,.]+)/i.exec(f.text)?.[1]), reason: /per your request/i.test(f.text) ? "customer request" : null };
};
const bbw: Parser = (f, L) => ({ orderId: L[idx(L, /^order number/i) + 1]?.match(/^\d{10,}$/)?.[0] ?? (L.find((l) => /^\d{12,}$/.test(l)) ?? null), scope: "full", items: [], reason: /unusual activity/i.test(f.text) ? "security" : null });
const bbts: Parser = (f) => {
  if (!/cancel+ed/i.test(f.subject + f.text.slice(0, 300))) return null;
  const items: CancellationItem[] = [];
  for (const m of Array.from(f.text.matchAll(/\*(\d+)\*\s*of\s+([\s\S]{3,160}?)(?=\n\s*\n|\nQuestions|\n[A-Z][a-z]+\?|$)/g))) items.push({ qty: Number(m[1]), name: m[2].replace(/\s+/g, " ").trim() });
  return { orderId: /order\s*#\s*(\d{6,})/i.exec(f.text)?.[1] ?? null, scope: "partial", items, reason: /non-payment/i.test(f.text) ? "non-payment" : null };
};
const oracle: Parser = (f, L) => {
  const o = idx(L, /^order\s*#\s*:?$/i);
  const order = (o >= 0 ? /^(\d{6,})/.exec(L[o + 1] ?? "")?.[1] : null) ?? /order\s*#\s*:?\s*(\d{6,})/i.exec(f.subject)?.[1] ?? null;
  const items: CancellationItem[] = [];
  const h = idx(L, /^item\/sku/i);
  let first = h >= 0 ? h + 1 : -1;
  while (first >= 0 && first < L.length && first < h + 4 && !/^\d{5,}$/.test(L[first])) first++;
  for (let i = first; i >= 1 && i + 2 < L.length && items.length < 20; i += 3) {
    if (!/^\d{5,}$/.test(L[i]) || !/^\d+$/.test(L[i + 1])) break;
    items.push({ name: `${L[i + 2]} (SKU ${L[i]})`, qty: Number(L[i + 1]) });
  }
  return { orderId: order, scope: /order is cancel+ed/i.test(f.text) ? "full" : "partial", items };
};
const supplyhouse: Parser = (f) => ({ orderId: /order\s*#(\d{6,})/i.exec(f.subject)?.[1] ?? null, scope: "full", items: [], reason: /security check/i.test(f.text) ? "security" : null });
const dkhardware: Parser = (f) => ({ orderId: /(DKH-\d{5,})/i.exec(f.subject + " " + f.text)?.[1] ?? null, scope: "full", items: [], reason: /as you requested/i.test(f.text) ? "customer request" : null });
const jellycat: Parser = (f) => (/cancel+ed/i.test(f.subject) ? { orderId: /order\s*#?(\d{6,})/i.exec(f.subject)?.[1] ?? null, scope: "full", items: [], refundAmount: money(/order total:\s*(\$[\d,.]+)/i.exec(f.text)?.[1]) } : null);
/** Shopify's "Refunded Items" cancel template: "Name × 5"; the order code in the subject. */
const shopifyRefunded: Parser = (f, L) => {
  if (!/cancel+ed/i.test(f.subject)) return null;
  const order = /order\s+#?([A-Z]{0,4}\d{6,})/i.exec(f.subject)?.[1] ?? null;
  const items: CancellationItem[] = [];
  for (const l of L) { const m = /^(.{3,160}?)\s+×\s+(\d+)$/.exec(l); if (m) items.push({ name: m[1], qty: Number(m[2]) }); }
  return { orderId: order, scope: "full", items, refundAmount: money(/^total\n\$?([\d,.]+)/im.exec(f.text)?.[0]), reason: /out of stock/i.test(f.text) ? "out of stock or customer request" : null };
};
const urbanoutfitters: Parser = (f, L) => {
  const order = /order\s+([A-Z]{2}\d{6,})/i.exec(f.text)?.[1] ?? null;
  const items: CancellationItem[] = [];
  for (let i = 0; i < L.length; i++) { const m = /^qty\s*:\s*(\d+)$/i.exec(L[i]); if (!m) continue; let j = i - 1; while (j >= 0 && /^(?:\$|price|total|style no|color|size|\d+$|https?:)/i.test(L[j])) j--; if (j >= 0 && !items.some((x) => x.name === L[j])) items.push({ name: L[j], qty: Number(m[1]) }); }
  return { orderId: order, scope: "partial", items, reason: /at your request/i.test(f.text) ? "customer request" : null };
};
const macys: Parser = (f, L) => ({ orderId: /order\s*#\s*:?\s*(\d{8,})/i.exec(f.subject + " " + f.text)?.[1] ?? null, scope: "partial", items: qtyPairs(L, Math.max(0, idx(L, /^cancel+ed$/i))), reason: "out of stock" });
const staples: Parser = (f, L) => {
  if (!/cancel/i.test(f.subject)) return null;
  const s = idx(L, /^cancel+ed item/i);
  return { orderId: /order\s*#?\s*:?\s*(\d{8,})/i.exec(f.subject)?.[1] ?? null, scope: /^item on your order/i.test(L[0] ?? "") ? "partial" : "full", items: s >= 0 ? qtyPairs(L, s) : [], reason: "customer request" };
};
const fleetfarm: Parser = (f) => ({ orderId: /order\s*#\s*([A-Z]{1,3}\d{6,})/i.exec(f.subject)?.[1] ?? null, scope: /part of your order/i.test(f.subject) ? "partial" : "full", items: [] });
const walgreens: Parser = (f, L) => {
  if (!/adjusted/i.test(f.subject)) return null;
  const c = idx(L, /^cancel+ed$/i);
  const end = idx(L, /^shipped$/i, Math.max(c, 0));
  return { orderId: /order\s*#(\d{10,})/i.exec(f.subject)?.[1] ?? null, scope: "partial", items: c >= 0 ? qtyPairs(L, c, end > 0 ? end : L.length) : [], reason: /out of stock/i.test(f.text) ? "out of stock" : null };
};
const michaelsGiftCard: Parser = (f) => {
  if (!GIFT_CARD_SUBJECT.test(f.subject)) return null;
  return { orderId: /order number\s*(\d{10,})/i.exec(f.text)?.[1] ?? null, scope: null, items: [], refundAmount: money(/amount\s*(\$[\d,.]+)/i.exec(f.text)?.[1]), refundMethod: "Michaels eGift card", reason: "gift card from a return, cancellation or credit" };
};
const kohls: Parser = (f) => ({ orderId: /order\s*#(\d{8,})/i.exec(f.text)?.[1] ?? null, scope: "full", items: [], reason: null });
const tnvalleybikes: Parser = (f) => (/payment cancel+ed/i.test(f.subject) ? { orderId: /order no\.?\s*([\d-]{10,})/i.exec(f.subject)?.[1] ?? null, scope: "full", items: [], refundAmount: money(/the\s*(\$[\d,.]+)\s*payment/i.exec(f.text)?.[1]) } : null);

/** Generic fallback: order #, scope from the wording, "Qty:" items. */
export const genericCancellation: Parser = (f, L) => {
  const order = ORDER_IN_SUBJECT.exec(f.subject)?.[1] ?? /order\s*(?:#|number|no\.?)\s*:?\s*([A-Z]{0,4}-?\d{5,}(?:-\d{2,})?)/i.exec(f.text)?.[1] ?? null;
  const full = /\b(?:your|the) (?:entire )?order (?:has been|was|is) cancel+ed\b|\bcancel+ed your order\b/i.test(f.subject + "\n" + f.text);
  const partial = /\b(?:some|the following|these|an?) items?\b.{0,40}\bcancel+ed\b|\bitems? from your order\b|\bpart of your order\b|\bitems? (?:was|were) cancel+ed\b/i.test(f.subject + "\n" + f.text);
  return { orderId: order, scope: full && !partial ? "full" : partial ? "partial" : null, items: qtyPairs(L) };
};

export const PARSERS: ReadonlyArray<{ domain: RegExp; retailer: string; parse: Parser }> = [
  { domain: /(^|\.)walmart\.com$/, retailer: "walmart.com", parse: walmart },
  { domain: /(^|\.)target\.com$/, retailer: "target.com", parse: target },
  { domain: /(^|\.)sephora\.com$/, retailer: "sephora.com", parse: sephora },
  { domain: /(^|\.)bathandbodyworks\.com$/, retailer: "bathandbodyworks.com", parse: bbw },
  { domain: /(^|\.)bigbadtoystore\.com$/, retailer: "bigbadtoystore.com", parse: bbts },
  { domain: /oraclecloud\.com$/, retailer: "oracle-hosted", parse: oracle },
  { domain: /(^|\.)supplyhouse\.com$/, retailer: "supplyhouse.com", parse: supplyhouse },
  { domain: /(^|\.)dkhardware\.com$/, retailer: "dkhardware.com", parse: dkhardware },
  { domain: /(^|\.)jellycat\.com$/, retailer: "jellycat.com", parse: jellycat },
  { domain: /(^|\.)(fentybeauty|olehenriksen|onlynaturalpet)\.com$/, retailer: "shopify", parse: shopifyRefunded },
  { domain: /(^|\.)urbanoutfitters\.com$/, retailer: "urbanoutfitters.com", parse: urbanoutfitters },
  { domain: /(^|\.)macys\.com$/, retailer: "macys.com", parse: macys },
  { domain: /(^|\.)staples\.com$/, retailer: "staples.com", parse: staples },
  { domain: /(^|\.)fleetfarm\.com$/, retailer: "fleetfarm.com", parse: fleetfarm },
  { domain: /(^|\.)walgreens\.com$/, retailer: "walgreens.com", parse: walgreens },
  { domain: /(^|\.)michaels\.com$/, retailer: "michaels.com", parse: michaelsGiftCard },
  { domain: /(^|\.)kohls\.com$/, retailer: "kohls.com", parse: kohls },
  { domain: /(^|\.)tnvalleybikes\.com$/, retailer: "tnvalleybikes.com", parse: tnvalleybikes },
];

/** Pure: the parse of a classified candidate — the retailer's parser, else the generic one. `complete` = the AI need not be asked. */
export function parseCancellation(f: EmailFacts, matched: string): CancellationParse & { complete: boolean } {
  const L = lines(f.text);
  const dom = f.fromDomain ?? "";
  const p = PARSERS.find((x) => x.domain.test(dom));
  const r = (p?.parse(f, L) ?? null) ?? genericCancellation(f, L) ?? {};
  const parsed: CancellationParse = { retailer: p?.retailer ?? registrable(dom || "unknown"), orderId: r.orderId ?? null, orderLast4: r.orderLast4 ?? null, scope: r.scope ?? null, items: r.items ?? [], refundAmount: r.refundAmount ?? null, refundMethod: r.refundMethod ?? null, reason: r.reason ?? null, source: "regex", matched };
  // complete: we know which order, and either the scope is full or the items carry quantities (the Michaels credit has neither — it is complete as a money notice)
  const hasOrder = !!parsed.orderId || !!parsed.orderLast4;
  const hasQty = parsed.items.some((i) => i.qty != null);
  const complete = (hasOrder && (parsed.scope === "full" || hasQty || (!!p && p.retailer === "michaels.com") || (!!p && parsed.scope === "partial" && p.retailer === "fleetfarm.com"))) || (hasQty && !!p);
  return { ...parsed, complete };
}

// ── Haiku for the rest ───────────────────────────────────────────────────────
const AiCancellationSchema = z.object({
  is_cancellation: z.boolean(),
  order_id: z.string().nullable(),
  scope: z.enum(["full", "partial"]).nullable(),
  items: z.array(z.object({ name: z.string(), qty: z.number().nullable() })),
  refund_amount: z.number().nullable(),
  refund_method: z.string().nullable(),
  reason: z.string().nullable(),
});
export type AiCancellation = z.infer<typeof AiCancellationSchema>;
export const AI_CANCELLATION_SYSTEM = `You read one email a retailer or supplier sent about an order. Decide whether it CONFIRMS that the order, or items of it, has been canceled (not a warning that it may be canceled, not a delay, not a subscription or membership). Return:
- is_cancellation: true only for a confirmed cancellation of goods ordered.
- order_id: the order number exactly as printed, else null.
- scope: "full" when the whole order was canceled, "partial" when some items were, null when unclear.
- items: the canceled items with their quantity as printed (qty null when not printed); [] when none are listed.
- refund_amount: a refund or released amount the email states in dollars, else null. refund_method: how it is refunded (card, gift card, store credit …), else null.
- reason: why it was canceled, in a few words, else null.`;
export type CancellationAiCall = (subject: string, text: string) => Promise<AiCancellation & { input_tokens: number; output_tokens: number }>;
const defaultAi: CancellationAiCall = async (subject, text) => {
  const res = await anthropicClient().messages.parse({
    model: AI.model, max_tokens: 2000, output_config: { effort: AI.effort, format: zodOutputFormat(AiCancellationSchema) },
    system: AI_CANCELLATION_SYSTEM, messages: [{ role: "user", content: `Subject: ${subject}\n\n${text.slice(0, 12000)}` }],
  });
  const parsed = AiCancellationSchema.safeParse(res.parsed_output);
  if (!parsed.success) throw new Error(`schema: ${parsed.error.message.slice(0, 200)}`);
  return { ...parsed.data, input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens };
};

/** Pure: the AI's answer folded into the parse (the regex order # wins when it found one; the model's items only when ours are empty). */
export function applyAi(p: CancellationParse, ai: AiCancellation): CancellationParse {
  return { ...p, orderId: p.orderId ?? ai.order_id ?? null, scope: p.scope ?? ai.scope ?? null, items: p.items.length ? p.items : ai.items.map((i) => ({ name: i.name, qty: i.qty })), refundAmount: p.refundAmount ?? ai.refund_amount ?? null, refundMethod: p.refundMethod ?? ai.refund_method ?? null, reason: p.reason ?? ai.reason ?? null, source: "ai" };
}

// ── Matching and the claim ───────────────────────────────────────────────────
export interface PoLine { id: string; po_id: string; product_name: string | null; product_pack: number | null; ordered_individual: number; qty_basis: string | null }
const STOP = new Set(["with", "from", "pack", "size", "oz", "ml", "count", "the", "and", "for", "of", "in", "by", "to", "per", "x"]);
const words = (s: string | null | undefined): Set<string> => new Set((s ?? "").toLowerCase().normalize("NFD").replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length >= 4 && !STOP.has(w)));
/** Pure: the one line whose name shares ≥ 2 distinctive words with the item's, else null. */
export function proposeLine(itemName: string, poLines: readonly PoLine[]): PoLine | null {
  if (poLines.length === 1) return poLines[0];
  const w = words(itemName);
  const scored = poLines.map((l) => ({ l, n: Array.from(words(l.product_name)).filter((x) => w.has(x)).length })).filter((x) => x.n >= 2).sort((a, b) => b.n - a.n);
  return scored.length && (scored.length === 1 || scored[0].n > scored[1].n) ? scored[0].l : null;
}

export type MatchResult = { po: PoRef; via: "order_id" | "last4" | "item_words" } | { po: null; reason: "no_order_id" | "no_po" | "ambiguous" | "unknown_sender"; candidates?: string[] };
/** Pure: the ONE PO a parsed cancellation names. */
export function matchCancellation(p: CancellationParse, f: EmailFacts, supplier: string | null, pos: readonly PoRef[], lines: readonly PoLine[]): MatchResult {
  if (p.orderId) {
    const hits = supplier ? findPos(supplier, p.orderId, pos) : pos.filter((po) => findPos(po.supplier, p.orderId!, [po]).length);
    if (hits.length === 1) return { po: hits[0], via: "order_id" };
    if (hits.length > 1) return { po: null, reason: "ambiguous", candidates: hits.map((h) => h.order_id) };
    if (!supplier && hits.length === 0) return { po: null, reason: "unknown_sender" };
    return { po: null, reason: "no_po" };
  }
  if (p.orderLast4) {
    const hits = pos.filter((po) => (!supplier || po.supplier === supplier) && po.order_id.endsWith(p.orderLast4!) && po.order_date && Math.abs(f.date.getTime() - new Date(po.order_date).getTime()) <= 60 * 86_400_000);
    if (hits.length === 1) return { po: hits[0], via: "last4" };
    return hits.length ? { po: null, reason: "ambiguous", candidates: hits.map((h) => h.order_id) } : { po: null, reason: "no_po" };
  }
  if (supplier && p.items.length) {
    const open = pos.filter((po) => po.supplier === supplier && !po.closed);
    const hits = open.filter((po) => p.items.some((it) => proposeLine(it.name, lines.filter((l) => l.po_id === po.id && lines.filter((x) => x.po_id === po.id).length > 1)) || lines.filter((l) => l.po_id === po.id).some((l) => Array.from(words(it.name)).filter((x) => words(l.product_name).has(x)).length >= 2)));
    if (hits.length === 1) return { po: hits[0], via: "item_words" };
    if (hits.length > 1) return { po: null, reason: "ambiguous", candidates: hits.map((h) => h.order_id) };
  }
  return { po: null, reason: "no_order_id" };
}

/** Pure: the suggested claims one matched cancellation becomes (one per matched item line, else one whole-PO claim). */
export function cancellationSuggestions(p: CancellationParse, f: EmailFacts, po: PoRef, poLines: readonly PoLine[], gmailMessageId: string): Suggestion[] {
  const note = `${f.subject} (${f.date.toISOString().slice(0, 10)}${p.source === "ai" ? ", read by AI" : ""})`;
  const base = { po_id: po.id, order_id: po.order_id, supplier: po.supplier, kind: "canceled" as const, found_by: "email" as const, source_email_id: gmailMessageId, source_items_json: p.items, note, rule: `email:${p.retailer}:${p.scope ?? "unknown"}${p.source === "ai" ? ":ai" : ""}` };
  const head = `Canceled per the ${p.retailer} email of ${f.date.toISOString().slice(0, 10)}${p.reason ? ` (${p.reason})` : ""}`;
  const refund = p.refundAmount != null ? ` Refund stated: $${p.refundAmount.toFixed(2)}${p.refundMethod ? ` (${p.refundMethod})` : ""}.` : "";
  const out: Suggestion[] = [];
  const itemsWithQty = p.items.filter((i) => i.qty != null);
  if (itemsWithQty.length) {
    const placed: Suggestion[] = [];
    for (const it of itemsWithQty) {
      const line = proposeLine(it.name, poLines);
      if (!line) continue;
      const pack = line.qty_basis === "product_legacy" ? 1 : line.product_pack;
      const individual = pack ? it.qty! * pack : null;
      const over = individual != null && individual > Number(line.ordered_individual) + 1e-9;
      placed.push({ ...base, po_line_item_id: line.id, qty: over || individual == null ? null : individual, amount: null,
        reason: `${head}: ${it.qty} × ${it.name}${individual != null ? ` = ${individual} Individual units` : ""}${over ? ` — more than the line's Ordered (${line.ordered_individual}; a combined order?), type the quantity` : ""}.${refund} Open the claim?`,
        key: `email:${gmailMessageId}:${line.id}` });
    }
    if (placed.length === itemsWithQty.length) return placed;
  }
  // whole-PO claim: a full cancel, or items AF could not place on a line
  const total = poLines.reduce((s, l) => s + Number(l.ordered_individual || 0), 0);
  const itemText = p.items.length ? ` Items: ${p.items.map((i) => `${i.qty ?? "?"} × ${i.name}`).join("; ")}.` : "";
  out.push({ ...base, po_line_item_id: null, qty: p.scope === "full" && total > 0 ? total : null, amount: p.scope === "full" ? p.refundAmount : p.refundAmount,
    reason: `${head}: ${p.scope === "full" ? "the whole order" : p.scope === "partial" ? "some items" : "unclear scope"}.${itemText}${refund} Open the claim?`,
    key: `email:${gmailMessageId}:po` });
  return out;
}

// ── The ingest (component 30 and the backfill) ───────────────────────────────
export interface CancellationDeps { gmail: gmail_v1.Gmail; list?: typeof listMessageIds; get?: typeof getMessage; ai?: CancellationAiCall }
export interface CancellationReport {
  scanned: number; candidates: number; not_candidates: Record<string, number>;
  rows: Array<{ gmail_message_id: string; date: string; sender: string; subject: string; retailer: string; matched: string; order_id: string | null; scope: string | null; items: string; refund: number | null; source: string; match: string; po: string | null; suggestions: Array<Suggestion & { outcome: SuggestOutcome["why"] }> }>;
  ai_calls: number; ai_skipped: number; cost: number; created: number;
}
export const POS_SQL = `SELECT p.id, p.supplier, p.order_id, p.order_date::text AS order_date, p.alt_order_ids, p.ships_to, (p.closed_at IS NOT NULL) AS closed FROM purchase_orders p`;
export const LINES_SQL = `SELECT l.id, l.po_id, l.product_name, le.product_pack, le.ordered_individual, l.qty_basis FROM po_line_items l JOIN po_line_expected le ON le.line_id = l.id`;

export async function readCancellationWatermark(query: QueryLike): Promise<Date | null> {
  const v = (await query(`SELECT value FROM settings WHERE key = $1`, [WATERMARK_KEY])).rows[0]?.value;
  return v?.last_scanned_at ? new Date(v.last_scanned_at) : null;
}

export async function ingestCancellations(opts: { query: QueryLike; deps: CancellationDeps; now?: Date; since?: Date | null; dryRun?: boolean; maxMessages?: number; log?: (m: string) => void }): Promise<CancellationReport> {
  const { query } = opts;
  const now = opts.now ?? new Date();
  const list = opts.deps.list ?? listMessageIds, get = opts.deps.get ?? getMessage;
  const since = opts.since !== undefined ? opts.since : await readCancellationWatermark(query);
  const from = since ? new Date(since.getTime() - OVERLAP_MS) : null;
  const q = `-category:promotions${from ? ` after:${Math.floor(from.getTime() / 1000)}` : ""} (canceled OR cancelled OR cancellation OR "out of stock" OR "couldn't complete" OR "unable to fulfill" OR "unable to process" OR "won't be charged" OR "gift card")`;
  const ids = await list(opts.deps.gmail, q, opts.maxMessages ?? 2000);
  const r: CancellationReport = { scanned: ids.length, candidates: 0, not_candidates: {}, rows: [], ai_calls: 0, ai_skipped: 0, cost: 0, created: 0 };
  if (!ids.length) { if (!opts.dryRun) await writeWatermark(query, now); return r; }
  const settings = (await query(`SELECT key, value FROM settings WHERE key = ANY($1::text[])`, [[DOMAIN_MAP_KEY, PLATFORM_SENDERS_KEY]])).rows;
  const domainMap = (settings.find((s: any) => s.key === DOMAIN_MAP_KEY)?.value ?? {}) as Record<string, string>;
  const platforms = (settings.find((s: any) => s.key === PLATFORM_SENDERS_KEY)?.value as string[] | undefined) ?? DEFAULT_PLATFORM_SENDERS;
  const pos: PoRef[] = (await query(POS_SQL)).rows.map((x: any) => ({ id: String(x.id), supplier: String(x.supplier), order_id: String(x.order_id), order_date: x.order_date, alt_order_ids: x.alt_order_ids, ships_to: x.ships_to, closed: !!x.closed }));
  const poLines: PoLine[] = (await query(LINES_SQL)).rows.map((x: any) => ({ id: String(x.id), po_id: String(x.po_id), product_name: x.product_name, product_pack: x.product_pack == null ? null : Number(x.product_pack), ordered_individual: Number(x.ordered_individual ?? 0), qty_basis: x.qty_basis }));
  const suppliers = Array.from(new Set(pos.map((p) => p.supplier)));
  // an email already behind a claim is never read twice
  const seen = new Set<string>((await query(`SELECT source_email_id FROM supplier_claims WHERE source_email_id IS NOT NULL`)).rows.map((x: any) => String(x.source_email_id)));
  const ai = opts.deps.ai ?? defaultAi;
  for (const id of ids) {
    if (seen.has(id)) { r.not_candidates.already_read = (r.not_candidates.already_read ?? 0) + 1; continue; }
    const msg = await get(opts.deps.gmail, id);
    const f = unwrapForwarded(msg);
    const c = classifyCancellation(f);
    if (!c.candidate) { r.not_candidates[c.why] = (r.not_candidates[c.why] ?? 0) + 1; continue; }
    r.candidates++;
    let p: CancellationParse = parseCancellation(f, c.matched);
    const complete = (p as any).complete as boolean;
    const sup = resolveSupplier(f.fromDomain, domainMap, suppliers, platforms);
    if (!complete && !sup.supplier) { r.not_candidates.unknown_sender_free_text = (r.not_candidates.unknown_sender_free_text ?? 0) + 1; r.candidates--; r.rows.push({ gmail_message_id: id, date: f.date.toISOString().slice(0, 10), sender: f.fromDomain ?? "?", subject: f.subject.slice(0, 90), retailer: p.retailer, matched: c.matched, order_id: p.orderId, scope: p.scope, items: "", refund: p.refundAmount, source: "regex (incomplete, unknown sender — not asked)", match: "unknown_sender", po: null, suggestions: [] }); continue; }
    if (!complete) {
      if (opts.dryRun || !aiAvailable()) { r.ai_skipped++; }
      else if (r.ai_calls >= CANCELLATION_AI_MAX_CALLS) { r.ai_skipped++; }
      else {
        r.ai_calls++;
        const t0 = Date.now();
        try {
          const a = await ai(f.subject, f.text);
          const cost = estimateCost(a.input_tokens, a.output_tokens);
          r.cost += cost;
          await logPrefill(query, { user_id: null, kind: "cancellation", retailer: p.retailer, input_chars: f.text.length, input_tokens: a.input_tokens, output_tokens: a.output_tokens, cost_estimate: cost, duration_ms: Date.now() - t0, schema_ok: true, error: null });
          if (!a.is_cancellation) { r.not_candidates.ai_not_a_cancellation = (r.not_candidates.ai_not_a_cancellation ?? 0) + 1; r.candidates--; continue; }
          p = applyAi(p, a);
        } catch (e: any) {
          await logPrefill(query, { user_id: null, kind: "cancellation", retailer: p.retailer, input_chars: f.text.length, input_tokens: 0, output_tokens: 0, cost_estimate: 0, duration_ms: Date.now() - t0, schema_ok: false, error: String(e?.message ?? e).slice(0, 300) }).catch(() => {});
          opts.log?.(`cancellation AI failed for ${id}: ${e?.message ?? e}`);
        }
      }
    }
    const m = matchCancellation(p, f, sup.supplier, pos, poLines);
    const row: CancellationReport["rows"][number] = { gmail_message_id: id, date: f.date.toISOString().slice(0, 10), sender: f.fromDomain ?? "?", subject: f.subject.slice(0, 90), retailer: p.retailer, matched: c.matched, order_id: p.orderId ?? (p.orderLast4 ? `…${p.orderLast4}` : null), scope: p.scope, items: p.items.map((i) => `${i.qty ?? "?"} × ${i.name}`).join("; ").slice(0, 300), refund: p.refundAmount, source: complete ? "regex" : p.source === "ai" ? "ai" : opts.dryRun ? "regex (AI would be asked)" : "regex (incomplete)", match: m.po ? `matched (${m.via})` : `${m.reason}${m.candidates ? ` (${m.candidates.join(", ")})` : ""}`, po: m.po?.order_id ?? null, suggestions: [] };
    if (m.po) {
      const existing = await existingClaims(query, [m.po.id]);
      for (const s of cancellationSuggestions(p, f, m.po, poLines.filter((l) => l.po_id === m.po!.id), id)) {
        const o = await suggestClaim(query, s, { dryRun: opts.dryRun, existing });
        if (o.created) { r.created++; existing.push({ po_id: s.po_id, po_line_item_id: s.po_line_item_id, kind: s.kind, status: "suggested", suggestion_key: s.key }); }
        row.suggestions.push({ ...s, outcome: o.why });
      }
    }
    r.rows.push(row);
  }
  if (!opts.dryRun) await writeWatermark(query, now);
  return r;
}
async function writeWatermark(query: QueryLike, now: Date): Promise<void> {
  await query(`INSERT INTO settings (key, value, updated_at) VALUES ($1, $2::jsonb, NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, [WATERMARK_KEY, JSON.stringify({ last_scanned_at: now.toISOString() })]);
}
