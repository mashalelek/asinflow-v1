// 31. Carrier tracking — EasyPost registration (hourly tier: the 00:00 pass and every hourly pass) —
// SPEC §26 "Carrier status — EasyPost" (claims patch §3.9, commit 4). Every open inbound / return tracking
// row whose carrier EasyPost tracks → POST /trackers (idempotent; the tracker id stored on every row carrying
// the number); the POST's answer is applied at once. A row stops being registered once delivered or 60 days
// after it shipped; GLS / OnTrac / LaserShip / OTHER are skipped (Velocity's tracking_status is their fallback).
// Scheduled passes only; no key → skipped with a note.
import { registerTrackers, easypostMode } from "../../easypost";
import type { ComponentDef, ComponentContext, ComponentResult } from "../types";

/** Test seam. */
export const carrierTrackingDeps = { register: registerTrackers, mode: easypostMode };

export const carrierTracking: ComponentDef = {
  n: 31, key: "31_carrier_tracking", name: "Carrier tracking (EasyPost)", tier: "hourly", kind: "account",
  call: "EasyPost POST /v2/trackers",
  async run(ctx: ComponentContext): Promise<ComponentResult> {
    const mode = carrierTrackingDeps.mode();
    if (mode === "off") { ctx.log("carrier tracking: EASYPOST_API_KEY not set — skipped"); return { counts: { skipped_no_key: 1 }, outcomes: {} }; }
    const r = await carrierTrackingDeps.register(ctx.query, new Date());
    const counts: Record<string, number> = { registered: r.registered, rows_updated: r.rows_updated, errors: r.errors };
    for (const [k, v] of Object.entries(r.skipped)) counts[`skipped_${k}`] = v;
    if (r.registered || r.errors) ctx.log(`carrier tracking (${mode}): ${r.registered} tracker(s) registered, ${r.errors} error(s)${r.rate_limited ? " — EasyPost rate-limited the account, the rest waits for the next pass" : ""}${r.no_carrier_account.length ? ` — no carrier account on EasyPost for ${r.no_carrier_account.join(", ")}` : ""}`);
    const outcomes = { ...r.outcomes };
    if (r.no_carrier_account.length) outcomes._no_carrier_account = `EasyPost has no carrier account for ${r.no_carrier_account.join(", ")}: add it under Carrier Accounts; those rows wait`;
    if (r.rate_limited) outcomes._rate_limited = "EasyPost answered 429; the pass stopped, the remaining rows register next hour";
    if (Object.keys(r.carrier_used).length) outcomes._carrier_used = Object.entries(r.carrier_used).map(([k, v]) => `${k} → ${v}`).join(", ");
    return { counts, outcomes };
  },
};
