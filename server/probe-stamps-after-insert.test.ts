import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// §14 (2026-10-09): the gating / hazmat probe stamps are written BY THE SINK,
// alongside the row, never before it exists.
//
// The bug: `UPDATE asins SET gating_checked_at = NOW() WHERE asin = $1` ran
// from inside the per-ASIN probe loop, which executes BEFORE writeResult's
// sink INSERTs a brand-new ASIN. The UPDATE therefore matched ZERO rows, and
// `.catch(() => {})` hid it. First-ever Product Info run on a new ASIN: probe
// succeeds, outcome says `updated`, stamp stays NULL. Found on B0INVALID9,
// which carried eligibility_status = 'no' with both stamps NULL.
//
// Same ordering class as the CSV-tags race (456b238): a write sequenced ahead
// of the INSERT it depends on, against a statement that fails SILENTLY when
// the row is missing. upsertTagsForAsin no-opped; an UPDATE matches nothing.
// Hence the zero-row guard below — moving the write is only half the fix, the
// other half is refusing to call a zero-row UPDATE a success.

// ── in-memory asins table ───────────────────────────────────────────────────
type Row = { asin: string; gating_checked_at: string | null; hazmat_checked_at: string | null };
let table: Row[] = [];
let sql: string[] = [];

vi.mock("./index", () => ({ log: () => {} }));
vi.mock("./db", () => ({
  isDbAvailable: () => true,
  pool: {},
  default: { query: async () => ({ rows: [], rowCount: 0 }) },
  query: async (text: string, values?: any[]) => {
    sql.push(text);
    const asin = String(values?.[0] ?? "");

    if (/^INSERT INTO asins /.test(text.trim())) {
      const existing = table.find((r) => r.asin === asin);
      if (existing) return { rows: [{ inserted: false }], rowCount: 1 };
      table.push({ asin, gating_checked_at: null, hazmat_checked_at: null });
      return { rows: [{ inserted: true }], rowCount: 1 };
    }
    // The statement under test. Mirrors postgres: an UPDATE whose WHERE
    // matches nothing is a successful statement with rowCount 0.
    if (/^UPDATE asins SET .*_checked_at/.test(text.trim())) {
      const row = table.find((r) => r.asin === asin);
      if (!row) return { rows: [], rowCount: 0 };
      if (/gating_checked_at = NOW\(\)/.test(text)) row.gating_checked_at = "2026-10-09T00:00:00Z";
      if (/hazmat_checked_at = NOW\(\)/.test(text)) row.hazmat_checked_at = "2026-10-09T00:00:00Z";
      return { rows: [], rowCount: 1 };
    }
    if (/SELECT id FROM asins/.test(text)) {
      return { rows: table.some((r) => r.asin === asin) ? [{ id: `id-${asin}` }] : [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  },
}));

import { mainCatalogSink } from "./routes";

const NEW_ASIN = "B0NEWASIN1";

const result: any = {
  asin: NEW_ASIN,
  cogs: 0,
  pricingData: {
    lowestFbaPrice: null, buyBoxPrice: null, buyBoxFulfillment: null, lowestPrice: null,
    avg30DayPrice: null, avg90DayPrice: null, numberOfSellers: null, sellersFba: null, sellersFbm: null,
  },
  feesData: { fbaFulfillmentFee: null, referralFee: null, feesEstimatePrice: null },
  catalogData: { weightLbs: null, title: null, brand: null, imageUrl: null, bsrRank: null, bsrCategory: null },
  eligibilityData: { status: "yes" },
};

beforeEach(() => {
  table = [];
  sql = [];
});

// ============================================================================
// The headline case: a brand-new ASIN's first Product Info run
// ============================================================================
describe("first Product Info run on a brand-new ASIN", () => {
  it("lands BOTH stamps — the row is inserted first, so the UPDATE matches it", async () => {
    expect(table).toHaveLength(0); // the ASIN does not exist yet

    // writeResult's order: persistResult (which INSERTs), THEN the stamps.
    await mainCatalogSink.persistResult(result, {
      fromCsvUpload: false, inputNotes: null, inputPromoNotes: null,
    });
    await mainCatalogSink.persistProbeStamps(NEW_ASIN, { gating: true, hazmat: true });

    const row = table.find((r) => r.asin === NEW_ASIN)!;
    expect(row).toBeDefined();
    expect(row.gating_checked_at).not.toBeNull();
    expect(row.hazmat_checked_at).not.toBeNull();
  });

  it("the OLD order now REJECTS instead of silently doing nothing", async () => {
    // Stamping before the INSERT is precisely the shipped bug. It used to be
    // swallowed; it is now a rejection the caller turns into an error outcome.
    await expect(
      mainCatalogSink.persistProbeStamps(NEW_ASIN, { gating: true, hazmat: true }),
    ).rejects.toThrow(/no asins row for B0NEWASIN1/);
    expect(table).toHaveLength(0);
  });
});

// ============================================================================
// The write itself
// ============================================================================
describe("persistProbeStamps", () => {
  beforeEach(() => {
    table = [{ asin: NEW_ASIN, gating_checked_at: null, hazmat_checked_at: null }];
  });

  it("writes both stamps in ONE statement when both probes succeeded", async () => {
    await mainCatalogSink.persistProbeStamps(NEW_ASIN, { gating: true, hazmat: true });
    const updates = sql.filter((t) => /UPDATE asins SET/.test(t));
    expect(updates).toHaveLength(1);
    expect(updates[0]).toContain("gating_checked_at = NOW()");
    expect(updates[0]).toContain("hazmat_checked_at = NOW()");
  });

  for (const [probe, mine, theirs] of [
    ["gating", "gating_checked_at", "hazmat_checked_at"],
    ["hazmat", "hazmat_checked_at", "gating_checked_at"],
  ] as const) {
    it(`${probe} alone: touches ${mine} and leaves ${theirs} entirely alone`, async () => {
      await mainCatalogSink.persistProbeStamps(NEW_ASIN, {
        gating: probe === "gating", hazmat: probe === "hazmat",
      });
      const row = table[0] as any;
      expect(row[mine]).not.toBeNull();
      // Not "set to NULL" — absent from the SET list. A failed probe's stamp
      // keeps whatever it had (§11); a NULL-valued SET would erase it.
      expect(row[theirs]).toBeNull();
      expect(sql.filter((t) => /UPDATE asins SET/.test(t))[0]).not.toContain(theirs);
    });
  }

  it("writes nothing at all when neither probe succeeded", async () => {
    await mainCatalogSink.persistProbeStamps(NEW_ASIN, { gating: false, hazmat: false });
    expect(sql.filter((t) => /UPDATE asins SET/.test(t))).toHaveLength(0);
  });

  it("rejects with the ASIN and the stamps named, so the error outcome is diagnosable", async () => {
    table = [];
    await expect(
      mainCatalogSink.persistProbeStamps(NEW_ASIN, { gating: true, hazmat: false }),
    ).rejects.toThrow(/B0NEWASIN1.*gating_checked_at = NOW\(\)/);
  });
});

// ============================================================================
// Structure: the write cannot drift back ahead of the INSERT
// ============================================================================
describe("the stamp write stays behind the INSERT", () => {
  const src = () => readFileSync(join(__dirname, "routes.ts"), "utf8");
  const productInfoRegion = () => {
    const s = src();
    const a = s.indexOf("const feesMap = await fetchFeesBatch(feeItems);");
    const b = s.indexOf("function runPostAnalyzeBackgroundSyncs");
    return s.slice(a, b);
  };
  const writeResultBody = () => {
    const s = src();
    const a = s.indexOf("async function writeResult(");
    return s.slice(a, s.indexOf("\nasync function runSheetsSync", a));
  };

  it("no stamp UPDATE survives in the Product Info probe region", () => {
    // The probe loop may only RECORD that a stamp was earned.
    expect(productInfoRegion()).not.toMatch(/UPDATE asins SET \w+_checked_at/);
  });

  it("writeResult calls persistProbeStamps AFTER awaiting persistResult", () => {
    const b = writeResultBody();
    const insertIdx = b.indexOf("await sink.persistResult(");
    const stampIdx = b.indexOf("await sink.persistProbeStamps(");
    expect(insertIdx).toBeGreaterThan(-1);
    expect(stampIdx).toBeGreaterThan(insertIdx);
  });

  it("the stamp write is not swallowed — no empty catch anywhere near it", () => {
    const b = writeResultBody();
    const i = b.indexOf("await sink.persistProbeStamps(");
    const around = b.slice(i - 200, i + 400);
    expect(around).not.toMatch(/\.catch\(\(\) => \{\}\)/);
    // It reports instead.
    expect(around).toMatch(/stamps\.onError\(/);
  });

  it("the sink refuses a zero-row match rather than reporting success", () => {
    const s = src();
    const i = s.indexOf("async persistProbeStamps(");
    const body = s.slice(i, i + 1400);
    expect(body).toMatch(/rowCount === 0/);
    expect(body).toMatch(/throw new Error\(/);
  });

  it("a failed stamp demotes that stage's outcome from updated to error", () => {
    const r = productInfoRegion();
    const i = r.indexOf("onError: (msg: string) => {");
    expect(i).toBeGreaterThan(-1);
    const body = r.slice(i, i + 600);
    expect(body).toMatch(/stageCounts\[stage\]\.updated--/);
    expect(body).toMatch(/stageCounts\[stage\]\.error\+\+/);
    expect(body).toMatch(/stageOutcomes\[stage\]\[asin\] = `error: stamp write failed/);
  });

  it("every Product Info writeResult call site passes the ASIN's stamps; the onboarding insert passes none (it probes nothing)", () => {
    const r = src();
    const calls = r.match(/await writeResult\([\s\S]{0,400}?\);/g) ?? [];
    expect(calls.length).toBe(6);
    const onboarding = calls.filter((c) => /input\.leadSource \?\? null, true\)/.test(c)); // insertOnly = true
    expect(onboarding).toHaveLength(1);
    expect(onboarding[0]).toMatch(/, null, input\.leadSource/); // no stamps: no probe ran
    for (const c of calls) if (!onboarding.includes(c)) expect(c).toMatch(/stampsFor\((input|item\.input)\.asin\)/);
  });
});
