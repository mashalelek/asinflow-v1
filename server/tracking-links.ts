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
import { carrierForNumber, type Carrier } from "./tracking-parse";

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
export async function followToFinal(url: string, final: RegExp, fetchFn: FetchLike = fetch as any): Promise<string | null> {
  let cur = url;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    if (final.test(cur)) return cur;
    let r = await fetchFn(cur, { method: "HEAD", redirect: "manual" });
    if (r.status === 405 || r.status === 403 || r.status === 501) {
      r = await fetchFn(cur, { method: "GET", redirect: "manual" });
      await r.body?.cancel?.().catch(() => {});
    }
    const loc = r.headers.get("location");
    if (!loc || r.status < 300 || r.status >= 400) return null;
    cur = new URL(loc.replace(/&amp;/g, "&"), cur).toString();
  }
  return final.test(cur) ? cur : null;
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
