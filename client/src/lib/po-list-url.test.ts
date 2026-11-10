import { describe, it, expect } from "vitest";
import { readPoListUrl, writePoListUrl } from "./po-list-url";
import { readAsinsUrl, writeAsinsUrl } from "@/pages/home";
import { readBulkUrl, writeBulkUrl } from "@/pages/bulk-calc";

describe("POs list URL state (2026-11-06)", () => {
  it("every filter, the sort and the page round-trip through the query string", () => {
    const s = { search: "caress", action: ["SHIP", "Pack size missing"], supplier: ["walmart.com", "target.com"], closed: "all" as const, refunds: "due" as const, claims: "open" as const, from: "2026-01-01", to: "2026-11-06", sort: { key: "order_total", dir: "desc" as const }, page: 3 };
    const q = writePoListUrl(s);
    expect(readPoListUrl(q)).toEqual({ ...s, action: ["Pack size missing", "SHIP"], supplier: ["target.com", "walmart.com"] });
  });
  it("the default list is the bare URL; D3 Status defaults to Open; ?asin= (the On Order link) searches the ASIN", () => {
    expect(writePoListUrl(readPoListUrl(""))).toBe("");
    expect(readPoListUrl("").closed).toBe("open");
    expect(readPoListUrl("?asin=b0bsx").search).toBe("B0BSX");
    expect(readPoListUrl("?refunds=due&closed=all&from=2026-10-01&to=bad")).toMatchObject({ refunds: "due", closed: "all", from: "2026-10-01", to: "", claims: "any" });
    expect(readPoListUrl("?claims=open").claims).toBe("open"); // "has open claims" (SPEC §22 §5)
  });
});

describe("ASINs and Bulk Calc URL state (2026-11-06)", () => {
  it("ASINs: search, scorecard view and page; an unknown view is All", () => {
    expect(readAsinsUrl(writeAsinsUrl({ q: "B0BRT7R75H", view: "buyList", page: 4 }))).toEqual({ q: "B0BRT7R75H", view: "buyList", page: 4 });
    expect(writeAsinsUrl({ q: "", view: "all", page: 1 })).toBe("");
    expect(readAsinsUrl("?view=nope").view).toBe("all");
  });
  it("Bulk Calc: column filters and sort; a broken ?f= is no filter", () => {
    const f = { roi: { op: "gt", value: 20 } } as any;
    expect(readBulkUrl(writeBulkUrl(f, "roi" as any, "asc"))).toEqual({ filters: f, sort: { col: "roi", dir: "asc" } });
    expect(readBulkUrl("?f=%7Bbad")).toEqual({ filters: {}, sort: null });
    expect(writeBulkUrl({}, null, "desc")).toBe("");
  });
});
