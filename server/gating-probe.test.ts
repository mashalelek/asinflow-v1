import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { probeGatingForAsins } from "./gating-probe";
import { submitOfferAddBatch } from "./offer-add-submit";
import type { QueryLike } from "./scheduler/types";

// Decision 9, confirmed by the 2026-10-16 gated-submit test: the Listings
// Restrictions probe is the only thing that says no, so the Add to SC
// preview runs it INLINE for its selection through the same writer component
// 8 uses. These tests pin the writer, the preview's use of it, and that a
// gated ASIN never reaches putListingsItem.

function fakeDb(prior: Record<string, string | null>, estimatesRows: Set<string>) {
  const sql: { text: string; params?: any[] }[] = [];
  const query: QueryLike = async (text, params) => {
    sql.push({ text, params });
    const t = text.replace(/\s+/g, " ").trim();
    if (t.startsWith("SELECT asin, eligibility_status FROM asin_estimates")) return { rows: Object.entries(prior).filter(([a]) => params![0].includes(a)).map(([asin, s]) => ({ asin, eligibility_status: s })), rowCount: 0 };
    if (t.startsWith("UPDATE asin_estimates SET eligibility_status")) return { rows: [], rowCount: estimatesRows.has(params![0]) ? 1 : 0 };
    if (t.startsWith("UPDATE asins SET gating_checked_at = NOW()")) return { rows: [], rowCount: 1 };
    throw new Error(`unexpected sql ${t.slice(0, 60)}`);
  };
  return { query, sql };
}
const probeOf = (answers: Record<string, any>) => (async (asin: string) => answers[asin] ?? { kind: "error", message: "no answer" }) as any;

describe("probeGatingForAsins (the one writer)", () => {
  it("writes status + stamp on a successful probe only, reports flips, keeps the stored value on error", async () => {
    const db = fakeDb({ A000000001: "yes", B000000002: "no", C000000003: "yes" }, new Set(["A000000001", "B000000002", "C000000003"]));
    const r = await probeGatingForAsins(["A000000001", "B000000002", "C000000003"], {
      query: db.query,
      probe: probeOf({ A000000001: { kind: "ok", status: "no" }, B000000002: { kind: "ok", status: "no" }, C000000003: { kind: "error", message: "throttled" } }),
    });
    expect(r.counts).toEqual({ updated: 2, yes: 0, no: 2, flips: 1, error: 1, missing_row: 0 });
    expect(r.outcomes).toEqual({ A000000001: "flip: yes -> no", C000000003: "error: throttled" });
    expect(r.flips).toEqual([{ asin: "A000000001", field: "gating", from: "ungated", to: "gated" }]);
    expect(r.statuses).toEqual({ A000000001: "no", B000000002: "no" });
    // C got NO write at all
    const writesForC = db.sql.filter((q) => q.text.startsWith("UPDATE") && q.params?.[0] === "C000000003");
    expect(writesForC).toHaveLength(0);
    // stamp follows the status write
    const forA = db.sql.filter((q) => q.params?.[0] === "A000000001").map((q) => q.text.slice(0, 40));
    expect(forA[0]).toMatch(/^UPDATE asin_estimates/);
    expect(forA[1]).toMatch(/^UPDATE asins SET gating_checked/);
  });

  it("a missing asin_estimates row is an error outcome and moves no stamp", async () => {
    const db = fakeDb({}, new Set());
    const r = await probeGatingForAsins(["N000000NEW"], { query: db.query, probe: probeOf({ N000000NEW: { kind: "ok", status: "yes" } }) });
    expect(r.counts.missing_row).toBe(1);
    expect(r.outcomes.N000000NEW).toBe("error: no asin_estimates row");
    expect(db.sql.some((q) => q.text.includes("gating_checked_at"))).toBe(false);
  });

  it("an empty selection probes nothing and queries nothing", async () => {
    const db = fakeDb({}, new Set());
    const r = await probeGatingForAsins([], { query: db.query, probe: probeOf({}) });
    expect(r.counts.updated).toBe(0);
    expect(db.sql).toHaveLength(0);
  });

  it("uses the caller's iteration when given (component 8 passes the runner's checkpointing loop)", async () => {
    const db = fakeDb({ A000000001: "yes" }, new Set(["A000000001"]));
    const seen: string[] = [];
    await probeGatingForAsins(["A000000001"], {
      query: db.query, probe: probeOf({ A000000001: { kind: "ok", status: "yes" } }),
      forEach: async (list, fn) => { for (const a of list) { seen.push(`iter:${a}`); await fn(a); } },
    });
    expect(seen).toEqual(["iter:A000000001"]);
  });
});

