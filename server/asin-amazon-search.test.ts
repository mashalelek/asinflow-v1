import { describe, it, expect, vi } from "vitest";
import { parseCatalogHit, amazonKeywords, rankCatalogHits, searchCatalogKeywords, catalogItem, _clearAmazonSearchCache } from "./asin-amazon-search";

vi.mock("./log", () => ({ log: () => {} }));
vi.mock("./spapi-auth", () => ({ spApiGet: async () => { throw new Error("no SP-API in tests"); } }));

const hit = (asin: string, title: string, size: string | null = null, pack: number | null = 1) => ({ asin, title, brand: "Yankee Candle", image_url: null, size, pack });

describe("Amazon catalog search (Maria 2026-11-06)", () => {
  it("parses a searchCatalogItems item: title, brand, size, package quantity, the MAIN image", () => {
    expect(parseCatalogHit({ asin: "b0155ogeuu", summaries: [{ marketplaceId: "ATVPDKIKX0DER", itemName: "Yankee Candle Christmas Eve 22oz Large Jar", brand: "Yankee Candle", size: "Classic Large Jar" }],
      attributes: { item_package_quantity: [{ value: 2 }] }, images: [{ marketplaceId: "ATVPDKIKX0DER", images: [{ variant: "PT01", link: "x" }, { variant: "MAIN", link: "main.jpg" }] }] }))
      .toEqual({ asin: "B0155OGEUU", title: "Yankee Candle Christmas Eve 22oz Large Jar", brand: "Yankee Candle", image_url: "main.jpg", size: "Classic Large Jar", pack: 2 });
    expect(parseCatalogHit({ asin: "bad" })).toBeNull();
  });
  it("keywords = brand + product name, the brand not doubled; never a UPC", () => {
    expect(amazonKeywords("Christmas Eve® Original Large Jar Candle", "Yankee Candle")).toBe("Yankee Candle Christmas Eve Original Large Jar Candle");
    expect(amazonKeywords("Yankee Candle Christmas Eve Large Jar", "Yankee Candle")).toBe("Yankee Candle Christmas Eve Large Jar");
    expect(amazonKeywords("Christmas Eve Large Jar", null)).toBe("Christmas Eve Large Jar");
  });
  it("ranks by the distinctive words (scent first), then the kind words (jar over tumbler), the pack and sold before", () => {
    const r = rankCatalogHits("Christmas Eve Original Large Jar Candle", "Yankee Candle", [
      hit("B0F3DQZ193", "Yankee Candle Christmas Cookie Scented Candle, 22oz Large Jar"),
      hit("B09BZWZKY9", "Yankee Candle Christmas Eve Scented Candle, 20oz Large Tumbler"),
      hit("B0F8K84QX6", "Yankee Candle Christmas Eve Scented Candle, 22oz Large Jar"),
      hit("B0SIXPACK1", "Yankee Candle Christmas Eve Large Jar", null, 6),
      hit("B0155OGEUU", "Yankee Candle Christmas Eve Scented, Classic 22oz Large Jar"),
    ], { pack: 1, soldBefore: new Set(["B0155OGEUU"]) });
    expect(r.map((h) => h.asin)).toEqual(["B0155OGEUU", "B0F8K84QX6", "B09BZWZKY9", "B0SIXPACK1", "B0F3DQZ193"]);
    expect(r[0].match.all).toBe(true);
    expect(r[4].match.missing).toEqual(["eve"]);
  });
  it("searches once per keyword string for 15 minutes; a failure is no results, never a throw", async () => {
    _clearAmazonSearchCache();
    let calls = 0;
    const get = async (_e: string, p: Record<string, any>) => { calls++; expect(p).toMatchObject({ keywords: "Yankee Candle Christmas Eve", marketplaceIds: "ATVPDKIKX0DER" }); expect(p.identifiers).toBeUndefined(); return { items: [{ asin: "B0155OGEUU", summaries: [{ itemName: "t" }] }] }; };
    let now = 0;
    expect((await searchCatalogKeywords("Yankee Candle Christmas Eve", { get, now: () => now })).hits.map((h) => h.asin)).toEqual(["B0155OGEUU"]);
    now = 14 * 60 * 1000; await searchCatalogKeywords("Yankee Candle Christmas Eve", { get, now: () => now });
    expect(calls).toBe(1);
    now = 16 * 60 * 1000; await searchCatalogKeywords("Yankee Candle Christmas Eve", { get, now: () => now });
    expect(calls).toBe(2);
    const failed = await searchCatalogKeywords("Yankee Candle Midnight", { get: async () => { throw Object.assign(new Error("boom"), { response: { status: 429 } }); } });
    expect(failed).toEqual({ hits: [], error: "429: boom" });
    expect(await catalogItem("B0NOTHERE1", { get: async () => { throw Object.assign(new Error("nf"), { response: { status: 404 } }); } })).toBeNull();
  });
});
