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
