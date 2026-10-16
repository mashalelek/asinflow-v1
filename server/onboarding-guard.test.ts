import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// §11 new-ASIN onboarding guard (2026-09-09). The incident: Product Info
// stopped fetching prices (2026-09-07) and the upload path got a prices
// PRE-pass — which silently no-oped for genuinely-new ASINs (its scope
// query and writePrice both target existing rows), so the sourcing sync
// (and brand-new CSV uploads) inserted priceless ASINs. The rule these
// pins enforce: every insert path onboards through onboardNewAsins
// (Product Info → prices → fees); Product Info alone never prices.
const read = (rel: string) => readFileSync(join(__dirname, rel), "utf8");

describe("every insert path onboards through onboardNewAsins", () => {
  it("the sourcing-sheet sync route onboards through the analyze stream, never runAnalyzeCore directly (the sourcing cron is gone — scheduler v1)", () => {
    const src = read("routes.ts");
    const i = src.indexOf("const result = await syncSourcingSheet(");
    expect(i).toBeGreaterThan(-1);
    const call = src.slice(i, i + 600);
    expect(call).toMatch(/runAnalyzeAndStream\(/); // → onboardNewAsins → one refresh job
    expect(call).not.toMatch(/getRunAnalyzeCore|runAnalyzeCore\(/);
  });

  it("the fromCsvUpload stream path routes through onboarding (no prices pre-pass remains)", () => {
    const src = read("routes.ts");
    const wrapper = src.slice(src.indexOf("async function runAnalyzeAndStream"), src.indexOf("async function runAnalyzeAndStream") + 1500);
    expect(wrapper).toMatch(/onboardNewAsins\(/);
    expect(wrapper).not.toMatch(/refreshPrices\(/); // the broken pre-pass is gone
  });

  it("onboarding creates the rows (insertOnly) THEN enqueues ONE refresh job — no inline stage order (scheduler v1)", () => {
    const src = read("routes.ts");
    const fn = src.slice(src.indexOf("async function onboardNewAsins"), src.indexOf("onboardNewAsinsRef = onboardNewAsins"));
    const insertIdx = fn.indexOf("await insertNewAsinRows(");
    const enqueueIdx = fn.indexOf("enqueueOnboardingJob(");
    expect(insertIdx).toBeGreaterThan(-1);
    expect(enqueueIdx).toBeGreaterThan(insertIdx);      // rows first, then the job
    // the shared insert half (2026-10-16: also used by sales onboarding) writes insertOnly rows
    const ins = fn.slice(fn.indexOf("async function insertNewAsinRows"));
    expect(ins).toMatch(/await writeResult\(/);
    expect(ins).toMatch(/input\.leadSource \?\? null, true\)/); // insertOnly = true
    // the onboarding job itself is built by the dedup helper: daily block on (its per-ASIN set is 2–8 + 10–17)
    const repo = read("scheduler/jobs-repo.ts");
    expect(repo).toMatch(/enqueueJob\(\{ trigger: "onboarding", includeDaily: true, scopeAsins: enqueued/);
    expect(fn).not.toMatch(/runAnalyzeCore\(|refreshPrices\(|runFeesStage\(/);
    expect(fn).not.toMatch(/INSERT INTO refresh_runs/);  // the job ledgers its own components
  });

  it("the upload route no longer fires the unledgered PO + suppression syncs (components 9 and 18 now)", () => {
    const src = read("routes.ts");
    expect(src).not.toMatch(/function runPostAnalyzeBackgroundSyncs/);
    expect(src).not.toMatch(/runPostAnalyzeBackgroundSyncs\(\)/);
  });

  it("the extension add onboards freshly inserted rows", () => {
    const src = read("routes.ts");
    const route = src.slice(src.indexOf('app.post("/api/import-asin"'), src.indexOf('app.post("/api/import-asin"') + 6000);
    expect(route).toMatch(/wasInserted && onboardNewAsinsRef/);
  });
});

// §11/§14 (2026-09-27). The incident: CSV Tags never landed on brand-new
// ASINs. upsertTagsForAsin opens with `SELECT id FROM asins` and returns
// SILENTLY when the row is absent, and the old code launched it alongside
// the fire-and-forget asins INSERT — so the lookup reliably won and every
// tag was dropped with no error. Existing ASINs were unaffected, which is
// why it read as intermittent. The rule: user-supplied fields an insert
// path was GIVEN must be applied after the row exists, in the same
// per-ASIN unit of work, with failures surfaced (bulk-promote.ts's
// contract).
describe("every insert path applies the tags/notes it was given, after the INSERT", () => {
  it("writeResult persists the row, THEN the tags — never concurrently", () => {
    const src = read("routes.ts");
    const fn = src.slice(src.indexOf("async function writeResult"), src.indexOf("async function runSheetsSync"));
    const persistIdx = fn.indexOf("await sink.persistResult(");
    const tagsIdx = fn.indexOf("await sink.persistTags(");
    expect(persistIdx).toBeGreaterThan(-1);          // awaited, not dropped
    expect(tagsIdx).toBeGreaterThan(persistIdx);     // ordered AFTER the insert
  });

  it("a tag failure is surfaced, not swallowed", () => {
    const src = read("routes.ts");
    const fn = src.slice(src.indexOf("async function writeResult"), src.indexOf("async function runSheetsSync"));
    expect(fn).toMatch(/catch/);
    expect(fn).toMatch(/tag write FAILED/);
  });

  it("the main sink returns its tag promise instead of catch-and-logging it", () => {
    const src = read("routes.ts");
    const sink = src.slice(src.indexOf("export const mainCatalogSink"), src.indexOf("async function writeResult"));
    expect(sink).toMatch(/return upsertTagsForAsin\(asin, tagNames\);/);
    // The swallowing form is what lost the tags — it must not come back.
    expect(sink).not.toMatch(/upsertTagsForAsin\([^)]*\)\.catch/);
  });

  it("no runAnalyzeCore call site applies tags outside writeResult", () => {
    const src = read("routes.ts");
    const core = src.slice(src.indexOf("async function runAnalyzeCore"));
    // persistTags is called in exactly one place: inside writeResult.
    expect((src.match(/sink\.persistTags\(/g) ?? []).length).toBe(1);
    expect(core).not.toMatch(/sink\.persistTags\(/);
  });

  it("every writeResult call site is awaited and passes the input's tags", () => {
    const src = read("routes.ts");
    const calls = src.match(/^\s*(await )?writeResult\(.*$/gm) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(5);   // first pass x2, retry x2, final sweep
    for (const c of calls) {
      expect(c, `un-awaited writeResult — tags would race the INSERT again:\n${c}`).toMatch(/await writeResult\(/);
      // Not anchored to the end of the call: the probe-stamps argument was
      // appended after tags on 2026-10-09 (§14). What matters is that the
      // tags are PASSED, not that they are last.
      expect(c, `writeResult call drops its tags argument:\n${c}`).toMatch(/\.tags \?\? null[,)]/);
    }
  });
});

describe("no synthesized price-absence errors (2026-09-09 poison incident)", () => {
  it("buildResult never synthesizes 'Price unavailable' / 'No pricing or fee data'", () => {
    const src = read("routes.ts");
    expect(src).not.toContain("Price unavailable - product found");
    expect(src).not.toContain("No pricing or fee data available");
  });
  it("conclusive price writes clear asin_estimates.error", () => {
    const src = read("price-sync.ts");
    const write = src.slice(src.indexOf("async function writePrice"), src.indexOf("async function writePrice") + 900);
    expect(write).toMatch(/error = NULL/);
  });
});
