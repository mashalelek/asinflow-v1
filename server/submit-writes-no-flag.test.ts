import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// §18 Writers / §19 (2026-10-10) — replaces submit-pending-flag.test.ts,
// which pinned the 2026-09-21 design this inverts.
//
// WAS: ACCEPTED wrote has_live_offer = TRUE (the "pending half"), the probe
// ladder was demoted to confirmer, a 'failed' verdict reverted to FALSE
// (guarded on no other SKU of the ASIN being 'live'), and a manual 'live'
// verdict wrote TRUE.
//
// IS: the flag is written ONLY by a probe. ACCEPTED writes nothing; the
// ledger row it creates drives the pending icon. Every verdict — API 'failed',
// manual live/failed/deleted — and the 48h stale promotion TRIGGER a re-probe
// instead, and the probe decides.
//
// The UX the 2026-09-21 change bought is kept: the icon still flips the
// instant the submit response lands, because the ledger row exists instantly.
// What is gone is a flag asserting SC has a listing before SC said so.

vi.mock("./index", () => ({ log: () => {} }));
const read = (f: string) => readFileSync(join(__dirname, f), "utf8");
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "").replace(/[ \t]+\/\/.*$/gm, "");
const code = (f: string) => stripComments(read(f));

describe("ACCEPTED at submit writes nothing to the flag", () => {
  it("offer-add.ts contains no has_live_offer write at all", () => {
    expect(code("offer-add.ts")).not.toMatch(/has_live_offer/);
  });

  it("nor has_buyable_offer — a submitted offer was never BUYABLE (§23)", () => {
    expect(code("offer-add.ts")).not.toMatch(/has_buyable_offer/);
  });

  it("the ledger row still starts 'pending' — now the SOLE driver of the icon", () => {
    // More load-bearing than before: with the flag write gone, this row is
    // the only thing that makes a just-submitted ASIN render as pending.
    expect(read("listing-submissions-repo.ts"))
      .toMatch(/verify_status,?[\s\S]*VALUES \(\$1, \$2, \$3, \$4, 'pending'/);
  });
});

describe("the sweep: 'failed' re-probes instead of reverting", () => {
  const repo = code("listing-submissions-repo.ts");
  const sweep = repo.slice(
    repo.indexOf("export async function verifyPending"),
    repo.indexOf("export async function countOpenAmong"),
  );

  it("no UPDATE ... has_live_offer = FALSE survives", () => {
    expect(sweep).not.toMatch(/has_live_offer = FALSE/);
  });

  it("the no-other-live-SKU guard is gone with the write it protected", () => {
    // The guard existed because a verdict is weak evidence about an ASIN:
    // failing ONE SKU says nothing about the others. The probe needs no
    // guard — it looks at every SKU and answers the actual question.
    expect(sweep).not.toMatch(/NOT EXISTS[\s\S]{0,200}verify_status = 'live'/);
  });

  it("'failed' calls the re-probe", () => {
    expect(sweep).toMatch(/if \(status === "failed"\)[\s\S]{0,400}reprobeAsinLiveOffer/);
  });

  it("the 48h stale promotion re-probes too", () => {
    expect(sweep).toMatch(/if \(status === "stale"[\s\S]{0,400}reprobeAsinLiveOffer/);
  });

  it("the sweep's own probe-driven write survives — it IS a probe", () => {
    // The ladder is the first writer again; this is the write that makes it so.
    expect(sweep).toMatch(/if \(probe\.input\.listed\)[\s\S]{0,400}writeLiveOfferVerdict/);
  });
});

describe("manual verdicts: all three re-probe, none writes", () => {
  const repo = code("listing-submissions-repo.ts");
  const manual = repo.slice(repo.indexOf("export async function resolveSubmissionManual"));

  it("manual 'live' no longer writes TRUE", () => {
    expect(manual).not.toMatch(/has_live_offer = TRUE/);
  });

  it("the re-probe is unconditional — not branched per verdict", () => {
    // live / failed / deleted all re-probe. Branching would recreate the old
    // asymmetry where only one verdict updated the flag.
    expect(manual).toMatch(/await reprobeAsinLiveOffer\(asin/);
    expect(manual).not.toMatch(/if \(verdict === "live"\)[\s\S]{0,300}reprobe/);
  });

  it("'deleted' still demotes only that SKU's is_primary, and nothing on asins", () => {
    expect(manual).toMatch(/UPDATE asin_skus s SET is_primary = FALSE/);
    expect(manual).not.toMatch(/UPDATE asins SET (in_catalog|primary_sku)/);
  });

  it("the verdict's own ledger write happens BEFORE the re-probe", () => {
    // Ordering matters: a throttled probe must not be able to lose the
    // human's verdict. The ledger row is already committed by then.
    const ledgerIdx = manual.indexOf("UPDATE listing_submissions SET verify_status");
    const probeIdx = manual.indexOf("reprobeAsinLiveOffer");
    expect(ledgerIdx).toBeGreaterThan(-1);
    expect(probeIdx).toBeGreaterThan(ledgerIdx);
  });

  it("the resolve endpoint surfaces the probe outcome", () => {
    const routes = code("routes.ts");
    const i = routes.indexOf('"/api/submissions/:id/resolve"');
    const handler = routes.slice(i, i + 900);
    expect(handler).toMatch(/const \{ flagOutcome \} = await resolveSubmissionManual/);
    expect(handler).toMatch(/res\.json\(\{ ok: true, flagOutcome \}\)/);
  });
});
