/**
 * Dashboard grid (SPEC §28 §2.3): columns = the range set's ranges, rows =
 * the metrics in three groups (SPEND / SALES / PROFIT), one value per cell.
 * Quiet chrome — Card tokens, a rule between groups, the group's main metric
 * in the larger weight like a SellerBoard tile, the rest in the row weight,
 * no red / orange anywhere. Text never wears a data color.
 */
import { Link } from "wouter";
import { Card } from "@/components/ui/card";
import { DASHBOARD_ROWS, PENDING_TOOLTIP, type DashboardCell, type DashboardColumn, type DashboardGrid, type DashboardGroup, type DashboardRowDef } from "@shared/dashboard";

const GROUP_LABEL: Record<DashboardGroup, string> = { spend: "Spend", sales: "Sales", profit: "Profit" };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function fmtMoney(v: number | null | undefined): string {
  if (v == null) return "—";
  const abs = Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return v < 0 ? `-$${abs}` : `$${abs}`;
}
export function fmtInt(v: number | null | undefined): string {
  if (v == null) return "—";
  return Number.isInteger(v) ? v.toLocaleString() : v.toLocaleString(undefined, { maximumFractionDigits: 2 });
}
/** "Jun 17" · "Jun 15 – 17" · "May 19 – Jun 17" · "Dec 1 – 31, 2025" (the year only when it is not the current one). */
export function fmtRangeLabel(from: string, to: string, currentYear = new Date().getFullYear()): string {
  const p = (s: string) => { const [y, m, d] = s.split("-").map(Number); return { y, m, d }; };
  const a = p(from), b = p(to);
  const yr = (y: number) => (y === currentYear ? "" : `, ${y}`);
  if (from === to) return `${MONTHS[a.m - 1]} ${a.d}${yr(a.y)}`;
  if (a.y === b.y && a.m === b.m) return `${MONTHS[a.m - 1]} ${a.d} – ${b.d}${yr(a.y)}`;
  if (a.y === b.y) return `${MONTHS[a.m - 1]} ${a.d} – ${MONTHS[b.m - 1]} ${b.d}${yr(a.y)}`;
  return `${MONTHS[a.m - 1]} ${a.d}, ${a.y} – ${MONTHS[b.m - 1]} ${b.d}, ${b.y}`;
}
/** The Refunds due cell's link (C1): the POs page filtered to POs with refunds due, any status, over the column's Spend range. */
export function refundsDueHref(col: Pick<DashboardColumn, "eastern">): string {
  return `/purchase-orders?refunds=due&closed=all&from=${col.eastern.from}&to=${col.eastern.to}`;
}

export interface CellText { main: string; small?: string; tooltip?: string; muted?: boolean }
/** What a cell shows: the value, the small line under it and the hover text. Pure. */
export function cellText(row: DashboardRowDef, cell: DashboardCell): CellText {
  if (cell.pending || row.pending) return { main: "—", tooltip: PENDING_TOOLTIP, muted: true };
  const dataFrom = cell.dataFrom ? `data from ${fmtRangeLabel(cell.dataFrom, cell.dataFrom)}` : undefined;
  switch (row.key) {
    case "avg_po_value": return { main: fmtMoney(cell.value), small: `${cell.poCount ?? 0} PO${cell.poCount === 1 ? "" : "s"}`, muted: cell.value == null };
    case "individual_units": return { main: fmtInt(cell.value), small: cell.missingPackSize ? `${cell.missingPackSize} row${cell.missingPackSize === 1 ? "" : "s"} missing pack size` : undefined };
    case "orders_units": return cell.value == null
      ? { main: `— / ${fmtInt(cell.secondary)}`, small: "orders after the re-backfill", muted: true }
      : { main: `${fmtInt(cell.value)} / ${fmtInt(cell.secondary)}`, small: dataFrom };
    case "sales": return { main: fmtMoney(cell.value), small: dataFrom };
    case "refunds": return { main: fmtMoney(cell.value), small: cell.secondary != null ? `${fmtInt(cell.secondary)} units` : undefined };
    default: return { main: row.format === "money" ? fmtMoney(cell.value) : fmtInt(cell.value), muted: cell.value == null };
  }
}

export function MetricGrid({ grid, loading }: { grid: DashboardGrid | null; loading: boolean }) {
  const hairline = { borderBottom: "0.5px solid hsl(var(--border))" } as const;
  const groups: DashboardGroup[] = ["spend", "sales", "profit"];
  const cols = grid?.columns ?? [];
  return (
    <Card className={`overflow-x-auto transition-opacity ${loading && grid ? "opacity-60" : ""}`} data-testid="dashboard-grid" aria-busy={loading}>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr style={hairline}>
            <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground w-[14rem]">{grid ? "" : loading ? "Loading…" : ""}</th>
            {cols.map((c) => (
              <th key={c.key} className="px-4 py-3 text-right align-bottom whitespace-nowrap" data-testid={`dashboard-col-${c.key}`}
                  title={c.eastern.from === c.pacific.from && c.eastern.to === c.pacific.to ? undefined : `Spend (Eastern): ${fmtRangeLabel(c.eastern.from, c.eastern.to)} · Sales (Pacific): ${fmtRangeLabel(c.pacific.from, c.pacific.to)}`}>
                <div className="text-sm font-medium">{c.label}</div>
                <div className="text-[11px] font-normal text-muted-foreground">{fmtRangeLabel(c.eastern.from, c.eastern.to)}</div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {groups.map((g, gi) => (
            <GroupRows key={g} group={g} first={gi === 0} cols={cols} />
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function GroupRows({ group, first, cols }: { group: DashboardGroup; first: boolean; cols: DashboardColumn[] }) {
  const rows = DASHBOARD_ROWS.filter((r) => r.group === group);
  return (
    <>
      <tr style={first ? undefined : { borderTop: "0.5px solid hsl(var(--border))" }}>
        <td colSpan={cols.length + 1} className="px-4 pt-4 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{GROUP_LABEL[group]}</td>
      </tr>
      {rows.map((r) => (
        <tr key={r.key} data-testid={`dashboard-row-${r.key}`} className={r.primary ? "text-base" : "text-sm"}>
          <td className={`px-4 py-1.5 whitespace-nowrap ${r.primary ? "font-semibold" : "text-muted-foreground"}`} title={r.definition}>{r.label}</td>
          {cols.map((c) => {
            const cell = c.cells[r.key];
            const t = cellText(r, cell);
            const link = r.key === "refunds_due" && (cell.value ?? 0) > 0;
            return (
              <td key={c.key} className="px-4 py-1.5 text-right align-top tabular-nums" title={t.tooltip} data-testid={`dashboard-cell-${r.key}-${c.key}`}>
                {link
                  ? <Link href={refundsDueHref(c)} className={`underline-offset-4 hover:underline ${r.primary ? "font-semibold" : ""}`} data-testid={`link-refunds-due-${c.key}`}>{t.main}</Link>
                  : <span className={`${r.primary ? "font-semibold" : ""} ${t.muted ? "text-muted-foreground/60" : ""}`}>{t.main}</span>}
                {t.small && <div className="text-[11px] font-normal text-muted-foreground">{t.small}</div>}
              </td>
            );
          })}
        </tr>
      ))}
    </>
  );
}
