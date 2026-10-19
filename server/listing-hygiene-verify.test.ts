// Listing hygiene: component 16 verifies accepted actions on its next pass.
import { describe, it, expect } from "vitest";
import { verifyListingActions } from "./listing-hygiene";

function db(rows: any[]) {
  const updates: Array<{ sql: string; params: any[] }> = [];
  const query = async (sql: string, params?: any[]) => {
    if (sql.startsWith("SELECT la.id")) return { rows, rowCount: rows.length };
    updates.push({ sql, params: params ?? [] });
    return { rows: [], rowCount: 1 };
  };
  return { query, updates };
}
const past = new Date(Date.now() - 3600_000).toISOString();

describe("verifyListingActions", () => {
  it("close → verified when offer_end_at <= now; delete → verified when the listing is gone", async () => {
    const d = db([
      { id: 1, action: "close", verify_passes: 0, listing_created_at: past, offer_end_at: past },
      { id: 2, action: "delete", verify_passes: 0, listing_created_at: null, offer_end_at: null },
    ]);
    const r = await verifyListingActions(d.query, new Date());
    expect(r).toEqual({ verified: 2, pending: 0, not_effective: 0 });
    expect(d.updates.every((u) => /status = 'verified'/.test(u.sql))).toBe(true);
  });
  it("not effective: one pass counts, the second marks not_effective", async () => {
    const d = db([
      { id: 3, action: "close", verify_passes: 0, listing_created_at: past, offer_end_at: null },
      { id: 4, action: "delete", verify_passes: 1, listing_created_at: past, offer_end_at: past },
    ]);
    const r = await verifyListingActions(d.query, new Date());
    expect(r).toEqual({ verified: 0, pending: 1, not_effective: 1 });
    expect(d.updates.find((u) => u.params[0] === 4)!.sql).toMatch(/not_effective/);
  });
  it("only SKUs probed this pass and after the action count (the query says so)", async () => {
    let seen = "";
    await verifyListingActions(async (sql: string) => { seen = sql; return { rows: [], rowCount: 0 }; }, new Date());
    expect(seen).toMatch(/listing_checked_at >= \$1::timestamptz AND s\.listing_checked_at > la\.fired_at/);
    expect(seen).toMatch(/la\.status = 'accepted' AND la\.dry_run = FALSE/);
  });
});
