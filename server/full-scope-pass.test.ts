import { describe, it, expect } from "vitest";
import { runFullScopePass } from "./full-scope-pass";

// Fake wiring: query router over canned phase-a/phase-b rows + write capture;
// httpGet keyed by endpoint (getListingsItem per SKU / searchListingsItems).
function makeHarness(cfg: {
  phaseA?: any[];
  phaseB?: any[];
  skuState?: Record<string, { present: boolean; issues?: any[] } | "transient">;
  searchItems?: Record<string, any[] | "transient">;
}) {
  const writes: Array<{ sql: string; params: any[] }> = [];
  const query = async (sql: string, params?: any[]) => {
    if (/JOIN asin_skus s ON s.asin_id = a.id/.test(sql) && /json_agg/.test(sql)) {
      return { rows: cfg.phaseA ?? [], rowCount: null };
    }
    if (/NOT EXISTS \(SELECT 1 FROM asin_skus/.test(sql)) {
      return { rows: cfg.phaseB ?? [], rowCount: null };
    }
    writes.push({ sql, params: params ?? [] });
    return { rows: [], rowCount: 1 };
  };
  const httpGet = async (endpoint: string, params?: any) => {
    if (params?.identifiersType === "ASIN") {
      const items = cfg.searchItems?.[params.identifiers];
      if (items === "transient") { const e: any = new Error("503"); e.response = { status: 503 }; throw e; }
      return { items: items ?? [] };
    }
    const sku = decodeURIComponent(endpoint.split("/").pop()!);
    const st = cfg.skuState?.[sku];
    if (st === "transient") { const e: any = new Error("429"); e.response = { status: 429 }; throw e; }
    if (!st || !st.present) { const e: any = new Error("404"); e.response = { status: 404 }; throw e; }
    return { summaries: [{ status: ["DISCOVERABLE"] }], issues: st.issues ?? [] };
  };
  return { writes, query, httpGet };
}

const aRow = (asin: string, primary: string | null, hasLive: boolean | null, skus: Array<[string, string]>) => ({
  asin, id: `id-${asin}`, primary_sku: primary, has_live_offer: hasLive,
  skus: skus.map(([sku, created_at]) => ({ sku, created_at })),
});

const base = { sellerId: "SELLER", pacingMs: 0, nowMs: () => 0 };

describe("full-scope pass — phase a + 8c", () => {
  it("8c: primary re-points to the NEWEST live SKU, demoting an older still-live primary", async () => {
    const h = makeHarness({
      phaseA: [aRow("B0A", "OLD-SKU", true, [["NEW-SKU", "2026-08-01"], ["OLD-SKU", "2026-01-01"]])],
      skuState: { "NEW-SKU": { present: true }, "OLD-SKU": { present: true } },
    });
    const r = await runFullScopePass({ ...base, dryRun: false, query: h.query as any, httpGet: h.httpGet as any });
    expect(r.phaseA.repoints).toEqual([{ asin: "B0A", from: "OLD-SKU", to: "NEW-SKU" }]);
    const repointWrite = h.writes.find((w) => /SET primary_sku/.test(w.sql))!;
    expect(repointWrite.params).toEqual(["B0A", "NEW-SKU"]);
    expect(repointWrite.sql).toMatch(/is_primary = \(s\.sku = \$2\)/); // atomic CTE
  });

  it("8c: NO live SKU → primary untouched (never re-pointed to a dead SKU, never nulled)", async () => {
    const h = makeHarness({
      phaseA: [aRow("B0B", "DEAD-SKU", true, [["DEAD-SKU", "2026-01-01"], ["OTHER", "2026-02-01"]])],
      skuState: {}, // all 404
    });
    const r = await runFullScopePass({ ...base, dryRun: false, query: h.query as any, httpGet: h.httpGet as any });
    expect(r.phaseA.repoints).toEqual([]);
    expect(r.phaseA.flips).toEqual([{ asin: "B0B", from: true, to: false }]);
    expect(h.writes.some((w) => /SET primary_sku/.test(w.sql))).toBe(false);
    // has_live_offer flip + empty snapshot still written
    const upd = h.writes.find((w) => /SET has_live_offer/.test(w.sql))!;
    // 4th param is has_buyable_offer (§23, 2026-09-15) — no live SKU means
    // no BUYABLE offer either, written in the SAME statement so the two
    // flags can never disagree about one probe.
    expect(upd.params).toEqual(["B0B", false, "[]", false]);
    expect(upd.sql).toMatch(/has_buyable_offer/);
  });

  it("probes EVERY SKU (no first-live short-circuit)", async () => {
    let calls = 0;
    const h = makeHarness({
      phaseA: [aRow("B0C", "S1", true, [["S1", "2026-03-01"], ["S2", "2026-01-01"], ["S3", "2026-02-01"]])],
      skuState: { S1: { present: true }, S2: { present: true }, S3: { present: true } },
    });
    const countingGet = async (e: string, p?: any) => { calls++; return h.httpGet(e, p); };
    const r = await runFullScopePass({ ...base, dryRun: false, query: h.query as any, httpGet: countingGet as any });
    expect(calls).toBe(3);
    expect(r.phaseA.skusProbed).toBe(3);
  });

  it("fail-closed: one transient SKU probe skips the WHOLE ASIN (no writes, no flip, no re-point)", async () => {
    const h = makeHarness({
      phaseA: [aRow("B0D", "S1", false, [["S1", "2026-01-01"], ["S2", "2026-02-01"]])],
      skuState: { S1: { present: true }, S2: "transient" },
    });
    const r = await runFullScopePass({ ...base, dryRun: false, query: h.query as any, httpGet: h.httpGet as any });
    expect(r.phaseA.transientSkipped).toBe(1);
    expect(r.phaseA.flips).toEqual([]);
    expect(h.writes).toHaveLength(0);
  });

  it("dry-run: identical report, ZERO writes", async () => {
    const h = makeHarness({
      phaseA: [aRow("B0E", "OLD", null, [["NEW", "2026-08-01"], ["OLD", "2026-01-01"]])],
      skuState: { NEW: { present: true, issues: [{ code: "18555", severity: "ERROR", message: "m" }] }, OLD: { present: true } },
    });
    const r = await runFullScopePass({ ...base, dryRun: true, query: h.query as any, httpGet: h.httpGet as any });
    expect(r.phaseA.flips).toEqual([{ asin: "B0E", from: null, to: true }]);
    expect(r.phaseA.repoints).toEqual([{ asin: "B0E", from: "OLD", to: "NEW" }]);
    expect(h.writes).toHaveLength(0);
  });
});

describe("full-scope pass — phase b discovery", () => {
  const bRow = (asin: string, primary: string | null = null, hasPrimaryRow = false) => ({
    asin, id: `id-${asin}`, primary_sku: primary, has_primary_row: hasPrimaryRow,
  });

  it("discovers SC-created SKUs, bootstraps primary only when none exists", async () => {
    const h = makeHarness({
      phaseB: [bRow("B0F")],
      searchItems: { B0F: [{ sku: "SC-SKU-1", summaries: [{ status: ["BUYABLE"] }], issues: [] }] },
    });
    const r = await runFullScopePass({ ...base, dryRun: false, query: h.query as any, httpGet: h.httpGet as any });
    expect(r.phaseB.discovered).toEqual([{ asin: "B0F", skus: ["SC-SKU-1"], live: true }]);
    const ins = h.writes.find((w) => /INSERT INTO asin_skus/.test(w.sql))!;
    expect(ins.params).toEqual(["id-B0F", "SC-SKU-1", true]); // bootstrap primary
    const upd = h.writes.find((w) => /SET has_live_offer/.test(w.sql))!;
    expect(upd.sql).toMatch(/primary_sku = \$4/);
  });

  it("stale primary_sku value blocks the bootstrap (per §18: only when NONE exists)", async () => {
    const h = makeHarness({
      phaseB: [bRow("B0G", "STALE-SKU")],
      searchItems: { B0G: [{ sku: "SC-SKU-2", summaries: [{ status: [] }], issues: [] }] },
    });
    await runFullScopePass({ ...base, dryRun: false, query: h.query as any, httpGet: h.httpGet as any });
    const ins = h.writes.find((w) => /INSERT INTO asin_skus/.test(w.sql))!;
    expect(ins.params[2]).toBe(false); // no bootstrap
    const upd = h.writes.find((w) => /SET has_live_offer/.test(w.sql))!;
    expect(upd.sql).not.toMatch(/primary_sku/);
  });

  it("no listing found → counted, stays NULL, nothing written", async () => {
    const h = makeHarness({ phaseB: [bRow("B0H")], searchItems: {} });
    const r = await runFullScopePass({ ...base, dryRun: false, query: h.query as any, httpGet: h.httpGet as any });
    expect(r.phaseB.noListing).toBe(1);
    expect(h.writes).toHaveLength(0);
  });

  it("dry-run: discovery reported, zero writes", async () => {
    const h = makeHarness({
      phaseB: [bRow("B0I")],
      searchItems: { B0I: [{ sku: "SC-SKU-3", summaries: [{ status: ["DISCOVERABLE"] }], issues: [] }] },
    });
    const r = await runFullScopePass({ ...base, dryRun: true, query: h.query as any, httpGet: h.httpGet as any });
    expect(r.phaseB.discovered).toHaveLength(1);
    expect(h.writes).toHaveLength(0);
  });
});

describe("full-scope pass — 8c amzn.gr.* exclusion", () => {
  it("skips a newer live amzn.gr.* twin: primary stays on the live base SKU (no-op)", async () => {
    const h = makeHarness({
      phaseA: [aRow("B0J", "BASE-SKU", true, [
        ["amzn.gr.BASE-SKU-xyz", "2026-06-01"],
        ["BASE-SKU", "2026-01-01"],
      ])],
      skuState: { "amzn.gr.BASE-SKU-xyz": { present: true }, "BASE-SKU": { present: true } },
    });
    const r = await runFullScopePass({ ...base, dryRun: false, query: h.query as any, httpGet: h.httpGet as any });
    expect(r.phaseA.repoints).toEqual([]);
    expect(h.writes.some((w) => /SET primary_sku/.test(w.sql))).toBe(false);
  });

  it("re-points to the newest live NON-amzn.gr SKU even when an amzn.gr twin is newer still", async () => {
    const h = makeHarness({
      phaseA: [aRow("B0K", "OLD-SKU", true, [
        ["amzn.gr.NEW-SKU-abc", "2026-07-01"],
        ["NEW-SKU", "2026-05-01"],
        ["OLD-SKU", "2026-01-01"],
      ])],
      skuState: {
        "amzn.gr.NEW-SKU-abc": { present: true },
        "NEW-SKU": { present: true },
        "OLD-SKU": { present: true },
      },
    });
    const r = await runFullScopePass({ ...base, dryRun: false, query: h.query as any, httpGet: h.httpGet as any });
    expect(r.phaseA.repoints).toEqual([{ asin: "B0K", from: "OLD-SKU", to: "NEW-SKU" }]);
  });

  it("ONLY amzn.gr.* SKUs live → primary unchanged, has_live_offer still TRUE with the amzn.gr issues snapshot", async () => {
    const h = makeHarness({
      phaseA: [aRow("B0L", "DEAD-SKU", false, [
        ["amzn.gr.DEAD-SKU-q", "2026-06-01"],
        ["DEAD-SKU", "2026-01-01"],
      ])],
      skuState: { "amzn.gr.DEAD-SKU-q": { present: true, issues: [{ code: "100893", severity: "ERROR", message: "m" }] } },
    });
    const r = await runFullScopePass({ ...base, dryRun: false, query: h.query as any, httpGet: h.httpGet as any });
    expect(r.phaseA.repoints).toEqual([]);
    expect(r.phaseA.flips).toEqual([{ asin: "B0L", from: false, to: true }]);
    expect(h.writes.some((w) => /SET primary_sku/.test(w.sql))).toBe(false);
    const upd = h.writes.find((w) => /SET has_live_offer/.test(w.sql))!;
    expect(upd.params[1]).toBe(true);
    expect(upd.params[2]).toContain("100893");
  });
});

// §18 all-known-SKUs-404 → discovery before FALSE (2026-08-28). An ASIN whose
// known SKUs all definitively 404 gets a searchListingsItems probe before any
// FALSE verdict — SC-created SKUs are otherwise invisible (phase b is gated on
// zero asin_skus rows). Found live: B0CT61H23P / CQ-OMI0-SSZ7.
describe("full-scope phase a — all-404 discovery", () => {
  const discItem = (sku: string, createdDate: string) =>
    ({ sku, summaries: [{ status: ["DISCOVERABLE"], createdDate }], issues: [] });

  it("all-404 + discovery hit → TRUE, asin_skus insert, 8c re-point to discovered SKU, counted as discovery", async () => {
    const h = makeHarness({
      phaseA: [aRow("B0DISC", "DEAD-SKU", false, [["DEAD-SKU", "2026-01-01"]])],
      skuState: {}, // DEAD-SKU 404s
      searchItems: { B0DISC: [discItem("SC-NEW-SKU", "2026-08-26")] },
    });
    const r = await runFullScopePass({ ...base, dryRun: false, query: h.query as any, httpGet: h.httpGet as any });
    expect(r.phaseA.discoveries).toEqual([{ asin: "B0DISC", skus: ["SC-NEW-SKU"], live: true }]);
    expect(r.phaseA.live).toBe(1);
    expect(r.phaseA.noOffer).toBe(0);
    expect(r.phaseA.flips).toEqual([{ asin: "B0DISC", from: false, to: true }]);
    expect(r.phaseA.repoints).toEqual([{ asin: "B0DISC", from: "DEAD-SKU", to: "SC-NEW-SKU" }]);
    expect(h.writes.some((w) => /INSERT INTO asin_skus/.test(w.sql) && w.params.includes("SC-NEW-SKU"))).toBe(true);
    expect(h.writes.some((w) => /SET primary_sku = \$2/.test(w.sql) && w.params[1] === "SC-NEW-SKU")).toBe(true);
    const flagWrite = h.writes.find((w) => /SET has_live_offer = TRUE/.test(w.sql))!;
    expect(flagWrite.params[0]).toBe("B0DISC");
  });

  it("all-404 + discovery empty → FALSE exactly as before, zero discoveries", async () => {
    const h = makeHarness({
      phaseA: [aRow("B0DEAD", "DEAD-SKU", false, [["DEAD-SKU", "2026-01-01"]])],
      skuState: {},
      searchItems: { B0DEAD: [] },
    });
    const r = await runFullScopePass({ ...base, dryRun: false, query: h.query as any, httpGet: h.httpGet as any });
    expect(r.phaseA.discoveries).toEqual([]);
    expect(r.phaseA.noOffer).toBe(1);
    const w = h.writes.find((x) => /SET has_live_offer = \$2/.test(x.sql))!;
    expect(w.params[1]).toBe(false);
  });

  it("all-404 + discovery transient → whole ASIN skipped, nothing written (fail-closed)", async () => {
    const h = makeHarness({
      phaseA: [aRow("B0TRAN", "DEAD-SKU", false, [["DEAD-SKU", "2026-01-01"]])],
      skuState: {},
      searchItems: { B0TRAN: "transient" },
    });
    const r = await runFullScopePass({ ...base, dryRun: false, query: h.query as any, httpGet: h.httpGet as any });
    expect(r.phaseA.transientSkipped).toBe(1);
    expect(r.phaseA.discoveries).toEqual([]);
    expect(h.writes.filter((w) => /UPDATE asins|INSERT INTO asin_skus/.test(w.sql))).toEqual([]);
  });

  it("amzn.gr.*-only discovery → TRUE + insert, but primary NEVER re-points to amzn.gr", async () => {
    const h = makeHarness({
      phaseA: [aRow("B0GR", "DEAD-SKU", false, [["DEAD-SKU", "2026-01-01"]])],
      skuState: {},
      searchItems: { B0GR: [discItem("amzn.gr.SOMETHING", "2026-08-26")] },
    });
    const r = await runFullScopePass({ ...base, dryRun: false, query: h.query as any, httpGet: h.httpGet as any });
    expect(r.phaseA.discoveries).toEqual([{ asin: "B0GR", skus: ["amzn.gr.SOMETHING"], live: true }]);
    expect(r.phaseA.repoints).toEqual([]);
    expect(h.writes.some((w) => /INSERT INTO asin_skus/.test(w.sql) && w.params.includes("amzn.gr.SOMETHING"))).toBe(true);
    expect(h.writes.some((w) => /SET primary_sku/.test(w.sql))).toBe(false);
    expect(h.writes.some((w) => /SET has_live_offer = TRUE/.test(w.sql))).toBe(true);
  });

  it("dry-run: discovery reported (discoveries/flips/repoints) with ZERO writes", async () => {
    const h = makeHarness({
      phaseA: [aRow("B0DRY", "DEAD-SKU", false, [["DEAD-SKU", "2026-01-01"]])],
      skuState: {},
      searchItems: { B0DRY: [discItem("SC-NEW-SKU", "2026-08-26")] },
    });
    const r = await runFullScopePass({ ...base, dryRun: true, query: h.query as any, httpGet: h.httpGet as any });
    expect(r.phaseA.discoveries).toHaveLength(1);
    expect(r.phaseA.repoints).toEqual([{ asin: "B0DRY", from: "DEAD-SKU", to: "SC-NEW-SKU" }]);
    expect(h.writes.filter((w) => /UPDATE|INSERT/.test(w.sql))).toEqual([]);
  });
});
