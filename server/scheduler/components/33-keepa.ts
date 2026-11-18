// 33. Keepa history — Keepa jobs ONLY (lane K; docs/claude_spec-patch-keepa-trends.md "Fetching: lane K", 2026-11-18).
// Never part of a scheduled pass, the Refresh button, an onboarding job or Bulk Calc: `planFor` in the runner gives
// a Keepa job this component alone and strips it from every refresh job. The daily Keepa job covers every active +
// parked ASIN (scope NULL → the scheduled rule); a new-ASIN job the ASINs just inserted. Body in server/keepa.ts.
import { runKeepaJob } from "../../keepa";
import type { ComponentDef, ComponentContext, ComponentResult } from "../types";

export const keepaHistory: ComponentDef = {
  n: 33, key: "33_keepa", name: "Keepa history", tier: "daily", kind: "batch",
  call: "Keepa GET /product (≤ 20 ASINs, buybox=1, rating=1; never offers)",
  async run(ctx: ComponentContext): Promise<ComponentResult> {
    return runKeepaJob(ctx, "33_keepa");
  },
};
