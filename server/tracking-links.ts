// Per-domain "tracking link" extractors (SPEC §26; Maria 2026-10-21). Some
// retailers print no carrier number in the email — only a link. Michaels'
// "Tracking Information" link is a click tracker that redirects to
// https://www.michaels.com/track?id=<tracking>&order=…&lastName=…&email=…;
// the carrier number is the `id` parameter (1Z09482W0312114120 for order
// 3500109099878917; USPS 9200190288079111507345 on another shipment).
//
// Mechanism: find the extractor's links after its label, follow the redirect
// chain WITHOUT rendering — HEAD with redirect:"manual" (GET if HEAD is
// refused; the body is never read), Location by Location, ≤ 5 hops — until a
// URL matches the final pattern; take the parameter; the carrier comes from
// the number's shape. Nothing is sent but the click-tracker request itself.
import { carrierForNumber, extractTracking, type Carrier } from "./tracking-parse";

export interface LinkExtractor {
  /** Registrable sender domain. */
  domain: string;
  /** The label the tracking link follows. */
  label: RegExp;
  /** Links to follow (searched within LINK_WINDOW characters after each label). */
  link: RegExp;
  /** The URL that carries the number. */
  final: RegExp;
  param: string;
}

export const LINK_EXTRACTORS: readonly LinkExtractor[] = [
  {
    domain: "michaels.com",
    label: /tracking\s*information/gi,
    link: /https?:\/\/[^\s)>"']*michaels\.com\/ls\/click\?[^\s)>"']+/i,
    final: /michaels\.com\/track\?/i,
    param: "id",
  },
];
const LINK_WINDOW = 400;
const MAX_HOPS = 5;

export const extractorFor = (domain: string | null): LinkExtractor | null => {
  if (!domain) return null;
  const reg = domain.toLowerCase().split(".").slice(-2).join(".");
  return LINK_EXTRACTORS.find((e) => e.domain === reg) ?? null;
};

export type FetchLike = (url: string, init: { method: "HEAD" | "GET"; redirect: "manual" }) => Promise<{ status: number; headers: { get(name: string): string | null }; body?: { cancel?: () => Promise<void> } | null }>;

/** Follow a redirect chain by Location headers only. Returns the URL matching `final`, or null. */
export async function followToFinal(url: string, final: RegExp | ((u: string) => boolean), fetchFn: FetchLike = fetch as any): Promise<string | null> {
  const ok = typeof final === "function" ? final : (u: string) => final.test(u);
  let cur = url;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    if (ok(cur)) return cur;
    let r = await fetchFn(cur, { method: "HEAD", redirect: "manual" });
    if (r.status === 405 || r.status === 403 || r.status === 501) {
      r = await fetchFn(cur, { method: "GET", redirect: "manual" });
      await r.body?.cancel?.().catch(() => {});
    }
    const loc = r.headers.get("location");
    if (!loc || r.status < 300 || r.status >= 400) return null;
    cur = new URL(loc.replace(/&amp;/g, "&"), cur).toString();
  }
  return ok(cur) ? cur : null;
}

/** The links an extractor follows in one email, de-duplicated, in order. */
export function trackingLinks(text: string, ex: LinkExtractor): string[] {
  const out: string[] = [];
  for (const m of Array.from(text.matchAll(ex.label))) {
    // The link must START within the window; it is read whole from the text
    // (Michaels' click URLs run ~750 characters — a window slice cut them).
    const from = m.index! + m[0].length;
    const hit = ex.link.exec(text.slice(from));
    if (!hit || hit.index > LINK_WINDOW) continue;
    const u = hit[0];
    if (!out.includes(u)) out.push(u);
  }
  return out;
}

/** Tracking numbers behind an email's tracking links (none for a domain without an extractor). */
export async function extractLinkTracking(text: string, senderDomain: string | null, fetchFn: FetchLike = fetch as any): Promise<Array<{ carrier: Carrier; trackingNumber: string }>> {
  const ex = extractorFor(senderDomain);
  if (!ex) return [];
  const out: Array<{ carrier: Carrier; trackingNumber: string }> = [];
  for (const link of trackingLinks(text, ex)) {
    let finalUrl: string | null = null;
    try { finalUrl = await followToFinal(link, ex.final, fetchFn); } catch { finalUrl = null; }
    if (!finalUrl) continue;
    const id = new URL(finalUrl).searchParams.get(ex.param)?.trim().toUpperCase();
    if (!id || !/^[0-9A-Z]{8,34}$/.test(id) || out.some((x) => x.trackingNumber === id)) continue;
    out.push({ carrier: carrierForNumber(id), trackingNumber: id });
  }
  return out;
}

// ── Generic tracking links (2026-10-22, Maria) ─────────────────────────────
// Any sender: a link that STARTS within LINK_WINDOW characters after a
// "track" label (Track package, Tracking information, Track your order…),
// or a URL that itself says "track", is followed by Location headers only
// (≤ MAX_HOPS, body never read) until a URL in the chain carries a number
// the carrier-URL parser recognises (extractTracking on the URL: a carrier
// site parameter — trknbr / tracknum / tLabels / tracking_numbers… — or a
// distinctive shape 1Z / TBA / 1LS). At most GENERIC_MAX_LINKS per email.
const GENERIC_LABEL = /\btrack(?:ing)?\b[^\n]{0,40}/gi;
const ANY_URL = /https?:\/\/[^\s)>"'\]]+/gi;
export const GENERIC_MAX_LINKS = 6;

/** The candidate tracking links in an email, in order, de-duplicated: the HTML's "track" anchors, then the text's. */
export function genericTrackingLinks(text: string, anchors: readonly string[] = []): string[] {
  const out: string[] = [];
  const push = (u: string) => { const c = u.replace(/&amp;/g, "&"); if (!out.includes(c) && out.length < GENERIC_MAX_LINKS) out.push(c); };
  for (const a of anchors) push(a);
  for (const m of Array.from(text.matchAll(GENERIC_LABEL))) {
    const from = m.index! + m[0].length;
    ANY_URL.lastIndex = 0;
    const hit = ANY_URL.exec(text.slice(from));
    if (hit && hit.index <= LINK_WINDOW) push(hit[0]);
  }
  for (const m of Array.from(text.matchAll(ANY_URL))) if (/track/i.test(m[0])) push(m[0]);
  return out;
}

const numbersInUrl = (u: string, orderIds: string[]) => {
  let d = u;
  try { d = decodeURIComponent(u); } catch { /* keep raw */ }
  return extractTracking(d, orderIds).filter((x) => x.carrier !== "OTHER");
};

/** Tracking numbers behind any sender's tracking links. */
export async function extractGenericLinkTracking(text: string, orderIds: string[], fetchFn: FetchLike = fetch as any, anchors: readonly string[] = []): Promise<Array<{ carrier: Carrier; trackingNumber: string }>> {
  const out: Array<{ carrier: Carrier; trackingNumber: string }> = [];
  for (const link of genericTrackingLinks(text, anchors)) {
    let finalUrl: string | null = null;
    try { finalUrl = await followToFinal(link, (u) => numbersInUrl(u, orderIds).length > 0, fetchFn); } catch { finalUrl = null; }
    if (!finalUrl) continue;
    for (const n of numbersInUrl(finalUrl, orderIds)) if (!out.some((x) => x.trackingNumber === n.trackingNumber)) out.push({ carrier: n.carrier, trackingNumber: n.trackingNumber });
  }
  return out;
}
