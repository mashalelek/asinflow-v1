// Supplier shipping email → tracking facts (SPEC §26; patch
// po-tracking-velocity §4). Pure: no I/O, no clock. The regex pass; the AI
// fallback (§4 D3) is separate (tracking-ai.ts).
//
// Real mailbox findings (orders@, 2026-10-21 survey of 400 messages):
//   - many text/plain parts are a one-line preview — gmail-client.ts adds the
//     HTML text; tracking often sits on the line AFTER its label
//     ("Tracking #:" ⏎ "535413445565", Staples / Zoro);
//   - carrier-site URLs carry the number (trknbr= / trackNums= / tracknum=);
//   - bare 12–15-digit numbers that are NOT tracking appear in the same
//     emails: UPCs (Macy's), 15-digit order numbers (Target), phone numbers
//     (ShipStation's carrier list) — so an all-digit number counts only with
//     a tracking label (or a carrier word) right before it, and never when it
//     equals the email's own order #;
//   - one email can carry several shipments, each followed by its items
//     (Macy's #4800667218: two UPS numbers, "Qty: 10" / "Qty: 7");
//   - Michaels' "Your Order Has Shipped" carries only its own 33-digit
//     shipment ids, no carrier tracking — nothing is extracted (→ AI / queue).

export type Carrier = "UPS" | "FEDEX" | "USPS" | "DHL" | "AMAZON" | "ONTRAC" | "LASERSHIP" | "GLS" | "OTHER";
export const CARRIERS: readonly Carrier[] = ["UPS", "FEDEX", "USPS", "DHL", "AMAZON", "ONTRAC", "LASERSHIP", "GLS", "OTHER"];

export interface ParsedShipment { carrier: Carrier; trackingNumber: string; items: Array<{ name: string; qty: number }> }

export interface ParsedEmail {
  /** Carrier-pattern match OR shipped-type language. Non-candidates are skipped. */
  candidate: boolean;
  /** "return": a return pickup / return label email — its number is the return package, never inbound. */
  kind: "shipped" | "out_for_delivery" | "delivered" | "return" | "other";
  /** The sender's domain — the ORIGINAL sender for a forward from our own mailboxes. */
  senderDomain: string | null;
  /** Distinct retailer order #s as printed (subject first). */
  orderIds: string[];
  shipToStreet: string | null;
  shipments: ParsedShipment[];
  /** A carrier's notice (UPS / FedEx / USPS sender, 2026-11-04): the shipper it was sent for, and the carrier's reference numbers. */
  shipperName?: string | null;
  carrierRefs?: string[];
}

/** Carriers that send notices on a shipper's behalf (registrable domains). */
export const CARRIER_SENDERS = ["ups.com", "fedex.com", "usps.com"];
export const isCarrierSender = (domain: string | null | undefined): boolean =>
  !!domain && CARRIER_SENDERS.includes(domain.toLowerCase().split(".").slice(-2).join("."));

