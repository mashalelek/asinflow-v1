// 18. Suppressions, FYP report (hourly, account). CALL-10. Rewritten as
// stage-then-swap in suppression-sync.ts: the report's ASIN set lands in a
// temp table and ONE update sets every row's flag from it — no window in
// which the catalog shows no suppressions, crash-safe. suppressed↔
// unsuppressed flips feed the completion notification (decision 16).
import { syncSuppressionData } from "../../suppression-sync";
import { flip } from "../runner";
import type { ComponentDef, ComponentContext, ComponentResult, Flip } from "../types";

export const suppressions: ComponentDef = {
  n: 18, key: "18_suppressions", name: "Suppressions (FYP)", tier: "hourly", kind: "account",
  call: "CALL-10 FYP report (account)",
  async run(_ctx: ComponentContext): Promise<ComponentResult> {
    const r = await syncSuppressionData();
    const outcomes: Record<string, string> = {};
    const flips: Flip[] = [];
    for (const f of r.flips) {
      outcomes[f.asin] = `flip: ${f.from ? "suppressed" : "clear"} -> ${f.to ? "suppressed" : "clear"}`;
      flips.push(flip(f.asin, "suppression", f.from ? "suppressed" : "unsuppressed", f.to ? "suppressed" : "unsuppressed"));
    }
    return { counts: { in_report: r.inReport, suppressed: r.suppressed, newly_suppressed: r.newlySuppressed, cleared: r.cleared }, outcomes, flips };
  },
};
