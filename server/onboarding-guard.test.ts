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
  it("sourcing cron calls onboarding, never runAnalyzeCore directly", () => {
    const src = read("sourcing-sync-cron.ts");
    expect(src).toMatch(/getOnboardNewAsins/);
    expect(src).not.toMatch(/getRunAnalyzeCore|runAnalyzeCore\(/);
  });

  it("the fromCsvUpload stream path routes through onboarding (no prices pre-pass remains)", () => {
    const src = read("routes.ts");
    const wrapper = src.slice(src.indexOf("async function runAnalyzeAndStream"), src.indexOf("async function runAnalyzeAndStream") + 1500);
    expect(wrapper).toMatch(/onboardNewAsins\(/);
    expect(wrapper).not.toMatch(/refreshPrices\(/); // the broken pre-pass is gone
  });

  it("onboarding runs core THEN prices THEN fees, ledgered with the caller's trigger", () => {
    const src = read("routes.ts");
    const fn = src.slice(src.indexOf("async function onboardNewAsins"), src.indexOf("onboardNewAsinsRef = onboardNewAsins"));
    const coreIdx = fn.indexOf("runAnalyzeCore(");
    const priceIdx = fn.indexOf("refreshPrices(");
    const feesIdx = fn.indexOf("runFeesStage(");
    expect(coreIdx).toBeGreaterThan(-1);
    expect(priceIdx).toBeGreaterThan(coreIdx);   // prices AFTER the insert
    expect(feesIdx).toBeGreaterThan(priceIdx);
    expect(fn).toMatch(/INSERT INTO refresh_runs/);
    expect(fn).toMatch(/trigger/);
  });

  it("the extension add onboards freshly inserted rows", () => {
    const src = read("routes.ts");
    const route = src.slice(src.indexOf('app.post("/api/import-asin"'), src.indexOf('app.post("/api/import-asin"') + 6000);
    expect(route).toMatch(/wasInserted && onboardNewAsinsRef/);
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
