// Per-domain tracking-link extractor — Michaels (SPEC §26, Maria 2026-10-21).
import { describe, it, expect } from "vitest";
import { extractLinkTracking, followToFinal, trackingLinks, LINK_EXTRACTORS, genericTrackingLinks, extractGenericLinkTracking, type FetchLike } from "./tracking-links";
import { carrierForNumber } from "./tracking-parse";
import { withLinkTracking, rowsFromEmail, resolveLinkPlaceholders } from "./tracking-ingest";
import { parseTrackingEmail, extractTracking } from "./tracking-parse";
import { trackAnchors } from "./gmail-client";

const CLICK = "http://jyf2rix8.michaels.com/ls/click?upn=u001.abc";
const MICHAELS_TEXT = `Order 3500109099878917 Your order has shipped!\nShipping Address\n805 Grandy Ave\nTracking\nInformation\n( ${CLICK} )\nITEM\nQTY (2)`;
// The real click tracker answers one 302 to /track?id=… (HTML-escaped &amp; in Location).
const fakeFetch = (id: string, calls: string[] = []): FetchLike => async (url, init) => {
  calls.push(`${init.method} ${url}`);
  if (url === CLICK) return { status: 302, headers: { get: (n) => (n.toLowerCase() === "location" ? `https://www.michaels.com/track?id=${id}&amp;order=XYZ&amp;lastName=B&amp;email=x` : null) } };
  return { status: 200, headers: { get: () => null } };
};

describe("Michaels tracking link", () => {
  it("a long click URL is read whole — only its start has to be near the label (real ones run ~750 chars)", () => {
    const long = `http://jyf2rix8.michaels.com/ls/click?upn=${"x".repeat(700)}`;
    expect(trackingLinks(`Tracking\r\n\r\nInformation\r\n\r\n( ${long} )`, LINK_EXTRACTORS[0])).toEqual([long]);
    expect(trackingLinks(`Tracking Information${" ".repeat(500)}( ${long} )`, LINK_EXTRACTORS[0])).toEqual([]);
  });
  it("one extractor, keyed on michaels.com, label 'Tracking Information', id parameter", () => {
    expect(LINK_EXTRACTORS.map((e) => [e.domain, e.param])).toEqual([["michaels.com", "id"]]);
    expect(trackingLinks(MICHAELS_TEXT, LINK_EXTRACTORS[0])).toEqual([CLICK]);
  });
  it("follows the redirect by Location headers only (HEAD, no body) and takes id; carrier from the number's shape", async () => {
    const calls: string[] = [];
    expect(await extractLinkTracking(MICHAELS_TEXT, "michaels.com", fakeFetch("1Z09482W0312114120", calls))).toEqual([{ carrier: "UPS", trackingNumber: "1Z09482W0312114120" }]);
    expect(calls).toEqual([`HEAD ${CLICK}`]);
    expect(await extractLinkTracking(MICHAELS_TEXT, "michaels.com", fakeFetch("9200190288079111507345"))).toEqual([{ carrier: "USPS", trackingNumber: "9200190288079111507345" }]);
  });
  it("HEAD refused → GET (manual redirect); a chain that never reaches /track → nothing", async () => {
    const seen: string[] = [];
    const f: FetchLike = async (url, init) => {
      seen.push(init.method);
      if (init.method === "HEAD") return { status: 405, headers: { get: () => null } };
      return { status: 302, headers: { get: () => "https://www.michaels.com/track?id=1Z09482W0312114120" } };
    };
    expect(await followToFinal(CLICK, /michaels\.com\/track\?/, f)).toBe("https://www.michaels.com/track?id=1Z09482W0312114120");
    expect(seen).toEqual(["HEAD", "GET"]);
    const dead: FetchLike = async () => ({ status: 200, headers: { get: () => null } });
    expect(await extractLinkTracking(MICHAELS_TEXT, "michaels.com", dead)).toEqual([]);
  });
  it("other domains have no extractor — no request is made", async () => {
    const calls: string[] = [];
    expect(await extractLinkTracking(MICHAELS_TEXT, "oe.target.com", fakeFetch("1Z0", calls))).toEqual([]);
    expect(calls).toEqual([]);
  });
  it("carrierForNumber: shape only", () => {
    expect(carrierForNumber("1Z09482W0312114120")).toBe("UPS");
    expect(carrierForNumber("9200190288079111507345")).toBe("USPS");
    expect(carrierForNumber("546832326711")).toBe("FEDEX");
    expect(carrierForNumber("ABC")).toBe("OTHER");
  });
  it("in ingest: the shipped email becomes a real row instead of the ai_disabled placeholder", async () => {
    const msg = { id: "m", threadId: null, date: new Date("2026-10-20T10:00:00Z"), subject: "Your Order Has Shipped", text: MICHAELS_TEXT, fromDomain: "michaels.com" };
    const p = await withLinkTracking(msg, parseTrackingEmail(msg), fakeFetch("1Z09482W0312114120"));
    expect(rowsFromEmail(msg, p)).toEqual([expect.objectContaining({ carrier: "UPS", tracking_number: "1Z09482W0312114120", retailer_order_id: "3500109099878917", match_reason: null })]);
  });
  it("re-run for existing placeholders: resolved rows are written and the placeholder is deleted", async () => {
    const writes: string[] = [];
    const query = async (sql: string, params?: any[]) => {
      if (sql.includes("tracking_number LIKE 'email:%'")) return { rows: [{ id: 9, gmail_message_id: "m", sender_domain: "michaels.com", retailer_order_id: "3500109099878917" }], rowCount: 1 };
      writes.push(`${sql.slice(0, 30)} ${JSON.stringify(params?.slice(0, 2))}`);
      return { rows: [{ inserted: true }], rowCount: 1 };
    };
    const deps = { gmail: {} as any, fetch: fakeFetch("1Z09482W0312114120"), get: async () => ({ id: "m", threadId: null, date: new Date(), from: "", fromDomain: "michaels.com", subject: "Your Order Has Shipped", text: MICHAELS_TEXT, labelIds: [] }) };
    const r = await resolveLinkPlaceholders(query as any, deps as any);
    expect(r).toEqual({ placeholders: 1, resolved: 1, rows: 1 });
    expect(writes.some((w) => w.includes("INSERT INTO po_tracking") && w.includes("1Z09482W0312114120"))).toBe(true);
    expect(writes.some((w) => w.startsWith("DELETE FROM po_tracking") && w.includes("email:michaels.com:3500109099878917"))).toBe(true);
  });
});

