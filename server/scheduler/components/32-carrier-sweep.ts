// 32. Carrier sweep — EasyPost backstop (daily, 00:00 pass) — SPEC §26 "Carrier status — EasyPost" (claims
// patch §3.9, commit 4). Webhooks carry the updates; this re-reads (GET /trackers/:id) every registered,
// undelivered tracker AF has not heard about for 3 days, in case one was missed. Stops once delivered or 60
// days old. Scheduled passes only; no key → skipped with a note.
import { sweepTrackers, easypostMode } from "../../easypost";
import type { ComponentDef, ComponentContext, ComponentResult } from "../types";

/** Test seam. */
export const carrierSweepDeps = { sweep: sweepTrackers, mode: easypostMode };

export const carrierSweep: ComponentDef = {
  n: 32, key: "32_carrier_sweep", name: "Carrier sweep (EasyPost)", tier: "daily", kind: "account",
  call: "EasyPost GET /v2/trackers/:id",
  async run(ctx: ComponentContext): Promise<ComponentResult> {
    const mode = carrierSweepDeps.mode();
    if (mode === "off") { ctx.log("carrier sweep: EASYPOST_API_KEY not set — skipped"); return { counts: { skipped_no_key: 1 }, outcomes: {} }; }
    const r = await carrierSweepDeps.sweep(ctx.query, new Date());
    const counts: Record<string, number> = { checked: r.checked, rows_updated: r.rows_updated, errors: r.errors };
    for (const [k, v] of Object.entries(r.skipped)) counts[`skipped_${k}`] = v;
    if (r.checked || r.errors) ctx.log(`carrier sweep (${mode}): ${r.checked} tracker(s) re-read, ${r.errors} error(s)`);
    return { counts, outcomes: r.outcomes };
  },
};