// "This message was sent to you at the request of ZARA DEL AMO FASHION CENTER to notify you…" (UPS), "From: ZARA DEL AMO FASHION CENTER",
// FedEx's "Shipper information" block (the name on the next line).
const SHIPPER_PATTERNS = [
  /\bat the request of\s+(.{2,80}?)\s+to notify\b/i,
  /^[ \t]*(?:from|shipper|shipped from|sender)[ \t]*:[ \t]*(\S.{1,79}?)[ \t]*$/im,
  /\bshipper information[ \t]*\n[ \t]*(\S.{1,79}?)[ \t]*$/im,
];
/** Pure: the shipper a carrier notice names, or null. */
export function extractShipper(text: string): string | null {
  for (const re of SHIPPER_PATTERNS) {
    const n = re.exec(text)?.[1]?.replace(/\s+/g, " ").replace(/[.,;:]+$/, "").trim();
    if (n && /[a-z]/i.test(n) && !/@|https?:/i.test(n)) return n;
  }
  return null;
}
/** Pure: the carrier's reference numbers as printed ("Reference Number 1: 212355503949", "Reference: PO-77", "Purchase order number: 4411"), distinct, in order. */
export function extractCarrierRefs(text: string): string[] {
  const out: string[] = [];
  for (const m of Array.from(text.matchAll(/(?:reference(?:\s*(?:number|no\.?|#))?(?:\s*\d)?|purchase\s+order\s+(?:number|no\.?|#)|invoice\s+(?:number|no\.?|#))\s*:\s*([A-Z0-9][A-Z0-9-]{3,39})\b/gi))) {
    const v = m[1].toUpperCase();
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

/** Mailboxes that FORWARD retailer mail into orders@ (patch §1: incl. mpeters.cqg+alias@gmail.com). */
export const OWN_DOMAINS = new Set(["coastalqualitygoods.com", "gmail.com", "googlemail.com"]);

// Return pickup / return label emails (Walmart "Return pickup confirmation",
// "Drop off your return at FedEx…"): the tracking number is the package going
// BACK to the retailer. Subject first; the body phrases are specific enough
// that a shipped email's "free returns" footer does not trip them.
const RETURN_SUBJECT = /\breturns?\b/i;
const RETURN_BODY = /\b(return pickup|prepaid return label|return label (?:is|has been) (?:attached|created|ready)|your return (?:is|has been) (?:scheduled|started|created|initiated))\b/i;
export const isReturnEmail = (subject: string, text = ""): boolean => RETURN_SUBJECT.test(subject) || RETURN_BODY.test(text);

const SHIPPED_WORDS = /\b(shipped|has shipped|on the way|on its way|about to ship|ready to ship|getting ready to ship|tracking|out for delivery|delivered|left our warehouse|shipment)\b/i;

const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** "805 Grandy Avenue" → "805 grandy". */
export function normalizeStreet(s: string): string | null {
  const m = /\b(\d{1,6})\s+([A-Za-z][A-Za-z'-]*)/.exec(s);
  return m ? `${m[1]} ${m[2].toLowerCase()}` : null;
}

const STREET = /\b(\d{1,6})\s+([A-Za-z][A-Za-z'-]*)(?:\s+[A-Za-z][A-Za-z'-]*){0,2}\s+(Ave|Avenue|St|Street|Rd|Road|Dr|Drive|Ln|Lane|Blvd|Boulevard|Way|Ct|Court|Pl|Place|Cir|Circle|Pkwy|Parkway|Hwy|Highway|Ter|Terrace|Trl|Trail|Loop|Run|Pike|Crest|Row)\b\.?/i;
// A bare "Delivery" heading on its own line also counts (Walmart: "Delivery ⏎
// Arrives Thu, Sep 3 ⏎ 805 Grandy Ave…") — own line only, so "Delivery
// method: Standard" / "delivery date" never match.
const SHIP_TO_LABEL = /(deliver(?:s|y|ing)?\s*(?:to|address)|ship(?:ping)?\s*(?:to|address)|shipped\s+to|ship-to|shipping\s+information|delivery\s+address|^[ \t]*delivery[ \t]*$)/gim;

export function extractShipTo(text: string): string | null {
  for (const m of Array.from(text.matchAll(SHIP_TO_LABEL))) {
    const window = text.slice(m.index! + m[0].length, m.index! + m[0].length + 260);
    const s = STREET.exec(window);
    if (s) return `${s[1]} ${s[2].toLowerCase()}`;
  }
  return null;
}

const ORDER_PATTERNS: RegExp[] = [
  /\border\s*(?:#|number|no\.?|num(?:ber)?|id)\s*:?\s*#?\s*\(?([A-Z0-9][A-Z0-9-]{2,30}[A-Z0-9])\)?/gi,
  /\border\s+#?\(?([A-Z0-9-]*\d[A-Z0-9-]*)\)?/gi,
  /\(#\s*([A-Z0-9][A-Z0-9-]*\d[A-Z0-9-]*)\)/gi, // "has shipped (#115450009)" — Pyramyd AIR, Tetley (2026-11-04)
  /\border\s*#\s*:?\s*([A-Z0-9-]*\d[A-Z0-9-]*)/gi,
];

export function extractOrderIds(subject: string, text: string): string[] {
  const grab = (s: string) => {
    const out: string[] = [];
    for (const re of ORDER_PATTERNS) {
      for (const m of Array.from(s.matchAll(re))) {
        // The match is case-insensitive, so "#102003876318342are about…" (Target's
        // subject) runs into the next word: cut a lowercase tail after a digit,
        // and drop a token that still has lowercase letters.
        const v = m[1].replace(/(\d)[a-z]+$/, "$1").replace(/^-+|-+$/g, "");
        if (/[a-z]/.test(v)) continue;
        if (!/\d/.test(v) || v.length < 4) continue;
        if (/^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/.test(v)) continue; // a date
        if (!out.some((x) => norm(x) === norm(v))) out.push(v);
      }
    }
    return out;
  };
  const fromSubject = grab(subject);
  if (fromSubject.length === 1) return fromSubject;
  const all = [...fromSubject];
  for (const v of grab(text)) if (!all.some((x) => norm(x) === norm(v))) all.push(v);
  return all;
}

const CARRIER_WORD: Array<[RegExp, Carrier]> = [
  [/\bfed\s?ex\b/i, "FEDEX"], [/\bups\b/i, "UPS"], [/\busps\b|postal service/i, "USPS"], [/\bdhl\b/i, "DHL"],
  [/\bontrac\b/i, "ONTRAC"], [/\blaser\s?ship\b/i, "LASERSHIP"], [/\bamazon\s+logistics\b/i, "AMAZON"],
  [/\bgls\b/i, "GLS"], // Zara's US parcels (claims patch §3.10, 2026-11-11)
];
/** A carrier named in prose or markup ("UPS", "FedEx Ground", "United Parcel Service" is not read) → Carrier, else null. */
export function carrierFromName(name: string | null | undefined): Carrier | null {
  if (!name) return null;
  for (const [re, c] of CARRIER_WORD) if (re.test(name)) return c;
  return null;
}
const carrierFromContext = (ctx: string): Carrier | null => {
  let best: { c: Carrier; at: number } | null = null;
  for (const [re, c] of CARRIER_WORD) {
    const all = Array.from(ctx.matchAll(new RegExp(re.source, "gi")));
    const last = all[all.length - 1];
    if (last && (!best || last.index! > best.at)) best = { c, at: last.index! };
  }
  return best?.c ?? null; // the carrier word NEAREST the number wins
};
const carrierFromHost = (url: string): Carrier | null =>
  /fedex\./i.test(url) ? "FEDEX" : /ups\.com/i.test(url) ? "UPS" : /usps\./i.test(url) ? "USPS" : /dhl\./i.test(url) ? "DHL" : /ontrac\./i.test(url) ? "ONTRAC" : null;

const TRACK_LABEL = /(tracking\s*(?:#|number|no\.?|num(?:ber)?|id|info)?|track\s+your\s+(?:shipment|package)|tracking\s*:)\s*[:#]?\s*$/i;

/** Carrier by number shape, given an optional context carrier. Null = not a tracking number we accept. */
/** USPS IMpb barcodes print "420" + ZIP (5 or 9) before the tracking number (ParcelPanel, DHL eCommerce). */
export function stripZipPrefix(token: string): string {
  const m = /^420(?:\d{5}|\d{9})(9\d{19,21})$/.exec(token);
  return m ? m[1] : token;
}

function classify(token: string, ctxCarrier: Carrier | null, hasLabel: boolean): Carrier | null {
  if (/^1Z[0-9A-Z]{16}$/.test(token)) return "UPS";
  if (/^TBA\d{12}$/.test(token)) return "AMAZON";
  if (/^1LS[0-9A-Z]{12,}$/.test(token)) return "LASERSHIP";
  if (/^C\d{14}$/.test(token)) return hasLabel || ctxCarrier === "ONTRAC" ? "ONTRAC" : null;
  if (/^[A-Z]{2}\d{9}US$/.test(token)) return hasLabel || ctxCarrier === "USPS" ? "USPS" : null;
  if (!/^\d+$/.test(token)) return null;
  if (!hasLabel && !ctxCarrier) return null; // all-digit: context required
  const n = token.length;
  if (ctxCarrier === "USPS" && n >= 20 && n <= 34) return "USPS";
  if (ctxCarrier === "DHL" && n >= 10 && n <= 11) return "DHL";
  if (ctxCarrier === "UPS" && n >= 9 && n <= 34) return "UPS"; // UPS Mail Innovations / SurePost ride USPS-shaped numbers
  if (ctxCarrier === "FEDEX" && [12, 15, 20, 22, 34].includes(n)) return "FEDEX";
  if (ctxCarrier === "GLS" && n >= 8 && n <= 20) return "GLS";
  if (ctxCarrier) return [10, 12, 15, 20, 22, 26, 30, 34].includes(n) ? ctxCarrier : null;
  if (n >= 20 && n <= 22 && token.startsWith("9")) return "USPS";
  if ([12, 15, 20, 22, 34].includes(n)) return "FEDEX";
  return null;
}

/** Carrier for a number with no surrounding context (a tracking link's id parameter): shape only. */
export function carrierForNumber(token: string): Carrier {
  const t = stripZipPrefix(token.toUpperCase());
  return classify(t, null, true) ?? "OTHER";
}

const URL_PARAM = /https?:\/\/[^\s)>"']*?[?&](?:trknbr|tracknums?|tracknum|tlabels|tracking_?numbers?|trackingnumber|inquirynumber1|qtc_tlabels1|tn)=([0-9A-Z]{8,34})/gi;

// Narvar's tracking page names the carrier in the path and the number as `t`:
// tracking.narvar.com/dickssportinggoods/tracking/fedex?t=…&bzip=… (2026-10-22).
const NARVAR_PAGE = /https?:\/\/tracking\.narvar\.com\/[^\/\s?]+\/tracking\/([a-z-]+)\?(?:[^\s#]*?&)?t=([0-9A-Z]{8,34})/gi;
const NARVAR_CARRIER: Record<string, Carrier> = { ups: "UPS", fedex: "FEDEX", usps: "USPS", dhl: "DHL", ontrac: "ONTRAC", lasership: "LASERSHIP", amazon: "AMAZON" };

export function extractTracking(text: string, orderIds: string[]): Array<{ carrier: Carrier; trackingNumber: string; at: number }> {
  const out: Array<{ carrier: Carrier; trackingNumber: string; at: number }> = [];
  const orders = new Set(orderIds.map(norm));
  const add = (carrier: Carrier | null, token: string, at: number) => {
    if (!carrier) return;
    const t = stripZipPrefix(token.toUpperCase());
    if (orders.has(norm(t))) return;
    const prev = out.find((x) => x.trackingNumber === t);
    if (prev) { prev.at = Math.min(prev.at, at); return; }
    out.push({ carrier, trackingNumber: t, at });
  };
  // 1. Carrier-site URL parameters — strongest evidence.
  for (const m of Array.from(text.matchAll(URL_PARAM))) {
    const token = m[1].toUpperCase();
    add(classify(token, carrierFromHost(m[0]), true) ?? carrierFromHost(m[0]), token, m.index!);
  }
  for (const m of Array.from(text.matchAll(NARVAR_PAGE))) {
    const token = m[2].toUpperCase();
    const ctx = NARVAR_CARRIER[m[1].toLowerCase()] ?? null;
    add(classify(token, ctx, true) ?? ctx, token, m.index!);
  }
  // 2. Tokens in the text, judged by the 60 characters before them.
  // Case-insensitive: Narvar prints "1z6y6f820322432042".
  const TOKEN = /\b(1Z[0-9A-Z]{16}|TBA\d{12}|1LS[0-9A-Z]{12,}|C\d{14}|[A-Z]{2}\d{9}US|\d{10,34})\b/gi;
  for (const m of Array.from(text.matchAll(TOKEN))) {
    const raw = m[1].toUpperCase();
    const token = /^\d+$/.test(raw) ? stripZipPrefix(raw) : raw;
    const before = text.slice(Math.max(0, m.index! - 60), m.index!);
    const distinctive = /^(1Z|TBA|1LS)/.test(token);
    // Inside a URL: only the distinctive shapes count (track.amazon.com/tracking/TBA…);
    // an all-digit number in a URL is trusted only as a known parameter (step 1).
    if (!distinctive && /https?:\/\/\S*$/.test(before)) continue;
    // "Reference" needs no word boundary: UPS run "Shipment Type: LetterReference Number 1: 212355503949" together (2026-11-04).
    if (/(?:\b(?:upc|sku|item\s*(?:no|#)|model|phone|tel|fax|po\s*box|order\s*(?:#|number|no)?)|reference\s*(?:number|no\.?|#)?\s*\d?)\s*[:#]?\s*$/i.test(before)) continue;
    const hasLabel = TRACK_LABEL.test(before.replace(/\s+/g, " ").trimEnd()) || /tracking/i.test(before.slice(-40));
    const ctx = text.slice(Math.max(0, m.index! - 80), m.index!);
    add(classify(token, carrierFromContext(ctx), hasLabel), token, m.index!);
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Items listed for one shipment: "name … Qty: N" pairs between this tracking # and the next. */
export function extractItems(segment: string): Array<{ name: string; qty: number }> {
  const lines = segment.split("\n").map((l) => l.trim()).filter(Boolean);
  const items: Array<{ name: string; qty: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const q = /^(?:qty|quantity)\s*:?\s*(\d{1,4})\b/i.exec(lines[i]);
    if (!q) continue;
    // The longest name-like line among the four above "Qty" — Macy's prints the
    // full name, then a truncated copy ending in "..." right above the qty.
    let name: string | null = null;
    for (let j = i - 1; j >= Math.max(0, i - 4); j--) {
      const l = lines[j];
      if (/^\$|^(upc|sku|item|price|color|size|per item)\b|^\d+(\.\d+)?$|tracking|delivery method|qty/i.test(l)) continue;
      const cand = l.replace(/(\.\.\.|…)\s*$/, "").trim();
      if (cand.length >= 8 && (!name || cand.length > name.length)) name = cand;
    }
    if (name) items.push({ name, qty: Number(q[1]) });
  }
  return items;
}

function unwrapForward(fromDomain: string | null, text: string): string | null {
  if (!fromDomain || !OWN_DOMAINS.has(fromDomain)) return fromDomain;
  const m = /From:\s*[^<\n]*<[^@<>\s]+@([^<>\s]+)>/i.exec(text);
  return m ? m[1].toLowerCase() : fromDomain;
}

// ── schema.org ParcelDelivery (2026-11-11, claims patch §3.10) ─────────────
// parcelLab's shipping notices (Harbor Freight "Your Shipment is heading your
// way shortly") carry the number only as hidden microdata: a display:none
// <div itemtype="http://schema.org/ParcelDelivery"> with the carrier's name,
// <meta itemprop="trackingNumber" content="1Z…"> and the trackingUrl —
// htmlToText drops it all. Google's shipping markup; some senders use the
// JSON-LD form instead. Read from the raw HTML (gmail-client.ts), pure.
export interface ParcelDelivery { carrier: string | null; trackingNumber: string; trackingUrl: string | null }

const unesc = (s: string) => s.replace(/&amp;/gi, "&").replace(/&quot;/gi, "\"").replace(/&#39;/g, "'");
const propContent = (block: string, prop: string): string | null => {
  const m = new RegExp(`<[^>]*\\bitemprop\\s*=\\s*["']${prop}["'][^>]*\\b(?:content|href)\\s*=\\s*["']([^"']+)["']`, "i").exec(block)
    ?? new RegExp(`<[^>]*\\b(?:content|href)\\s*=\\s*["']([^"']+)["'][^>]*\\bitemprop\\s*=\\s*["']${prop}["']`, "i").exec(block)
    ?? new RegExp(`<([a-z]+)[^>]*\\bitemprop\\s*=\\s*["']${prop}["'][^>]*>([^<]{1,200})<`, "i").exec(block);
  const v = m ? (m.length === 3 ? m[2] : m[1]) : null;
  return v ? unesc(v).trim() : null;
};
/** Pure: every ParcelDelivery the HTML marks up (microdata, then JSON-LD), distinct by number. */
export function parcelDeliveries(html: string): ParcelDelivery[] {
  const out: ParcelDelivery[] = [];
  const add = (carrier: string | null, number: string | null, url: string | null) => {
    const n = number?.trim().toUpperCase() ?? "";
    if (!/^[0-9A-Z]{8,34}$/.test(n) || out.some((x) => x.trackingNumber === n)) return;
    out.push({ carrier: carrier?.trim() || null, trackingNumber: n, trackingUrl: url });
  };
  // microdata: each ParcelDelivery block runs to the next one (or 6,000 characters)
  const starts = Array.from(html.matchAll(/itemtype\s*=\s*["']https?:\/\/schema\.org\/ParcelDelivery["']/gi)).map((m) => m.index!);
  starts.forEach((at, i) => {
    const block = html.slice(at, Math.min(starts[i + 1] ?? html.length, at + 6000));
    const carrierBlock = /itemprop\s*=\s*["']carrier["'][\s\S]{0,600}/i.exec(block)?.[0] ?? "";
    add(propContent(carrierBlock, "name"), propContent(block, "trackingNumber"), propContent(block, "trackingUrl"));
  });
  // JSON-LD
  for (const m of Array.from(html.matchAll(/<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi))) {
    let data: unknown;
    try { data = JSON.parse(m[1].trim()); } catch { continue; }
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) { v.forEach(walk); return; }
      if (!v || typeof v !== "object") return;
      const o = v as Record<string, unknown>;
      const t = o["@type"];
      if (t === "ParcelDelivery" || (Array.isArray(t) && t.includes("ParcelDelivery"))) {
        const c = o.carrier as Record<string, unknown> | string | undefined;
        add(typeof c === "string" ? c : (c?.name as string | undefined) ?? null, o.trackingNumber as string | undefined ?? null, (o.trackingUrl as string | undefined) ?? null);
      }
      for (const k of Object.keys(o)) walk(o[k]);
    };
    walk(data);
  }
  return out;
}

export function parseTrackingEmail(msg: { subject: string; text: string; fromDomain: string | null; parcelDeliveries?: ParcelDelivery[] | null }): ParsedEmail {
  const text = msg.text.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
  const all = `${msg.subject}\n${text}`;
  const orderIds = extractOrderIds(msg.subject, text);
  const found = extractTracking(text, orderIds);
  const shipments: ParsedShipment[] = found.map((f, i) => ({
    carrier: f.carrier, trackingNumber: f.trackingNumber,
    items: extractItems(text.slice(f.at, i + 1 < found.length ? found[i + 1].at : undefined)),
  }));
  // The markup's ParcelDelivery when the text printed nothing (parcelLab / Harbor Freight): carrier by its name,
  // else by the tracking URL's host, else by the number's shape.
  if (shipments.length === 0) {
    const orders = new Set(orderIds.map(norm));
    for (const p of msg.parcelDeliveries ?? []) {
      if (orders.has(norm(p.trackingNumber))) continue;
      const fromUrl = p.trackingUrl ? carrierFromHost(p.trackingUrl) : null;
      shipments.push({ carrier: carrierFromName(p.carrier) ?? fromUrl ?? carrierForNumber(p.trackingNumber), trackingNumber: p.trackingNumber, items: [] });
    }
  }
  const kind: ParsedEmail["kind"] = isReturnEmail(msg.subject, text) ? "return"
    : /\bdelivered\b/i.test(msg.subject) ? "delivered"
    : /out for delivery/i.test(msg.subject) ? "out_for_delivery"
    : SHIPPED_WORDS.test(all) ? "shipped" : "other";
  const senderDomain = unwrapForward(msg.fromDomain, text);
  const carrier = isCarrierSender(senderDomain);
  return {
    candidate: shipments.length > 0 || SHIPPED_WORDS.test(all),
    kind,
    senderDomain,
    orderIds,
    shipToStreet: extractShipTo(text),
    shipments,
    ...(carrier ? { shipperName: extractShipper(text), carrierRefs: extractCarrierRefs(text) } : {}),
  };
}
