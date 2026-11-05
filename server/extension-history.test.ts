// Purchase history for the extensions (SPEC §11 "Purchase history", Maria 2026-11-05).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normSku, parsePack, nameScore, matchListing, howBought, conversionLine, asinHistory, extensionHistory, HistoryQuerySchema } from "./extension-history";
import * as HV from "../chrome-extension/core/history-view.js";
const { historyLines } = ((HV as any).default ?? HV) as typeof HV;

describe("normalizing a listing", () => {
  it("SKU / UPC: dashes, spaces, dots and case stripped", () => {
    expect(normSku("20350-GOLD 5.c")).toBe("20350gold5c");
    expect(normSku("0 12345-67890 5")).toBe(normSku("012345678905"));
  });
  it("pack-size tokens stripped from the name, the pack parsed as its own number", () => {
    const cases: Array<[string, number | null, string]> = [
      ["Lenox Gold Hole Saw (2-Pack)", 2, "lenox gold hole saw"],
      ["Dr Teal's Bath Oil, 12-pack", 12, "dr teals bath oil"],
      ["Coffee Mugs, Set of 4", 4, "coffee mugs"],
      ["Coffee Pods Pack of 6", 6, "coffee pods"],
      ["Widget × 12", 12, "widget"],
      ["Widget x 3", 3, "widget"],
      ["Vitamin D 60 ct", 60, "vitamin d"],
      ["Gum, 14 Count", 14, "gum"],
      ["(6 pack) Dr Teal’s Restorative Oil", 6, "dr teals restorative oil"],
      ["Lindt LINDOR 5.1 oz. Bag", null, "lindt lindor 5 1 oz bag"],
    ];
    for (const [name, pack, base] of cases) expect({ name, ...parsePack(name) }).toEqual({ name, pack, base });
  });
  it("name similarity: 1 when equal, the word-set Dice coefficient otherwise", () => {
    expect(nameScore("a b c", "a b c")).toBe(1);
    expect(nameScore("dr teals bath oil", "dr teals restorative bath oil")).toBeCloseTo(0.889, 3);
    expect(nameScore("", "x")).toBe(0);
  });
});

describe("matching a retailer listing to the supplier's past PO lines", () => {
  const L = (asin: string, product_name: string, supplier_sku: string | null = null) => ({ asin, title: `T ${asin}`, product_name, supplier_sku });
  const lines = [
    L("B000000001", "Lenox 20350GOLD5C Gold Hole Saw (5-Pack)", "20350-GOLD5C"),
    L("B000000002", "Lenox 20350GOLD5C Gold Hole Saw", "20350GOLD5C-B"),
    L("B000000003", "Fruit of the Loom Sleep Pant, XL"),
    L("B000000004", "Fruit of the Loom Sleep Pant, L"),
    L("B000000005", "Little Debbie Pumpkin Spice Rolls, 13.13 oz"),
  ];
  it("SKU first: one ASIN on the normalized SKU is confident, whatever the name", () => {
    expect(matchListing(lines, { name: "anything", sku: "20350 gold5c" }).confident).toMatchObject({ asin: "B000000001", by: "sku" });
  });
  it("then the name, pack tokens stripped: an exact base name is confident", () => {
    expect(matchListing(lines, { name: "Little Debbie Pumpkin Spice Rolls, 13.13 oz (2-pack)" }).confident).toMatchObject({ asin: "B000000005", by: "name", score: 1 });
  });
  it("two exact base names (a 5-pack and a single of one product) → choices, never a guess", () => {
    const m = matchListing(lines, { name: "Lenox 20350GOLD5C Gold Hole Saw, 2-Pack" });
    expect(m.confident).toBeNull();
    expect(m.choices.map((c) => c.asin)).toEqual(["B000000001", "B000000002"]);
  });
  it("close names with no clear leader → the top 3", () => {
    const m = matchListing(lines, { name: "Fruit of the Loom Sleep Pant" });
    expect(m.confident).toBeNull();
    expect(m.choices.map((c) => c.asin)).toEqual(["B000000003", "B000000004"]);
  });
  it("nothing alike → no choices", () => {
    expect(matchListing(lines, { name: "Garden Hose 50 ft" })).toEqual({ confident: null, choices: [] });
  });
});

describe("how it was bought, and the listing's conversion", () => {
  it("'6-pack × 2' from the line's retailer units, else its name; '× 12' for singles", () => {
    expect(howBought(6, null, 2)).toBe("6-pack × 2");
    expect(howBought(null, "(6 pack) Bath Oil", 1)).toBe("6-pack × 1");
    expect(howBought(1, "Rolls", 12)).toBe("× 12");
  });
  it("'this listing: 12-pack → 4 ASIN units (ASIN is a 3-pack)' only when both pack sizes are known", () => {
    expect(conversionLine(12, 3)).toBe("this listing: 12-pack → 4 ASIN units (ASIN is a 3-pack)");
    expect(conversionLine(1, 1)).toBe("this listing: single → 1 ASIN unit (ASIN is a single)");
    expect(conversionLine(null, 3)).toBeNull();
    expect(conversionLine(12, null)).toBeNull();
  });
});

