// 4. BSR / rank + category (daily, rides CALL-2). Writes asin_estimates.bsr
// and bsr_category (COALESCE: a missing rank never blanks a known one),
// asins.category, and one asin_estimates_history row per ASIN per daily
// pass (the seller/price/BSR trend snapshot Product Info used to write).
import { getCatalogResults } from "./shared";
import type { ComponentDef, ComponentContext, ComponentResult } from "../types";

export const bsr: ComponentDef = {
  n: 4, key: "04_bsr", name: "BSR / rank + category", tier: "daily", kind: "derived",
  call: "rides CALL-2 (salesRanks)",
  async run(ctx: ComponentContext): Promise<ComponentResult> {
    const results = await getCatalogResults(ctx);
    const counts = { updated: 0, no_rank: 0, inconclusive: 0, history_rows: 0 };
    const outcomes: Record<string, string> = {};
    for (const asin of ctx.scopeAsins) {
      const e = results.get(asin);
      if (e?.kind !== "parsed") { counts.inconclusive++; continue; }
      const { bsrRank, bsrCategory } = e.data;
      if (bsrRank == null) { counts.no_rank++; outcomes[asin] = "no_rank"; }
      else counts.updated++;
      await ctx.query(
        `UPDATE asin_estimates SET bsr = COALESCE($2, bsr), bsr_category = COALESCE($3, bsr_category) WHERE asin = $1`,
        [asin, bsrRank, bsrCategory],
      );
      if (bsrCategory) await ctx.query(`UPDATE asins SET category = $2 WHERE asin = $1`, [asin, bsrCategory]);
      const h = await ctx.query(
        `INSERT INTO asin_estimates_history (asin_id, sellers_fba, sellers_fbm, sale_price, bsr)
         SELECT a.id, e.sellers_fba, e.sellers_fbm, COALESCE(e.lowest_fba_price, e.buy_box_price, e.lowest_price), COALESCE($2, e.bsr)
           FROM asins a LEFT JOIN asin_estimates e ON e.asin = a.asin WHERE a.asin = $1`,
        [asin, bsrRank],
      );
      counts.history_rows += h.rowCount ?? 0;
    }
    return { counts, outcomes };
  },
};
