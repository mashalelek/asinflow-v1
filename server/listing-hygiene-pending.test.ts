// skip_action_pending counts ANY recent accepted action on the SKU — close or
// delete (2026-10-20). CS-ZH3X-SXV9's DELETE read back open (end_at null) for
// ~5½ min before the 404; a close pass in that window must skip it.
import { describe, it, expect } from "vitest";
import { loadSkuFacts, evaluateClose, PENDING_ACTION_MS, pendingHolds, type HoldGroup } from "./listing-hygiene";
import { dbRow, PASS } from "./listing-hygiene.test-fixtures";

const NOW = new Date("2026-10-19T14:00:00Z");

/**
 * A fake asin_skus query that EVALUATES action_pending the way the SQL says:
 * accepted rows for the SKU fired after the window start — and, only if the
 * SQL filters on la.action, of the queried action. So the test reads the real
 * query's semantics, not a hard-coded flag.
 */
function fakeDb(actions: Array<{ sku: string; action: "close" | "delete"; status: string; fired_at: Date }>) {
  let seenSql = "";
  let seenParams: any[] = [];
  const query = async (sql: string, params?: any[]) => {
    seenSql = sql; seenParams = params ?? [];
    const since = new Date(params![params!.length - 1]);
    const actionFilter = /la\.action\s*=\s*\$(\d+)/.exec(sql);
    const wanted = actionFilter ? params![Number(actionFilter[1]) - 1] : null;
    const rows = [dbRow("ZV-TEST-001")].map((r) => ({
      ...r,
      action_pending: actions.some((a) => a.sku === r.sku && a.status === "accepted" && a.fired_at > since && (wanted == null || a.action === wanted)),
    }));
    return { rows, rowCount: rows.length };
  };
  return { query, sql: () => seenSql, params: () => seenParams };
}
const basis = { now: NOW, inventoryFrom: PASS, listingFrom: PASS };

describe("skip_action_pending across action kinds", () => {
  it("an accepted DELETE within the window → the close candidate is skipped as skip_action_pending", async () => {
    const db = fakeDb([{ sku: "ZV-TEST-001", action: "delete", status: "accepted", fired_at: new Date(NOW.getTime() - 6 * 60_000) }]);
    const [f] = await loadSkuFacts(db.query as any, { asins: ["B000000001"] }, "close", NOW);
    expect(f.actionPending).toBe(true);
    expect(evaluateClose(f, basis).outcome).toBe("skip_action_pending");
  });

  it("outside the window, or not accepted, it does not count", async () => {
    const old = fakeDb([{ sku: "ZV-TEST-001", action: "delete", status: "accepted", fired_at: new Date(NOW.getTime() - PENDING_ACTION_MS - 60_000) }]);
    expect(evaluateClose((await loadSkuFacts(old.query as any, { asins: ["B000000001"] }, "close", NOW))[0], basis).outcome).toBe("would_close");
    const inv = fakeDb([{ sku: "ZV-TEST-001", action: "delete", status: "invalid", fired_at: new Date(NOW.getTime() - 60_000) }]);
    expect(evaluateClose((await loadSkuFacts(inv.query as any, { asins: ["B000000001"] }, "close", NOW))[0], basis).outcome).toBe("would_close");
  });

  it("the query filters on SKU, status and time — not on the action kind", async () => {
    const db = fakeDb([]);
    await loadSkuFacts(db.query as any, { asins: ["B000000001"] }, "delete", NOW);
    expect(db.sql()).not.toMatch(/la\.action\s*=/);
    expect(db.sql()).toMatch(/la\.sku = s\.sku AND la\.status = 'accepted'/);
    expect(db.params()).toHaveLength(2);
  });
});

// ── "Action required": the pending hold per action (Maria 2026-10-21) ──────
const grp = (job_id: number, action: "close" | "delete", total: number, open: number, released = false): HoldGroup =>
  ({ job_id, action, total, open, released, held_at: `2026-10-${String(job_id % 28 + 1).padStart(2, "0")}T05:42:49.000Z` });

describe("pendingHolds — the Action-required indicator's source", () => {
  it("shows with an unreleased hold", () => {
    expect(pendingHolds([grp(123, "delete", 162, 162)])).toEqual({ close: null, delete: { job_id: 123, action: "delete", count: 162, held_at: grp(123, "delete", 1, 1).held_at } });
  });
  it("clears after release — a release job exists, or every held row carries its release result", () => {
    expect(pendingHolds([grp(123, "delete", 162, 162, true)]).delete).toBeNull();
    expect(pendingHolds([grp(123, "delete", 162, 0)]).delete).toBeNull();
  });
  it("a newer night's hold supersedes the older one, and a released newer hold never resurfaces the older", () => {
    expect(pendingHolds([grp(123, "delete", 162, 162), grp(140, "delete", 30, 30)]).delete).toMatchObject({ job_id: 140, count: 30 });
    expect(pendingHolds([grp(123, "delete", 162, 162), grp(140, "delete", 30, 30, true)]).delete).toBeNull();
  });
  it("one pending hold per action, independently", () => {
    const p = pendingHolds([grp(140, "close", 60, 60), grp(123, "delete", 162, 162, true)]);
    expect(p.close).toMatchObject({ job_id: 140, count: 60 });
    expect(p.delete).toBeNull();
  });
});
