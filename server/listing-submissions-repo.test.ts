import { describe, it, expect } from "vitest";
import { resolveSubmissionsBulk, dismissFlags, verifyPending, findRecentPendingIds, countOpenAmong } from "./listing-submissions-repo";

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

// §19 auto verify after submit — the id-scoping contract. The sweep body
// (probe → classify → write) is exercised against real batches; these pin
// the SELECT shape: scoped runs filter to the batch's ids, unscoped runs
// stay the full-sweep query, helpers never query on empty input.
function captureQuery(rows: any[] = []) {
  const calls: Array<{ sql: string; params?: any[] }> = [];
  const query = async (sql: string, params?: any[]) => {
    calls.push({ sql, params });
    return { rows, rowCount: rows.length };
  };
  return { calls, query };
}

describe("verifyPending id scoping (§19 auto verify after submit)", () => {
  it("unscoped: full-sweep query, no id filter, no params", async () => {
    const { calls, query } = captureQuery([]);
    const s = await verifyPending("SELLER", { query: query as any });
    expect(s.checked).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).not.toContain("id = ANY");
    expect(calls[0].params).toBeUndefined();
  });

  it("scoped: id = ANY filter with the batch ids as $1", async () => {
    const ids = ["11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222"];
    const { calls, query } = captureQuery([]);
    await verifyPending("SELLER", { query: query as any, ids });
    expect(calls[0].sql).toContain("AND id = ANY($1::uuid[])");
    // Status filter is still present — resolved ids fall out of a scoped re-run.
    expect(calls[0].sql).toContain("verify_status IN ('pending','processing','stale')");
    expect(calls[0].params).toEqual([ids]);
  });

  it("empty ids array behaves as unscoped (defensive)", async () => {
    const { calls, query } = captureQuery([]);
    await verifyPending("SELLER", { query: query as any, ids: [] });
    expect(calls[0].sql).not.toContain("id = ANY");
  });
});

describe("findRecentPendingIds", () => {
  it("newest pending row per (asin, sku) pair via parallel unnest params", async () => {
    const { calls, query } = captureQuery([{ id: "aaa" }, { id: "bbb" }]);
    const ids = await findRecentPendingIds(
      [{ asin: "B000000001", sku: "SKU-1" }, { asin: "B000000002", sku: "SKU-2" }],
      query as any,
    );
    expect(ids).toEqual(["aaa", "bbb"]);
    expect(calls[0].sql).toContain("DISTINCT ON (asin, sku)");
    expect(calls[0].sql).toContain("verify_status = 'pending'");
    expect(calls[0].params).toEqual([["B000000001", "B000000002"], ["SKU-1", "SKU-2"]]);
  });

  it("no pairs → no query", async () => {
    const { calls, query } = captureQuery();
    expect(await findRecentPendingIds([], query as any)).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe("countOpenAmong", () => {
  it("counts non-terminal rows within the id set", async () => {
    const { calls, query } = captureQuery([{ n: 3 }]);
    expect(await countOpenAmong(["x"], query as any)).toBe(3);
    expect(calls[0].sql).toContain("verify_status IN ('pending','processing','stale')");
    expect(calls[0].params).toEqual([["x"]]);
  });

  it("empty ids → 0 without a query", async () => {
    const { calls, query } = captureQuery();
    expect(await countOpenAmong([], query as any)).toBe(0);
    expect(calls).toHaveLength(0);
  });
});
