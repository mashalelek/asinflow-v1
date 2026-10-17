// 9. Actual COGS from the PO sheet (hourly). CALL-5 Orders Google Sheet via
// runSheetsSync. Since 2026-10-17 (patch asins-on-order-from-pos) it writes
// COGS / prep only — ordered_qty is derived from the PO tables, so the
// old "must precede inventory (15)" ordering constraint and the clearing
// pass are gone (`cleared` is always 0). Scheduled scope = the full sheet;
// a scoped job syncs its ASINs only.
import type { ComponentDef, ComponentContext, ComponentResult } from "../types";

export const poSheet: ComponentDef = {
  n: 9, key: "09_po_sheet", name: "Actual COGS from PO sheet", tier: "hourly", kind: "account",
  call: "CALL-5 Orders sheet",
  async run(ctx: ComponentContext): Promise<ComponentResult> {
    const run = ctx.cache.get("runSheetsSync") as ((filter?: ReadonlySet<string>) => Promise<{ updated: number; skipped: number; errors: string[]; cleared: number; clearedAsins: string[] }>) | undefined;
    if (!run) throw new Error("runSheetsSync is not injected into the runner");
    const filter = ctx.job.scope_asins ? new Set(ctx.scopeAsins) : undefined;
    const r = await run(filter);
    const outcomes: Record<string, string> = {};
    for (const a of r.clearedAsins) outcomes[a] = "ordered_qty cleared (no sheet rows)";
    for (const e of r.errors) outcomes[e.split(":")[0] || "_sheet"] = `error: ${e}`;
    return { counts: { updated: r.updated, skipped: r.skipped, cleared: r.cleared, errors: r.errors.length }, outcomes };
  },
};
