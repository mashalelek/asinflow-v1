// 12. Competitive Price Threshold (hourly, rides CALL-6). Decision 12: CPT
// moved from a submit-time-only value (listing_submissions.cpt_seen) to
// asin_estimates.competitive_price_threshold, written by the prices
// component every pass from the same itemOffers response — zero extra
// calls. This row records coverage; the write is in writePrice.
import { PRICES_PARSED } from "./10-prices";
import type { ParsedOffers } from "../../offers-parse";
import type { ComponentDef, ComponentContext, ComponentResult } from "../types";

export const cpt: ComponentDef = {
  n: 12, key: "12_cpt", name: "Competitive Price Threshold", tier: "hourly", kind: "derived",
  call: "rides CALL-6 (Summary.CompetitivePriceThreshold)",
  async run(ctx: ComponentContext): Promise<ComponentResult> {
    const parsed = ctx.cache.get(PRICES_PARSED) as Map<string, ParsedOffers> | undefined;
    if (!parsed) {
      const r = await ctx.query(
        `SELECT count(*) FILTER (WHERE competitive_price_threshold IS NOT NULL)::int AS with_cpt, count(*)::int AS total
           FROM asin_estimates WHERE asin = ANY($1::text[])`, [ctx.scopeAsins],
      );
      return { counts: { with_cpt: Number(r.rows[0]?.with_cpt ?? 0), total: Number(r.rows[0]?.total ?? 0), from_rows: 1 }, outcomes: {} };
    }
    const counts = { with_cpt: 0, no_cpt: 0, not_fetched: 0 };
    const outcomes: Record<string, string> = {};
    for (const asin of ctx.scopeAsins) {
      const p = parsed.get(asin);
      if (!p) { counts.not_fetched++; continue; }
      if (p.competitivePriceThreshold != null) counts.with_cpt++;
      else { counts.no_cpt++; outcomes[asin] = "no_cpt"; }
    }
    return { counts, outcomes };
  },
};
