// 16. Live offer / buyable / current issues (hourly). CALL-9 getListingsItem
// per SKU through runFullScopePass phases a + b (phase c is component 1).
// Scheduled scope is active + parked (decision 10) via the explicit filter;
// runFullScopePass itself keeps NO status filter (§18 A3), so a manual
// Refresh with dead rows on screen can still correct a frozen flag.
//
// Listing hygiene (2026-10-19): the probe also reads `attributes` and writes
// each SKU's listing state (asin_skus.listing_created_at / offer_end_at /
// listing_checked_at — owner: this component only).
import { runFullScopePass, type FullScopeReport } from "../../full-scope-pass";
import { ASIN_CHECKPOINT_EVERY } from "../types";
import { chunk } from "./shared";
import { verifyListingActions } from "../../listing-hygiene";
import type { ComponentDef, ComponentContext, ComponentResult } from "../types";

export const LISTINGS_REPORTS = "listings:reports";

export const liveOffer: ComponentDef = {
  n: 16, key: "16_live_offer", name: "Live offer / buyable / issues", tier: "hourly", kind: "asin",
  call: "CALL-9 getListingsItem, per SKU",
  async run(ctx: ComponentContext): Promise<ComponentResult> {
    const counts = { probed: 0, live: 0, no_offer: 0, transient: 0, flips: 0, repoints: 0, discoveries: 0, no_listing: 0 };
    const outcomes: Record<string, string> = {};
    const reports: FullScopeReport[] = (ctx.cache.get(LISTINGS_REPORTS) as FullScopeReport[] | undefined) ?? [];
    const startedAt = new Date();
    for (const part of chunk(ctx.asins, ASIN_CHECKPOINT_EVERY)) {
      const rep = await runFullScopePass({ dryRun: false, asinFilter: new Set(part), phaseC: false, recordListingState: true });
      reports.push(rep);
      const a = rep.phaseA, b = rep.phaseB;
      counts.probed += a.asins + b.asins; counts.live += a.live; counts.no_offer += a.noOffer;
      counts.transient += a.transientSkipped + b.transientSkipped;
      counts.flips += a.flips.length; counts.repoints += a.repoints.length;
      counts.discoveries += a.discoveries.length + b.discovered.length; counts.no_listing += b.noListing;
      Object.assign(outcomes, rep.outcomes);
      await ctx.checkpoint(part[part.length - 1]);
    }
    ctx.cache.set(LISTINGS_REPORTS, reports);
    // Listing hygiene: accepted closes / deletes whose SKU this run probed are
    // verified (or count a pass toward not_effective).
    const v = await verifyListingActions(ctx.query, startedAt);
    Object.assign(counts, { actions_verified: v.verified, actions_pending: v.pending, actions_not_effective: v.not_effective });
    return { counts, outcomes };
  },
};