describe("generic tracking links (any sender, 2026-10-22)", () => {
  // A redirect map: each URL → its Location (absent = 200, end of chain).
  const chain = (hops: Record<string, string>, calls: string[] = []): FetchLike => async (url) => {
    calls.push(url);
    const loc = hops[url];
    return { status: loc ? 302 : 200, headers: { get: (n: string) => (n.toLowerCase() === "location" ? loc ?? null : null) } };
  };
  it("HTML anchors that say track are kept (htmlToText drops hrefs) — text label first, then href", () => {
    const html = `<a href="https://x.com/a">Shop</a><a href="https://click.x.com/1?u=2&amp;v=3"><span>Track package</span></a><a href="https://x.com/track/9">here</a>`;
    expect(trackAnchors(html)).toEqual(["https://click.x.com/1?u=2&v=3", "https://x.com/track/9"]);
  });
  it("Narvar's tracking page: carrier from the path, number from t", () => {
    expect(extractTracking("https://tracking.narvar.com/dickssportinggoods/tracking/fedex?t=394837261504&bzip=97850", [])).toEqual([expect.objectContaining({ carrier: "FEDEX", trackingNumber: "394837261504" })]);
  });
  it("follows a track link's redirects until a carrier URL carries the number; an order page yields nothing", async () => {
    const hops = { "https://click.esp.com/a": "https://www.ups.com/track?loc=en_US&tracknum=1Z999AA10123456784" };
    const calls: string[] = [];
    expect(await extractGenericLinkTracking("", ["5001"], chain(hops, calls), ["https://click.esp.com/a"])).toEqual([{ carrier: "UPS", trackingNumber: "1Z999AA10123456784" }]);
    expect(calls).toEqual(["https://click.esp.com/a"]);
    expect(await extractGenericLinkTracking("Track your order: https://shop.x.com/orders/abc?key=1", ["5001"], chain({}))).toEqual([]);
  });
  it("text links after a track label, capped per email", () => {
    const text = Array.from({ length: 9 }, (_, i) => `Track it https://t.x.com/${i}`).join("\n");
    expect(genericTrackingLinks(text)).toHaveLength(6);
  });
  it("in ingest: only an email that would queue a placeholder is followed; one with a number makes no request", async () => {
    const hops = { "https://click.esp.com/a": "https://www.fedex.com/fedextrack/?trknbr=394837261504" };
    const msg = { id: "m", threadId: null, date: new Date(), subject: "Your order has shipped", text: "Order #5001234 has shipped. Track package", fromDomain: "acme.com", trackLinks: ["https://click.esp.com/a"] };
    const p = await withLinkTracking(msg, parseTrackingEmail(msg), chain(hops));
    expect(rowsFromEmail(msg, p).map((r) => [r.carrier, r.tracking_number])).toEqual([["FEDEX", "394837261504"]]);
    const calls: string[] = [];
    const withNo = { ...msg, text: "Order #5001234 has shipped. UPS tracking number 1Z999AA10123456784" };
    await withLinkTracking(withNo, parseTrackingEmail(withNo), chain(hops, calls));
    expect(calls).toEqual([]);
    const promo = { ...msg, subject: "Fall sale", text: "Track your rewards https://x.com/track" };
    await withLinkTracking(promo, parseTrackingEmail(promo), chain(hops, calls));
    expect(calls).toEqual([]);
  });
});
