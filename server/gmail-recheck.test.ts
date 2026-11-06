import { describe, it, expect } from "vitest";
import { pruneRecheck, withRecheck, serialized, RECHECK_DAYS } from "./gmail-recheck";
import { parseGmailMessage, htmlAddsOrderIds } from "./gmail-client";
import { reconcileConfirmations, CONFIRM_UNMATCHED_KEY } from "./po-confirm-reconcile";
import { recheckForNewPo, recheckDeps } from "./new-po-recheck";

const b64 = (s: string) => Buffer.from(s).toString("base64url");

describe("gmail-recheck", () => {
  it("prunes entries older than 14 days; the stored ids follow the window's, once each", () => {
    expect(RECHECK_DAYS).toBe(14);
    const now = new Date("2026-11-20T00:00:00Z");
    expect(pruneRecheck({ a: "2026-11-06T00:00:00Z", b: "2026-11-05T23:59:59Z" }, now)).toEqual({ a: "2026-11-06T00:00:00Z" });
    expect(withRecheck(["x", "a"], { a: "t", b: "t" })).toEqual({ ids: ["x", "a", "b"], rechecked: 1 });
  });
  it("serialized runs one call at a time, in order, and a failure does not block the next", async () => {
    const seen: string[] = [];
    const f = serialized(async (k: string, ms: number) => { seen.push(`start ${k}`); await new Promise((r) => setTimeout(r, ms)); if (k === "b") throw new Error("b"); seen.push(`end ${k}`); return k; });
    const out = await Promise.allSettled([f("a", 20), f("b", 1), f("c", 1)]);
    expect(seen).toEqual(["start a", "end a", "start b", "start c", "end c"]);
    expect(out.map((o) => o.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
  });
});

describe("parseGmailMessage: a long plain part that leaves out the order # (Michaels, 2026-11-06)", () => {
  const msg = (plain: string, html: string) => ({
    id: "m", internalDate: "0", payload: { mimeType: "multipart/alternative", headers: [{ name: "Subject", value: "We've received your order!" }, { name: "From", value: "Michaels <no-reply@michaels.com>" }],
      parts: [{ mimeType: "text/plain", body: { data: b64(plain) } }, { mimeType: "text/html", body: { data: b64(html) } }] },
  });
  const hollow = `Pick Up Information\n\nITEM\nQTY ()\nPRICE\n\nItem No: \n\n $ \n\n${"Shipping Information\nRecipient\n\n".repeat(20)}`;
  it("the HTML's text is added when it names an order # the plain part does not", () => {
    const m = parseGmailMessage(msg(hollow, `<span style="display:none">Order 4300109060826629 Thank you, Maria!</span><td>Order 4300109060826629</td>`) as any);
    expect(hollow.length).toBeGreaterThan(300);
    expect(m.text).toContain("4300109060826629");
  });
  it("a substantial plain part that already names the order # stays alone", () => {
    const plain = `Order 4300109060826629\n${hollow}`;
    expect(parseGmailMessage(msg(plain, "<p>Order 4300109060826629 and more</p>") as any).text).toBe(plain.trim());
    expect(htmlAddsOrderIds("s", plain, "Order 4300109060826629")).toBe(false);
  });
});

describe("reconcileConfirmations: a confirmation that arrives before its PO", () => {
  const conf = { id: "c", threadId: null, date: new Date("2026-11-05T22:20:02Z"), labelIds: [], from: "Walmart <help@walmart.com>", fromDomain: "walmart.com", trackLinks: [], subject: "Thanks for your order", text: "Order# 200015248695719\nOrder total $18.47" };
  function db(pos: any[]) {
    const settings: Record<string, any> = {};
    const q = async (sql: string, p: any[] = []) => {
      if (/FROM purchase_orders p$/.test(sql.trim())) return { rows: pos, rowCount: pos.length };
      if (/SELECT value FROM settings WHERE key/.test(sql)) return { rows: settings[p[0]] ? [{ value: settings[p[0]] }] : [], rowCount: 0 };
      if (/INSERT INTO settings/.test(sql)) { settings[p[0]] = { ...(/settings\.value \|\|/.test(sql) ? settings[p[0]] : {}), ...JSON.parse(p[1]) }; return { rows: [], rowCount: 1 }; }
      if (/SELECT id FROM po_line_items WHERE po_id/.test(sql)) return { rows: [{ id: "l1" }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    };
    return { q: q as any, settings };
  }
  it("kept on the list, matched by a later pass once the PO exists; a renewal is tried on the first read only", async () => {
    const pos: any[] = [];
    const { q, settings } = db(pos);
    let renewalAsks = 0;
    let window = ["c"];
    const deps = { gmail: {} as any, list: async () => window, get: async () => conf as any, onUnmatched: async () => { renewalAsks++; return false; } };
    const first = await reconcileConfirmations({ query: q, deps, now: new Date("2026-11-05T23:00:00Z") });
    expect(first.unmatched).toBe(1);
    expect(settings[CONFIRM_UNMATCHED_KEY]).toEqual({ c: "2026-11-05T22:20:02.000Z" });
    window = [];
    const second = await reconcileConfirmations({ query: q, deps, now: new Date("2026-11-06T05:00:00Z") });
    expect(second).toMatchObject({ rechecked: 1, unmatched: 1 });
    expect(renewalAsks).toBe(1);
    pos.push({ id: "w", supplier: "walmart.com", order_id: "200015248695719", order_total: 18.47, line_count: 1 });
    const third = await reconcileConfirmations({ query: q, deps, now: new Date("2026-11-07T05:00:00Z"), onlyStored: true, onlyPoId: "w" });
    expect(third).toMatchObject({ rechecked: 1, matched: 1, agreed: 1 });
    expect(settings[CONFIRM_UNMATCHED_KEY]).toEqual({});
  });
});

describe("recheckForNewPo", () => {
  it("does nothing where the passes do not run (ENABLE_CRONS unset: a local dev server never writes to Drive)", async () => {
    const saved = { ...recheckDeps };
    let called = 0;
    Object.assign(recheckDeps, { enabled: () => false, ingest: async () => { called++; throw new Error("no"); } });
    try { expect(await recheckForNewPo({} as any, "p", () => {})).toBeNull(); expect(called).toBe(0); } finally { Object.assign(recheckDeps, saved); }
  });
  it("reads the stored emails for that PO only, documents then confirmations; a failure is logged, not thrown", async () => {
    const saved = { ...recheckDeps };
    const seen: any[] = [], logs: string[] = [];
    Object.assign(recheckDeps, {
      enabled: () => true, gmail: () => ({}), drive: () => ({}),
      ingest: async (o: any) => { seen.push(["docs", o.onlyStored, o.onlyPoId]); return { items: [{}], rechecked: 3 }; },
      reconcile: async (o: any) => { seen.push(["confirm", o.onlyStored, o.onlyPoId]); return { matched: 1 }; },
    });
    try {
      expect(await recheckForNewPo({} as any, "p9", (m) => logs.push(m))).toEqual({ documents: 1, confirmations: 1 });
      expect(seen).toEqual([["docs", true, "p9"], ["confirm", true, "p9"]]);
      Object.assign(recheckDeps, { ingest: async () => { throw new Error("gmail down"); } });
      await recheckForNewPo({} as any, "p9", (m) => logs.push(m));
      expect(logs[1]).toMatch(/failed — the next pass retries \(gmail down\)/);
    } finally { Object.assign(recheckDeps, saved); }
  });
});
