import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { buildFilterChips } from "./filter-chips";

const base = { activeFilter: "all", filterUncalculated: false, searchQuery: "", selectedCount: 0, showGated: true, showMeltable: true, colFilters: {} };
const label = (id: string) => ({ roi: "ROI", supplier: "Supplier" } as Record<string, string>)[id] ?? id;
const value = (id: string) => ({ roi: "> 20", supplier: "any of: walmart.com" } as Record<string, string>)[id] ?? "";

describe("active-filter chips (2026-10-18)", () => {
  it("nothing filtered → no chips", () => {
    expect(buildFilterChips(base, label, value)).toEqual([]);
  });
  it("Maria's case: the saved hide-gated toggle is a visible chip", () => {
    expect(buildFilterChips({ ...base, showGated: false }, label, value)).toEqual([{ key: "gated", label: "Gated: hidden" }]);
  });
  it("every kind of filter gets a chip: tile, uncalculated, search / selection, gated, meltable, each column filter", () => {
    const chips = buildFilterChips({ ...base, activeFilter: "profitable", filterUncalculated: true, searchQuery: "tetley", showGated: false, showMeltable: false, colFilters: { roi: { colId: "roi" }, supplier: { colId: "supplier" } } }, label, value);
    expect(chips.map((c) => c.label)).toEqual(["Tile: Profitable", "Uncalculated only", 'Search: "tetley"', "Gated: hidden", "Meltable: hidden", "ROI: > 20", "Supplier: any of: walmart.com"]);
    expect(buildFilterChips({ ...base, searchQuery: "x", selectedCount: 3 }, label, value).map((c) => c.key)).toEqual(["selection"]);
  });
  it("the ASINs page renders the bar above the table with the hidden count, a per-chip clear and Clear filters", () => {
    const home = readFileSync(resolve(__dirname, "../pages/home.tsx"), "utf8");
    expect(home).toMatch(/<FilterChipsBar chips=\{filterChips\} hiddenCount=\{hiddenByFilters\} onClear=\{clearFilterChip\} onClearAll=\{clearAllFilters\} \/>/);
    expect(home).toMatch(/const hiddenByFilters = results\.length - queryFilteredResults\.length;/);
    expect(home).toMatch(/else if \(key === "gated"\) \{ setShowGated\(true\); saveShowGated\(true\); \}/);
    const bar = readFileSync(resolve(__dirname, "../components/filter-chips-bar.tsx"), "utf8");
    expect(bar).toMatch(/\{hiddenCount\} hidden by filters/);
    expect(bar).toMatch(/>Clear filters</);
  });
});

describe("added-ASIN report (Upload File / Sync Sourcing, 2026-10-18)", () => {
  it("counts the added ASINs that are loaded but hidden by the filters", async () => {
    const { addedHiddenReport } = await import("./filter-chips");
    const loaded = [{ asin: "B09HRDGW17" }, { asin: "B07K1N4K54" }, { asin: "B01MQHMQ00" }];
    const shown = [{ asin: "B07K1N4K54" }];
    expect(addedHiddenReport(["b09hrdgw17", "B07K1N4K54", "B01MQHMQ00", "B0NOTLOADED"], loaded, shown)).toEqual({ present: ["B09HRDGW17", "B07K1N4K54", "B01MQHMQ00"], hidden: ["B09HRDGW17", "B01MQHMQ00"] });
  });
  it("the page toasts '<n> added — <h> hidden by your filters' with Show (reveal those ASINs only) for uploads and sourcing syncs, and re-checks after their onboarding job", () => {
    const home = readFileSync(resolve(__dirname, "../pages/home.tsx"), "utf8");
    expect(home).toMatch(/const added = `\$\{pendingAdded\.asins\.length\} added — \$\{report\.hidden\.length\} hidden by your filters`;/);
    expect(home).toMatch(/onClick=\{\(\) => setRevealAsins\(\(prev\) => new Set\(\[\.\.\.Array\.from\(prev\), \.\.\.report\.hidden\]\)\)\}/);
    expect(home).toMatch(/if \(uploaded\) setPendingAdded\(\{ asins: uploaded, title: "Upload onboarded", base: "" \}\);/);
    expect(home).toMatch(/setPendingAdded\(\{ asins: Array\.from\(addedAsins\), title: "Sourcing sheet synced"/);
    expect(home).toMatch(/return results\.filter\(\(r\) => keep\.has\(r\.asin\) \|\| revealAsins\.has\(r\.asin\.toUpperCase\(\)\)\);/);
    expect(home).toMatch(/if \(report\.hidden\.length <= watch\.hidden\) return;/);
  });
});
