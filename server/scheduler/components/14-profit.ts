// 14. Estimated profit / margin / ROI (hourly, computed). Decision A
// (2026-10-15): PERSISTS NOTHING. Profit is calculated client-side by
// calculateProfit in shared/schema.ts and the server never stores it (SPEC
// §14 "Single recalculation point"). This row records how many ASINs in
// scope now have complete profit inputs — a price, a fee, and a COGS — so
// the ledger says whether the derived view is computable, and names the
// missing input for the rest.
import { NO_ESTIMATES_ROW } from "../step-failures";
import type { ComponentDef, ComponentContext, ComponentResult } from "../types";

export const profit: ComponentDef = {
  n: 14, key: "14_profit", name: "Estimated profit / margin / ROI (client-side)", tier: "hourly", kind: "derived",
  call: "none (computed client-side)",
  async run(ctx: ComponentContext): Promise<ComponentResult> {
    const rows = (await ctx.query(
      `SELECT e.asin,
              (e.lowest_fba_price IS NOT NULL OR e.buy_box_price IS NOT NULL OR e.lowest_price IS NOT NULL) AS has_price,
              (e.fba_fee IS NOT NULL) AS has_fee,
              (COALESCE(e.actual_cogs, e.estimated_cogs) IS NOT NULL) AS has_cogs
         FROM asin_estimates e WHERE e.asin = ANY($1::text[])`, [ctx.scopeAsins],
    )).rows;
    const counts = { complete: 0, incomplete: 0, missing_row: Math.max(0, ctx.scopeAsins.length - rows.length) };
    const outcomes: Record<string, string> = {};
    // A scoped ASIN with no estimates row is named (2026-11-09) — hourly, so it never hides behind the daily gating step.
    const have = new Set(rows.map((r: any) => String(r.asin)));
    for (const asin of ctx.scopeAsins) if (!have.has(asin)) outcomes[asin] = NO_ESTIMATES_ROW;
    for (const r of rows) {
      const missing = [!r.has_price && "price", !r.has_fee && "fee", !r.has_cogs && "cogs"].filter(Boolean);
      if (missing.length === 0) counts.complete++;
      else { counts.incomplete++; outcomes[String(r.asin)] = `incomplete: missing ${missing.join(", ")}`; }
    }
    return { counts, outcomes };
  },
};
