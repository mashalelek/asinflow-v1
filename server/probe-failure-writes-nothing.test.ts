import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { getInboundHazmat } from "./inbound-hazmat";

// §11 / §14 / §21 (2026-10-07): a failed gating or hazmat probe must never be
// recorded as a success. It writes NOTHING — no fallback value, no
// _checked_at stamp move — records error:<msg>, and Retry failed re-asks.
//
// The bug: getEligibility swallowed every API error into {status:"check"} and
// getInboundHazmat returned null. Neither surfaced failure, so the stage's
// error outcome was unreachable and a failed probe recorded `updated`. Worse,
// asin_estimates writes `eligibility_status = EXCLUDED.eligibility_status`
// UNCONDITIONALLY — a throttle overwrote a stored `no` with `check` and moved
// gating_checked_at, which the old 30-day rule then used to skip re-probing.

const read = (f: string) => readFileSync(join(__dirname, f), "utf8");

// ============================================================================
// The probes surface failure as a value the caller cannot mistake for an answer
// ============================================================================
describe("getInboundHazmat returns a typed result, never a sentinel", () => {
  const failingGet = (status: number, code?: string) => async () => {
    const e: any = new Error("boom");
    e.response = { status, data: code ? { errors: [{ code }] } : undefined };
    throw e;
  };
  const FAST = { maxAttempts: 2, initialBackoffMs: 1 };

  it("a 429 after retries is kind:'error' with a message — not null, not false", async () => {
    const r = await getInboundHazmat("BTHROTTLE", failingGet(429, "QuotaExceeded"), FAST);
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.message).toBeTruthy();
    // no value field at all — nothing to read as an answer
    expect(r).not.toHaveProperty("isHazmat");
  });

  it("a success is kind:'ok' with the boolean", async () => {
    const ok = async () => ({ payload: { ineligibilityReasonList: [{ code: "FBA_INB_0015" }] } });
    expect(await getInboundHazmat("BOK", ok as any, FAST)).toEqual({ kind: "ok", isHazmat: true });
  });
});

describe("getEligibility returns a typed result, and 'check' is not a probe output", () => {
  const src = () => read("spapi.ts");

  it("the EligibilityProbe union has NO 'check' member", () => {
    const s = src();
    const block = s.slice(s.indexOf("export type EligibilityProbe"), s.indexOf("export async function getEligibility"));
    expect(block).toMatch(/kind: "ok"; status: "yes" \| "no"/);
    expect(block).toMatch(/kind: "error"; message: string/);
    expect(block).not.toMatch(/"check"/);
  });

  it("no code path returns {status:'check'} any more", () => {
    const s = src();
    const fn = s.slice(s.indexOf("export async function getEligibility"), s.indexOf("// Hazmat detection"));
    expect(fn).not.toMatch(/return \{ status: "check" \}/);
    // the catch surfaces the failure instead
    expect(fn).toMatch(/kind: "error"/);
  });

  it("an unset SP_API_SELLER_ID is an ERROR outcome, not a stored non-answer", () => {
    const s = src();
    const fn = s.slice(s.indexOf("export async function getEligibility"), s.indexOf("// Hazmat detection"));
    expect(fn).toMatch(/SP_API_SELLER_ID not configured/);
    expect(fn).toMatch(/if \(!sellerId\)[\s\S]{0,300}kind: "error"/);
  });
});

