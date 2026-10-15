// 6. Dangerous good (daily, rides CALL-2). attributes.hazmat array present
// and non-empty → TRUE; a parsed response always answers (true/false); an
// absent or inconclusive entry writes nothing (COALESCE keeps the prior).
import { getCatalogResults } from "./shared";
import type { ComponentDef, ComponentContext, ComponentResult } from "../types";

export const dangerousGood: ComponentDef = {
  n: 6, key: "06_dangerous_good", name: "Dangerous good", tier: "daily", kind: "derived",
  call: "rides CALL-2 (attributes.hazmat)",
  async run(ctx: ComponentContext): Promise<ComponentResult> {
    const results = await getCatalogResults(ctx);
    const prior = new Map<string, boolean | null>(
      (await ctx.query(`SELECT asin, is_dangerous_good FROM asins WHERE asin = ANY($1::text[])`, [ctx.scopeAsins]))
        .rows.map((r: any) => [String(r.asin), r.is_dangerous_good]),
    );
    const counts = { dg: 0, not_dg: 0, flips: 0, inconclusive: 0 };
    const outcomes: Record<string, string> = {};
    for (const asin of ctx.scopeAsins) {
      const e = results.get(asin);
      if (e?.kind !== "parsed" || e.data.isDangerousGood == null) { counts.inconclusive++; continue; }
      const v = e.data.isDangerousGood === true;
      await ctx.query(`UPDATE asins SET is_dangerous_good = $2 WHERE asin = $1`, [asin, v]);
      if (v) counts.dg++; else counts.not_dg++;
      const was = prior.get(asin);
      if (was != null && was !== v) { counts.flips++; outcomes[asin] = `flip: ${was} -> ${v}`; }
    }
    return { counts, outcomes };
  },
};
