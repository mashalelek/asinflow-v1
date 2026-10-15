// 21. Actual fees charged (hourly, rides CALL-11). Not implemented until the
// Finances API patch lands: sales_daily.actual_* fee columns are never
// written today. Ledger row only, same as 20.
import type { ComponentDef, ComponentResult } from "../types";

export const actualFees: ComponentDef = {
  n: 21, key: "21_actual_fees", name: "Actual fees charged", tier: "hourly", kind: "derived",
  call: "rides CALL-11 (Finances patch pending)",
  async run(): Promise<ComponentResult> {
    return { counts: { skipped: 1 }, outcomes: { _component: "skipped: finances_patch_pending" } };
  },
};
