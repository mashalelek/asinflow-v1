import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { bandVar } from "./metric-tiles";

// Dashboard tiles (patch docs/claude_spec-patch-dashboard-tiles.md §1.3, §1.5):
// one card per range column with a band by position, three hairline sections,
// 28 px main values, a 2-column sub-metric grid, visible dim Profit rows,
// no "More" link; the band variables exist in both themes.
const tiles = readFileSync(resolve(__dirname, "metric-tiles.tsx"), "utf8");
const css = readFileSync(resolve(__dirname, "../index.css"), "utf8");

describe("bands", () => {
  it("by column position, the 5th for set 3's last column, band-1 for a lone Custom column", () => {
    expect([0, 1, 2, 3].map((i) => bandVar(i, 4))).toEqual(["var(--dash-band-1)", "var(--dash-band-2)", "var(--dash-band-3)", "var(--dash-band-4)"]);
    expect(bandVar(4, 5)).toBe("var(--dash-band-5)");
    expect(bandVar(0, 1)).toBe("var(--dash-band-1)");
  });
  it("--dash-band-1…5 are defined under :root and .dark with the approved hexes, and the tiles use the variables, never inline hexes", () => {
    const root = css.slice(css.indexOf(":root {"), css.indexOf(".dark {"));
    const dark = css.slice(css.indexOf(".dark {"));
    expect(root).toMatch(/--dash-band-1: #4A5F78;[\s\S]*--dash-band-2: #4E6B7E;[\s\S]*--dash-band-3: #55767E;[\s\S]*--dash-band-4: #5E7E7B;[\s\S]*--dash-band-5: #66847A;/);
    expect(dark).toMatch(/--dash-band-1: #3A4F68;[\s\S]*--dash-band-2: #3E5B6E;[\s\S]*--dash-band-3: #45666E;[\s\S]*--dash-band-4: #4E6E6B;[\s\S]*--dash-band-5: #56746A;/);
    expect(tiles).toMatch(/backgroundColor: bandVar\(index, count\)/);
    expect(tiles.match(/#[0-9A-Fa-f]{6}/g)).toEqual(["#FAFAF9", "#E7E5E4"]); // only the two band ink colours from the mockup
  });
});

describe("card anatomy", () => {
  it("N tiles for N columns in a repeat(N) grid that stacks below lg; a lone Custom column is capped in width", () => {
    expect(tiles).toMatch(/grid grid-cols-1 gap-4 lg:\[grid-template-columns:repeat\(var\(--tiles\),minmax\(0,1fr\)\)\]/);
    expect(tiles).toMatch(/\["--tiles" as string\]: String\(cols\.length\)/);
    expect(tiles).toMatch(/cols\.length === 1 \? "lg:max-w-\[28rem\]" : ""/);
    expect(tiles).toMatch(/cols\.map\(\(col, i\) => <MetricTile key=\{col\.key\} col=\{col\} index=\{i\} count=\{cols\.length\}/);
  });
  it("three sections separated by hairlines; main values 28 px / 700; sub-metrics 16 px / 600 in a 2-column grid; labels 11 px with .08em tracking", () => {
    expect(tiles.match(/<section className=\{`\$\{SECTION\} border-t/g)).toHaveLength(2);
    expect(tiles).toMatch(/text-\[28px\] font-bold leading-\[1\.15\]/);
    expect(tiles).toMatch(/const SUB_VALUE = "text-base font-semibold";/);
    expect(tiles).toMatch(/const LABEL = "text-\[11px\] font-bold uppercase tracking-\[0\.08em\] text-muted-foreground";/);
    expect(tiles.match(/grid grid-cols-2 gap-x-4 gap-y-3/g)).toHaveLength(3);
  });
  it("Profit rows are visible dim placeholders with the note in the label row; Refunds (Sales) is a dim placeholder with the tooltip; no More link", () => {
    expect(tiles).toMatch(/data-testid=\{t\("profit-note"\)\}>\{PENDING_TOOLTIP\}<\/div>/);
    expect(tiles).toMatch(/<Main label="Gross profit" value="—" dim/);
    expect(tiles).toMatch(/<Sub label="Net profit" testId=\{t\("net-profit"\)\} dim>—<\/Sub>/);
    expect(tiles).toMatch(/<Sub label="Est\. payout" testId=\{t\("est-payout"\)\} dim>—<\/Sub>/);
    expect(tiles).toMatch(/<Sub label="Refunds" testId=\{t\("refunds"\)\} dim>—<\/Sub>/);
    expect(tiles).toMatch(/title=\{dim \? PENDING_TOOLTIP : undefined\}/);
    expect(tiles).not.toMatch(/>\s*More\b/);
  });
  it("the SPEND 2 × 2: Refunds due (link when > 0), Avg. PO value with '· N POs', ASIN units, Individual units with the missing-pack-size note", () => {
    expect(tiles).toMatch(/<Sub label="Refunds due"[\s\S]*?<Link href=\{refundsDueHref\(col\)\}/);
    expect(tiles).toMatch(/<Sub label="Avg\. PO value"[\s\S]*?· \{avg\.small\}/);
    expect(tiles).toMatch(/<Sub label="ASIN units ordered"/);
    expect(tiles).toMatch(/<Sub label="Individual units ordered" note=\{ind\.small\}/);
  });
});
