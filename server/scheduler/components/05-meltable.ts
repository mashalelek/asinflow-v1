// 5. Meltable (daily, rides CALL-2). temperature_rating chilled/frozen/
// refriger, is_heat_sensitive, or meltable → TRUE. Written as a latch
// (is_meltable OR new), exactly as before; un-flagging is not in this patch.
import { getCatalogResults } from "./shared";
import type { ComponentDef, ComponentContext, ComponentResult } from "../types";

export const meltable: ComponentDef = {
  n: 5, key: "05_meltable", name: "Meltable", tier: "daily", kind: "derived",
  call: "rides CALL-2 (attributes)",
  async run(ctx: ComponentContext): Promise<ComponentResult> {
    const results = await getCatalogResults(ctx);
    const before = new Set<string>(
      (await ctx.query(`SELECT asin FROM asins WHERE asin = ANY($1::text[]) AND is_meltable = TRUE`, [ctx.scopeAsins]))
        .rows.map((r: any) => String(r.asin)),
    );
    const counts = { meltable: 0, not_meltable: 0, newly_flagged: 0, inconclusive: 0 };
    const outcomes: Record<string, string> = {};
    for (const asin of ctx.scopeAsins) {
      const e = results.get(asin);
      if (e?.kind !== "parsed") { counts.inconclusive++; continue; }
      const m = e.data.isMeltable === true;
      await ctx.query(`UPDATE asins SET is_meltable = (is_meltable OR $2) WHERE asin = $1`, [asin, m]);
      if (m) {
        counts.meltable++;
        if (!before.has(asin)) { counts.newly_flagged++; outcomes[asin] = "flip: not_meltable -> meltable"; }
      } else {
        counts.not_meltable++;
      }
    }
    return { counts, outcomes };
  },
};
