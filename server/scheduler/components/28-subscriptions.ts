// 28. Subscription alerts (daily, 00:00 pass) — patch po-ai-prefill §9,
// SPEC §27. "Subscription renews" on the last PO's lines while the next
// order is within 7 days (and not more than 14 days overdue); cleared when
// the subscription is paused / canceled or a renewal PO exists. Renewal
// POs themselves are created by component 27 (from the confirmation email).
import { runSubscriptionAlerts } from "../../subscriptions";
import { ymdLocal } from "./shared";
import type { ComponentDef, ComponentContext, ComponentResult } from "../types";

export const subscriptionAlerts: ComponentDef = {
  n: 28, key: "28_subscriptions", name: "Subscription alerts", tier: "daily", kind: "account",
  call: "none (AF tables)",
  async run(ctx: ComponentContext): Promise<ComponentResult> {
    const r = await runSubscriptionAlerts(ctx.query, ymdLocal(new Date()));
    return { counts: { due: r.due, raised: r.raised, cleared: r.cleared, overdue: r.overdue }, outcomes: {} };
  },
};
