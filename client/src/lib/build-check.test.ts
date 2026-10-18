import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { entryScriptFromHtml, currentEntryScript, isStaleBuild } from "./build-check";
import { refreshPlan, applyStreamedRow } from "./upload-flow";

// 2026-10-18: production served the upload fix while a tab opened at 06:04 ET
// kept running the old bundle and re-ran one 11-ASIN upload as jobs #59/#60.

const html = (h: string) => `<!DOCTYPE html><html><head><script type="module" crossorigin src="/assets/index-${h}.js"></script><link rel="stylesheet" href="/assets/index-x.css"></head></html>`;

describe("stale-tab build check", () => {
  it("reads the entry script an index.html names", () => {
    expect(entryScriptFromHtml(html("By6_t5iT"))).toBe("/assets/index-By6_t5iT.js");
    expect(entryScriptFromHtml("<html>dev: /src/main.tsx</html>")).toBeNull();
  });
  it("reads this page's own entry script", () => {
    const doc = { querySelectorAll: () => [{ getAttribute: () => "https://asinflow-cqg.onrender.com/assets/index-OLD123.js" }] } as any;
    expect(currentEntryScript(doc)).toBe("/assets/index-OLD123.js");
    expect(currentEntryScript({ querySelectorAll: () => [] } as any)).toBeNull();
  });
  it("a newer deploy is stale; same build or an unreadable index is not", () => {
    expect(isStaleBuild("/assets/index-OLD123.js", entryScriptFromHtml(html("By6_t5iT")))).toBe(true);
    expect(isStaleBuild("/assets/index-By6_t5iT.js", entryScriptFromHtml(html("By6_t5iT")))).toBe(false);
    expect(isStaleBuild("/assets/index-By6_t5iT.js", null)).toBe(false);
    expect(isStaleBuild(null, "/assets/index-By6_t5iT.js")).toBe(false);
  });
  it("the banner is mounted app-wide and checks on load, on an interval and on focus", () => {
    const app = readFileSync(resolve(__dirname, "../App.tsx"), "utf8");
    expect(app).toMatch(/<UpdateBanner \/>/);
    const banner = readFileSync(resolve(__dirname, "../components/update-banner.tsx"), "utf8");
    expect(banner).toMatch(/fetch\("\/", \{ cache: "no-store"/);
    expect(banner).toMatch(/setInterval\(check, CHECK_MS\)/);
    expect(banner).toMatch(/visibilitychange/);
    expect(banner).toMatch(/window\.location\.reload\(\)/);
  });
});

describe("a page load after a completed upload", () => {
  const home = readFileSync(resolve(__dirname, "../pages/home.tsx"), "utf8");
  it("starts with no pending upload — the list is in-memory only, never read from storage or the URL", () => {
    expect(home).toMatch(/const \[asins, setAsins\] = useState<AsinInput\[\]>\(\[\]\);/);
    // every setAsins is either the freshly parsed file or the clear
    const sets = home.match(/setAsins\([^)]*\)/g) ?? [];
    expect(sets.sort()).toEqual(["setAsins([])", "setAsins(parsed)"]);
    expect(home).not.toMatch(/(localStorage|sessionStorage)\.(get|set)Item\([^)]*(upload|pending)/i);
    expect(home).not.toMatch(/URLSearchParams[\s\S]{0,80}upload/i);
  });
  it("so the button is a normal Refresh (the 'N uploaded' label needs a pending list) and a click plans a Refresh", () => {
    expect(home).toMatch(/asins\.length > 0[\s\S]{0,40}\? `Refresh \$\{asins\.length\} uploaded`/);
    expect(refreshPlan([])).toEqual({ kind: "refresh" });
  });
  it("and the stored rows render as loaded — B09HRDGW17 keeps its title and $50.11 even if a late placeholder streams in", () => {
    const stored: any = { asin: "B09HRDGW17", catalogData: { title: "Metallica - Exclusive Limited Edition", imageUrl: "https://m.media-amazon.com/x.jpg" }, pricingData: { buyBoxPrice: 50.11, lowestFbaPrice: 50.11, numberOfSellers: 3 } };
    const placeholder: any = { asin: "B09HRDGW17", catalogData: { title: null, imageUrl: null }, pricingData: { buyBoxPrice: null, lowestFbaPrice: null, numberOfSellers: null } };
    expect(applyStreamedRow([stored], placeholder)).toEqual([stored]);
  });
});
