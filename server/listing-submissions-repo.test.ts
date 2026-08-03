import { describe, it, expect } from "vitest";
import { resolveSubmissionsBulk, dismissFlags } from "./listing-submissions-repo";

// Minimal fake query router: SELECT of a row by id → configurable status;
// UPDATEs are recorded. Mirrors the QueryLike surface the repo uses.
function makeFakeQuery(statusById: Record<string, string>) {
  const updates: Array<{ sql: string; params: any[] }> = [];
  const query = async (sql: string, params?: any[]) => {
    if (/SELECT asin, sku, verify_status FROM listing_submissions/.test(sql)) {
      const id = params?.[0];
      const st = statusById[id];
      return st
        ? { rows: [{ asin: "B000TEST01", sku: "TST-SKU-001", verify_status: st }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    updates.push({ sql, params: params ?? [] });
    if (/UPDATE listing_submissions\s+SET flags_acknowledged_at/.test(sql)) {
      // Terminal-only guard emulation: return ids whose status is terminal.
      const ids: string[] = params?.[0] ?? [];
      const TERMINAL = new Set(["live", "failed", "deleted"]);
      return { rows: ids.filter((id) => TERMINAL.has(statusById[id])).map((id) => ({ id })), rowCount: 0 };
    }
    return { rows: [], rowCount: 1 };
  };
  return { query, updates };
}

describe("resolveSubmissionsBulk — §19 batch semantics", () => {
  it("applies the single-row semantics per id; already-terminal rows are skipped with the reason, never a batch failure", async () => {
    const { query } = makeFakeQuery({ a: "stale", b: "live", c: "pending" });
    const r = await resolveSubmissionsBulk(["a", "b", "c"], "failed", query as any);
    expect(r.resolved.sort()).toEqual(["a", "c"]);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0].id).toBe("b");
    expect(r.skipped[0].reason).toMatch(/already resolved \(live\)/);
  });

  it("unknown ids are skipped with a not-found reason", async () => {
    const { query } = makeFakeQuery({});
    const r = await resolveSubmissionsBulk(["nope"], "live", query as any);
    expect(r.resolved).toEqual([]);
    expect(r.skipped[0].reason).toMatch(/not found/);
  });

  it("deleted verdict still demotes is_primary per row (single-row semantics preserved)", async () => {
    const { query, updates } = makeFakeQuery({ a: "stale" });
    await resolveSubmissionsBulk(["a"], "deleted", query as any);
    expect(updates.some((u) => /SET is_primary = FALSE/.test(u.sql))).toBe(true);
  });
});

describe("dismissFlags — §19 acknowledge semantics", () => {
  it("dismisses terminal rows and reports non-terminal ids as skipped", async () => {
    const { query } = makeFakeQuery({ t1: "live", t2: "failed", n1: "stale" });
    const r = await dismissFlags(["t1", "t2", "n1"], query as any);
    expect(r.dismissed.sort()).toEqual(["t1", "t2"]);
    expect(r.skipped).toEqual(["n1"]);
  });

  it("empty input is a no-op (no query fired)", async () => {
    const { query, updates } = makeFakeQuery({});
    const r = await dismissFlags([], query as any);
    expect(r).toEqual({ dismissed: [], skipped: [] });
    expect(updates).toHaveLength(0);
  });

  it("the UPDATE sets flags_acknowledged_at and never touches issues/review_flags", async () => {
    const { query, updates } = makeFakeQuery({ t1: "live" });
    await dismissFlags(["t1"], query as any);
    const u = updates.find((x) => /flags_acknowledged_at/.test(x.sql))!;
    expect(u.sql).toMatch(/SET flags_acknowledged_at = now\(\)/);
    expect(u.sql).not.toMatch(/issues|review_flags|terminal_conflict/);
    expect(u.sql).toMatch(/verify_status IN \('live','failed','deleted'\)/);
  });
});
