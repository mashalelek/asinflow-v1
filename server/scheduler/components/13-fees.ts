// 13. FBA fee estimate (hourly). CALL-7 feesEstimate batch, on the price
// component 10 just wrote (Low-Price FBA rates apply under $10, so a price
// crossing that line changes the fee). ASINs whose price outcome was not
// `updated` are skipped as skipped_no_price — never a fallback estimate.
import { runFeesStage } from "../../refresh-job";
import { PRICES_OUTCOMES } from "./10-prices";
import { forEachBatch } from "./shared";
import type { ComponentDef, ComponentContext, ComponentResult } from "../types";

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
    return { counts, outcomes };
  },
};
