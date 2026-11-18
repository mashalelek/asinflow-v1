// Keepa trend columns, the UI half (docs/claude_spec-patch-keepa-trends.md "Header and columns", "Hover", "Range";
// commit 5). The columns on every ASIN table, added once to a saved layout, the prefs stored with the column config
// per key, the path / toggle / hover helpers, and the mockup's stylesheet carried over as is.
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ALL_COLUMNS, DEFAULT_COLUMNS, COLUMN_GROUPS, KEEPA_COLUMN_IDS, isKeepaColumn } from "@shared/schema";
import { KEEPA_CELLS, KEEPA_LINE } from "@shared/keepa";
import { loadColumnConfig, saveColumnConfig, getDefaultConfig, readKeepaPrefs, DEFAULT_KEEPA_PREFS } from "./columns";
import { trendPath, visibleLines, hoverDate, KEEPA_CHART_W, KEEPA_COL_W } from "@/components/keepa-trends";

const SRC = join(__dirname, "..");
const read = (p: string) => readFileSync(join(SRC, p), "utf8");

// a localStorage for the column-config tests
const store = new Map<string, string>();
(globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } };
beforeEach(() => store.clear());

describe("the four columns", () => {
  it("are a Keepa group after Sellers, in the patch's order, visible by default, left-aligned charts", () => {
    const keys = COLUMN_GROUPS.map((g) => g.key);
    expect(keys.indexOf("keepa")).toBe(keys.indexOf("sellers") + 1);
    expect(COLUMN_GROUPS.find((g) => g.key === "keepa")!.label).toBe("Keepa");
    expect([...KEEPA_COLUMN_IDS]).toEqual(["priceTrend", "salesVelocityTrend", "offerCount", "ratingCount"]);
    const cols = ALL_COLUMNS.filter((c) => c.group === "keepa");
    expect(cols.map((c) => c.id)).toEqual([...KEEPA_COLUMN_IDS]);
    expect(cols.map((c) => c.label)).toEqual(["Price Trend", "Sales Velocity Trend", "Offer Count", "Rating Count"]);
    expect(cols.every((c) => c.defaultVisible && c.align === "left")).toBe(true);
    const i = DEFAULT_COLUMNS.indexOf("fba30d");
    expect(DEFAULT_COLUMNS.slice(i + 1, i + 5)).toEqual([...KEEPA_COLUMN_IDS]);
    expect(Object.keys(KEEPA_CELLS)).toEqual([...KEEPA_COLUMN_IDS]);
  });
  it("a user with a saved layout gains them once, visible; hiding them afterwards sticks", () => {
    const old = { order: DEFAULT_COLUMNS.filter((id) => !isKeepaColumn(id)), visible: ["product", "salePrice"], stockOrderV: 1 };
    store.set("fba-column-config", JSON.stringify(old));
    const cfg = loadColumnConfig();
    for (const id of KEEPA_COLUMN_IDS) { expect(cfg.order).toContain(id); expect(cfg.visible.has(id)).toBe(true); }
    expect(cfg.order.indexOf("priceTrend")).toBe(cfg.order.indexOf("fba30d") + 1);
    cfg.visible.delete("offerCount");
    saveColumnConfig(cfg);
    expect(loadColumnConfig().visible.has("offerCount")).toBe(false);
    expect(loadColumnConfig().visible.has("priceTrend")).toBe(true);
  });
  it("are on every table whose rows are ASINs: ASINs, Bulk Calc, Repricer, ASIN Analytics", () => {
    const bulk = read("pages/bulk-calc.tsx");
    for (const id of KEEPA_COLUMN_IDS) expect(bulk).toMatch(new RegExp(`"${id}"`));
    for (const page of ["pages/home.tsx", "pages/bulk-calc.tsx", "pages/repricer.tsx", "pages/analytics.tsx"]) {
      const src = read(page);
      expect(src, page).toMatch(/<KeepaRangeSwitch prefs=\{keepa\.prefs\} onPrefsChange=\{keepa\.setPrefs\} \/>/);
      expect(src, page).toMatch(/onKeepaPrefsChange=\{keepa\.setPrefs\}/);
      expect(src, page).toMatch(/useKeepaPrefs\(columnConfig/);
    }
    // the Repricer tab and Bulk Calc save under their own keys; Analytics through its own saver
    expect(read("pages/repricer.tsx")).toMatch(/saveColumnConfig\(next, REPRICER_COLUMNS_KEY\)/);
    expect(read("pages/bulk-calc.tsx")).toMatch(/saveColumnConfig\(next, BULK_COLUMNS_KEY\)/);
    expect(read("pages/analytics.tsx")).toMatch(/useKeepaPrefs\(columnConfig, handleColumnConfigChange\)/);
    expect(read("pages/analytics.tsx")).toMatch(/keepa: config\.keepa \?\? DEFAULT_KEEPA_PREFS/);
  });
  it("are charts: never sorted, filtered or exported; the header carries the Keepa line and the chips, no sort click", () => {
    const table = read("components/results-table.tsx");
    const header = table.slice(table.indexOf("if (isKeepaColumn(colId)) {"), table.indexOf("<KeepaHeaderChips"));
    expect(header).not.toMatch(/onClick=\{\(\) => onSort/);
    expect(header).not.toMatch(/ColumnFilterButton/);
    expect(header).toMatch(/<span className="text-\[9px\] opacity-60">Keepa<\/span>/);
    expect(table).toMatch(/content = <KeepaTrendCell cell=\{colId as KeepaColumnId\} asin=\{result\.asin\} trends=\{keepaTrends\[result\.asin\]\} prefs=\{keepaPrefs\} \/>/);
    expect(read("components/export-buttons.tsx")).toMatch(/if \(isKeepaColumn\(colId\)\) continue;/);
    expect(read("components/column-filter.tsx")).not.toMatch(/priceTrend|salesVelocityTrend|offerCount|ratingCount/);
    // the mockup's column widths
    expect(KEEPA_COL_W).toEqual({ priceTrend: 170, salesVelocityTrend: 210, offerCount: 180, ratingCount: 140 });
    expect(KEEPA_CHART_W).toEqual({ priceTrend: 150, salesVelocityTrend: 150, offerCount: 150, ratingCount: 120 });
    expect(table).toMatch(/priceTrend: 170, salesVelocityTrend: 210, offerCount: 180, ratingCount: 140/);
  });
});

describe("prefs (range + the two toggles) live with the column config", () => {
  it("default 1 year, both lines shown; saved and read back per key; an unknown value falls back", () => {
    expect(getDefaultConfig().keepa).toEqual(DEFAULT_KEEPA_PREFS);
    expect(DEFAULT_KEEPA_PREFS).toEqual({ range: "1y", showNew: true, showFba: true });
    const cfg = getDefaultConfig();
    cfg.keepa = { range: "all", showNew: false, showFba: true };
    saveColumnConfig(cfg, "fba-repricer-column-config");
    expect(loadColumnConfig("fba-repricer-column-config").keepa).toEqual({ range: "all", showNew: false, showFba: true });
    expect(loadColumnConfig().keepa).toEqual(DEFAULT_KEEPA_PREFS); // the main table's own key is untouched
    expect(readKeepaPrefs({ range: "2y", showNew: "no" })).toEqual({ range: "1y", showNew: true, showFba: true });
    expect(readKeepaPrefs(undefined)).toEqual(DEFAULT_KEEPA_PREFS);
  });
  it("a toggle hides the line (and its popup row) in every row; the other line's scale is untouched (the scale comes from the server)", () => {
    expect(visibleLines("priceTrend", { range: "1y", showNew: true, showFba: true })).toEqual(["buy_box", "new_price"]);
    expect(visibleLines("priceTrend", { range: "1y", showNew: false, showFba: true })).toEqual(["buy_box"]);
    expect(visibleLines("offerCount", { range: "1y", showNew: true, showFba: false })).toEqual(["offers_new"]);
    expect(visibleLines("salesVelocityTrend", { range: "1y", showNew: false, showFba: false })).toEqual(["monthly_sold", "sales_rank"]);
    expect(visibleLines("ratingCount", { range: "1y", showNew: false, showFba: false })).toEqual(["rating_count"]);
    // the cell reads the scale from the server's bounds, never recomputes it client-side
    const cell = read("components/keepa-trends.tsx");
    expect(cell).toMatch(/trends\.scales\[/);
    expect(cell).not.toMatch(/Math\.min\(\.\.\./);
  });
});

describe("drawing and hover", () => {
  it("trendPath: 14 points over the width, a gap lifts the pen (no segment across it), larger values higher, nothing = M0 0", () => {
    const d = trendPath([0, 10, null, 10, 0], 0, 10, 100, 36);
    expect(d).toBe("M0.0 33.0L25.0 3.0M75.0 3.0L100.0 33.0");
    expect(trendPath([null, null], 0, 1, 100)).toBe("M0 0");
    expect(trendPath([5, 5], 5, 5, 100)).toBe("M0.0 33.0L100.0 33.0"); // a flat line sits at the bottom, span 0 → 1
    // Sales Rank: the larger rank number is plotted higher (lo = min, hi = max, as every other line)
    const rank = trendPath([100, 200], 100, 200, 100);
    expect(rank).toBe("M0.0 33.0L100.0 3.0");
  });
  it("hoverDate reads `Mar 4, 2026`; the popup is a fixed portal (never clipped by the table's scroll box) with one row per visible line", () => {
    expect(hoverDate("2026-03-01", 3)).toBe("Mar 4, 2026");
    expect(hoverDate("2025-11-19", 364)).toBe("Nov 18, 2026");
    const cell = read("components/keepa-trends.tsx");
    expect(cell).toMatch(/createPortal\(\s*<div className="kp-tip"/);
    expect(cell).toMatch(/hover && createPortal/);
    expect(cell).toMatch(/\/api\/keepa\/history\/\$\{asin\}\?range=\$\{range\}/);
    expect(cell).toMatch(/\[\.\.\.drawn\]\.reverse\(\)/); // the first listed line is drawn on top
    expect(read("components/keepa-trends.css")).toMatch(/\.kp-tip\{position:fixed/);
  });
  it("the stylesheet is the mockup's rules, prefixed: chips, dot, the off state, the segmented switch, the tip", () => {
    const mock = read("../../docs/mockups/keepa-trends-2026-11-18.html");
    const css = read("components/keepa-trends.css");
    const same = (mockSel: string, ours: string) => {
      const m = mock.match(new RegExp(`${mockSel.replace(/[.{}()]/g, "\\$&")}\\{([^}]+)\\}`))![1];
      const o = css.match(new RegExp(`${ours.replace(/[.{}()]/g, "\\$&")}\\{([^}]+)\\}`))![1];
      for (const decl of m.split(";").filter(Boolean)) expect(o, `${ours} ← ${mockSel}: ${decl}`).toContain(decl);
    };
    same("button.chip", "button.kp-chip");
    same("button.chip.off", "button.kp-chip.off");
    same(".dot", ".kp-dot");
    same(".seg", ".kp-seg");
    same(".seg button.on", ".kp-seg button.on");
    same("svg.sp path", "svg.kp-sp path");
    for (const decl of ["background:#2a2824", "border:1px solid #3a3733", "border-radius:6px", "padding:6px 9px", "gap:2px", "font-size:11px", "line-height:15px", "white-space:nowrap", "box-shadow:0 4px 14px rgba(0,0,0,.45)"]) expect(css).toContain(decl);
    expect(css).toContain(".kp-chip{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 8px;border:1px solid transparent;border-radius:11px");
    expect(css).toContain("span.kp-chip{padding-left:0}");
    expect(css).toContain(".kp-lg{display:flex;gap:6px;margin-top:6px;align-items:center;flex-wrap:wrap}");
    for (const s of Object.keys(KEEPA_LINE)) expect(css).not.toContain(KEEPA_LINE[s as keyof typeof KEEPA_LINE].color); // colors come from shared/keepa.ts, inline
  });
});
