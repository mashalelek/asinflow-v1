import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// §11 Product Info probes EVERYTHING in its working set (2026-10-07).
//
// WHY SOURCE PINS: the four stages live inline inside registerRoutes'
// runAnalyzeCore closure, not in an extractable pure function, so there is no
// seam to call. These pins assert the RULES at their source — the same
// approach onboarding-guard.test.ts uses for the same reason. The behavioural
// proof is the live gate run (Product Info on a known-gated ASIN showing the
// outcome map and the status flip), which no unit test can substitute for.
//
// The incident: B00P0OYZ66 had gating_checked_at 2026-10-04 and
// eligibility_status 'yes'; Amazon had gated it (APPROVAL_REQUIRED). The
// 30-day rule meant no probe was ever allowed to replace the stale answer, so
// the padlock lied. Gating flipped in under 3 days — a shorter window would
// be the same bug, smaller.
const SRC = () => readFileSync(join(__dirname, "routes.ts"), "utf8");

/** The Product Info stage region: from the fees batch to the ledger write. */
function productInfoRegion(): string {
  const s = SRC();
  const start = s.indexOf("const feesMap = await fetchFeesBatch(feeItems);");
  const end = s.indexOf("function runPostAnalyzeBackgroundSyncs");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return s.slice(start, end);
}

