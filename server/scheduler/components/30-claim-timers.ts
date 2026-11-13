// 30. Claim timers (hourly tier: the 00:00 pass and every hourly pass) —
// SPEC §22 "Supplier claims" (D7, commit 2, Maria 2026-11-11). The one
// 5-business-day timer: an open claim with NO open task whose timer ran
// out gets follow_up_supplier (Waiting on supplier) or check_on_it with the
// reason, once, so the Claims page, the POs list's Claims column and the
// Dashboard agree without anyone opening /claims (the page load runs the
// same sweep). No API call: AF tables only. Scheduled passes only; the
// manual entry is the Claims page itself.
// Commit 5 (2026-11-12): the same pass also FINDS claims (claims patch §3.1, D8) — missing / never_received
// suggestions from the tracking and Velocity figures (claim-suggestions.ts) and canceled suggestions from the
// cancellation emails of the last hours (cancellation-emails.ts, Gmail; the AI fallback for free text). Suggested
// only: nothing changes a PO until Maria opens one.
import { sweepClaimTimers } from "../../claim-buckets";
import { sweepSuggestions } from "../../claim-suggestions";
import { ingestCancellations } from "../../cancellation-emails";
import { gmailClient } from "../../gmail-client";
import { ingestClaimEmails } from "../../claim-emails";
import { driveClient } from "../../drive-client";
import type { ComponentDef, ComponentContext, ComponentResult } from "../types";

/** Test seam. */
export const claimTimerDeps = { sweep: sweepClaimTimers, suggest: sweepSuggestions, cancellations: ingestCancellations, gmail: gmailClient, emails: ingestClaimEmails, drive: driveClient };

export const claimTimers: ComponentDef = {
  n: 30, key: "30_claim_timers", name: "Claim timers", tier: "hourly", kind: "account",
  call: "none (AF tables: supplier_claims, supplier_claim_tasks) · Gmail list/get for cancellation emails · Haiku for free text",
  async run(ctx: ComponentContext): Promise<ComponentResult> {
    const now = new Date();
    const created = await claimTimerDeps.sweep(ctx.query, now, null);
    const counts: Record<string, number> = { created: created.length, follow_up_supplier: 0, check_on_it: 0 };
    const outcomes: Record<string, string> = {};
    for (const c of created) { counts[c.kind] = (counts[c.kind] ?? 0) + 1; outcomes[`claim ${c.claim_id}`] = `${c.kind}: ${c.reason}`; }
    if (created.length) ctx.log(`claim timers: ${created.length} task${created.length === 1 ? "" : "s"} created (${counts.follow_up_supplier} follow up, ${counts.check_on_it} check on it)`);
    // Auto-found claims (commit 5): suggestions only.
    const s = await claimTimerDeps.suggest(ctx.query, now);
    counts.suggested = s.created;
    for (const x of s.suggestions) if (x.outcome === "created") outcomes[`suggested ${x.kind} ${x.order_id}`] = x.reason.slice(0, 200);
    let emails = 0;
    try {
      const c = await claimTimerDeps.cancellations({ query: ctx.query, deps: { gmail: claimTimerDeps.gmail() }, now, log: ctx.log });
      counts.cancellation_emails_scanned = c.scanned; counts.cancellation_candidates = c.candidates; counts.suggested_canceled = c.created; counts.cancellation_ai_calls = c.ai_calls;
      emails = c.created;
      for (const row of c.rows) for (const x of row.suggestions) if (x.outcome === "created") outcomes[`suggested canceled ${x.order_id}`] = x.reason.slice(0, 200);
    } catch (e: any) {
      outcomes._cancellation_emails = `error: ${e?.message ?? e}`;
      counts.cancellation_errors = 1;
    }
    if (s.created || emails) ctx.log(`claim suggestions: ${s.created} from tracking / Velocity, ${emails} from cancellation emails`);
    // Supplier emails (commit 6, §3.11): refund / credit confirmations, replies, labels, Maria's own emails — the rows of the table.
    try {
      let drive: ReturnType<typeof driveClient> | null = null;
      try { drive = claimTimerDeps.drive(); } catch { drive = null; }
      const m = await claimTimerDeps.emails({ query: ctx.query, deps: { gmailFor: (mb) => claimTimerDeps.gmail(mb), drive }, now, log: ctx.log });
      counts.claim_emails_scanned = m.scanned; counts.claim_emails_applied = m.applied; counts.claim_email_ai_calls = m.ai_calls;
      for (const r of m.rows) if (r.applied && !/^already|^nothing/.test(r.applied)) outcomes[`email row ${r.row} ${r.gmail_message_id}`] = `${r.applied}`.slice(0, 200);
      if (m.applied) ctx.log(`claim emails: ${m.applied} applied of ${m.scanned} scanned (${Object.entries(m.counts).map(([k, v]) => `row ${k}: ${v}`).join(", ")})`);
    } catch (e: any) {
      outcomes._claim_emails = `error: ${e?.message ?? e}`;
      counts.claim_email_errors = 1;
    }
    return { counts, outcomes };
  },
};
