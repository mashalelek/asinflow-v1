import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { tickLabel, periodLabel, axisMoney, SERIES_COLORS, CHART_TITLES } from "./dashboard-chart";
import { loadChartRange, seriesQuery } from "./dashboard-charts";

// Dashboard charts (SPEC §28; tiles patch 2026-11-04 swapped the marks): one
// shared DashboardChart, Spend bars (left $ axis) + Sales line (right $ axis)
// with a checkbox each, Last 12
// months / Custom local picker remembered per browser, sums from the server.
const chart = readFileSync(resolve(__dirname, "dashboard-chart.tsx"), "utf8");
const charts = readFileSync(resolve(__dirname, "dashboard-charts.tsx"), "utf8");
const page = readFileSync(resolve(__dirname, "../pages/dashboard.tsx"), "utf8");

describe("DashboardChart — marks, series toggles, quiet chrome", () => {
  it("bars capped at 24 px with 4 px rounded data-ends, a 2 px line, a solid hairline grid, no gradients, text in text tokens", () => {
    expect(chart).toMatch(/<Bar yAxisId="spend" dataKey="spend" name="Spend" fill=\{colors\.spend\} maxBarSize=\{24\} radius=\{\[4, 4, 0, 0\]\}/);
    expect(chart).toMatch(/<Line yAxisId="sales" type="monotone" dataKey="sales" name="Sales" stroke=\{colors\.sales\} strokeWidth=\{2\} dot=\{false\}/);
    expect(chart).not.toMatch(/<Bar yAxisId="sales"|<Line yAxisId="spend"/);
    expect(chart).toMatch(/<CartesianGrid stroke="hsl\(var\(--border\)\)" strokeWidth=\{1\} vertical=\{false\} \/>/);
    expect(chart).not.toMatch(/strokeDasharray|linearGradient|<defs/);
    expect(chart).not.toMatch(/text-red|bg-red|text-orange|amber|destructive/);
    expect(chart).toMatch(/fill: mutedInk/);
  });
  it("unticking a series removes it AND its axis; both are on by default; a table view twin exists", () => {
    expect(chart).toMatch(/\{showSpend && <YAxis yAxisId="spend" tick/); // Spend = the left axis
    expect(chart).toMatch(/\{showSales && <YAxis yAxisId="sales" orientation="right"/); // Sales = the right axis
    expect(chart).toMatch(/\{showSpend && <Bar yAxisId="spend"/);
    expect(chart).toMatch(/\{showSales && <Line yAxisId="sales"/);
    expect(charts).toMatch(/running30: \{ sales: true, spend: true \}, monthly: \{ sales: true, spend: true \}, weekly: \{ sales: true, spend: true \}/);
    expect(chart).toMatch(/data-testid=\{`button-\$\{kind\}-table`\}/);
  });
  it("the tooltip lists period, Sales, Spend, POs, units sold and orders; the coverage note and the to-date note", () => {
    expect(chart).toMatch(/label="Spend"[\s\S]*label="Sales"[\s\S]*label=\{`PO\$\{p\.poCount === 1 \? "" : "s"\}`\}[\s\S]*label="ASIN units sold"[\s\S]*label="orders"/);
    expect(chart).toMatch(/Sales from \$\{fmtRangeLabel\(series\.salesFrom, series\.salesFrom\)\} — earlier periods have no sales data\./);
    expect(chart).toMatch(/The last period is to date\./);
  });
  it("labels and axis ticks", () => {
    expect(tickLabel("monthly", "2026-10-01")).toBe("Oct '26");
    expect(tickLabel("weekly", "2026-10-26")).toBe("10/26");
    expect(tickLabel("running30", "2026-11-03")).toBe("11/3");
    expect(periodLabel("monthly", "2026-11-01", true)).toBe("Nov 2026 (to date)");
    expect(periodLabel("weekly", "2026-10-26", false)).toBe("Week of Oct 26");
    expect(periodLabel("running30", "2026-11-03", true)).toBe("30 days to Nov 3 (today)");
    expect(axisMoney(0)).toBe("$0"); expect(axisMoney(850)).toBe("$850"); expect(axisMoney(5400)).toBe("$5.4K"); expect(axisMoney(25143)).toBe("$25K"); expect(axisMoney(1_250_000)).toBe("$1.3M");
    expect(CHART_TITLES).toEqual({ running30: "30-day running", monthly: "Monthly", weekly: "Weekly" });
  });
  it("series colours follow the entity, not the mark: Sales keeps the blue slot (now the line), Spend the teal one (now the bars)", () => {
    expect(SERIES_COLORS).toEqual({ light: { sales: "#0a5adb", spend: "#12a190" }, dark: { sales: "#3c83f6", spend: "#12a594" } });
  });
});

describe("DashboardCharts — the local range control", () => {
  it("Last 12 months by default (the server resolves it — no from/to sent); Custom sends both; the choice is remembered under af-dashboard-chart-range", () => {
    expect(loadChartRange(null, "2026-11-03")).toEqual({ mode: "last12", from: "2026-01-01", to: "2026-11-03" });
    expect(loadChartRange(JSON.stringify({ mode: "custom", from: "2026-06-01", to: "2026-06-30" }))).toEqual({ mode: "custom", from: "2026-06-01", to: "2026-06-30" });
    expect(loadChartRange(JSON.stringify({ mode: "custom", from: "2026-07-01", to: "2026-06-30" }), "2026-11-03")).toEqual({ mode: "custom", from: "2026-01-01", to: "2026-11-03" });
    expect(loadChartRange("garbage", "2026-11-03").mode).toBe("last12");
    expect(seriesQuery("monthly", { mode: "last12", from: "2026-01-01", to: "2026-11-03" })).toBe("kind=monthly");
    expect(seriesQuery("weekly", { mode: "custom", from: "2026-01-01", to: "2026-11-03" })).toBe("kind=weekly&from=2026-01-01&to=2026-11-03");
    expect(charts).toMatch(/CHART_RANGE_KEY = "af-dashboard-chart-range"/);
    expect(charts).not.toMatch(/useDateRange|date-range-context/);
    expect(page).toMatch(/<DashboardCharts \/>/);
  });
});
