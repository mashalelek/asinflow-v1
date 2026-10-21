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
    expect(up).toMatch(/ON CONFLICT \(carrier, tracking_number\) DO UPDATE SET\s+gmail_message_id = EXCLUDED\.gmail_message_id/);
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
