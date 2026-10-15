// 3. Catalog-deleted signal (daily, rides CALL-2). An ASIN absent from a
// COMPLETE batch response is catalog-deleted (DA-2); present = alive;
// inconclusive = no write. applyCatalogDeletedSignal owns the auto-dead
// transition and never un-archives (the Revive dialog does).
import { applyCatalogDeletedSignal } from "../../catalog-deleted-write";
import { getCatalogResults } from "./shared";
import type { ComponentDef, ComponentContext, ComponentResult } from "../types";

export const catalogDeleted: ComponentDef = {
  n: 3, key: "03_catalog_deleted", name: "Catalog-deleted signal", tier: "daily", kind: "derived",
  call: "rides CALL-2",
  async run(ctx: ComponentContext): Promise<ComponentResult> {
    const results = await getCatalogResults(ctx);
    const prior = new Map<string, boolean>(
      (await ctx.query(`SELECT asin, is_catalog_deleted FROM asins WHERE asin = ANY($1::text[])`, [ctx.scopeAsins]))
        .rows.map((r: any) => [String(r.asin), r.is_catalog_deleted === true]),
    );
    const counts = { alive: 0, deleted: 0, newly_deleted: 0, restored: 0, inconclusive: 0 };
    const outcomes: Record<string, string> = {};
    for (const asin of ctx.scopeAsins) {
      const e = results.get(asin);
      const signal: boolean | null = e?.kind === "parsed" ? false : e?.kind === "absent" ? true : null;
      if (signal == null) { counts.inconclusive++; continue; }
      await applyCatalogDeletedSignal(asin, signal, ctx.query as any);
      const was = prior.get(asin) ?? false;
      if (signal) {
        counts.deleted++;
        if (!was) { counts.newly_deleted++; outcomes[asin] = "flip: alive -> catalog_deleted (status dead)"; }
      } else {
        counts.alive++;
        if (was) { counts.restored++; outcomes[asin] = "flip: catalog_deleted -> alive (revive via dialog)"; }
      }
    }
    return { counts, outcomes };
  },
};
