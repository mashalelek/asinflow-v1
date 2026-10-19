// 15. FBA inventory snapshot (hourly). CALL-8 getInventorySummaries — one
// paginated account call; the scope decides which ASINs' rows are written.
// Creates asin_skus rows and bootstraps a primary SKU where none exists,
// which is why it MUST precede 16 (listings need the SKU set). Not
// resumable mid-way (one account call); reruns whole on resume.
//
// Listing hygiene (2026-10-19): also the ONLY writer of sku_fba_inventory —
// every FBA bucket per SKU, account-wide, after a complete pull (a failed
// page throws, so an incomplete pull writes nothing and the job stops here;
// component 22 never runs on it).
import { syncInventory } from "../../inventory-sync";
import type { ComponentDef, ComponentContext, ComponentResult } from "../types";

export const INVENTORY_RESULT = "inventory:result";

export const inventory: ComponentDef = {
  n: 15, key: "15_inventory", name: "FBA inventory snapshot", tier: "hourly", kind: "account",
  call: "CALL-8 inventory summaries (account, paginated)",
  async run(ctx: ComponentContext): Promise<ComponentResult> {
    const r = await syncInventory(new Set(ctx.scopeAsins), { recordSkuBuckets: true, jobId: ctx.job.id });
    ctx.cache.set(INVENTORY_RESULT, r);
    return { counts: { synced: r.synced, skipped: r.skipped, primary_bootstrapped: r.primaryBootstrapped, sku_rows: r.skuRows ?? 0, sku_zero_filled: r.skuZeroFilled ?? 0 }, outcomes: {} };
  },
};
