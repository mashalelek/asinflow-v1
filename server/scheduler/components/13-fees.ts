// 13. FBA fee estimate (hourly). CALL-7 feesEstimate batch, on the price
// component 10 just wrote (Low-Price FBA rates apply under $10, so a price
// crossing that line changes the fee). ASINs whose price outcome was not
// `updated` are skipped as skipped_no_price — never a fallback estimate.
//
// Retry (Maria 2026-11-05): an ASIN whose estimate failed with SP-API's
// "internal service failure", another 5xx, throttling or a timeout is asked
// again ONCE, after the whole step and a backoff, before it counts as an
// error (counts.retried / counts.recovered). Anything still failing is a
// step failure unless known-persistent (server/scheduler/step-failures.ts).
import { runFeesStage } from "../../refresh-job";
import { PRICES_OUTCOMES } from "./10-prices";
import { forEachBatch } from "./shared";
import type { ComponentDef, ComponentContext, ComponentResult } from "../types";

/** Pure: a fee outcome worth one retry — a 5xx / throttling / timeout, per ASIN or for the whole call. */
export const TRANSIENT_FEE_ERROR = /internal service failure|internalfailure|service unavailable|quotaexceeded|throttl|too many requests|timed? ?out|econnreset|socket hang up|^error: (?:5\d\d|429|\?):/i;

/** Test seam: the backoff before the retry, and the sleep. */
export const feesRetry = { backoffMs: 20_000, sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) };

export const fees: ComponentDef = {
  n: 13, key: "13_fees", name: "FBA fee estimate", tier: "hourly", kind: "batch",
  call: "CALL-7 feesEstimate batch",
  async run(ctx: ComponentContext): Promise<ComponentResult> {
    // Non-updated price outcomes from this job; on a resume with no cache
    // the stored-price rule inside runFeesStage still skips priceless rows.
    const skip = new Set(Object.keys((ctx.cache.get(PRICES_OUTCOMES) as Record<string, string> | undefined) ?? {}));
    const counts: Record<string, number> = { updated: 0, skipped_no_price: 0, error: 0 };
    const outcomes: Record<string, string> = {};
    await forEachBatch(ctx, async (part) => {
      const r = await runFeesStage({ filter: new Set(part), dryRun: false, emit: () => {}, skipAsins: skip });
      for (const [k, v] of Object.entries(r.counts)) counts[k] = (counts[k] ?? 0) + Number(v);
      Object.assign(outcomes, r.outcomes);
    });
    const again = Object.entries(outcomes).filter(([, o]) => TRANSIENT_FEE_ERROR.test(o)).map(([a]) => a);
    if (again.length) {
      ctx.log(`retrying ${again.length} transient fee error(s) after ${Math.round(feesRetry.backoffMs / 1000)} s`);
      await feesRetry.sleep(feesRetry.backoffMs);
      const r = await runFeesStage({ filter: new Set(again), dryRun: false, emit: () => {}, skipAsins: skip });
      let recovered = 0;
      for (const a of again) {
        if (r.outcomes[a] == null) { delete outcomes[a]; recovered++; } // written: no outcome on success
        else outcomes[a] = r.outcomes[a];
      }
      counts.retried = again.length;
      counts.recovered = recovered;
      counts.updated += recovered;
      counts.error -= recovered;
    }
    return { counts, outcomes };
  },
};
