/**
 * Dashboard cell formatting (SPEC §28): the pure helpers the tiles render
 * with — money / int / range labels, the Refunds due link, each row's cell
 * text (value, small line, tooltip) and the coverage tooltip. The table
 * grid this file used to render was replaced by the tile cards
 * (client/src/components/metric-tiles.tsx, tiles patch 2026-11-04).
 */
import { PENDING_TOOLTIP, type DashboardCell, type DashboardColumn, type DashboardCoverage, type DashboardRowDef } from "@shared/dashboard";

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

const fmtTime = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { hour: "numeric", minute: "2-digit" }) : "never");
/** The coverage line (tiles patch 2026-11-04: a tooltip on every tile's SALES label, no longer a header line): "Sales through Nov 3 · synced 6:47 PM · data from Sep 9, 2024 · Orders from Oct 31, 2024". */
export function coverageTooltip(cov: DashboardCoverage | null | undefined): string {
  if (!cov) return "";
  const parts = [
    `Sales through ${cov.newestSaleDate ? fmtRangeLabel(cov.newestSaleDate, cov.newestSaleDate) : "—"}`,
    `synced ${fmtTime(cov.lastSalesSyncAt)}`,
  ];
  if (cov.earliestSaleDate) parts.push(`data from ${fmtRangeLabel(cov.earliestSaleDate, cov.earliestSaleDate)}`);
  if (cov.rebackfillPending) parts.push("Orders not loaded yet — run backfill:sales for the Pacific-day basis");
  else if (cov.ordersFrom && cov.earliestSaleDate && cov.ordersFrom > cov.earliestSaleDate) parts.push(`Orders from ${fmtRangeLabel(cov.ordersFrom, cov.ordersFrom)} (earlier sales stay on the old day basis)`);
  return parts.join(" · ");
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
    case "refunds": return { main: fmtMoney(cell.value), small: cell.secondary != null ? `${fmtInt(cell.secondary)} ASIN units` : undefined };
    default: return { main: row.format === "money" ? fmtMoney(cell.value) : fmtInt(cell.value), muted: cell.value == null };
  }
}
