import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { rowsToRefresh, mergeRefreshedRows, RowRefresher } from "./row-refresh";

const r = (asin: string, title = "t"): any => ({ asin, catalogData: { title } });

describe("job-finish row refresh (2026-10-18)", () => {
  it("a scoped job refreshes only its rows that are on screen; a scheduled pass (no scope) the visible page", () => {
    expect(rowsToRefresh({ scope_asins: ["b09hrdgw17", "B0NOTSHOWN"] }, ["B09HRDGW17", "B07K1N4K54"])).toEqual(["B09HRDGW17"]);
    expect(rowsToRefresh({ scope_asins: null }, ["B09HRDGW17", "B07K1N4K54"])).toEqual(["B09HRDGW17", "B07K1N4K54"]);
    expect(rowsToRefresh({ scope_asins: ["B0NOTSHOWN"] }, ["B09HRDGW17"])).toEqual([]);
  });
  it("refreshed rows replace theirs in place; a requested row the server no longer returns leaves; others are untouched", () => {
    const prev = [r("A000000001"), r("A000000002"), r("A000000003")];
    const out = mergeRefreshedRows(prev, [r("A000000002", "new")], ["A000000002", "A000000003"]);
    expect(out.map((x) => [x.asin, x.catalogData.title])).toEqual([["A000000001", "t"], ["A000000002", "new"]]);
  });
  it("one request at a time: refreshes asked while one is in flight go out together afterwards; a job is handled once", async () => {
    const sent: string[][] = [];
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    const rr = new RowRefresher(async (asins) => { sent.push(asins); if (sent.length === 1) await gate; });
    const first = rr.request(["A1"]);
    void rr.request(["A2"]); void rr.request(["A3", "A2"]);
    expect(sent).toEqual([["A1"]]);
    release(); await first;
    expect(sent).toEqual([["A1"], ["A2", "A3"]]);
    expect(rr.seenJob(63)).toBe(true);
    expect(rr.seenJob(63)).toBe(false);
  });
  it("the ASINs page never reloads the full list when a job finishes", () => {
    const home = readFileSync(resolve(__dirname, "../pages/home.tsx"), "utf8");
    const finished = home.slice(home.indexOf("const onJobFinished = useCallback"), home.indexOf("const jobs = useJobs("));
    expect(finished).not.toMatch(/fetchAsins\(/);
    expect(finished).toMatch(/refreshJobRows\(job\);/);
    expect(home).toMatch(/if \(!rowRefresher\.seenJob\(job\.id\)\) return;/);
    expect(home).toMatch(/const asins = Array\.from\(new Set\(\[\.\.\.rowsToRefresh\(job, visibleAsinsRef\.current\), \.\.\.extra\]\)\);/);
    expect(home).toMatch(/visibleAsinsRef\.current = paginatedResults\.map\(\(r\) => r\.asin\);/);
    expect(home).toMatch(/&asins=\$\{encodeURIComponent\(asins\.join\(","\)\)\}/);
  });
});
