import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { failedAsinsFrom, type StageResult } from "./stage-results";

// §11 Product Info results dialog + Retry failed (2026-10-07).
//
// Before this: product_info_summary was emitted to NO consumer, Product
// Info's whole report was a toast ("Processed N ASINs"), and Retry failed was
// wired to the Prices & Stock prices stage only.

describe("failedAsinsFrom — Retry failed spans ALL FOUR stages", () => {
  const stages: StageResult[] = [
    { stage: "catalog", outcomes: { A1: "updated", A2: "inconclusive", A3: "error: boom" } },
    { stage: "fees", outcomes: { A1: "skipped_no_price", A4: "error: no fee in response" } },
    { stage: "gating", outcomes: { A1: "updated", A5: "error: 503" } },
    { stage: "hazmat", outcomes: { A6: "error: There is an internal service failure." } },
  ];

  it("collects error ASINs from every stage, not just one", () => {
    // A2 is inconclusive -> also retryable (see below).
    expect(failedAsinsFrom(stages)).toEqual(["A2", "A3", "A4", "A5", "A6"]);
  });

  it("collects catalog `inconclusive` — a partial batch gave NO answer, so re-ask", () => {
    // §11: inconclusive means the response came back without this ASIN and
    // without proving its absence. It is fail-closed exactly so it can be
    // asked again, which makes it a retry case, not a result.
    expect(failedAsinsFrom([{ stage: "catalog", outcomes: { Z: "inconclusive" } }])).toEqual(["Z"]);
  });

  it("does NOT retry outcomes that ARE answers, or that had nothing to ask", () => {
    const failed = failedAsinsFrom(stages);
    // skipped_no_price is a missing INPUT, not a failed call.
    expect(failed).not.toContain("A1");
    // `absent` is CONCLUSIVE — missing from a complete batch (the DA-2
    // catalog-deleted signal). Re-asking cannot change it.
    expect(failedAsinsFrom([{ stage: "catalog", outcomes: { W: "absent" } }])).toEqual([]);
    // and a success is obviously not retryable
    expect(failedAsinsFrom([{ stage: "catalog", outcomes: { V: "updated" } }])).toEqual([]);
  });

  it("dedupes an ASIN that failed in more than one stage", () => {
    expect(failedAsinsFrom([
      { stage: "gating", outcomes: { X: "error: a" } },
      { stage: "hazmat", outcomes: { X: "error: b" } },
    ])).toEqual(["X"]);
  });

  it("is empty for a clean run, so the button does not render", () => {
    expect(failedAsinsFrom([{ stage: "gating", outcomes: { X: "updated" } }])).toEqual([]);
    expect(failedAsinsFrom([{ stage: "gating" }])).toEqual([]);
    expect(failedAsinsFrom([])).toEqual([]);
  });

  it("matches the error: prefix the stages actually write", () => {
    // §11 vocabulary — the resolver writes `error: <msg>`; a bare "error"
    // would also match, but an outcome merely CONTAINING the word must not.
    expect(failedAsinsFrom([{ stage: "fees", outcomes: { Y: "updated, no error" } }])).toEqual([]);
  });
});

describe("one renderer, one dialog (scheduler v1, 2026-10-15)", () => {
  const read = (p: string) => readFileSync(join(__dirname, p), "utf8");

  it("the jobs dialog renders per-component counts through StageResultsList; home.tsx has no copy", () => {
    expect((read("jobs-dialog.tsx").match(/<StageResultsList/g) ?? []).length).toBe(1);
    const home = read("../pages/home.tsx");
    expect(home).not.toMatch(/<StageResultsList/);
    expect(home).not.toMatch(/Object\.values\(refreshResult\.stages/);
  });

  it("the Product Info summary consumer and its dialog are gone from home.tsx", () => {
    const home = read("../pages/home.tsx");
    expect(home).not.toMatch(/product_info_summary/);
    expect(home).not.toMatch(/dialog-product-info-results/);
    expect(home).not.toMatch(/setProductInfoResult/);
    expect(home).not.toContain('title: "Product Info complete"');
  });

  it("Retry failed lives in the jobs dialog and spans every component of the job", () => {
    const dlg = read("jobs-dialog.tsx");
    expect(dlg).toMatch(/failedAsinsFromRuns\(d\.components\)/);
    expect(dlg).toMatch(/onRetry\(failedAsinsFromRuns/);
  });
});
