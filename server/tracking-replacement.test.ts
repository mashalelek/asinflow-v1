// Replacement orders → the original PO (Maria 2026-11-04 — the "PO not in AF" rows).
import { describe, it, expect } from "vitest";
import { replacementOriginalFromText, replacementLookup, replacementNote, appendPoNote } from "./tracking-replacement";
import { matchTrackingRows, type PoRef } from "./tracking-match";

// The real emails' text (production, 2026-11-04), trimmed.
const WALMART = "We’re working on your replacement Hello Maria, Sorry to hear there was an issue with your items. View order Original order number 2000148-69766592 Replacement order number 2000154-98956485 Replacement summary Enoz Lavender Scented Moth Ball Packets Qty: 12 Replacement | Missing Items from Box";
const TARGET = "Order #41400000169130960 Your replacement item is coming soon Hi Maria, You recently contacted us about replacing an item from your order: #102003764562536. We'd like to let you know that we're currently processing your replacement (order number #41400000169130960).";
const TARGET_MANY = "You recently contacted us about replacing items from your order: #912003759093365. We'd like to let you know that we're currently processing your replacements (order number #41400000169014341).";

describe("replacementOriginalFromText", () => {
  it("Walmart and Target name the original and the replacement", () => {
    expect(replacementOriginalFromText(WALMART)).toEqual({ original: "2000148-69766592", replacement: "2000154-98956485" });
    expect(replacementOriginalFromText(TARGET)).toEqual({ original: "102003764562536", replacement: "41400000169130960" });
    expect(replacementOriginalFromText(TARGET_MANY)).toEqual({ original: "912003759093365", replacement: "41400000169014341" });
  });
  it("an ordinary shipping email names no original", () => {
    expect(replacementOriginalFromText("Your package shipped, Maria! This is a replacement for a recent order. Order number: 2000154-98956485")).toBeNull();
  });
});

describe("replacementLookup", () => {
  const msgs: Record<string, string> = { a: "Your package shipped. Order number: 2000154-98956485", b: WALMART, c: TARGET };
  const deps = {
    list: async (_g: any, q: string) => (q.includes("2000154-98956485") ? ["a", "b"] : q.includes("41400000169130961") ? ["c"] : []),
    get: async (_g: any, id: string) => ({ id, threadId: null, date: new Date("2026-08-27T15:00:00Z"), from: "", fromDomain: null, subject: "", text: msgs[id], labelIds: [] }),
  };
  it("the email naming an original for THIS replacement #; another replacement's email does not count", async () => {
    const look = replacementLookup({} as any, deps as any);
    expect(await look("2000154-98956485")).toEqual({ original: "2000148-69766592", date: new Date("2026-08-27T15:00:00Z") });
    expect(await look("41400000169130961")).toBeNull(); // the only email is for …960
    expect(await look("999")).toBeNull();
  });
});

describe("the matcher attaches a replacement's tracking to the original PO, with a note and a History row", () => {
  const POS: PoRef[] = [
    { id: "po-orig", supplier: "walmart.com", order_id: "200014869766592" },
    { id: "po-other", supplier: "walmart.com", order_id: "200015138003869" },
  ];
  function db(notes: string | null) {
    const writes: Array<{ sql: string; params: any[] }> = [];
    const query = async (sql: string, params?: any[]) => {
      if (sql.includes("FROM po_tracking") && sql.trimStart().startsWith("SELECT")) return { rows: [{ id: 573, carrier: "FEDEX", tracking_number: "517715131849", sender_domain: "walmart.com", retailer_order_id: "2000154-98956485", email_subject: "Your package is delayed", gmail_message_id: "g" }], rowCount: 1 };
      if (sql.startsWith("SELECT value FROM settings")) return { rows: [], rowCount: 0 };
      if (sql.startsWith("SELECT notes FROM purchase_orders")) return { rows: [{ notes }], rowCount: 1 };
      if (sql.includes("FROM purchase_orders")) return { rows: POS, rowCount: POS.length };
      if (sql.startsWith("SELECT alias, supplier FROM supplier_aliases")) return { rows: [], rowCount: 0 };
      writes.push({ sql, params: params ?? [] });
      return { rows: [], rowCount: 1 };
    };
    return { query: query as any, writes };
  }
  const replacementFor = async (id: string) => (id === "2000154-98956485" ? { original: "2000148-69766592", date: new Date("2026-08-27T15:00:00Z") } : null);

  it("live: matched via replacement, the note appended to the PO's notes, a po_edit_log row", async () => {
    const d = db("Missing 2 units");
    const r = await matchTrackingRows(d.query, { replacementFor });
    expect(r.links).toEqual([{ id: 573, po_id: "po-orig", supplier: "walmart.com", via: "replacement" }]);
    const up = d.writes.find((w) => w.sql.includes("UPDATE po_tracking"))!;
    expect([up.params[2], up.params[3], up.params[4]]).toEqual(["po-orig", "matched", "replacement"]);
    const line = "Replacement order #2000154-98956485 (2026-08-27) — FEDEX 517715131849";
    expect(d.writes.find((w) => w.sql.startsWith("UPDATE purchase_orders SET notes"))!.params).toEqual(["po-orig", `Missing 2 units\n${line}`]);
    expect(d.writes.find((w) => w.sql.includes("INSERT INTO po_edit_log"))!.params).toEqual(["po-orig", null, "po", "po-orig", "notes", "Missing 2 units", `Missing 2 units\n${line}`]);
  });
  it("dry run: listed, nothing written", async () => {
    const d = db(null);
    const r = await matchTrackingRows(d.query, { dryRun: true, replacementFor });
    expect(r.matched_via).toEqual({ replacement: 1 });
    expect(d.writes).toHaveLength(0);
  });
  it("no replacement email → stays no_po", async () => {
    const d = db(null);
    const r = await matchTrackingRows(d.query, { dryRun: true, replacementFor: async () => null });
    expect(r.unmatched).toEqual({ no_po: 1 });
  });
});

describe("appendPoNote", () => {
  it("a line already there is not added twice", async () => {
    const line = replacementNote("41400000169014341", new Date("2026-09-18T12:00:00Z"), "UPS", "1Z97231RYW00313008");
    const writes: string[] = [];
    const q = (async (sql: string) => { if (sql.startsWith("SELECT notes")) return { rows: [{ notes: `x\n${line}` }] }; writes.push(sql); return { rows: [] }; }) as any;
    expect(await appendPoNote(q, "p", line)).toBe(false);
    expect(writes).toHaveLength(0);
  });
});
