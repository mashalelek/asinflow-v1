// 8. Eligibility / gating (daily). CALL-4 Listings Restrictions per ASIN.
// The probe itself lives in server/gating-probe.ts — the one writer of
// eligibility_status / gating_checked_at, shared with the Add to SC preview
// (decision 9, inline since 2026-10-16). This file only supplies the
// runner's iteration (checkpoints + cancel).
import { probeGatingForAsins } from "../../gating-probe";
import { forEachAsin } from "./shared";
import type { ComponentDef, ComponentContext, ComponentResult } from "../types";

export const gating: ComponentDef = {
  n: 8, key: "08_gating", name: "Eligibility / gating", tier: "daily", kind: "asin",
  call: "CALL-4 Listings Restrictions, per ASIN",
  async run(ctx: ComponentContext): Promise<ComponentResult> {
    const r = await probeGatingForAsins(ctx.asins, {
      query: ctx.query,
      forEach: (_asins, fn) => forEachAsin(ctx, fn),
    });
    return { counts: { ...r.counts }, outcomes: r.outcomes, flips: r.flips };
  },
};
