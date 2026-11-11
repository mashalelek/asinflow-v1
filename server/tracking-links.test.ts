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
    // the placeholder is dropped by id (2026-11-11: by registrable domain + order base key, dropPlaceholdersFor)
    expect(writes.some((w) => w.startsWith("DELETE FROM po_tracking") && w.includes("[[9]]"))).toBe(true);
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

// ── Claims patch §3.10 (2026-11-11): HEAD-less click trackers, anchor rules, why a link yields nothing ──
import { readFileSync } from "fs";
import { join } from "path";
import { followDiagnostic, linkOutcome, ruleAnchors, ANCHOR_RULES } from "./tracking-links";
const fx2 = (name: string) => JSON.parse(readFileSync(join(__dirname, "__fixtures__", "tracking-emails", `${name}.json`), "utf8"));
/** A fetch that answers HEAD with `headStatus` (no Location) and GET with the chain's Location. */
const getOnly = (hops: Record<string, string>, headStatus = 404, calls: string[] = []): FetchLike => async (url, init) => {
  calls.push(`${init.method} ${url}`);
  if (init.method === "HEAD") return { status: headStatus, headers: { get: () => null } };
  const loc = hops[url];
  return { status: loc ? 302 : 200, headers: { get: (n: string) => (n.toLowerCase() === "location" ? loc ?? null : null) }, body: { cancel: async () => {} } };
};

describe("click trackers that redirect only a GET (Duluth, Klaviyo, Shopify — 2026-11-11)", () => {
  it("Duluth: HEAD answers 404; the GET's Location carries trackingId + carrierCode=ups → UPS", async () => {
    const m = fx2("duluth-track-order-get-only");
    const hops = { "https://link.duluthtrading.com/q/TOKEN2": "https://dlhip.omni.manh.com/selfservice/ui/tracking.html?orderId=WEB46731911&trackingId=1ZB3480B0424951037&carrierCode=ups&orgId=DuluthTrading&token=SCRUBBED" };
    const calls: string[] = [];
    const p = await withLinkTracking(m, parseTrackingEmail(m), getOnly(hops, 404, calls));
    expect(p.shipments).toEqual([{ carrier: "UPS", trackingNumber: "1ZB3480B0424951037", items: [] }]);
    // TOKEN1 (the first Track Order anchor) was tried first: HEAD, then GET, then the second
    expect(calls.slice(0, 2)).toEqual(["HEAD https://link.duluthtrading.com/q/TOKEN1", "GET https://link.duluthtrading.com/q/TOKEN1"]);
    expect(rowsFromEmail({ id: "d", threadId: null, date: new Date(m.date), subject: m.subject }, p)).toEqual([expect.objectContaining({ carrier: "UPS", tracking_number: "1ZB3480B0424951037", retailer_order_id: "WEB46731911" })]);
  });
  it("a HEAD that answers 200 without Location is also retried as GET (the body is cancelled, never read)", async () => {
    let cancelled = 0;
    const f: FetchLike = async (url, init) => {
      if (init.method === "HEAD") return { status: 200, headers: { get: () => null } };
      return { status: 302, headers: { get: (n: string) => (n === "location" ? "https://www.ups.com/track?tracknum=1Z999AA10123456784" : null) }, body: { cancel: async () => { cancelled++; } } };
    };
    expect(await followToFinal("https://click.x.com/a", /ups\.com/, f)).toBe("https://www.ups.com/track?tracknum=1Z999AA10123456784");
    expect(cancelled).toBe(1);
  });
});

describe("per-domain anchor rules (Summit Racing through Narvar's CTA — the anchor says 'View Up-to-Date Order Details')", () => {
  it("one rule: narvar.com senders; every cta.narvar.com/f/a/ anchor is a candidate, capped at 20", () => {
    expect(ANCHOR_RULES.map((r) => [r.domain, r.max])).toEqual([["narvar.com", 20]]);
    const m = fx2("summit-narvar-anchors");
    expect(ruleAnchors("summitracing.narvar.com", m.links)).toHaveLength(16);
    expect(ruleAnchors("acme.com", m.links)).toEqual([]);
    expect(ruleAnchors(null, m.links)).toEqual([]);
    expect(ruleAnchors("x.narvar.com", Array.from({ length: 30 }, (_, i) => `https://cta.narvar.com/f/a/T${i}`))).toHaveLength(20);
  });
  it("the seventh anchor lands on tracking.summitracing.com/…/tracking/ups?tracking_numbers=1z1xw… (lower case) → UPS, upper-cased", async () => {
    const m = fx2("summit-narvar-anchors");
    const hops: Record<string, string> = {};
    m.links.forEach((u: string, i: number) => { hops[u] = i === 6 ? "https://tracking.summitracing.com/summitracing/tracking/ups?tracking_numbers=1z1xw7200417169589&service=GR&order_number=3403404-20261004" : `https://www.summitracing.com/page${i}`; });
    const calls: string[] = [];
    const p = await withLinkTracking(m, parseTrackingEmail(m), getOnly(hops, 404, calls));
    expect(p.shipments).toEqual([{ carrier: "UPS", trackingNumber: "1Z1XW7200417169589", items: [] }]);
    expect(rowsFromEmail({ id: "s", threadId: null, date: new Date(m.date), subject: m.subject }, p)).toEqual([expect.objectContaining({ carrier: "UPS", tracking_number: "1Z1XW7200417169589", retailer_order_id: "3403404-20261004" })]);
  });
});

describe("why a link yields nothing (the backfill report)", () => {
  it("Zara: the tracking link lands on tracking-not-available; Typology: Klaviyo → the account page (login); Shopify: login_required; Ace: 403", async () => {
    const z = fx2("zara-tracking-unavailable");
    const hops = { "https://www.zara.com/integration/1/tracking/TOKEN": "https://www.zara.com/tracking-not-available" };
    expect((await withLinkTracking(z, parseTrackingEmail(z), getOnly(hops))).shipments).toEqual([]);
    expect(linkOutcome(await followDiagnostic("https://www.zara.com/integration/1/tracking/TOKEN", getOnly(hops)))).toBe("www.zara.com: tracking page says not available");
    expect(linkOutcome({ final: "https://us.typology.com/account/orders?action=tracking&_kx=SCRUBBED", status: 200 })).toBe("us.typology.com: needs a login");
    expect(linkOutcome({ final: "https://shopify.com/14999880/account/callback?error=login_required", status: 400 })).toBe("shopify.com: needs a login");
    expect(linkOutcome({ final: "https://www.acehardware.com/order-detail/TOKEN", status: 403 })).toBe("www.acehardware.com: blocked (403)");
    expect(linkOutcome({ final: "https://store.ui.com/us/en/order/abc/status?customerId=SCRUBBED", status: 200 })).toBe("store.ui.com: page carries no number in its URL");
    expect(linkOutcome({ final: "https://x.com/a", status: -1 })).toBe("x.com: request failed");
    const t = fx2("typology-klaviyo-login");
    expect((await withLinkTracking(t, parseTrackingEmail(t), getOnly({ "https://ctrk.klclick.com/l/TOKEN_1": "https://us.typology.com/account/orders?action=tracking" }))).shipments).toEqual([]);
  });
});
