// 26. PO tracking push (daily, 00:00 pass, right after 25) — SPEC §26.
// Tracking-only (D1, the one scheduled Velocity write, SPEC §14): adds
// tracking numbers to existing inbound pending / partially_received orders;
// never creates an order, never changes a quantity. Scheduled pass only; the
// manual trigger is POs → Sync tracking.
import { pushTracking } from "../../tracking-push";
import type { ComponentDef, ComponentContext, ComponentResult } from "../types";

export const poTrackingPush: ComponentDef = {
  n: 26, key: "26_po_tracking_push", name: "PO tracking push", tier: "daily", kind: "account",
  call: "Velocity GET /inbound (+ inventory, shipments) · GET / PUT /inbound/:order_id",
  async run(ctx: ComponentContext): Promise<ComponentResult> {
    const r = await pushTracking({ query: ctx.query, log: ctx.log });
    const outcomes: Record<string, string> = {};
    for (const p of r.plans) {
      const added = p.targets.filter((t) => t.to_add.length).map((t) => `${t.velocity_order_id}+${t.to_add.join(",")}`);
      const review = p.rows.filter((x) => x.decision === "review").map((x) => `${x.tracking_number}: ${x.reasons.join("; ")}`);
      if (added.length || review.length) outcomes[p.order_id] = [...added, ...review].join(" | ");
    }
    return {
      counts: { rows: r.rows_evaluated, pushed: r.pushed, already_present: r.already_present, push_failed: r.push_failed, held: r.held, review: r.review, received_by_velocity: r.received_by_velocity, puts: r.puts, put_errors: r.put_errors },
      outcomes,
    };
  },
};
