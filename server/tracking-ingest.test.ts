// PO tracking ingest (SPEC §26, patch po-tracking-velocity commit 2).
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { ingestTracking, WATERMARK_KEY } from "./tracking-ingest";

const fx = (name: string) => JSON.parse(readFileSync(join(__dirname, "__fixtures__", "tracking-emails", `${name}.json`), "utf8"));
const NAMES = ["macys-two-shipments", "michaels-shipped-no-tracking", "promo-not-shipping", "kohls-forward-no-tracking"];

function harness(opts: { existing?: Record<string, "unmatched" | "matched"> } = {}) {
  const writes: Array<{ sql: string; params: any[] }> = [];
  let listedQuery = "";
  const rows = new Map<string, string>(Object.entries(opts.existing ?? {}));
  const query = async (sql: string, params?: any[]) => {
    if (sql.startsWith("SELECT value FROM settings")) return { rows: [{ value: { last_scanned_at: "2026-10-20T04:00:00.000Z" } }], rowCount: 1 };
    if (sql.includes("tracking_number LIKE 'email:%'")) return { rows: [], rowCount: 0 }; // resolveLinkPlaceholders' read
    writes.push({ sql, params: params ?? [] });
    if (sql.includes("INSERT INTO po_tracking")) {
      const key = `${params![0]}|${params![1]}`;
      const st = rows.get(key);
      if (!st) { rows.set(key, "unmatched"); return { rows: [{ inserted: true }], rowCount: 1 }; }
      return st === "unmatched" ? { rows: [{ inserted: false }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 1 };
  };
  const deps = {
    gmail: {} as any,
    list: async (_g: any, q: string) => { listedQuery = q; return NAMES; },
    get: async (_g: any, id: string) => { const f = fx(id); return { id, threadId: `t-${id}`, date: new Date(f.date), from: "", fromDomain: f.fromDomain, subject: f.subject, text: f.text, labelIds: [] }; },
  };
  return { query, deps, writes, rows, q: () => listedQuery };
}

describe("ingestTracking", () => {
  it("rows: Macy's two numbers + Michaels' placeholder; promo and order confirmation contribute none; watermark advances", async () => {
    const h = harness();
    const r = await ingestTracking({ query: h.query as any, deps: h.deps, now: new Date("2026-10-21T04:00:00Z") });
    expect(r).toMatchObject({ scanned: 4, rows: 3, inserted: 3, placeholders: 1 });
    expect(Array.from(h.rows.keys()).sort()).toEqual(["OTHER|email:michaels.com:3500432322101240", "UPS|1ZE3985C3677512769", "UPS|1ZXH51993644511848"]);
    expect(h.writes.some((w) => w.sql.includes("INSERT INTO settings") && w.params[0] === WATERMARK_KEY && JSON.parse(w.params[1]).last_scanned_at === "2026-10-21T04:00:00.000Z")).toBe(true);
  });
  it("Gmail query: Promotions excluded, from the watermark minus a day of overlap", async () => {
    const h = harness();
    await ingestTracking({ query: h.query as any, deps: h.deps });
    expect(h.q()).toBe(`-category:promotions after:${Math.floor(Date.parse("2026-10-19T04:00:00.000Z") / 1000)}`);
  });
  it("dedup on (carrier, tracking_number): a repeat refreshes an unmatched row, is ignored once matched", async () => {
    const h = harness({ existing: { "UPS|1ZE3985C3677512769": "unmatched", "UPS|1ZXH51993644511848": "matched" } });
    const r = await ingestTracking({ query: h.query as any, deps: h.deps });
    expect(r).toMatchObject({ inserted: 1, refreshed: 1, ignored_repeats: 1 });
    const up = h.writes.find((w) => w.sql.includes("INSERT INTO po_tracking"))!.sql;
    expect(up).toMatch(/ON CONFLICT \(carrier, tracking_number\) WHERE split_of IS NULL DO UPDATE SET\s+gmail_message_id = EXCLUDED\.gmail_message_id/);
    expect(up).toMatch(/WHERE po_tracking\.status = 'unmatched'/);
  });
  it("a dry run writes nothing — no rows, no watermark — and returns the drafts", async () => {
    const h = harness();
    const r = await ingestTracking({ query: h.query as any, deps: h.deps, dryRun: true });
    expect(h.writes).toHaveLength(0);
    expect(r.drafts?.map((d) => d.tracking_number)).toEqual(["1ZE3985C3677512769", "1ZXH51993644511848", "email:michaels.com:3500432322101240"]);
    expect(r.drafts?.[0]).toMatchObject({ retailer_order_id: "4800990541", ship_to_street: "805 grandy", sender_domain: "notify.macys.com", items_json: [expect.objectContaining({ qty: 10 })] });
  });
});

// ── Claims patch §3.10 (2026-11-11): a placeholder is replaced in place when a number arrives for its order ──
describe("placeholders replaced in place (dropResolvedPlaceholders / dropPlaceholdersFor)", () => {
  const PH = [
    { id: 50, sender_domain: "beauty.sephora.com", retailer_order_id: "839122002407", match_reason: "ai_no_tracking", gmail_message_id: "a", shipped_at: "2026-10-19" },
    { id: 214, sender_domain: "summitracing.narvar.com", retailer_order_id: "2392393-20261004", match_reason: "ai_disabled", gmail_message_id: "b", shipped_at: "2026-10-05" },
    { id: 428, sender_domain: "zara.com", retailer_order_id: "54452653087", match_reason: "dismissed", gmail_message_id: "c", shipped_at: "2026-09-16" },
    { id: 7, sender_domain: "typology.com", retailer_order_id: "1283797", match_reason: "ai_disabled", gmail_message_id: "d", shipped_at: "2026-10-21" },
  ];
  const REAL = [
    { id: 900, sender_domain: "sephora.com", retailer_order_id: "839122002407", carrier: "FEDEX", tracking_number: "539377361530" },
    { id: 901, sender_domain: "summitracing.com", retailer_order_id: "2392393", carrier: "UPS", tracking_number: "1Z1XW7200306058478" },
    { id: 902, sender_domain: "mail.zara.com", retailer_order_id: "54452653087", carrier: "GLS", tracking_number: "56830412345" },
    { id: 903, sender_domain: "typology.com", retailer_order_id: "9999999", carrier: "UPS", tracking_number: "1Z999AA10123456784" },
  ];
  const fake = () => {
    const deletes: any[][] = [];
    const query = async (sql: string, params?: any[]) => {
      if (sql.includes("tracking_number LIKE 'email:%'")) return { rows: PH, rowCount: PH.length };
      if (sql.includes("tracking_number NOT LIKE 'email:%'")) return { rows: REAL, rowCount: REAL.length };
      if (sql.startsWith("DELETE")) { deletes.push(params ?? []); return { rows: [], rowCount: 1 }; }
      return { rows: [], rowCount: 0 };
    };
    return { query, deletes };
  };
  it("same registrable sender domain + order base key: Sephora (subdomain), Summit (ship-date suffix), a dismissed one too; a different order never", async () => {
    const { dropResolvedPlaceholders } = await import("./tracking-ingest");
    const f = fake();
    const r = await dropResolvedPlaceholders(f.query as any);
    expect(r.map((x) => [x.id, x.by_id, x.carrier, x.tracking_number])).toEqual([[50, 900, "FEDEX", "539377361530"], [214, 901, "UPS", "1Z1XW7200306058478"], [428, 902, "GLS", "56830412345"]]);
    expect(f.deletes).toEqual([[[50, 214, 428]]]);
  });
  it("a dry run lists and deletes nothing; dropPlaceholdersFor drops the one order's placeholder(s)", async () => {
    const { dropResolvedPlaceholders, dropPlaceholdersFor } = await import("./tracking-ingest");
    const f = fake();
    expect((await dropResolvedPlaceholders(f.query as any, { dryRun: true })).length).toBe(3);
    expect(f.deletes).toEqual([]);
    expect(await dropPlaceholdersFor(f.query as any, "sephora.com", "839122002407")).toEqual([50]);
    expect(await dropPlaceholdersFor(f.query as any, "summitracing.com", "2392393")).toEqual([214]);
    expect(await dropPlaceholdersFor(f.query as any, "typology.com", "1111111")).toEqual([]);
    expect(await dropPlaceholdersFor(f.query as any, "typology.com", null)).toEqual([]);
    expect(f.deletes).toEqual([[[50]], [[214]]]);
  });
});

describe("sameSender (2026-11-11)", () => {
  it("equal registrable domains; a Narvar sender named after the retailer; never two unrelated retailers", async () => {
    const { sameSender } = await import("./tracking-ingest");
    expect(sameSender("beauty.sephora.com", "sephora.com")).toBe(true);
    expect(sameSender("summitracing.narvar.com", "summitracing.com")).toBe(true);
    expect(sameSender("summitracing.com", "summitracing.narvar.com")).toBe(true);
    expect(sameSender("dickssportinggoods.narvar.com", "summitracing.com")).toBe(false);
    expect(sameSender("t.shopifyemail.com", "cafemam.com")).toBe(false);
    expect(sameSender("ui.com", "store.ui.com")).toBe(true);
    expect(sameSender("ui.com", "x.ui.narvar.com")).toBe(false); // "ui" is too short a name to vouch for a host
  });
});