// A fake QueryLike answering the module's four queries.
function fakeDb(rows: { asins?: any; po?: any[]; supplierLines?: any[]; email?: any; suppliers?: string[]; aliases?: any[] }) {
  const calls: Array<{ sql: string; params?: any[] }> = [];
  const q = async (sql: string, params?: any[]) => {
    calls.push({ sql, params });
    if (/FROM asins WHERE asin/.test(sql)) return { rows: rows.asins ? [rows.asins] : [] };
    if (/FROM po_asins pa JOIN purchase_orders p ON p.id = pa.po_id\s+WHERE pa.asin/.test(sql)) return { rows: rows.po ?? [] };
    if (/SELECT DISTINCT supplier FROM purchase_orders/.test(sql)) return { rows: (rows.suppliers ?? []).map((supplier) => ({ supplier })) };
    if (/FROM supplier_aliases/.test(sql)) return { rows: rows.aliases ?? [] };
    if (/email_used/.test(sql)) return { rows: rows.email ? [rows.email] : [] };
    if (/SELECT DISTINCT pa.asin/.test(sql)) return { rows: rows.supplierLines ?? [] };
    throw new Error(`unexpected SQL: ${sql.slice(0, 80)}`);
  };
  return { q: q as any, calls };
}
const po = (order_id: string, order_date: string, qty: number, cost: number | null, in365 = true, lines: any[] = [{ ru: 6, name: "x", qty: 2 }]) => ({ order_id, order_date, supplier: "walmart.com", qty, cost_per_unit: cost, asin_name: "Rolls", units_per_pack: 3, in365, lines });

