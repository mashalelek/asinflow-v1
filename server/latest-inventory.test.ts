import { describe, it, expect, vi } from "vitest";
vi.mock("./index", () => ({ log: () => {} }));
import { LATEST_INVENTORY_SQL } from "./routes";

// ASINs page performance (2026-10-18): the latest snapshot per ASIN is one
// index probe per ASIN, never a scan of the whole snapshot history; no
// snapshot is deleted.
describe("latest inventory snapshot query", () => {
  it("LATERAL + ORDER BY snapshot_at DESC LIMIT 1 per ASIN (idx_inventory_latest), not DISTINCT ON over every snapshot", () => {
    expect(LATEST_INVENTORY_SQL).toMatch(/CROSS JOIN LATERAL \(/);
    expect(LATEST_INVENTORY_SQL).toMatch(/WHERE s\.asin_id = a\.id\s+ORDER BY s\.snapshot_at DESC\s+LIMIT 1/);
    expect(LATEST_INVENTORY_SQL).not.toMatch(/DISTINCT ON/);
    expect(LATEST_INVENTORY_SQL).not.toMatch(/\bDELETE\b/);
  });
  it("the list handler uses it", async () => {
    const { readFileSync } = await import("fs");
    const src = readFileSync(new URL("./routes.ts", import.meta.url), "utf8");
    expect(src).toMatch(/const invResult = await query\(subset \? `\$\{LATEST_INVENTORY_SQL\} WHERE a\.asin = ANY\(\$1::text\[\]\)` : LATEST_INVENTORY_SQL, withSubset\(\[\]\)\)/);
    expect(src).not.toMatch(/SELECT DISTINCT ON \(i\.asin_id\)\s+a\.asin, i\.available_fba/);
  });
});

describe("ASINs list ?asins= row refresh", () => {
  it("each per-ASIN query takes the subset filter; tags are ordered so a row compares the same either way", async () => {
    const { readFileSync } = await import("fs");
    const src = readFileSync(new URL("./routes.ts", import.meta.url), "utf8");
    const h = src.slice(src.indexOf("async function listAsinsHandler"), src.indexOf("res.json(asinResults)"));
    expect(h).toMatch(/\.slice\(0, 500\)/);
    expect(h).toMatch(/WHERE \$\{activeFilter\}\$\{onlyA\(1\)\}/);
    expect(h).toMatch(/loadAsinPipeline\(\(sql, params\) => query\(sql, params\), subset \?\? undefined\)/);
    expect((h.match(/\$\{onlyA\(\d\)\}/g) ?? []).length).toBe(6); // main, sales, days in stock, deltas, SKUs, tags
    expect(h).toMatch(/\$\{subset \? "WHERE asin = ANY\(\$1::text\[\]\)" : ""\}/); // submissions
    expect(h).toMatch(/ORDER BY a\.asin, t\.name/);
  });
});
