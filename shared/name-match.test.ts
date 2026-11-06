import { describe, it, expect } from "vitest";
import { distinctiveWords, nameMatch, nameMismatchNote, sizeWords } from "./name-match";

// Maria 2026-11-06, yankeecandle.com HFUS09823034326.
describe("name-match", () => {
  it("the distinctive words leave out the kind of product, the brand and sizes", () => {
    expect(distinctiveWords("Christmas Eve Original Large Jar Candle")).toEqual(["christma", "eve"]);
    expect(distinctiveWords("Cherries On Snow Large Jar Candles", "Yankee Candle")).toEqual(["cherrie", "snow"]);
    expect(sizeWords("Classic 22 oz Large Jar, Pack of 2, 4 pack")).toEqual(["22oz", "4pk"]);
  });
  it("Midnight Jasmine is not Christmas Eve; Macintosh is not Cherries On Snow; the real titles match", () => {
    expect(nameMismatchNote("Christmas Eve Original Large Jar Candle", "Yankee Candle Midnight Jasmine Scented, Classic 22oz Large Jar Single Wick Candle, Over 110 Hours of Burn Time", "Yankee Candle")).toBe("title says Midnight Jasmine, product is Christmas Eve");
    expect(nameMismatchNote("Cherries On Snow Large Jar Candle", "Yankee Candle Macintosh Large Classic Jar Candle", "Yankee Candle")).toBe("title says Macintosh, product is Cherries Snow");
    expect(nameMismatchNote("Cherries On Snow Large Jar Candle", "Yankee Candle Cherries On Snow Scented, Classic 22oz Large Jar Single Wick Candle", "Yankee Candle")).toBeNull();
    expect(nameMatch("Christmas Eve Large Jar", "Yankee Candle Christmas Eve Large Jar Candle")).toMatchObject({ all: true, ratio: 1 });
  });
  it("no note without a title, or when the name has nothing distinctive", () => {
    expect(nameMismatchNote("Large Jar Candle", "Yankee Candle Macintosh Large Jar")).toBeNull();
    expect(nameMismatchNote("Christmas Eve", null)).toBeNull();
  });
});