describe("the 30-day gating/hazmat skip is GONE from Product Info", () => {
  // Scoped to the Product Info region ON PURPOSE. server/bulk-refresh.ts has
  // its own THIRTY_D/staleOrNever/gatingScope/hazmatScope for §21 Bulk Calc's
  // gating/hazmat LOOKUP CACHE, which has an explicit bustCache override and
  // is a different feature — not a sync button narrowing itself. Those hits
  // are expected and must NOT be deleted by a future sweep of this rule.
  const FORBIDDEN = ["THIRTY_D", "staleOrNever", "reused_stored", "would_probe", "gatingScope", "hazmatScope"];

  for (const token of FORBIDDEN) {
    it(`"${token}" does not appear in the Product Info region`, () => {
      expect(productInfoRegion()).not.toContain(token);
    });
  }

  it("neither probe is guarded by anything but dryRun", () => {
    const r = productInfoRegion();
    // The probes sit in one `if (!dryRun)` block. A freshness guard coming
    // back would have to add a condition here, which this catches.
    expect(r).toMatch(/if \(!dryRun\) \{[\s\S]*getEligibility\(input\.asin\)/);
    expect(r).toMatch(/if \(!dryRun\) \{[\s\S]*getInboundHazmat\(input\.asin\)/);
    expect(r).not.toMatch(/gating_checked_at[^\n]*>[^\n]*Date\.now/);
  });

  it("the stored value is a dry-run starting point, never a reuse-instead-of-probe branch", () => {
    const r = productInfoRegion();
    expect(r).toMatch(/stored\?\.eligibility_status/);          // still read
    // ...but no branch that SKIPS the probe because a stamp looked fresh.
    expect(r).not.toMatch(/else[\s\S]{0,120}reuse/i);
  });

  it("the probe stamps are still written on every probe", () => {
    const r = productInfoRegion();
    expect(r).toMatch(/UPDATE asins SET gating_checked_at = NOW\(\)/);
    expect(r).toMatch(/UPDATE asins SET hazmat_checked_at = NOW\(\)/);
  });
});

describe("per-ASIN outcomes for ALL FOUR stages", () => {
  it("declares one outcome map per stage, in the Prices & Stock shape", () => {
    const r = productInfoRegion();
    expect(r).toMatch(/stageOutcomes:\s*Record<"catalog" \| "fees" \| "gating" \| "hazmat", Record<string, string>>/);
  });

  for (const stage of ["catalog", "fees", "gating", "hazmat"] as const) {
    it(`${stage} writes a per-ASIN outcome`, () => {
      expect(productInfoRegion()).toMatch(new RegExp(`stageOutcomes\\.${stage}\\[input\\.asin\\]\\s*=`));
    });
  }

  it("the ledger write passes the stage's map — the '{}' literal is gone", () => {
    const r = productInfoRegion();
    expect(r).toMatch(/\$5::jsonb, \$6::jsonb/);
    expect(r).toMatch(/JSON\.stringify\(stageOutcomes\[stage as keyof typeof stageOutcomes\]/);
    expect(r).not.toContain("'{}'::jsonb");
  });

  it("fees' skipped_no_price is recorded per ASIN — the one surviving skip", () => {
    const r = productInfoRegion();
    expect(r).toMatch(/stageOutcomes\.fees\[asin\] = "skipped_no_price"/);
  });

  it("every outcome vocabulary word from §11 appears", () => {
    const r = productInfoRegion();
    for (const word of ['"updated"', '"absent"', '"inconclusive"', '"skipped_no_price"']) {
      expect(r, word).toContain(word);
    }
    // errors carry the message, as price-sync.ts:198 does. Since 2026-10-07
    // the gating/hazmat messages come from the probes' typed {kind:"error"}
    // results rather than a caught exception.
    expect(r).toMatch(/`error: \$\{eligProbe\.message\}`/);
    expect(r).toMatch(/`error: \$\{hzProbe\.message\}`/);
    expect(r).toMatch(/`error: \$\{feeEntry\.message \?\? "unknown"\}`/);
  });
});

describe("counts shape is {updated, error} plus the stage-specific values", () => {
  it("catalog: updated / absent / inconclusive / error — NOT parsed", () => {
    const r = productInfoRegion();
    expect(r).toMatch(/catalog: \{ updated: 0, absent: 0, inconclusive: 0, error: 0 \}/);
    expect(r).not.toMatch(/catalog: \{ parsed:/);
  });
  it("fees keeps skipped_no_price", () => {
    expect(productInfoRegion()).toMatch(/fees: \{ updated: 0, skipped_no_price: feesSkippedNoPrice\.size, error: 0 \}/);
  });
  for (const stage of ["gating", "hazmat"] as const) {
    it(`${stage}: exactly {updated, error}`, () => {
      expect(productInfoRegion()).toMatch(new RegExp(`${stage}: \\{ updated: 0, error: 0 \\}`));
    });
  }
});

describe("one probe failure is per-ASIN, never fatal to the run", () => {
  it("each probe is branched INDEPENDENTLY on its typed result", () => {
    // Was "individually try/caught" until 2026-10-07. The try/catch was dead
    // code — both probe functions swallowed their own errors and never threw,
    // which is exactly why a failed probe recorded `updated`. They now return
    // {kind:"ok"|"error"} and each gets its own branch; a shared one would
    // let a gating failure skip that ASIN's hazmat probe.
    const r = productInfoRegion();
    const gating = r.slice(r.indexOf("getEligibility(input.asin)"));
    expect(gating).toMatch(/eligProbe\.kind === "ok"[\s\S]{0,600}\} else \{[\s\S]{0,300}stageCounts\.gating\.error\+\+/);
    const hazmat = r.slice(r.indexOf("getInboundHazmat(input.asin)"));
    expect(hazmat).toMatch(/hzProbe\.kind === "ok"[\s\S]{0,600}\} else \{[\s\S]{0,300}stageCounts\.hazmat\.error\+\+/);
  });

  it("a failed probe records error:<msg> for THAT ASIN and leaves the loop running", () => {
    const r = productInfoRegion();
    expect(r).toMatch(/stageCounts\.gating\.error\+\+;[\s\S]{0,200}stageOutcomes\.gating\[input\.asin\] = `error:/);
    expect(r).toMatch(/stageCounts\.hazmat\.error\+\+;[\s\S]{0,200}stageOutcomes\.hazmat\[input\.asin\] = `error:/);
    // No rethrow / break / return inside either failure branch.
    for (const probe of ["gating", "hazmat"]) {
      const i = r.indexOf(`stageCounts.${probe}.error++`);
      const block = r.slice(i, i + 300);
      expect(block, probe).not.toMatch(/\bthrow\b|\bbreak\b|\breturn\b/);
    }
  });
});

describe("dry-run lists the whole scope, not a would-probe subset", () => {
  it("emits scope: asinList and no wouldProbe sets", () => {
    const r = productInfoRegion();
    expect(r).toMatch(/dryRun \? \{ scope: asinList \}/);
    expect(r).not.toContain("wouldProbeGating");
    expect(r).not.toContain("wouldProbeHazmat");
  });
  it("a live run emits the outcome maps instead", () => {
    expect(productInfoRegion()).toMatch(/\{ outcomes: stageOutcomes \}/);
  });
  it("dry-run still writes no ledger rows", () => {
    // Index-based rather than a regex window: a loop + comment sit between
    // the guard and the INSERT, so proximity matching is fragile. What
    // matters is that the INSERT is inside the !dryRun block.
    const r = productInfoRegion();
    const insertIdx = r.indexOf("INSERT INTO refresh_runs");
    const guardIdx = r.lastIndexOf("if (!dryRun) {", insertIdx);
    expect(insertIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(insertIdx);
    // and nothing closes that block before the INSERT
    expect(r.slice(guardIdx, insertIdx)).not.toMatch(/^\s{4}\}/m);
  });
});

describe("Bulk Calc's cache is deliberately untouched (§21)", () => {
  it("bulk-refresh.ts keeps its own freshness cache with the bustCache override", () => {
    const bulk = readFileSync(join(__dirname, "bulk-refresh.ts"), "utf8");
    // Pinned so a future "remove the 30-day rule everywhere" sweep has to
    // read this and make a deliberate decision about a DIFFERENT feature.
    expect(bulk).toContain("THIRTY_D");
    expect(bulk).toMatch(/bustCache \|\| staleOrNever/);
  });
});
