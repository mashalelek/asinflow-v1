// 30. Claim timers (hourly tier: the 00:00 pass and every hourly pass) —
// SPEC §22 "Supplier claims" (D7, commit 2, Maria 2026-11-11). The one
// 5-business-day timer: an open claim with NO open task whose timer ran
// out gets follow_up_supplier (Waiting on supplier) or check_on_it with the
// reason, once, so the Claims page, the POs list's Claims column and the
// Dashboard agree without anyone opening /claims (the page load runs the
// same sweep). No API call: AF tables only. Scheduled passes only; the
// manual entry is the Claims page itself.
import { sweepClaimTimers } from "../../claim-buckets";
import type { ComponentDef, ComponentContext, ComponentResult } from "../types";

/** Test seam. */
export const claimTimerDeps = { sweep: sweepClaimTimers };

export const claimTimers: ComponentDef = {
  n: 30, key: "30_claim_timers", name: "Claim timers", tier: "hourly", kind: "account",
  call: "none (AF tables: supplier_claims, supplier_claim_tasks)",
  async run(ctx: ComponentContext): Promise<ComponentResult> {
    const created = await claimTimerDeps.sweep(ctx.query, new Date(), null);
    const counts: Record<string, number> = { created: created.length, follow_up_supplier: 0, check_on_it: 0 };
    const outcomes: Record<string, string> = {};
    for (const c of created) { counts[c.kind] = (counts[c.kind] ?? 0) + 1; outcomes[`claim ${c.claim_id}`] = `${c.kind}: ${c.reason}`; }
    if (created.length) ctx.log(`claim timers: ${created.length} task${created.length === 1 ? "" : "s"} created (${counts.follow_up_supplier} follow up, ${counts.check_on_it} check on it)`);
    return { counts, outcomes };
  },
};
