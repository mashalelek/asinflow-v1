// 17. Primary SKU (hourly, derived). No call of its own: the primary is
// re-pointed inside 15 (bootstrap when none exists) and 16 (latest-live-
// wins, discovery, phase-b bootstrap) and by Add to SC. This row makes the
// re-points of this pass answerable from the ledger.
import { INVENTORY_RESULT } from "./15-inventory";
import { LISTINGS_REPORTS } from "./16-live-offer";
import type { FullScopeReport } from "../../full-scope-pass";
import type { ComponentDef, ComponentContext, ComponentResult } from "../types";

export const primarySku: ComponentDef = {
  n: 17, key: "17_primary_sku", name: "Primary SKU", tier: "hourly", kind: "derived",
  call: "derived from 15 and 16",
  async run(ctx: ComponentContext): Promise<ComponentResult> {
    const inv = ctx.cache.get(INVENTORY_RESULT) as { primaryBootstrapped: number } | undefined;
    const reports = (ctx.cache.get(LISTINGS_REPORTS) as FullScopeReport[] | undefined) ?? [];
    const counts = { bootstrapped_by_inventory: inv?.primaryBootstrapped ?? 0, repointed_by_listings: 0, discovered_skus: 0, from_cache: inv || reports.length ? 1 : 0 };
    const outcomes: Record<string, string> = {};
    for (const rep of reports) {
      for (const rp of rep.phaseA.repoints) { counts.repointed_by_listings++; outcomes[rp.asin] = `repoint: ${rp.from ?? "∅"} -> ${rp.to}`; }
      for (const d of rep.phaseA.discoveries) { counts.discovered_skus += d.skus.length; outcomes[d.asin] = `${outcomes[d.asin] ? outcomes[d.asin] + "; " : ""}discovered ${d.skus.join(", ")}`; }
      for (const d of rep.phaseB.discovered) { counts.discovered_skus += d.skus.length; outcomes[d.asin] = `discovered ${d.skus.join(", ")}`; }
    }
    const without = await ctx.query(
      `SELECT count(*)::int AS n FROM asins a WHERE a.asin = ANY($1::text[]) AND a.primary_sku IS NULL
          AND EXISTS (SELECT 1 FROM asin_skus s WHERE s.asin_id = a.id)`, [ctx.scopeAsins],
    );
    return { counts: { ...counts, skus_but_no_primary: Number(without.rows[0]?.n ?? 0) }, outcomes };
  },
};
