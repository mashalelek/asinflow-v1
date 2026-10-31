import { describe, it, expect } from "vitest";
import { nameTokens, tokenOverlap, rankHistory, suggestAsins } from "./asin-suggest";

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
      if (/a.title ILIKE \$1/.test(sql)) return { rows: [{ asin: "B0HIST", title: "Pens 12 count", primary_sku: null, image_url: null, brand: null, sold_as: null, units_per_pack: null }, { asin: "B0TITLE", title: "Pens, 12ct, black", primary_sku: null, image_url: null, brand: null, sold_as: null, units_per_pack: null }], rowCount: 2 };
      if (/asin_skus/.test(sql)) return { rows: [{ asin: "B0SEARCH", title: "Pencils", primary_sku: null, image_url: null, brand: null, sold_as: null, units_per_pack: null }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    };
    const out = await suggestAsins(q, { supplier: "walmart.com", product: "Pens 12ct", q: "pen" });
    expect(out.map((s) => [s.asin, s.via, s.in_af, s.sold_as, s.units_per_pack])).toEqual([["B0HIST", "history_exact", true, "multi-pack", 12], ["B0TITLE", "title", true, null, null], ["B0SEARCH", "search", true, null, null]]);
  });
});
