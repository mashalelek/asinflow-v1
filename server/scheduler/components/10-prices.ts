// 10. Competitive prices (hourly). CALL-6 itemOffers batch, 20 per call at
// Amazon's 0.1 rps floor — the longest component (~21 min full scope).
// refreshPrices owns the write (prices, sellers, CPT, fetched_at) and the
// invalid_asin auto-dead; this file chunks it with checkpoints and leaves
// the parsed offers in the cache for 11 and 12 (riders) and the outcomes
// for 13 (fees skip no-price ASINs).
import { refreshPrices, type PriceRefreshResult } from "../../price-sync";
import { forEachBatch } from "./shared";
import type { ParsedOffers } from "../../offers-parse";
import type { ComponentDef, ComponentContext, ComponentResult } from "../types";

export const PRICES_OUTCOMES = "prices:outcomes";
export const PRICES_PARSED = "prices:parsed";

export const prices: ComponentDef = {
  n: 10, key: "10_prices", name: "Competitive prices", tier: "hourly", kind: "batch",
  call: "CALL-6 itemOffers batch",
  async run(ctx: ComponentContext): Promise<ComponentResult> {
    const counts: Record<string, number> = {};
    const outcomes: Record<string, string> = {};
    const parsed = (ctx.cache.get(PRICES_PARSED) as Map<string, ParsedOffers> | undefined) ?? new Map<string, ParsedOffers>();
    await forEachBatch(ctx, async (part) => {
      const r: PriceRefreshResult = await refreshPrices(undefined, new Set(part), { dryRun: false });
      for (const [k, v] of Object.entries(r.counts)) counts[k] = (counts[k] ?? 0) + Number(v);
      Object.assign(outcomes, r.outcomes);
      (r.parsed ?? new Map<string, ParsedOffers>()).forEach((v, k) => parsed.set(k, v));
    });
    ctx.cache.set(PRICES_PARSED, parsed);
    ctx.cache.set(PRICES_OUTCOMES, { ...(ctx.cache.get(PRICES_OUTCOMES) as Record<string, string> | undefined), ...outcomes });
    return { counts, outcomes };
  },
};
