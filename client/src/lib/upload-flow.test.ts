import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { refreshPlan, queuedJobIdFromMessage } from "./upload-flow";

// Fix 2026-10-18 (the 11-ASIN diagnosis): upload state, stream merge, reload on job completion.
const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8");
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const row = (over: any = {}): any => ({
  asin: "B09HRDGW17", cogs: 0, error: null, pricesFetchedAt: "2026-10-18T10:05:08.000Z",
  pricingData: { lowestFbaPrice: 50.11, buyBoxPrice: 50.11, lowestPrice: 49.86, sellersFba: 2, sellersFbm: 5 },
  catalogData: { title: "Metallica - Exclusive Limited Edition", brand: "walmart exclusive", imageUrl: "https://m.media-amazon.com/images/I/41s3cLT8U-L.jpg", bsrRank: 45 },
  feesData: { fbaFulfillmentFee: 7.6, referralFee: 7.5, feesEstimatePrice: 50.11 },
  ...over,
});
const placeholder = (asin = "B09HRDGW17"): any => ({
  asin, cogs: 0, error: null,
  pricingData: { lowestFbaPrice: null, buyBoxPrice: null, lowestPrice: null, sellersFba: null, sellersFbm: null },
  catalogData: { title: null, brand: null, imageUrl: null, bsrRank: null },
  feesData: { fbaFulfillmentFee: null, referralFee: null, feesEstimatePrice: null },
});

describe("1. upload then Refresh runs a refresh job", () => {
  it("a pending upload is onboarded once; the job_queued message clears it, so the next click is a normal Refresh", () => {
    let pending: any[] = [{ asin: "B09HRDGW17" }, { asin: "B0D2RHBG85" }];
    expect(refreshPlan(pending)).toEqual({ kind: "onboard_upload", asins: pending });
    const id = queuedJobIdFromMessage({ type: "job_queued", data: { jobId: 52, asins: 2 } });
    expect(id).toBe(52);
    if (id != null) pending = []; // what the page does on that message
    expect(refreshPlan(pending)).toEqual({ kind: "refresh" });
    expect(queuedJobIdFromMessage({ type: "progress", data: {} })).toBeNull();
  });
  it("the page clears the pending upload on job_queued, watches that job, and plans every click through refreshPlan", () => {
    const home = read("pages/home.tsx");
    expect(home).toMatch(/const queuedId = queuedJobIdFromMessage\(msg\);[\s\S]{0,300}setAsins\(\[\]\);/);
    expect(home).toMatch(/refreshPlan\(asins\)/);
    expect(home).toMatch(/const \{ job \} = await getJob\(id\); jobs\.watch\(job\);/);
    expect(home).not.toMatch(/if \(!asinsOverride && asins\.length > 0\) \{ await runAnalysis\(asins\); return; \}/);
  });
});
