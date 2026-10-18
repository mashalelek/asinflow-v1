import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

// ASINs page (2026-10-18): a slow or failed list load never looks like an empty page.
const home = readFileSync(resolve(__dirname, "home.tsx"), "utf8");
const fetchAsins = home.slice(home.indexOf("const fetchAsins = useCallback"), home.indexOf("useEffect(() => {\n    fetchAsins("));

describe("ASINs list load state", () => {
  it("fetchAsins marks loading, treats a non-OK answer or a non-array as an error, and marks ready only on success", () => {
    expect(fetchAsins).toMatch(/setListLoad\(\{ state: "loading" \}\);/);
    expect(fetchAsins).toMatch(/if \(!r\.ok\) \{[\s\S]*?throw new Error/);
    expect(fetchAsins).toMatch(/if \(!Array\.isArray\(data\)\) throw new Error/);
    expect(fetchAsins).toMatch(/setListLoad\(\{ state: "ready" \}\);/);
    expect(fetchAsins).toMatch(/setListLoad\(\{ state: "error", error: err\?\.message \?\? String\(err\) \}\);/);
  });
  it("the table area shows an indicator while loading, the reason + Retry on failure; the empty-page hint only after a successful empty load", () => {
    expect(home).toMatch(/listLoad\.state === "loading" && results\.length === 0 && asins\.length === 0 && \([\s\S]{0,200}data-testid="asins-loading"/);
    expect(home).toMatch(/listLoad\.state === "loading" && results\.length > 0 && \([\s\S]{0,200}data-testid="asins-reloading"/);
    expect(home).toMatch(/listLoad\.state === "error" && \([\s\S]{0,300}data-testid="asins-load-error"/);
    expect(home).toMatch(/data-testid="button-retry-asins"/);
    expect(home).toMatch(/dbLoaded && listLoad\.state === "ready" && \(/);
  });
});
