import { describe, it, expect, vi } from "vitest";
import { normPart, partNumbers, titleScore, nameTokens, tokenOverlap, rankHistory, suggestAsins } from "./asin-suggest";
import { _clearAmazonSearchCache } from "./asin-amazon-search";

vi.mock("./log", () => ({ log: () => {} }));
vi.mock("./spapi-auth", () => ({ spApiGet: async () => { throw new Error("no SP-API in tests"); } }));

// po-ai-prefill §6.4: history (exact, then tokens) beats title matches beats the model's guess (appended by the client).
describe("ASIN suggestions", () => {
  it("normalizes names: ®™, punctuation and stop words drop out", () => {
    expect(nameTokens("Red Heart® Super Saver® Solid Yarn, Color: Light Blue")).toEqual(["red", "heart", "super", "saver", "solid", "yarn", "light", "blue"]);
    expect(tokenOverlap(["a", "b", "c"], ["b", "c", "d"])).toBe(0.5);
  });
  it("ranks an exact normalized match first, then token overlap ≥ 0.5, newest PO breaking ties; weak matches are dropped", () => {
    const rows = [
      { asin: "B0EXACT", product_name: "Red Heart Super Saver Solid Yarn, Color: Light Blue", last_ordered: "2026-09-01" },
      { asin: "B0CLOSE", product_name: "Red Heart Super Saver Solid Yarn, Blue", last_ordered: "2026-10-01" },
      { asin: "B0CLOSE2", product_name: "Red Heart Super Saver Solid Yarn, Blue", last_ordered: "2026-08-01" },
      { asin: "B0FAR", product_name: "Liquitex BASICS Acrylic Paint, Blue Gray", last_ordered: "2026-10-20" },
    ];
    const r = rankHistory("Red Heart® Super Saver® Solid Yarn, Color: Light Blue", rows);
    expect(r.map((x) => [x.asin, x.via])).toEqual([["B0EXACT", "history_exact"], ["B0CLOSE", "history_tokens"], ["B0CLOSE2", "history_tokens"]]);
    expect(rankHistory("", rows)).toEqual([]);
  });
  it("suggestAsins: history first (with AF's pack fields), then catalog title matches, then the typed search; no duplicates", async () => {
    const q = async (sql: string, params: any[] = []) => {
      if (/FROM po_line_items l JOIN po_asins/.test(sql)) return { rows: [{ asin: "B0HIST", product_name: "Pens 12ct", last_ordered: "2026-10-01" }], rowCount: 1 };
      if (/WHERE a.asin = ANY/.test(sql)) return { rows: params[0].map((asin: string) => ({ asin, title: "Pens 12 count", primary_sku: "SKU-H", image_url: null, brand: "Bic", sold_as: "multi-pack", units_per_pack: 12 })), rowCount: 1 };
      if (/a.title ILIKE ANY/.test(sql)) return { rows: [{ asin: "B0HIST", title: "Pens 12 count", primary_sku: null, image_url: null, brand: null, sold_as: null, units_per_pack: null }, { asin: "B0TITLE", title: "Pens, 12ct, black", primary_sku: null, image_url: null, brand: null, sold_as: null, units_per_pack: null }, { asin: "B0NONE", title: "Stapler", primary_sku: null, image_url: null, brand: null, sold_as: null, units_per_pack: null }], rowCount: 3 };
      if (/a.asin ILIKE \$1/.test(sql)) return { rows: [{ asin: "B0SEARCH", title: "Pencils", primary_sku: null, image_url: null, brand: null, sold_as: null, units_per_pack: null }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    };
    const out = await suggestAsins(q, { supplier: "walmart.com", product: "Pens 12ct", q: "pen" });
    expect(out.map((s) => [s.asin, s.via, s.in_af, s.sold_as, s.units_per_pack])).toEqual([["B0HIST", "history_exact", true, "multi-pack", 12], ["B0TITLE", "title", true, null, null], ["B0SEARCH", "search", true, null, null]]);
  });
  // Maria 2026-11-04, acmetools.com 42838131: "Lenox 20350GOLD5C" must find B07VH2L2QF ("Lenox Gold 20350-GOLD5C Titanium Edge …").
  it("part numbers: normalized (dashes, spaces, dots, case), ≥ 5 characters with ≥ 3 digits; the SKU whole", () => {
    expect(normPart("20350-GOLD5C")).toBe("20350gold5c");
    expect(normPart("20 350.gold 5c")).toBe("20350gold5c");
    expect(partNumbers("20350GOLD5C", "Lenox 20350GOLD5C Gold Titanium Utility Blades, 5-Pack, 3/4in, 12oz")).toEqual(["20350gold5c"]);
    expect(partNumbers(null, "UPC 012345678905 Widget")).toEqual(["012345678905"]);
    expect(partNumbers("AB1", "no part numbers 5-pack")).toEqual([]);
  });
  it("suggestAsins: a part-number hit ranks first, above history and title words; brand named in the line nudges a title match", async () => {
    const lenox = { asin: "B07VH2L2QF", title: "Lenox Gold 20350-GOLD5C Titanium Edge Utility Knife Blade - 5/Pack, 3 Pack (Total 15 Blades)", primary_sku: "LEN-TOO-2QF-GGT-001", image_url: null, brand: "Lenox", sold_as: "multi-pack", units_per_pack: 3 };
    const other = { asin: "B0OTHERBLD", title: "Utility Knife Blade Gold Titanium 100 pack", primary_sku: null, image_url: null, brand: "Stanley", sold_as: null, units_per_pack: null };
    const branded = { asin: "B0LENOXBLD", title: "Lenox Utility Knife Blade Gold Titanium", primary_sku: null, image_url: null, brand: "Lenox", sold_as: null, units_per_pack: null };
    const seenSql: string[] = [];
    const q = async (sql: string, params: any[] = []) => {
      seenSql.push(sql);
      if (/regexp_replace/.test(sql) && /LIKE ANY/.test(sql)) return { rows: params[0].includes("%20350gold5c%") ? [lenox] : [], rowCount: 1 };
      if (/l\.supplier_sku/.test(sql)) return { rows: [], rowCount: 0 }; // no past line with this SKU
      if (/FROM po_line_items l JOIN po_asins/.test(sql)) return { rows: [{ asin: "B0HISTBLDE", product_name: "Lenox Gold Titanium Utility Blades", last_ordered: "2026-09-01" }], rowCount: 1 };
      if (/WHERE a.asin = ANY/.test(sql)) return { rows: params[0].map((asin: string) => ({ ...other, asin })), rowCount: 1 };
      if (/a.title ILIKE ANY/.test(sql)) return { rows: [other, branded, lenox], rowCount: 3 };
      return { rows: [], rowCount: 0 };
    };
    const out = await suggestAsins(q, { supplier: "acmetools.com", product: "Lenox 20350GOLD5C Gold Titanium Utility Blades", sku: "20350GOLD5C", limit: 3 });
    expect(out.map((s) => [s.asin, s.via])).toEqual([["B07VH2L2QF", "part_number"], ["B0HISTBLDE", "history_tokens"], ["B0LENOXBLD", "title"]]);
    expect(titleScore("Lenox Utility Blades", "Lenox Utility Knife Blades", "Lenox")).toBeGreaterThan(titleScore("Lenox Utility Blades", "Lenox Utility Knife Blades", "Stanley"));
    expect(titleScore("Lenox Utility Blades", "Stapler", "Lenox")).toBe(0);
  });
  it("Yankee 2026-11-06: a past line sharing only generic words is no match; the same supplier SKU is", async () => {
    const rows = [{ asin: "B00184W5LY", product_name: "Midnight Jasmine Original Large Jar Candle", last_ordered: "2026-10-01" }, { asin: "B0155OGEUU", product_name: "Christmas Eve Classic Large Jar", last_ordered: "2026-09-01" }];
    expect(rankHistory("Christmas Eve® Original Large Jar Candle", rows).map((r) => r.asin)).toEqual(["B0155OGEUU"]);
    const q = async (sql: string, params: any[] = []) => {
      if (/l\.supplier_sku/.test(sql)) return { rows: params[1] === "1129856" ? [{ asin: "B0155OGEUU", product_name: "Christmas Eve", last_ordered: "2026-11-06" }] : [], rowCount: 1 };
      if (/WHERE a.asin = ANY/.test(sql)) return { rows: params[0].map((asin: string) => ({ asin, title: "Yankee Candle Christmas Eve Large Jar", primary_sku: null, image_url: null, brand: "Yankee Candle", sold_as: null, units_per_pack: null })), rowCount: 1 };
      return { rows: [], rowCount: 0 };
    };
    const out = await suggestAsins(q, { supplier: "yankeecandle.com", product: "Christmas Eve Original Large Jar Candle", sku: "1129856", limit: 3 });
    expect(out[0]).toMatchObject({ asin: "B0155OGEUU", via: "history_sku", name_all: true, mismatch: null });
  });
  it("the model's guess counts only when Amazon's catalog has it and its title names every distinctive word", async () => {
    const q = async () => ({ rows: [], rowCount: 0 });
    const titles: Record<string, string> = { B00184W5LY: "Yankee Candle Midnight Jasmine Large Jar", B0155OGEUU: "Yankee Candle Christmas Eve Classic Large Jar" };
    const deps = { get: async (e: string) => { const asin = e.split("/").pop()!; if (!titles[asin]) throw Object.assign(new Error("nf"), { response: { status: 404 } }); return { asin, summaries: [{ itemName: titles[asin] }] }; } };
    _clearAmazonSearchCache();
    expect(await suggestAsins(q, { supplier: "yankeecandle.com", product: "Christmas Eve Original Large Jar Candle", guess: "B00184W5LY", deps })).toEqual([]);
    expect(await suggestAsins(q, { supplier: "yankeecandle.com", product: "Christmas Eve Original Large Jar Candle", guess: "B0NOTREAL1", deps })).toEqual([]);
    const ok = await suggestAsins(q, { supplier: "yankeecandle.com", product: "Christmas Eve Original Large Jar Candle", guess: "B0155OGEUU", deps });
    expect(ok.map((s) => [s.asin, s.via, s.in_af])).toEqual([["B0155OGEUU", "model", false]]);
  });
});
