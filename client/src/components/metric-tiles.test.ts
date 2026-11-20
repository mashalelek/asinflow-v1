import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { bandVar } from "./metric-tiles";
import { cellText, writeOffsHref, lostDamagedHref } from "./metric-grid";
import { DASHBOARD_ROWS } from "@shared/dashboard";

// Dashboard tiles (patch docs/claude_spec-patch-dashboard-tiles.md §1.3, §1.5):
// one card per range column with a band by position, three hairline sections,
// 28 px main values, a 2-column sub-metric grid, the PROFIT rows filled by the
// Finances patch with a "More" link; the band variables exist under :root (AF is dark only since 2026-11-18).
const tiles = readFileSync(resolve(__dirname, "metric-tiles.tsx"), "utf8");
const css = readFileSync(resolve(__dirname, "../index.css"), "utf8");

describe("bands", () => {
  it("by column position, the 5th for set 3's last column, band-1 for a lone Custom column", () => {
    expect([0, 1, 2, 3].map((i) => bandVar(i, 4))).toEqual(["var(--dash-band-1)", "var(--dash-band-2)", "var(--dash-band-3)", "var(--dash-band-4)"]);
    expect(bandVar(4, 5)).toBe("var(--dash-band-5)");
    expect(bandVar(0, 1)).toBe("var(--dash-band-1)");
  });
  it("--dash-band-1…5 are defined once under :root with the approved dark hexes, and the tiles use the variables, never inline hexes", () => {
    expect(css).not.toMatch(/^\.dark \{/m);
    const dark = css.slice(css.indexOf(":root {"));
    expect(dark).toMatch(/--dash-band-1: #3A4F68;[\s\S]*--dash-band-2: #3E5B6E;[\s\S]*--dash-band-3: #45666E;[\s\S]*--dash-band-4: #4E6E6B;[\s\S]*--dash-band-5: #56746A;/);
    expect(tiles).toMatch(/backgroundColor: bandVar\(index, count\)/);
    expect(tiles.match(/#[0-9A-Fa-f]{6}/g)).toEqual(["#FAFAF9", "#E7E5E4", "#93c5fd"]); // the two band ink colours and the More link colour, all from the mockups
  });
});

describe("card anatomy", () => {
  it("N tiles for N columns in a repeat(N) grid that stacks below lg; a lone Custom column is capped in width", () => {
    expect(tiles).toMatch(/grid grid-cols-1 gap-4 lg:\[grid-template-columns:repeat\(var\(--tiles\),minmax\(0,1fr\)\)\]/);
    expect(tiles).toMatch(/\["--tiles" as string\]: String\(cols\.length\)/);
    expect(tiles).toMatch(/cols\.length === 1 \? "lg:max-w-\[28rem\]" : ""/);
    expect(tiles).toMatch(/cols\.map\(\(col, i\) => <MetricTile key=\{col\.key\} col=\{col\} index=\{i\} count=\{cols\.length\}/);
    // lg+: each card is a 4-row subgrid so the band / Spend / Sales / Profit sections align across a row whatever wraps inside one card
    expect(tiles).toMatch(/lg:grid lg:grid-rows-subgrid lg:row-span-4/);
  });
  it("three sections separated by hairlines; main values 28 px / 700; sub-metrics 16 px / 600 in a 2-column grid; labels 11 px with .08em tracking", () => {
    expect(tiles.match(/<section className=\{`\$\{SECTION\} border-t/g)).toHaveLength(2);
    expect(tiles).toMatch(/text-\[28px\] font-bold leading-\[1\.15\]/);
    expect(tiles).toMatch(/const SUB_VALUE = "text-base font-semibold";/);
    expect(tiles).toMatch(/const LABEL = "text-\[11px\] font-bold uppercase tracking-\[0\.08em\] text-muted-foreground";/);
    expect(tiles.match(/grid grid-cols-2 gap-x-4 gap-y-3/g)).toHaveLength(3);
  });
  // Finances API patch (commit 7, mockup docs/mockups/finances-breakdown-2026-11-19.html): the placeholders and the note are gone.
  it("PROFIT: Net profit main, Gross profit · Est. payout · Margin · ROI, a More link; SALES Refunds reads '33 · $962.50'; no 'after the Finances API patch' note", () => {
    expect(tiles).not.toMatch(/profit-note/);
    expect(tiles).toMatch(/<Main label="Net profit" value=\{np\.main\} dim=\{np\.muted\}/);
    expect(tiles).toMatch(/<Sub label="Gross profit" testId=\{t\("gross-profit"\)\} dim=\{gp\.muted\}>\{gp\.main\}<\/Sub>/);
    expect(tiles).toMatch(/<Sub label="Est\. payout" testId=\{t\("est-payout"\)\} dim=\{ep\.muted\}>\{ep\.main\}<\/Sub>/);
    expect(tiles).toMatch(/<Sub label="Margin"/); expect(tiles).toMatch(/<Sub label="ROI"/);
    expect(tiles).toMatch(/onClick=\{\(\) => onMore\?\.\(col\)\} data-testid=\{t\("more"\)\}>More<\/button>/);
    expect(tiles).toMatch(/<Sub label="Refunds" testId=\{t\("refunds"\)\} dim=\{rf\.muted\} title=\{rf\.tooltip\}>/);
    const refunds = DASHBOARD_ROWS.find((r) => r.key === "refunds")!;
    expect(cellText(refunds, { value: 33, secondary: 962.5 })).toEqual({ main: "33", small: "$962.50", tooltip: undefined });
    expect(cellText(refunds, { value: null, pending: true })).toMatchObject({ main: "—", muted: true });
    expect(cellText(DASHBOARD_ROWS.find((r) => r.key === "margin")!, { value: 10.48 })).toMatchObject({ main: "10.48%" });
    expect(cellText(DASHBOARD_ROWS.find((r) => r.key === "net_profit")!, { value: 3538.12, dataFrom: "2024-11-19" })).toEqual({ main: "$3,538.12", muted: false, small: "data from Nov 19, 2024" });
    expect(DASHBOARD_ROWS.filter((r) => r.group === "profit").map((r) => r.key)).toEqual(["net_profit", "gross_profit", "est_payout", "margin", "roi"]);
    expect(DASHBOARD_ROWS.some((r) => r.pending)).toBe(false);
  });
  it("the SPEND 2 × 2: Refunds due (link when > 0), Avg. PO value with '· N POs', ASIN units, Individual units with the missing-pack-size note", () => {
    expect(tiles).toMatch(/<Sub label="Refunds due"[\s\S]*?<Link href=\{refundsDueHref\(col\)\}/);
    expect(tiles).toMatch(/<Sub label="Avg\. PO value"[\s\S]*?· \{avg\.small\}/);
    expect(tiles).toMatch(/<Sub label="ASIN units ordered"/);
    expect(tiles).toMatch(/<Sub label="Individual units ordered" note=\{ind\.small\}/);
  });
  // Claims commit 9 (§3.14, mockup docs/mockups/dashboard-writeoffs-2026-11-15.html): two cells under the four, in the same 2-column grid.
  it("Supplier write-offs and Lost / damaged by us: a link with '· N claims' / '· N ASIN units' and the hover split when > 0, a dim '$0.00' with no link when empty (rows 2, 3, 6, 7)", () => {
    expect(tiles).toMatch(/<Sub label="Supplier write-offs" testId=\{t\("write-offs"\)\} dim=\{wo\.muted\}[\s\S]*?<Link href=\{writeOffsHref\(col\)\} className=\{LINK\} title=\{wo\.tooltip\}[\s\S]*?· \{wo\.small\}/);
    expect(tiles).toMatch(/<Sub label="Lost \/ damaged by us" testId=\{t\("lost-damaged"\)\} dim=\{ld\.muted\}[\s\S]*?<Link href=\{lostDamagedHref\(col\)\} className=\{LINK\} title=\{ld\.tooltip\}[\s\S]*?· \{ld\.small\}/);
    expect(tiles).toMatch(/\{wo\.muted\s*\?\s*<span>\{wo\.main\}<\/span>/);
    expect(tiles).toMatch(/\{ld\.muted\s*\?\s*<span>\{ld\.main\}<\/span>/);
    // the two cells sit inside the SPEND grid, after Individual units — still one 2-column grid in SPEND
    expect(tiles.indexOf('label="Supplier write-offs"')).toBeGreaterThan(tiles.indexOf('label="Individual units ordered"'));
    expect(tiles.indexOf('label="Lost / damaged by us"')).toBeLessThan(tiles.indexOf("{/* SALES"));
    // the cell texts (metric-grid): "$58.40 · 3 claims" with the split "missing $38.42 · can't sell $19.98" on hover; "$20.82 · 3 ASIN units"; "$0.00" muted
    const wo = cellText(DASHBOARD_ROWS.find((r) => r.key === "write_offs")!, { value: 58.4, claimCount: 3, byKind: { missing: 38.42, cant_sell: 19.98 } });
    expect(wo).toEqual({ main: "$58.40", small: "3 claims", tooltip: "missing $38.42 · can't sell $19.98" });
    expect(cellText(DASHBOARD_ROWS.find((r) => r.key === "write_offs")!, { value: 12.5, claimCount: 1, byKind: { damaged: 12.5 } })).toEqual({ main: "$12.50", small: "1 claim", tooltip: "damaged $12.50" });
    expect(cellText(DASHBOARD_ROWS.find((r) => r.key === "write_offs")!, { value: 0, claimCount: 0, byKind: {} })).toEqual({ main: "$0.00", muted: true });
    const ld = cellText(DASHBOARD_ROWS.find((r) => r.key === "lost_damaged")!, { value: 20.82, secondary: 3, poCount: 2 });
    expect(ld).toEqual({ main: "$20.82", small: "3 ASIN units", tooltip: "on 2 POs" });
    expect(cellText(DASHBOARD_ROWS.find((r) => r.key === "lost_damaged")!, { value: 0, secondary: 0, poCount: 0 })).toEqual({ main: "$0.00", muted: true });
    // the links: Claims › Closed filtered to the write-off dates; POs filtered to rows with lost / damaged units in the order dates, open and closed
    const col = { eastern: { from: "2026-11-01", to: "2026-11-14" } };
    expect(writeOffsHref(col)).toBe("/claims?bucket=closed&written_off_from=2026-11-01&written_off_to=2026-11-14");
    expect(lostDamagedHref(col)).toBe("/purchase-orders?lost=1&closed=all&from=2026-11-01&to=2026-11-14");
    // the mockup's wording for the lost cell was "· 3 units"; Maria 2026-11-15: the kind is named — "· 3 ASIN units" (the quantity-names rule)
    expect(readFileSync(resolve(__dirname, "../../../docs/mockups/dashboard-writeoffs-2026-11-15.html"), "utf8")).toContain("· 3 ASIN units");
  });
});
