import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

// Dashboard patch commit 1 (D1, SPEC §8 / §28): the Dashboard tab takes the
// slot Analytics held, the old page is "ASIN Analytics" right after it, and
// /dashboard never joins the shared date-picker routes (its ranges are
// page-local, the §23 Repricer rule).
const nav = readFileSync(resolve(__dirname, "top-nav.tsx"), "utf8");
const app = readFileSync(resolve(__dirname, "../../App.tsx"), "utf8");

function navItems(src: string): Array<{ path: string; label: string }> {
  const block = src.slice(src.indexOf("const NAV_ITEMS"), src.indexOf("];", src.indexOf("const NAV_ITEMS")));
  return Array.from(block.matchAll(/path: "([^"]+)", label: "([^"]+)"/g)).map((m) => ({ path: m[1], label: m[2] }));
}

describe("top nav — Dashboard slot and the ASIN Analytics rename", () => {
  const items = navItems(nav);
  it("Dashboard is the FIRST tab (tiles patch 2026-11-04), then ASINs · Bulk Calc · ASIN Analytics · POs …; no tab is still called Analytics", () => {
    const paths = items.map((i) => i.path);
    expect(paths.slice(0, 5)).toEqual(["/dashboard", "/asins", "/bulk-calc", "/analytics", "/purchase-orders"]);
    expect(app).toMatch(/<Route path="\/">\s*<Redirect to="\/asins" \/>/); // default landing page unchanged
    expect(items.find((i) => i.path === "/dashboard")?.label).toBe("Dashboard");
    expect(items.find((i) => i.path === "/analytics")?.label).toBe("ASIN Analytics");
    expect(items.some((i) => i.label === "Analytics")).toBe(false);
  });
  it("/dashboard is registered in the router and is NOT a date-picker route", () => {
    expect(app).toMatch(/<Route path="\/dashboard" component=\{Dashboard\} \/>/);
    expect(app).toMatch(/<Route path="\/analytics" component=\{Analytics\} \/>/);
    const pickerLine = /const DATE_PICKER_ROUTES = \[([^\]]*)\]/.exec(nav)![1];
    expect(pickerLine).not.toContain("/dashboard");
    expect(pickerLine).toContain("/analytics");
  });
});
