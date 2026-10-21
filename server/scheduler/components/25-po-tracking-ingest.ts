// 25. PO tracking ingest (daily, 00:00 pass) — SPEC §26. Gmail (orders@,
// service account + DWD) → po_tracking, then matching to AF POs. After Sync
// POs (9) so a PO entered today exists before matching. Scheduled pass only
// (SCHEDULED_ONLY_COMPONENTS); the manual trigger is POs → Sync tracking.
// A Gmail failure is recorded, not thrown: 26 still evaluates the rows that
// already exist.
import { gmailClient } from "../../gmail-client";
import { ingestTracking } from "../../tracking-ingest";
import { matchTrackingRows } from "../../tracking-match";
import type { ComponentDef, ComponentContext, ComponentResult } from "../types";

/** Test seam. */
export const trackingIngestDeps = { gmail: () => gmailClient() };

export const poTrackingIngest: ComponentDef = {
  n: 25, key: "25_po_tracking_ingest", name: "PO tracking ingest", tier: "daily", kind: "account",
  call: "Gmail API users.messages (orders@, gmail.readonly)",
  async run(ctx: ComponentContext): Promise<ComponentResult> {
    const counts: Record<string, number> = {};
    const outcomes: Record<string, string> = {};
    try {
      const r = await ingestTracking({ query: ctx.query, deps: { gmail: trackingIngestDeps.gmail() }, log: ctx.log });
      Object.assign(counts, { scanned: r.scanned, candidates: r.candidates, rows: r.rows, inserted: r.inserted, refreshed: r.refreshed, placeholders: r.placeholders, link_resolved: r.link_resolved, placeholders_resolved: r.placeholders_resolved ?? 0 });
      outcomes._window = `${r.since ?? "start"}..${r.until}`;
    } catch (err: any) {
      counts.failed = 1;
      outcomes._ingest = `error: ${err?.message ?? err}`;
      ctx.log(outcomes._ingest);
    }
    const m = await matchTrackingRows(ctx.query);
    Object.assign(counts, { matched: m.matched, ...Object.fromEntries(Object.entries(m.unmatched).map(([k, v]) => [`unmatched_${k}`, v])) });
    if (Object.keys(m.seeded).length) outcomes._domain_map_seeded = Object.entries(m.seeded).map(([d, s]) => `${d}→${s}`).join(", ");
    return { counts, outcomes };
  },
};
