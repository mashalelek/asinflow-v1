// 15. FBA inventory snapshot (hourly). CALL-8 getInventorySummaries — one
// paginated account call; the scope decides which ASINs' rows are written.
// Creates asin_skus rows and bootstraps a primary SKU where none exists,
// which is why it MUST precede 16 (listings need the SKU set). Not
// resumable mid-way (one account call); reruns whole on resume.
import { syncInventory } from "../../inventory-sync";
import type { ComponentDef, ComponentContext, ComponentResult } from "../types";

export const INVENTORY_RESULT = "inventory:result";

export const inventory: ComponentDef = {
  n: 15, key: "15_inventory", name: "FBA inventory snapshot", tier: "hourly", kind: "account",
  call: "CALL-8 inventory summaries (account, paginated)",
  async run(ctx: ComponentContext): Promise<ComponentResult> {
    const r = await syncInventory(new Set(ctx.scopeAsins));
    ctx.cache.set(INVENTORY_RESULT, r);
    return { counts: { synced: r.synced, skipped: r.skipped, primary_bootstrapped: r.primaryBootstrapped }, outcomes: {} };
  },
};