// ============================================================================
// Caller 1 — the Product Info stage
// ============================================================================
describe("Product Info: a failed probe writes nothing", () => {
  const region = () => {
    const s = read("routes.ts");
    const a = s.indexOf("const feesMap = await fetchFeesBatch(feeItems);");
    const b = s.indexOf("function runPostAnalyzeBackgroundSyncs");
    return s.slice(a, b);
  };

  for (const [probe, call, stamp] of [
    ["gating", "getEligibility", "gating_checked_at"],
    ["hazmat", "getInboundHazmat", "hazmat_checked_at"],
  ] as const) {
    // The stamp is EARNED in the ok branch and WRITTEN later, by the sink,
    // behind the asins INSERT (§14, 2026-10-09 — the stamp used to be an
    // UPDATE right here, which matched zero rows on a brand-new ASIN). What
    // this test pins is unchanged in substance: only a successful probe may
    // put a stamp in play, and the failure branch may not.
    it(`${probe}: the stamp is claimed inside the ok branch ONLY`, () => {
      const r = region();
      const i = r.indexOf(`await ${call}(input.asin)`);
      const block = r.slice(i, i + 1400);
      const okIdx = block.indexOf('.kind === "ok"');
      const stampIdx = block.indexOf(`${probe}: true }`);
      const elseIdx = block.indexOf("} else {");
      expect(okIdx).toBeGreaterThan(-1);
      expect(stampIdx).toBeGreaterThan(okIdx);   // after the ok check
      expect(stampIdx).toBeLessThan(elseIdx);     // and before the else
      // and the claim is recorded, not written, here
      expect(block.slice(okIdx, elseIdx)).toMatch(/probeStamps\.set\(input\.asin/);
      expect(block.slice(okIdx, elseIdx)).not.toMatch(new RegExp(`UPDATE asins SET ${stamp}`));
    });

    it(`${probe}: the failure branch records error:<msg> and writes no value`, () => {
      const r = region();
      const i = r.indexOf(`await ${call}(input.asin)`);
      const block = r.slice(i, i + 1400);
      // Bound the else-block at its CLOSING brace, not a fixed window — a
      // fixed slice overran into the next probe's block, which legitimately
      // assigns a value.
      const elseStart = block.indexOf("} else {");
      const elseEnd = block.indexOf("\n          }", elseStart);
      expect(elseEnd).toBeGreaterThan(elseStart);
      const failure = block.slice(elseStart, elseEnd);
      expect(failure).toMatch(new RegExp(`stageCounts\\.${probe}\\.error\\+\\+`));
      expect(failure).toMatch(new RegExp(`stageOutcomes\\.${probe}\\[input\\.asin\\] = \`error: `));
      // nothing written in the failure branch
      expect(failure).not.toMatch(/UPDATE asins SET/);
      expect(failure).not.toMatch(/probeStamps\.set/);   // no stamp claimed either
      expect(failure).not.toMatch(/eligibilityData = \{/);
      expect(failure).not.toMatch(/hazmatFlag = /);
    });
  }

  it("the probes are no longer wrapped in try/catch — they cannot throw now", () => {
    // The old try/catch was dead code: both functions swallowed their errors.
    // Branching on `kind` is the whole mechanism.
    const r = region();
    const i = r.indexOf("await getEligibility(input.asin)");
    expect(r.slice(i - 200, i)).not.toMatch(/try \{\s*$/);
  });
});

// ============================================================================
// Caller 2 — Bulk Calc's gating/hazmat cache (§21)
// ============================================================================
describe("Bulk Calc: a failed probe is not cached", () => {
  const src = () => read("bulk-refresh.ts");

  for (const [probe, call, counts] of [
    ["gating", "getEligibility", "gCounts"],
    ["hazmat", "getInboundHazmat", "hCounts"],
  ] as const) {
    it(`${probe}: the failure branch continues BEFORE any cache write`, () => {
      const s = src();
      const i = s.indexOf(`const ${probe === "gating" ? "elig" : "hz"} = await ${call}(r.asin)`);
      expect(i).toBeGreaterThan(-1);
      const block = s.slice(i, i + 1200);
      const guard = block.indexOf('.kind !== "ok"');
      const insert = block.indexOf("INSERT INTO bulk_gating_hazmat_cache");
      expect(guard).toBeGreaterThan(-1);
      expect(insert).toBeGreaterThan(guard);          // cache write comes after
      const failure = block.slice(guard, insert);
      expect(failure).toMatch(new RegExp(`${counts}\\.error\\+\\+`));
      expect(failure).toMatch(/error: \$\{/);
      expect(failure).toMatch(/continue;/);           // and never reaches it
      expect(failure).not.toMatch(/INSERT INTO|UPDATE bulk_list_asins/);
    });
  }

  it("the 30-day window and the bustCache override are untouched", () => {
    const s = src();
    expect(s).toContain("THIRTY_D");
    expect(s).toMatch(/bustCache \|\| staleOrNever/);
  });

  it("no caller reads a null hazmat as an answer any more", () => {
    const s = src();
    // the old COALESCE-the-sentinel write is gone; the value is a real boolean
    expect(s).not.toMatch(/COALESCE\(\$2, bulk_gating_hazmat_cache\.is_hazmat\)/);
    expect(s).toMatch(/hz\.isHazmat/);
  });
});

// ============================================================================
// The data rule the whole commit exists for
// ============================================================================
describe("a throttle never turns a known answer into a non-answer", () => {
  it("mocked 429: the probe reports error and offers no value to write", async () => {
    const throttled = async () => {
      const e: any = new Error("Request throttled");
      e.response = { status: 429, data: { errors: [{ code: "QuotaExceeded" }] } };
      throw e;
    };
    const r = await getInboundHazmat("B00KNOWNNO", throttled, { maxAttempts: 2, initialBackoffMs: 1 });
    expect(r.kind).toBe("error");
    // A caller branching on kind therefore has NOTHING to write — which is
    // what keeps a stored `no` (or `true`) standing. There is no false, no
    // null, and no "check" to leak into the column.
    expect(r).not.toHaveProperty("isHazmat");
  });

  it("'check' survives in SPEC only as the stored never-probed value", () => {
    const spec = readFileSync(join(__dirname, "../docs/SPEC.md"), "utf8");
    expect(spec).toMatch(/`"check"` as a stored `eligibility_status` means \*\*"never probed"\*\*/);
  });
});
