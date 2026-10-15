// 7. Hazmat, FBA inbound program (daily). CALL-3 getItemEligibilityPreview
// per ASIN. Every ASIN in scope, every pass — no freshness cache
// (decision 3). A failed probe writes nothing and moves no stamp.
import { getInboundHazmat } from "../../inbound-hazmat";
import { forEachAsin } from "./shared";
import type { ComponentDef, ComponentContext, ComponentResult } from "../types";

export const hazmat: ComponentDef = {
  n: 7, key: "07_hazmat", name: "Hazmat (FBA inbound)", tier: "daily", kind: "asin",
  call: "CALL-3 inbound eligibility itemPreview, per ASIN",
  async run(ctx: ComponentContext): Promise<ComponentResult> {
    const prior = new Map<string, boolean | null>(
      (await ctx.query(`SELECT asin, is_hazmat FROM asins WHERE asin = ANY($1::text[])`, [ctx.asins]))
        .rows.map((r: any) => [String(r.asin), r.is_hazmat]),
    );
    const counts = { updated: 0, hazmat: 0, flips: 0, error: 0 };
    const outcomes: Record<string, string> = {};
    await forEachAsin(ctx, async (asin) => {
      const p = await getInboundHazmat(asin);
      if (p.kind !== "ok") { counts.error++; outcomes[asin] = `error: ${p.message}`; return; }
      await ctx.query(`UPDATE asins SET is_hazmat = $2, hazmat_checked_at = NOW() WHERE asin = $1`, [asin, p.isHazmat]);
      counts.updated++;
      if (p.isHazmat) counts.hazmat++;
      const was = prior.get(asin);
      if (was != null && was !== p.isHazmat) { counts.flips++; outcomes[asin] = `flip: ${was} -> ${p.isHazmat}`; }
    });
    return { counts, outcomes };
  },
};
