import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

// §18 A3 (2026-10-09) — the listings reconcile scopes to EVERY ASIN AF knows.
//
// The two filters removed here are why B07J2WWWD4's wrong TRUE was frozen:
// full-scope-pass.ts selected `status IN ('active','parked')` and the
// now-deleted live-offer-sync.ts selected `in_catalog = TRUE`. The ASIN is
// dead with in_catalog=f, so it sat outside both reconciles and nothing could
// ever correct it.
//
// Source pins rather than behavioural tests: the scope lives in SQL string
// literals, and the thing worth preventing is a filter coming BACK.

const read = (p: string) => readFileSync(join(__dirname, p), "utf8");

// These pins grep for patterns that ALSO appear in the tombstone comments
// explaining what was removed and why — the comments are the point, so the
// greps have to be comment-blind or they fail on their own documentation.
const stripComments = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")   // block comments
    .replace(/^[ \t]*\/\/.*$/gm, "")      // whole-line // comments
    .replace(/[ \t]+\/\/.*$/gm, "");      // trailing // comments
const code = (p: string) => stripComments(read(p));
const pass = () => code("full-scope-pass.ts");

describe("A3: no status or in_catalog filter survives in the reconcile", () => {
  it("full-scope-pass.ts has no status IN ('active', 'parked') scope", () => {
    const s = pass();
    expect(s).not.toMatch(/status\s+IN\s*\(\s*'active'/);
    // and no activeCond indirection to hide it behind
    expect(s).not.toMatch(/activeCond/);
  });

  it("full-scope-pass.ts has no in_catalog scope", () => {
    expect(pass()).not.toMatch(/in_catalog\s*=\s*TRUE/i);
  });

  it("phase a's row query is unfiltered except for the explicit selection", () => {
    const s = pass();
    const i = s.indexOf("json_agg(json_build_object('sku'");
    const q = s.slice(i - 400, i + 400);
    expect(q).toMatch(/WHERE TRUE \$\{filterCond\}/);
  });

  it("phase b is no longer gated on status — only on having no SKUs", () => {
    const s = pass();
    const i = s.indexOf("has_primary_row");
    const q = s.slice(i, i + 500);
    expect(q).toMatch(/WHERE NOT EXISTS \(SELECT 1 FROM asin_skus/);
    expect(q).not.toMatch(/status/);
  });

  it("phase b selects has_live_offer, so flip detection is real", () => {
    // Without it every phase-b discovery would report `flip: null -> true`
    // even when the flag was already TRUE.
    const s = pass();
    const i = s.indexOf("has_primary_row");
    expect(s.slice(i - 300, i)).toMatch(/a\.has_live_offer/);
  });
});

describe("A2: the one-primitive invariant, enforced by grep", () => {
  const SERVER = __dirname;
  const files = [
    "full-scope-pass.ts",
    "listing-submissions-repo.ts",
    "offer-add.ts",
    "routes.ts",
    "inventory-sync.ts",
    "refresh-job.ts",
    "live-offer-check.ts",
  ];

  it("live-offer-write.ts is the only file containing a has_live_offer UPDATE", () => {
    const writers: string[] = [];
    for (const f of files) {
      const s = code(f);
      // An UPDATE statement that assigns the flag. Comments mentioning the
      // column are fine; an assignment is not.
      if (/SET\s+has_live_offer\s*=/.test(s)) writers.push(f);
    }
    // offer-add.ts and listing-submissions-repo.ts still carry the three
    // NON-probe writers until the writers→re-probe commit (§18 "still true at
    // this commit"). Everything else must be clean, and the probe paths are.
    expect(writers.sort()).toEqual(["listing-submissions-repo.ts", "offer-add.ts"]);
  });

  it("the primitive itself writes both flags in one statement", () => {
    const s = read("live-offer-write.ts");
    const i = s.indexOf("UPDATE asins");
    const stmt = s.slice(i, s.indexOf("`,", i));
    expect(stmt).toMatch(/has_live_offer = \$2/);
    expect(stmt).toMatch(/has_buyable_offer = \$3/);
    expect(stmt).toMatch(/offer_checked_at = now\(\)/);
    expect(stmt).toMatch(/buyable_checked_at = now\(\)/);
    // one statement, not two
    expect(stmt.match(/UPDATE asins/g) ?? []).toHaveLength(1);
  });

  it("the primitive cannot write without an outcome sink", () => {
    const s = read("live-offer-write.ts");
    // The sink is a required field on deps, and the outcome is recorded
    // BEFORE the dryRun early-return — so every path ledgers.
    expect(s).toMatch(/outcomes:\s*OutcomeSink/);
    const body = s.slice(s.indexOf("export async function writeLiveOfferVerdict"));
    const recordIdx = body.indexOf("deps.outcomes(v.asin, outcome)");
    const dryIdx = body.indexOf("if (deps.dryRun)");
    const updIdx = body.indexOf("UPDATE asins");
    expect(recordIdx).toBeGreaterThan(-1);
    expect(recordIdx).toBeLessThan(dryIdx);
    expect(dryIdx).toBeLessThan(updIdx);
  });

  it("the deleted modules are gone, not merely unreferenced", () => {
    expect(existsSync(join(SERVER, "live-offer-sync.ts"))).toBe(false);
    expect(existsSync(join(SERVER, "..", "script", "backfill-has-live-offer.ts"))).toBe(false);
    for (const f of files) {
      expect(code(f), f).not.toMatch(/syncLiveOffers|live-offer-sync/);
    }
  });

  it("recheck-issues runs the stage, not a second implementation", () => {
    const s = code("routes.ts");
    const i = s.indexOf('"/api/asins/:asin/recheck-issues"');
    expect(i).toBeGreaterThan(-1);
    const handler = s.slice(i, i + 1600);
    expect(handler).toMatch(/runFullScopePass\(\{ dryRun: false, asinFilter/);
    expect(handler).toMatch(/report\.outcomes\[asin\]/);
  });

  it("the refresh job persists the pass's own outcomes, not a rebuilt subset", () => {
    const s = code("refresh-job.ts");
    const i = s.indexOf('runStage("listings"');
    const body = s.slice(i, i + 1400);
    expect(body).toMatch(/\.\.\.report\.outcomes/);
    // the old flips+discoveries-only reconstruction is gone
    expect(body).not.toMatch(/for \(const f of a\.flips\) outcomes/);
  });
});

describe("A1: no present:true without a non-empty summary", () => {
  it("sku-listing-fetch gates present on summaries.length", () => {
    const s = code("sku-listing-fetch.ts");
    // Scope to the function body — the exported union type legitimately
    // contains the string `present: true` above it.
    const fn = s.slice(s.indexOf("export async function checkSkuListingStatus"));
    const i = fn.indexOf("const summaries");
    expect(i).toBeGreaterThan(-1);
    const body = fn.slice(i, i + 400);
    expect(body).toMatch(/summaries\.length === 0/);
    expect(body).toMatch(/present: false, shell: true/);
    // the shell gate precedes the only present:true return in the body
    expect(i).toBeLessThan(fn.indexOf("present: true"));
  });

  it("neither fetch path keys A1 on status instead of summaries", () => {
    // The B01JO20V8U trap: a real listing with status: []. Keying on status
    // would call it absent.
    for (const f of ["sku-listing-fetch.ts", "sku-listing-search.ts", "live-offer-check.ts"]) {
      expect(code(f), f).not.toMatch(/status\.length === 0|status\]\.length === 0/);
    }
  });

  it("discoverAsinListings filters shells before recording SKUs", () => {
    const s = code("live-offer-check.ts");
    const i = s.indexOf("const found: DiscoveredListing[]");
    const body = s.slice(i, i + 700);
    expect(body).toMatch(/summaries\) && it\.summaries\.length > 0/);
  });

  it("the §19 sweep's flag write is keyed on `listed`, never on `found`", () => {
    const s = code("listing-submissions-repo.ts");
    expect(s).toMatch(/if \(probe\.input\.listed\)/);
    expect(s).not.toMatch(/if \(probe\.input\.found\)/);
  });
});
