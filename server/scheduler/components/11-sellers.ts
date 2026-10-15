// 11. Seller count FBA / FBM (hourly, rides CALL-6). The write happened in
// component 10 (writePrice writes sellers_fba / sellers_fbm with the
// prices); this row records what landed so the ledger answers "which ASINs
// got a seller count this pass".
import { PRICES_PARSED } from "./10-prices";
import type { ParsedOffers } from "../../offers-parse";
import type { ComponentDef, ComponentContext, ComponentResult } from "../types";

export const sellers: ComponentDef = {
  n: 11, key: "11_sellers", name: "Seller count", tier: "hourly", kind: "derived",
  call: "rides CALL-6 (Summary.NumberOfOffers)",
  async run(ctx: ComponentContext): Promise<ComponentResult> {
    const parsed = ctx.cache.get(PRICES_PARSED) as Map<string, ParsedOffers> | undefined;
    if (!parsed) {
      // Resumed after 10 completed: the counts live on the rows already.
      const r = await ctx.query(
        `SELECT count(*) FILTER (WHERE sellers_fba IS NOT NULL OR sellers_fbm IS NOT NULL)::int AS with_count, count(*)::int AS total
           FROM asin_estimates WHERE asin = ANY($1::text[])`, [ctx.scopeAsins],
      );
      return { counts: { with_count: Number(r.rows[0]?.with_count ?? 0), total: Number(r.rows[0]?.total ?? 0), from_rows: 1 }, outcomes: {} };
    }
    const counts = { with_count: 0, zero_sellers: 0, not_fetched: 0 };
    const outcomes: Record<string, string> = {};
    for (const asin of ctx.scopeAsins) {
      const p = parsed.get(asin);
      if (!p) { counts.not_fetched++; continue; }
      if (p.sellersFba + p.sellersFbm === 0) { counts.zero_sellers++; outcomes[asin] = "no_sellers"; }
      else counts.with_count++;
    }
    return { counts, outcomes };
  },
};
