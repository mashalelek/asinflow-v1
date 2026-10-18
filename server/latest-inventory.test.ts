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
    expect(src).toMatch(/const invResult = await query\(LATEST_INVENTORY_SQL\)/);
    expect(src).not.toMatch(/SELECT DISTINCT ON \(i\.asin_id\)\s+a\.asin, i\.available_fba/);
  });
});
