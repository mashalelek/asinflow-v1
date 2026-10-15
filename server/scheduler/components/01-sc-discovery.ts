// 1. SC-only SKU discovery + onboarding (hourly, runs FIRST in every pass —
// decision 8). CALL-1 searchListingsItems, account scope.
//
// Pulls the whole account listing, finds ASINs Seller Central has that AF
// does not, and onboards them through the injected callback (the routes
// layer's onboardScDiscoveries — the ONE insert path). This is what the old
// cron could not do: the callback is now injected into the runner, so
// schedule and button share one entry point.
import { fetchAllAccountListings } from "../../sc-discovery";
import { resolveForOnboard } from "../../full-scope-pass";
import type { ComponentDef, ComponentContext, ComponentResult } from "../types";

export const scDiscovery: ComponentDef = {
  n: 1, key: "01_sc_discovery", name: "SC-only SKU discovery + onboarding", tier: "hourly", kind: "account",
  call: "CALL-1 searchListingsItems (account)",
  async run(ctx: ComponentContext): Promise<ComponentResult> {
    const pull = await fetchAllAccountListings(ctx.sellerId);
    if (!pull.ok) {
      // A partial pull onboards NOTHING (§18 phase c).
      ctx.log(`sc_list_incomplete after ${pull.pagesFetched} page(s): ${pull.detail}`);
      return { counts: { sc_list_incomplete: 1, onboarded: 0 }, outcomes: { _phase_c: `error: sc_list_incomplete — ${pull.detail}` } };
    }
    const skusByAsin = new Map<string, string[]>();
    for (const l of pull.listings) {
      const arr = skusByAsin.get(l.asin) ?? [];
      arr.push(l.sku);
      skusByAsin.set(l.asin, arr);
    }
    const scAsins = Array.from(skusByAsin.keys());
    const known = new Set(
      (await ctx.query(`SELECT asin FROM asins WHERE asin = ANY($1::text[])`, [scAsins])).rows.map((r: any) => String(r.asin)),
    );
    const missing = scAsins.filter((a) => !known.has(a));
    const resolved = missing.length > 0 ? await resolveForOnboard(missing, skusByAsin, ctx.query) : [];

    const outcomes: Record<string, string> = {};
    let onboarded = 0;
    if (resolved.length > 0) {
      const onboard = ctx.cache.get("onboardScDiscoveries") as ((rows: typeof resolved) => Promise<void>) | undefined;
      if (!onboard) {
        ctx.log(`${resolved.length} SC-only ASIN(s) found but no onboarding callback is injected — reported, not onboarded`);
        for (const r of resolved) outcomes[r.asin] = `found_not_onboarded · SKUs ${r.skus.join(", ")}`;
      } else {
        await onboard(resolved);
        onboarded = resolved.length;
        for (const r of resolved) outcomes[r.asin] = `onboarded · SKUs ${r.skus.join(", ")} · COGS ${r.cogsSource} · link ${r.buyLinkSource}`;
      }
    }
    ctx.log(`${pull.pages} pages, ${pull.listings.length} listings, ${scAsins.length} ASINs, ${known.size} already in AF, ${onboarded} onboarded`);
    return {
      counts: { sc_listings: pull.listings.length, sc_asins: scAsins.length, already_in_af: known.size, onboarded },
      outcomes,
    };
  },
};
