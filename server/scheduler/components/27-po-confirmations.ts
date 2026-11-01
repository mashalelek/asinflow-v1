// 27. Confirmation-email reconcile (daily, 00:00 pass) — patch po-ai-prefill
// §6.7, SPEC §26. Gmail (orders@) order confirmations vs AF POs: order #,
// total, line count; a difference raises "Confirm order details" on the
// PO's lines. No AI, nothing written to the PO. After the tracking pass
// (25 / 26). Scheduled pass only; the manual trigger is POST
// /api/pos/reconcile-confirmations. A Gmail failure is recorded, not thrown.
import { gmailClient } from "../../gmail-client";
import { reconcileConfirmations } from "../../po-confirm-reconcile";
import { tryRenewalFromEmail } from "../../subscriptions";
import type { ComponentDef, ComponentContext, ComponentResult } from "../types";

/** Test seam. */
export const confirmDeps = { gmail: () => gmailClient() };

export const poConfirmations: ComponentDef = {
  n: 27, key: "27_po_confirmations", name: "PO confirmation reconcile", tier: "daily", kind: "account",
  call: "Gmail API users.messages (orders@, gmail.readonly)",
  async run(ctx: ComponentContext): Promise<ComponentResult> {
    const counts: Record<string, number> = {};
    const outcomes: Record<string, string> = {};
    try {
      const r = await reconcileConfirmations({
        query: ctx.query, log: ctx.log,
        deps: {
          gmail: confirmDeps.gmail(),
          // §27: an unmatched confirmation may be a subscription renewal → a renewal PO with "Review renewal PO".
          onUnmatched: async (msg, p, supplier) => {
            const res = await tryRenewalFromEmail(ctx.query, supplier, { id: msg.id, subject: msg.subject, text: msg.text, date: msg.date, orderId: p.orderIds[0] ?? null, total: p.total });
            if (res.created) outcomes[`renewal ${supplier} ${p.orderIds[0] ?? msg.id}`] = `PO ${res.poId} created — ${res.item}`;
            return res.created;
          },
        },
      });
      Object.assign(counts, { scanned: r.scanned, confirmations: r.confirmations, matched: r.matched, agreed: r.agreed, differed: r.differed, raised: r.raised, unmatched: r.unmatched, ambiguous: r.ambiguous, renewals: r.renewals });
      for (const d of r.diffs) outcomes[`${d.supplier} ${d.order_id}`] = d.differences.join("; ");
      outcomes._window = `${r.since ?? "start"}..${r.until}`;
    } catch (err: any) {
      counts.failed = 1;
      outcomes._reconcile = `error: ${err?.message ?? err}`;
      ctx.log(outcomes._reconcile);
    }
    return { counts, outcomes };
  },
};
