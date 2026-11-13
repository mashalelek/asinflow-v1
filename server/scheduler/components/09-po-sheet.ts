// 9. Actual COGS from AF's POs (hourly) — the BACKSTOP since 2026-11-13 (Orders-sheet retirement commit 1): every PO
// write syncs its own ASINs at once (server/asin-po-costs.ts, syncAsinCostsAfterPoWrite); this pass re-derives the
// whole map so a failed per-request sync is caught up within the hour. It has read AF's PO tables, not the Orders
// sheet, since 2026-10-18 (loadAfAsinCostMap); the key `09_po_sheet` is kept for the ledger's continuity. Since
// 2026-10-17 it writes COGS / prep only — ordered_qty is derived from the PO tables (`cleared` is always 0).
// Scheduled scope = every PO'd ASIN; a scoped job syncs its ASINs only.
import type { ComponentDef, ComponentContext, ComponentResult } from "../types";

export const poSheet: ComponentDef = {
  n: 9, key: "09_po_sheet", name: "Actual COGS from AF POs", tier: "hourly", kind: "account",
  call: "AF PO tables",
  async run(ctx: ComponentContext): Promise<ComponentResult> {
    const run = ctx.cache.get("syncAsinCostsFromPos") as ((filter?: ReadonlySet<string>) => Promise<{ updated: number; skipped: number; errors: string[]; cleared: number; clearedAsins: string[] }>) | undefined;
    if (!run) throw new Error("syncAsinCostsFromPos is not injected into the runner");
    const filter = ctx.job.scope_asins ? new Set(ctx.scopeAsins) : undefined;
    const r = await run(filter);
    const outcomes: Record<string, string> = {};
    for (const a of r.clearedAsins) outcomes[a] = "ordered_qty cleared (no sheet rows)";
    for (const e of r.errors) outcomes[e.split(":")[0] || "_sheet"] = `error: ${e}`;
    return { counts: { updated: r.updated, skipped: r.skipped, cleared: r.cleared, errors: r.errors.length }, outcomes };
  },
};
