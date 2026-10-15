// 20. Refunds (hourly, rides CALL-11). Not implemented until the Finances
// API patch lands: sales-sync inserts units_refunded / refund_amount as 0
// and never updates them. The row exists so the numbering in SPEC resolves
// to a ledger entry and the gap is visible every pass.
import type { ComponentDef, ComponentResult } from "../types";

export const refunds: ComponentDef = {
  n: 20, key: "20_refunds", name: "Refunds", tier: "hourly", kind: "derived",
  call: "rides CALL-11 (Finances patch pending)",
  async run(): Promise<ComponentResult> {
    return { counts: { skipped: 1 }, outcomes: { _component: "skipped: finances_patch_pending" } };
  },
};