describe("one ASIN's history (stored values, read)", () => {
  it("last COGS with date and PO #; the 365-day average weighted by ASIN units; POs and units in 365 days; recent 5", async () => {
    const db = fakeDb({ asins: { title: "Rolls 3-pack", units_per_pack: 3 }, po: [po("A3", "2026-10-20", 4, 10), po("A2", "2026-06-01", 12, 8), po("A1", "2025-01-05", 100, 1, false)] });
    const h = await asinHistory(db.q, "B000000005", 12, "2026-11-05");
    expect(h).toMatchObject({ asin: "B000000005", title: "Rolls 3-pack", asinPack: 3, last: { cogs: 10, orderDate: "2026-10-20", orderId: "A3" }, avg365: 8.5, pos365: 2, units365: 16, conversion: "this listing: 12-pack → 4 ASIN units (ASIN is a 3-pack)" });
    expect(h.recent.map((r) => [r.orderId, r.how, r.asinUnits])).toEqual([["A3", "6-pack × 2", 4], ["A2", "6-pack × 2", 12], ["A1", "6-pack × 2", 100]]);
    const sql = db.calls.find((c) => /WHERE pa.asin/.test(c.sql))!;
    expect(sql.sql).toMatch(/NOT COALESCE\(\(SELECT bool_and\(\(l\.qty_canceled IS NOT NULL AND l\.qty_canceled >= COALESCE\(l\.qty_ordered, 0\)\)\)/); // a fully canceled row is no purchase
    expect(sql.sql).toMatch(/ORDER BY p\.order_date DESC, p\.entry_seq DESC/);
    expect(sql.params).toEqual(["B000000005", "2026-11-05"]);
  });
  it("the last COGS skips a row with no cost; the ASIN's pack falls back to the newest PO row's", async () => {
    const h = await asinHistory(fakeDb({ asins: { title: null, units_per_pack: null }, po: [po("A3", "2026-10-20", 4, null), po("A2", "2026-06-01", 2, 8)] }).q, "B000000005");
    expect(h).toMatchObject({ last: { orderId: "A2", cogs: 8 }, avg365: 8, asinPack: 3, title: "Rolls" });
  });
});

describe("GET /api/extension/history", () => {
  it("asin or supplier is required; an ASIN is 10 characters, upper-cased", () => {
    expect(HistoryQuerySchema.safeParse({}).success).toBe(false);
    expect(HistoryQuerySchema.parse({ asin: "b0hf19wzx8" }).asin).toBe("B0HF19WZX8");
    expect(HistoryQuerySchema.safeParse({ asin: "B0X" }).success).toBe(false);
    expect(HistoryQuerySchema.parse({ supplier: "www.walmart.com", pack: "12" }).pack).toBe(12);
  });
  it("a retailer page: the supplier through the host (alias map), its last email, a confident match's history", async () => {
    const db = fakeDb({ suppliers: ["walmart.com"], email: { email_used: "orders@example.com", order_date: "2026-10-23", order_id: "W9" }, supplierLines: [{ asin: "B000000005", title: "Rolls", product_name: "Rolls, 13 oz", supplier_sku: null }], asins: { title: "Rolls", units_per_pack: 3 }, po: [po("W9", "2026-10-23", 3, 9)] });
    const r = await extensionHistory(db.q, { supplier: "www.walmart.com", name: "Rolls, 13 oz (12-pack)" }, "2026-11-05");
    expect(r.supplier).toEqual({ host: "www.walmart.com", supplier: "walmart.com", known: true, lastEmail: { email: "orders@example.com", orderDate: "2026-10-23", orderId: "W9" } });
    expect(r.match).toMatchObject({ kind: "confident", by: "name" });
    expect(r.history).toMatchObject({ asin: "B000000005", conversion: "this listing: 12-pack → 4 ASIN units (ASIN is a 3-pack)" });
    expect(db.calls.find((c) => /SELECT DISTINCT pa.asin/.test(c.sql))!.params).toEqual(["walmart.com"]); // the SAME supplier only
  });
  it("a remembered pick (&asin=) skips the matching; a new supplier gets no matching and no email", async () => {
    const picked = await extensionHistory(fakeDb({ suppliers: ["walmart.com"], asins: { title: "Rolls", units_per_pack: 1 }, po: [] }).q, { supplier: "walmart.com", name: "Rolls", asin: "B000000005" });
    expect(picked.match.kind).toBe("picked");
    const fresh = await extensionHistory(fakeDb({ suppliers: ["walmart.com"] }).q, { supplier: "www.newshop.com", name: "Rolls" });
    expect(fresh).toMatchObject({ supplier: { supplier: "newshop.com", known: false, lastEmail: null }, match: { kind: "none" }, history: null });
  });
  it("is on the extensions' route lists and the stale-page guard's exemptions; mounted in routes.ts", () => {
    const src = readFileSync(join(__dirname, "routes.ts"), "utf8");
    expect(src).toMatch(/app\.get\("\/api\/extension\/history"/);
    const routes = JSON.parse(readFileSync(join(__dirname, "../chrome-extension/core/extension-routes.json"), "utf8"));
    expect(routes["capture-po"]).toContain("/extension/history");
    expect(routes.analyzer).toContain("/extension/history");
  });
});

describe("the panels' history lines (core/history-view.js)", () => {
  const hist = { asin: "B000000005", title: "Rolls", asinPack: 3, last: { cogs: 9, orderDate: "2026-10-23", orderId: "W9", supplier: "walmart.com" }, avg365: 8.5, pos365: 2, units365: 16, conversion: "this listing: 12-pack → 4 ASIN units (ASIN is a 3-pack)", recent: [{ orderDate: "2026-10-23", orderId: "W9", supplier: "walmart.com", how: "6-pack × 2", asinUnits: 4, cogs: 9 }] };
  it("last COGS with date and PO #, the 365-day line, the conversion, each recent purchase", () => {
    const lines = historyLines(hist, true, 2026);
    expect(lines.map((l) => `${l.k}: ${l.v}`)).toEqual([
      "Last COGS: $9.00 · Oct 23, 2026 · PO W9 · walmart.com",
      "365 days: avg $8.50 · 2 POs · 16 units",
      "Pack: this listing: 12-pack → 4 ASIN units (ASIN is a 3-pack)",
      "Oct 23: 6-pack × 2 → 4 units · $9.00 · walmart.com",
    ]);
    expect(historyLines(hist, false, 2026)[0].v).toBe("$9.00 · Oct 23, 2026 · PO W9");
    expect(historyLines(hist, false, 2027)[3].k).toBe("Oct 23 2026");
  });
  it("no purchases", () => {
    expect(historyLines({ ...hist, last: null, pos365: 0, recent: [], conversion: null }).map((l) => l.v)).toEqual(["no purchase in AF", "no POs"]);
  });
  it("Capture PO remembers a pick per listing URL (+ name) in chrome.storage.local and sends it back as &asin=", () => {
    const src = readFileSync(join(__dirname, "../chrome-extension/capture-history.js"), "utf8");
    expect(src).toMatch(/historyPick:\$\{listingUrl\(url\)\}\|\$\{normName\(name\)\}/);
    expect(src).toMatch(/chrome\.storage\.local\.set\(\{ \[pickKey\(url, l\.name\)\]: ch\.asin \}\)/);
    expect(src).toMatch(/asin: picked/);
  });
});
