// The breakdown panel's rows (Finances API patch commit 7, SPEC §6; mockup
// docs/mockups/finances-breakdown-2026-11-19.html): pure, from the API's
// FinancesBreakdown. SB's names and order; a $0.00 line is not listed inside a
// group; Promo / Advertising cost / Indirect expenses are shown dim at $0.00.
import type { FinancesBreakdown, FinancesBreakdownLine, FinancesGroup } from "@shared/finances";

export type PanelRow =
  | { kind: "line"; cls: "p" | "s" | "tot"; label: string; value: string; zero?: boolean; title?: string; line?: string }
  | { kind: "group"; group: Exclude<FinancesGroup, "top" | "hidden">; label: string; value: string }
  | { kind: "hr" };

export function fmtMoney(v: number): string {
  const abs = Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return v < 0 ? `-$${abs}` : `$${abs}`;
}
export const fmtPct = (v: number | null) => (v == null ? "—" : `${v.toFixed(2)}%`);
const fmtInt = (v: number) => v.toLocaleString();

/** "includes $5.77 estimated for 1 pending unit" (§6 "Estimates": hover only). */
export function estimateTitle(l: FinancesBreakdownLine): string | undefined {
  if (!l.estAmount || !l.estUnits) return undefined;
  const u = Math.round(l.estUnits);
  return `includes ${fmtMoney(Math.abs(l.estAmount))} estimated for ${fmtInt(u)} pending unit${u === 1 ? "" : "s"}`;
}

const GROUP_LABELS: Record<Exclude<FinancesGroup, "top" | "hidden">, string> = { refund_cost: "Refund cost", amazon_fees: "Amazon fees", cost_of_goods: "Cost of goods" };

/** The rows of the panel, top to bottom; `collapsed` hides a group's lines. */
export function panelRows(b: FinancesBreakdown, collapsed: ReadonlySet<string> = new Set()): PanelRow[] {
  const rows: PanelRow[] = [];
  const t = b.totals;
  rows.push({ kind: "line", cls: "p", label: "Sales", value: fmtMoney(t.sales), line: "sales" });
  rows.push({ kind: "line", cls: "p", label: "Units", value: fmtInt(t.units), line: "units" });
  rows.push({ kind: "line", cls: "p", label: "Refunds", value: fmtInt(t.refunds), line: "refunds" });
  rows.push({ kind: "line", cls: "p", label: "Promo", value: fmtMoney(0), zero: true });
  rows.push({ kind: "line", cls: "p", label: "Advertising cost", value: fmtMoney(0), zero: true });
  const groups: [Exclude<FinancesGroup, "top" | "hidden">, number][] = [["refund_cost", t.refundCost], ["amazon_fees", t.amazonFees], ["cost_of_goods", t.costOfGoods]];
  for (const [g, total] of groups) {
    rows.push({ kind: "group", group: g, label: GROUP_LABELS[g], value: fmtMoney(total) });
    if (collapsed.has(g)) continue;
    for (const l of b.lines) {
      if (l.group !== g) continue;
      // Prep and COGS are always listed (the split is the point, §5); other $0.00 lines are not (SB).
      if (l.amount === 0 && l.line !== "cogs" && l.line !== "prep") continue;
      rows.push({ kind: "line", cls: "s", label: l.label, value: fmtMoney(l.amount), title: estimateTitle(l), line: l.line });
    }
  }
  rows.push({ kind: "hr" });
  rows.push({ kind: "line", cls: "p", label: "Gross profit", value: fmtMoney(t.grossProfit) });
  rows.push({ kind: "line", cls: "p", label: "Indirect expenses", value: fmtMoney(0), zero: true });
  rows.push({ kind: "line", cls: "tot", label: "Net profit", value: fmtMoney(t.netProfit) });
  rows.push({ kind: "line", cls: "p", label: "Estimated payout", value: fmtMoney(t.estPayout) });
  rows.push({ kind: "hr" });
  rows.push({ kind: "line", cls: "p", label: "Refund rate", value: fmtPct(t.refundRate) });
  rows.push({ kind: "line", cls: "p", label: "Sellable returns", value: fmtPct(t.sellableReturns) });
  rows.push({ kind: "line", cls: "p", label: "Margin", value: fmtPct(t.margin) });
  rows.push({ kind: "line", cls: "p", label: "ROI", value: fmtPct(t.roi) });
  return rows;
}