describe("component 8 delegates to the shared writer", () => {
  it("08-gating.ts holds no SQL of its own", () => {
    const s = readFileSync(join(__dirname, "scheduler", "components", "08-gating.ts"), "utf8");
    expect(s).toMatch(/probeGatingForAsins\(ctx\.asins/);
    expect(s).toMatch(/forEach: \(_asins, fn\) => forEachAsin\(ctx, fn\)/);
    expect(s).not.toMatch(/UPDATE asin_estimates|UPDATE asins|getEligibility/);
  });
});

describe("Add to SC preview: inline probe, no jobs row", () => {
  const routes = () => readFileSync(join(__dirname, "routes.ts"), "utf8");
  const preview = () => { const s = routes(); return s.slice(s.indexOf('app.post("/api/offer-add/preview"'), s.indexOf('app.post("/api/offer-add/submit"')); };

  it("probes inline BEFORE loading submit rows, and never enqueues a job", () => {
    const r = preview();
    const probe = r.indexOf("await probeGatingForAsins(");
    const rows = r.indexOf("await loadSubmitRows(asins)");
    expect(probe).toBeGreaterThan(-1);
    expect(rows).toBeGreaterThan(probe);
    expect(r).not.toMatch(/runJobAndWait|enqueueJob|components: \[8\]|isRunnerActive/);
    expect(routes()).not.toMatch(/components: \[8\]/); // the component-8-only enqueue path is gone
  });

  it("carries gating_checked_at to the excluded rows and the dialog says 'as of'", () => {
    expect(preview()).toMatch(/gatingCheckedAt: stampByAsin\.get\(e\.asin\)/);
    const dialog = readFileSync(join(__dirname, "..", "client", "src", "components", "offer-add-preview-dialog.tsx"), "utf8");
    expect(dialog).toMatch(/as of \{e\.gatingCheckedAt/);
  });

  it("a gated ASIN is excluded by the pre-filter and never reaches the orchestrator (so never putListingsItem)", async () => {
    const offerAddFn = vi.fn(async () => ({ kind: "preview" } as any));
    const fetchOffersFn = vi.fn(async () => ({ ok: true, allOffers: [], competitivePriceThreshold: null, buyBoxPrice: null } as any));
    const rows: any[] = [
      { asin: "B0DK7YJCFF", is_catalog_deleted: false, eligibility_status: "no", gating_checked_at: "2026-10-16T20:00:00.000Z", is_hazmat: false, cogs: 10, fbaFee: 3, referralFee: 2, feesEstimatePrice: 20, weightLbs: 1, category: null, prepCost: 0, storageCost: 0 },
    ];
    const r = await submitOfferAddBatch(rows, {
      queryFn: async () => ({ rows: [] }),
      sellerId: "S", settings: {} as any, includeInboundShipping: false, allExistingSkus: [],
      offerAddFn, fetchOffersFn, phase4Mode: "preview",
    } as any);
    expect(r.preFilter.excluded).toEqual([{ asin: "B0DK7YJCFF", reason: "gated" }]);
    expect(r.perAsin[0].outcome).toMatchObject({ kind: "skipped", reason: "gated" });
    expect(offerAddFn).not.toHaveBeenCalled();
    expect(fetchOffersFn).not.toHaveBeenCalled();
  });
});
