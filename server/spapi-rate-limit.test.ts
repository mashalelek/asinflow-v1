import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

// SPEC §11 "SP-API rate limiting" (2026-09-06): FIFO order, burst then steady
// rate, header override, 429 drain/retry/throw after 3, unknown-path
// passthrough. Fake clock throughout.
import { withRateLimit, rateLimitStats, operationKeyFor, _resetRateLimitsForTests } from "./spapi-rate-limit";

beforeEach(() => {
  _resetRateLimitsForTests();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

const ok = (headers: Record<string, any> = {}) => ({ headers, data: {} });
const throttle429 = () => {
  const e: any = new Error("429");
  e.response = { status: 429, headers: {} };
  return e;
};

// Advance fake time until a promise settles (limiter sleeps internally).
async function drain<T>(p: Promise<T>, maxMs = 600_000): Promise<T> {
  let settled = false;
  let result: any, error: any;
  p.then((r) => { settled = true; result = r; }, (e) => { settled = true; error = e; });
  for (let t = 0; t < maxMs && !settled; t += 50) {
    await vi.advanceTimersByTimeAsync(50);
  }
  if (!settled) throw new Error("promise did not settle under fake clock");
  if (error) throw error;
  return result;
}

const OFFERS = "/products/pricing/v0/items/B000000001/offers"; // 1 rps, burst 2

describe("operationKeyFor", () => {
  it("maps table paths and strips query strings", () => {
    expect(operationKeyFor("/batches/products/pricing/v0/itemOffers")).toBe("pricing.itemOffersBatch");
    expect(operationKeyFor(OFFERS + "?MarketplaceId=X")).toBe("pricing.itemOffers");
    expect(operationKeyFor("/listings/2021-08-01/items/SELLER/SKU-1")).toBe("listings.items");
    expect(operationKeyFor("/some/unknown/path")).toBeNull();
  });
});

describe("withRateLimit", () => {
  it("burst then steady rate: 2 immediate (burst), 3rd waits ~1/rate", async () => {
    const sends: number[] = [];
    const call = () => withRateLimit(OFFERS, async () => { sends.push(Date.now()); return ok(); });
    const start = Date.now();
    await drain(Promise.all([call(), call(), call()]));
    expect(sends[0] - start).toBeLessThan(100);
    expect(sends[1] - start).toBeLessThan(100);
    expect(sends[2] - start).toBeGreaterThanOrEqual(900); // ~1s at 0.95rps
    expect(rateLimitStats()["pricing.itemOffers"].sent).toBe(3);
  });

  it("FIFO: waiters release in submission order", async () => {
    const order: string[] = [];
    const call = (id: string) => withRateLimit(OFFERS, async () => { order.push(id); return ok(); });
    await drain(Promise.all([call("a"), call("b"), call("c"), call("d")]));
    expect(order).toEqual(["a", "b", "c", "d"]);
  });

  // Downward-only (2026-09-07): the header may slow a bucket but never raise
  // it above its seeded rate — Amazon's advertised 0.1 on itemOffersBatch
  // kept re-raising the 0.09 seed to 0.095 and drawing steady-state 429s.
  it("x-amzn-RateLimit-Limit header lowers the bucket rate", async () => {
    await drain(withRateLimit(OFFERS, async () => ok({ "x-amzn-ratelimit-limit": "0.5" })));
    const s = rateLimitStats()["pricing.itemOffers"];
    expect(s.adjusted).toBe(true);
    expect(s.rate).toBeCloseTo(0.5 * 0.95, 3);
  });

  it("x-amzn-RateLimit-Limit header never raises the rate above the seed", async () => {
    await drain(withRateLimit(OFFERS, async () => ok())); // create the bucket at its seed
    const seeded = rateLimitStats()["pricing.itemOffers"].rate;
    await drain(withRateLimit(OFFERS, async () => ok({ "x-amzn-ratelimit-limit": "5" })));
    const s = rateLimitStats()["pricing.itemOffers"];
    expect(s.adjusted).toBe(false);
    expect(s.rate).toBeCloseTo(seeded, 3);
  });

  it("429 drains the bucket, retries transparently, succeeds", async () => {
    let calls = 0;
    const res = await drain(withRateLimit(OFFERS, async () => {
      calls++;
      if (calls === 1) throw throttle429();
      return ok();
    }));
    expect(calls).toBe(2);
    expect(res).toBeTruthy();
    expect(rateLimitStats()["pricing.itemOffers"].throttled).toBe(1);
  });

  it("throws the 429 after 3 retries (4 attempts total)", async () => {
    let calls = 0;
    await expect(drain(withRateLimit(OFFERS, async () => { calls++; throw throttle429(); })))
      .rejects.toMatchObject({ response: { status: 429 } });
    expect(calls).toBe(4);
  });

  it("non-throttle errors pass through immediately, no retry", async () => {
    let calls = 0;
    const boom: any = new Error("500");
    boom.response = { status: 500 };
    await expect(drain(withRateLimit(OFFERS, async () => { calls++; throw boom; }))).rejects.toBe(boom);
    expect(calls).toBe(1);
  });

  it("unknown paths pass through unpaced", async () => {
    const start = Date.now();
    for (let i = 0; i < 5; i++) await withRateLimit("/some/unknown/path", async () => ok());
    expect(Date.now() - start).toBe(0); // no timers consumed
  });
});
