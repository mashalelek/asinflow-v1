import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { cellText, fmtRangeLabel, refundsDueHref, fmtMoney, coverageTooltip } from "@/components/metric-grid";
import { DASHBOARD_ROWS, PENDING_TOOLTIP } from "@shared/dashboard";

// Dashboard page (SPEC §28, commit 5): page-local ranges only, quiet chrome,
// placeholders with the tooltip, the Refunds due link.
const page = readFileSync(resolve(__dirname, "dashboard.tsx"), "utf8");
const grid = readFileSync(resolve(__dirname, "../components/metric-grid.tsx"), "utf8");
const tiles = readFileSync(resolve(__dirname, "../components/metric-tiles.tsx"), "utf8");
const row = (key: string) => DASHBOARD_ROWS.find((r) => r.key === key)!;

describe("the page never touches the global date range and keeps quiet chrome", () => {
  it("imports neither useDateRange nor the date-range context nor computePresetRange; remembers the set under af-dashboard-range-set", () => {
    for (const src of [page, grid, tiles]) {
      expect(src).not.toMatch(/useDateRange|date-range-context|computePresetRange|DataStudioDatePicker/);
      expect(src).not.toMatch(/text-red|bg-red|text-orange|bg-orange|amber|destructive/);
    }
    expect(page).toMatch(/RANGE_SET_KEY = "af-dashboard-range-set"/);
    expect(page).toMatch(/fetch\(`\/api\/dashboard\/grid\?\$\{q\.toString\(\)\}`\)/);
  });
  it("header (tiles patch 2026-11-04): the title only, no subtitle, no coverage lines; the range-set dropdown with the four sets and the custom control beside it; the coverage lives in the SALES tooltip", () => {
    expect(page).not.toMatch(/Spend by PO date|dashboard-coverage|dashboard-rebackfill-pending|ToggleGroup/);
    expect(page).toMatch(/<label htmlFor="dashboard-range-set"[^>]*>Date ranges<\/label>/);
    expect(page).toMatch(/\(\[1, 2, 3, 4\] as RangeSetKey\[\]\)\.map\(\(n\) => \([\s\S]*?<SelectItem key=\{n\} value=\{String\(n\)\}/);
    expect(page).toMatch(/onValueChange=\{\(v\) => \{ const n = Number\(v\) as RangeSetKey; setSet\(n\); saveSet\(n\); \}\}/);
    expect(page).toMatch(/\{set === 4 && \([\s\S]*?data-testid="dashboard-custom-range"/);
    expect(tiles).toMatch(/<div className=\{LABEL\} title=\{coverage \|\| undefined\} data-testid=\{t\("sales-label"\)\}>Sales<\/div>/);
    const cov = { earliestSaleDate: "2024-09-09", newestSaleDate: "2026-11-03", lastSalesSyncAt: "2026-11-03T23:47:19.213Z", ordersFrom: "2024-10-31", rebackfillPending: false };
    expect(coverageTooltip(cov)).toMatch(/^Sales through Nov 3 · synced \d{1,2}:\d{2} [AP]M · data from Sep 9, 2024 · Orders from Oct 31, 2024 \(earlier sales stay on the old day basis\)$/);
    expect(coverageTooltip({ ...cov, ordersFrom: null, rebackfillPending: true })).toMatch(/Orders not loaded yet — run backfill:sales/);
    expect(coverageTooltip(null)).toBe("");
  });
  it("the tiles replaced the grid: placeholders with the tooltip, Refunds due linked only when > 0", () => {
    expect(page).toMatch(/<MetricTiles grid=\{grid\} loading=\{loading\} \/>/);
    expect(page).not.toMatch(/MetricGrid/);
    expect(tiles).toMatch(/\(c\.refunds_due\.value \?\? 0\) > 0\s*\? <Link href=\{refundsDueHref\(col\)\}/);
    expect(cellText(row("gross_profit"), { value: null, pending: true })).toEqual({ main: "—", tooltip: PENDING_TOOLTIP, muted: true });
    expect(cellText(row("refunds"), { value: null, pending: true, secondary: null }).tooltip).toBe("after the Finances API patch");
  });
});

describe("cell text (pure)", () => {
  it("money / ints / the pair / the small lines", () => {
    expect(cellText(row("spend"), { value: 1234.5 })).toEqual({ main: "$1,234.50", muted: false });
    expect(fmtMoney(-12)).toBe("-$12.00");
    expect(cellText(row("avg_po_value"), { value: null, poCount: 0 })).toEqual({ main: "—", small: "0 POs", muted: true });
    expect(cellText(row("avg_po_value"), { value: 100, poCount: 1 })).toEqual({ main: "$100.00", small: "1 PO", muted: false });
    expect(cellText(row("individual_units"), { value: 28, missingPackSize: 1 })).toEqual({ main: "28", small: "1 row missing pack size" });
    expect(cellText(row("individual_units"), { value: 28, missingPackSize: 0 })).toEqual({ main: "28", small: undefined });
    expect(cellText(row("orders_units"), { value: 12, secondary: 30, dataFrom: null })).toEqual({ main: "12 / 30", small: undefined });
    expect(cellText(row("orders_units"), { value: null, secondary: 30, dataFrom: null })).toMatchObject({ main: "— / 30", small: "orders after the re-backfill" });
    expect(cellText(row("sales"), { value: 97, dataFrom: "2024-10-31" })).toEqual({ main: "$97.00", small: "data from Oct 31, 2024" });
  });
  it("range labels and the Refunds due link", () => {
    expect(fmtRangeLabel("2026-06-17", "2026-06-17", 2026)).toBe("Jun 17");
    expect(fmtRangeLabel("2026-06-15", "2026-06-17", 2026)).toBe("Jun 15 – 17");
    expect(fmtRangeLabel("2026-05-19", "2026-06-17", 2026)).toBe("May 19 – Jun 17");
    expect(fmtRangeLabel("2025-12-01", "2025-12-31", 2026)).toBe("Dec 1 – 31, 2025");
    expect(fmtRangeLabel("2025-12-12", "2026-01-10", 2026)).toBe("Dec 12, 2025 – Jan 10, 2026");
    // Claims commit 2 (§3.7): the cell opens the Claims page — Waiting on refund to post + Waiting on supplier — with the column's PO date range.
    expect(refundsDueHref({ eastern: { from: "2026-06-01", to: "2026-06-17" } })).toBe("/claims?bucket=waiting_refund,waiting_supplier&from=2026-06-01&to=2026-06-17");
  });
});
