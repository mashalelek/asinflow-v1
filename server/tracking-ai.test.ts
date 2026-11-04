// PO tracking AI fallback (SPEC §26; built 2026-11-04 — the ai_disabled placeholders).
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { aiFallbackAvailable, AI_DISABLED_REASON, AI_NO_TRACKING_REASON, verifiedAiShipments, verifiedAiLink, aiEmailText, resolvePlaceholdersWithAi, type TrackingAiCall } from "./tracking-ai";
import { rowsFromEmail } from "./tracking-ingest";
import { parseTrackingEmail } from "./tracking-parse";

describe("AI fallback: availability and the placeholder", () => {
  it("available exactly when a key is configured", () => {
    expect(aiFallbackAvailable({ ANTHROPIC_API_KEY: "sk-test" } as any)).toBe(true);
    expect(aiFallbackAvailable({} as any)).toBe(false);
  });
  it("a shipped email nothing can read is queued as unmatched / ai_disabled — the ingest never calls the model itself", () => {
    const msg = { id: "m", threadId: null, date: new Date(), subject: "Your order #12345 has shipped", text: "Your order #12345 has shipped. Track it in your account.", fromDomain: "shop.example.com" };
    expect(rowsFromEmail(msg, parseTrackingEmail(msg))).toEqual([expect.objectContaining({ match_reason: AI_DISABLED_REASON, tracking_number: "email:shop.example.com:12345", carrier: "OTHER" })]);
  });
  it("the Anthropic client is constructed in server/config/ai.ts only; no other server module builds one", () => {
    // Other modules may import the SDK's zod output-format helper (a type-level helper, no client).
    for (const f of readdirSync(__dirname).filter((x) => x.endsWith(".ts") && !x.endsWith(".test.ts"))) {
      const src = readFileSync(join(__dirname, f), "utf8");
      expect(src).not.toMatch(/api\.anthropic\.com|new Anthropic\(/);
      expect(src.replace(/@anthropic-ai\/sdk\/helpers\/zod/g, "")).not.toMatch(/@anthropic-ai/);
    }
    expect(readFileSync(join(__dirname, "config", "ai.ts"), "utf8")).toMatch(/new Anthropic\(\)/);
  });
});

describe("nothing the model says is trusted as is", () => {
  const text = "Your order 1283797 is on the way. UPS tracking 1Z999AA10123456784. Call 8434671254. USPS 420978509261290326101842853358";
  it("a number counts only when printed in the email — not the order #, not invented; a USPS ZIP prefix is dropped", () => {
    expect(verifiedAiShipments([
      { carrier: "UPS", tracking_number: "1Z 999 AA1 0123 4567 84" },
      { carrier: "FEDEX", tracking_number: "123456789012" },
      { carrier: "OTHER", tracking_number: "1283797" },
      { carrier: "USPS", tracking_number: "420978509261290326101842853358" },
      { carrier: "BOGUS", tracking_number: "8434671254" },
    ], text, "1283797")).toEqual([
      { carrier: "UPS", trackingNumber: "1Z999AA10123456784" },
      { carrier: "USPS", trackingNumber: "9261290326101842853358" },
      { carrier: "OTHER", trackingNumber: "8434671254" },
    ]);
  });
  it("a link counts only when it is one of the email's own URLs", () => {
    const msg = { text: "[TRACK YOUR ORDER](https://us.typology.com/account/orders?action=tracking)", trackLinks: ["https://ctrk.klclick.com/l/01M5"] };
    expect(verifiedAiLink("https://ctrk.klclick.com/l/01M5", msg)).toBe("https://ctrk.klclick.com/l/01M5");
    expect(verifiedAiLink("https://us.typology.com/account/orders?action=tracking", msg)).toBe("https://us.typology.com/account/orders?action=tracking");
    expect(verifiedAiLink("https://www.ups.com/track?tracknum=1Z999AA10123456784", msg)).toBeNull();
    expect(verifiedAiLink(null, msg)).toBeNull();
  });
  it("the model sees the text without invisible padding, with the tracking links", () => {
    expect(aiEmailText({ text: "On the way! &zwnj; &zwnj;‌ &#8199; &#847; Order #1", trackLinks: ["https://x.test/t"] })).toBe("On the way! Order #1\n\nTracking links:\nhttps://x.test/t");
  });
});

describe("resolvePlaceholdersWithAi", () => {
  const PH = [
    { id: 7, gmail_message_id: "m7", gmail_thread_id: null, sender_domain: "typology.com", retailer_order_id: "1283797", email_subject: "Your order 1283797 is on the way", ship_to_street: null, shipped_at: new Date("2026-10-21") },
    { id: 8, gmail_message_id: "m8", gmail_thread_id: null, sender_domain: "beauty.sephora.com", retailer_order_id: "839122002407", email_subject: "Shipped", ship_to_street: null, shipped_at: new Date("2026-10-19") },
    { id: 9, gmail_message_id: "m9", gmail_thread_id: null, sender_domain: "giftcardoutlets.com", retailer_order_id: "BO-1", email_subject: "Shipped", ship_to_street: null, shipped_at: new Date("2026-10-09") },
  ];
  const TEXT: Record<string, string> = { m7: "Your order 1283797 is on the way. UPS tracking 1Z999AA10123456784", m8: "Your Sephora order has shipped. Review it in My Account." };
  function setup(ai: TrackingAiCall | null) {
    const writes: Array<{ sql: string; params: any[] }> = [];
    const upserts: any[] = [];
    const query = async (sql: string, params?: any[]) => {
      if (sql.includes("FROM po_tracking") && sql.trimStart().startsWith("SELECT")) return { rows: PH, rowCount: PH.length };
      writes.push({ sql, params: params ?? [] });
      return { rows: [{ id: 1 }], rowCount: 1 };
    };
    const deps = {
      gmail: {} as any, ai,
      get: async (_g: any, id: string) => ({ id, threadId: null, date: new Date("2026-10-21"), from: "", fromDomain: null, subject: "s", text: TEXT[id] ?? "", labelIds: [] }),
      onePo: (r: any) => (r.sender_domain === "giftcardoutlets.com" ? null : { po_id: `po-${r.id}`, supplier: r.sender_domain }),
      upsert: async (d: any) => { upserts.push(d); },
      fetch: async () => ({ status: 200, headers: { get: () => null } }),
    };
    return { query: query as any, deps, writes, upserts };
  }
  const reply = (m: Record<string, any>): TrackingAiCall => async (_s, text) => ({ input_tokens: 1000, output_tokens: 50, track_link: null, shipments: [], ...(text.includes("1283797") ? m.m7 : m.m8) });

  it("dry run: counts the emails it would ask about, no model call, no write", async () => {
    let calls = 0;
    const s = setup(async () => { calls++; throw new Error("no"); });
    const r = await resolvePlaceholdersWithAi(s.query, s.deps, { dryRun: true });
    expect(r).toMatchObject({ placeholders: 3, one_po: 2, no_single_po: 1, dry_run: 2, calls: 0 });
    expect(calls).toBe(0);
    expect(s.writes).toHaveLength(0);
  });
  it("live: a printed number replaces the placeholder (source ai); none → ai_no_tracking; every call logged as tracking_fallback", async () => {
    const s = setup(reply({ m7: { shipments: [{ carrier: "UPS", tracking_number: "1Z999AA10123456784" }] }, m8: { shipments: [{ carrier: "UPS", tracking_number: "1Z000000000000000" }] } }));
    const r = await resolvePlaceholdersWithAi(s.query, s.deps);
    expect(r).toMatchObject({ calls: 2, resolved: 1, rows: 1, none: 1, failed: 0, no_single_po: 1 });
    expect(s.upserts).toEqual([expect.objectContaining({ carrier: "UPS", tracking_number: "1Z999AA10123456784", retailer_order_id: "1283797", source: "ai", match_reason: null, gmail_message_id: "m7" })]);
    expect(s.writes.filter((w) => w.sql.startsWith("DELETE FROM po_tracking")).map((w) => w.params[0])).toEqual([7]);
    expect(s.writes.filter((w) => w.sql.startsWith("UPDATE po_tracking")).map((w) => w.params)).toEqual([[8, AI_NO_TRACKING_REASON]]);
    const logs = s.writes.filter((w) => w.sql.includes("INSERT INTO po_prefill_log"));
    expect(logs.map((w) => [w.params[1], w.params[2], w.params[9]])).toEqual([["tracking_fallback", "typology.com", true], ["tracking_fallback", "beauty.sephora.com", true]]);
  });
  it("a failed call is logged (schema_ok false) and the placeholder stays ai_disabled for the next pass", async () => {
    const s = setup(async () => { throw new Error("overloaded"); });
    const r = await resolvePlaceholdersWithAi(s.query, s.deps);
    expect(r).toMatchObject({ calls: 2, failed: 2, resolved: 0 });
    expect(s.writes.filter((w) => w.sql.startsWith("UPDATE po_tracking") || w.sql.startsWith("DELETE"))).toHaveLength(0);
    expect(s.writes.filter((w) => w.sql.includes("INSERT INTO po_prefill_log")).map((w) => [w.params[9], w.params[10]])).toEqual([[false, "overloaded"], [false, "overloaded"]]);
  });
  it("capped per pass: the rest wait (over_cap), untouched", async () => {
    const s = setup(reply({ m7: {}, m8: {} }));
    const r = await resolvePlaceholdersWithAi(s.query, s.deps, { maxCalls: 1 });
    expect(r).toMatchObject({ calls: 1, skipped_cap: 1 });
    expect(r.items.map((i) => i.outcome)).toEqual(["none", "over_cap"]);
  });
  it("AI off: nothing asked", async () => {
    const s = setup(null);
    const r = await resolvePlaceholdersWithAi(s.query, s.deps);
    expect(r).toMatchObject({ off: true, calls: 0, one_po: 2 });
    expect(s.writes).toHaveLength(0);
  });
});
