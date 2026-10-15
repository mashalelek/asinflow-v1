// 8. Eligibility / gating (daily). CALL-4 Listings Restrictions per ASIN.
// Only restrictions[].length is kept: empty → yes, otherwise → no. A failed
// probe writes nothing and moves no stamp. gated↔ungated flips feed the
// completion notification (decision 16).
import { getEligibility } from "../../spapi";
import { forEachAsin } from "./shared";
import { flip } from "../runner";
import type { ComponentDef, ComponentContext, ComponentResult, Flip } from "../types";

export const gating: ComponentDef = {
  n: 8, key: "08_gating", name: "Eligibility / gating", tier: "daily", kind: "asin",
  call: "CALL-4 Listings Restrictions, per ASIN",
  async run(ctx: ComponentContext): Promise<ComponentResult> {
    const prior = new Map<string, string | null>(
      (await ctx.query(`SELECT asin, eligibility_status FROM asin_estimates WHERE asin = ANY($1::text[])`, [ctx.asins]))
        .rows.map((r: any) => [String(r.asin), r.eligibility_status]),
    );
    const counts = { updated: 0, yes: 0, no: 0, flips: 0, error: 0, missing_row: 0 };
    const outcomes: Record<string, string> = {};
    const flips: Flip[] = [];
    await forEachAsin(ctx, async (asin) => {
      const p = await getEligibility(asin);
      if (p.kind !== "ok") { counts.error++; outcomes[asin] = `error: ${p.message}`; return; }
      const r = await ctx.query(`UPDATE asin_estimates SET eligibility_status = $2 WHERE asin = $1`, [asin, p.status]);
      if ((r.rowCount ?? 0) === 0) { counts.missing_row++; outcomes[asin] = "error: no asin_estimates row"; return; }
      await ctx.query(`UPDATE asins SET gating_checked_at = NOW() WHERE asin = $1`, [asin]);
      counts.updated++;
      if (p.status === "yes") counts.yes++; else counts.no++;
      const was = prior.get(asin) ?? null;
      if (was != null && was !== "check" && was !== p.status) {
        counts.flips++;
        outcomes[asin] = `flip: ${was} -> ${p.status}`;
        flips.push(flip(asin, "gating", was === "yes" ? "ungated" : "gated", p.status === "yes" ? "ungated" : "gated"));
      }
    });
    return { counts, outcomes, flips };
  },
};
