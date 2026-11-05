// Fees: a transient error (internal service failure, 5xx, throttling, timeout) is asked again once, after the step and
// a backoff, before it counts (Maria 2026-11-05).
import { describe, it, expect, vi } from "vitest";
vi.mock("../index", () => ({ log: () => {} }));
const calls: Array<string[]> = [];
vi.mock("../refresh-job", () => ({
  runFeesStage: async (opts: { filter: Set<string> }) => {
    const asins = Array.from(opts.filter); calls.push(asins);
    const first = calls.length === 1;
    const outcomes: Record<string, string> = {};
    let error = 0, updated = 0;
    for (const a of asins) {
      if (a === "B0000000P1") { outcomes[a] = "error: no fee in response"; error++; }
      else if (a === "B0000000T1" && first) { outcomes[a] = "error: There is an internal service failure."; error++; }
      else if (a === "B0000000T2") { outcomes[a] = "error: 503: Request failed with status code 503"; error++; }
      else updated++;
    }
    return { counts: { updated, error, skipped_no_price: 0 }, outcomes };
  },
}));
import { fees, feesRetry, TRANSIENT_FEE_ERROR } from "./components/13-fees";

describe("13 Fees retry", () => {
  it("the transient ones are retried once after the backoff; recovered ones count as updated; persistent errors are not retried", async () => {
    const slept: number[] = [];
    feesRetry.sleep = async (ms) => { slept.push(ms); };
    const ctx: any = { asins: ["B0000000OK", "B0000000P1", "B0000000T1", "B0000000T2"], cache: new Map(), log: () => {}, checkpoint: async () => {} };
    const r = await fees.run(ctx);
    expect(calls[1].sort()).toEqual(["B0000000T1", "B0000000T2"]);
    expect(slept).toEqual([feesRetry.backoffMs]);
    expect(r.counts).toMatchObject({ retried: 2, recovered: 1, updated: 2, error: 2 });
    expect(r.outcomes).toEqual({ B0000000P1: "error: no fee in response", B0000000T2: "error: 503: Request failed with status code 503" });
  });
  it("what is transient", () => {
    for (const s of ["error: There is an internal service failure.", "error: 503: x", "error: 429: Too Many Requests", "error: ?: timeout of 30000ms exceeded", "error: QuotaExceeded"]) expect({ s, t: TRANSIENT_FEE_ERROR.test(s) }).toEqual({ s, t: true });
    for (const s of ["error: no fee in response", "error: There is an client-side error. Please verify your inputs.", "error: 400: bad"]) expect({ s, t: TRANSIENT_FEE_ERROR.test(s) }).toEqual({ s, t: false });
  });
});
