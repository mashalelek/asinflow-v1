/**
 * Dashboard tiles (SPEC §28 "Layout", patch docs/claude_spec-patch-dashboard-tiles.md
 * §1.3, mockup docs/dashboard-tiles-mockup-2026-11-04.dc.html): one card per
 * range column — a coloured header band (the range name and its resolved
 * dates; --dash-band-1…5 by column position, the only colour on the page),
 * then three hairline-separated sections: SPEND (main value + a 2 × 2 grid),
 * SALES (main value + Orders / Units · Refunds), PROFIT (visible dim
 * placeholders with the "after the Finances API patch" note in the label
 * row). Every row is shown — no "More" link. The data shapes and the cell
 * texts are the shipped ones (shared/dashboard.ts, metric-grid.tsx helpers).
 */
import { Link } from "wouter";
import { DASHBOARD_ROWS, PENDING_TOOLTIP, type DashboardColumn, type DashboardGrid, type DashboardRowKey } from "@shared/dashboard";
import { cellText, coverageTooltip, fmtRangeLabel, refundsDueHref } from "@/components/metric-grid";

/** The band variable for a column: by position, the 5th for set 3's last column; a lone Custom column takes the first. */
export function bandVar(index: number, count: number): string {
  const n = count <= 1 ? 1 : Math.min(index + 1, 5);
  return `var(--dash-band-${n})`;
}

const row = (key: DashboardRowKey) => DASHBOARD_ROWS.find((r) => r.key === key)!;
const SECTION = "px-[18px] pt-[14px] pb-4 flex flex-col gap-3";
const LABEL = "text-[11px] font-bold uppercase tracking-[0.08em] text-muted-foreground";
const SUB_LABEL = "text-xs text-muted-foreground";
const SUB_VALUE = "text-base font-semibold";
const DIM = "text-muted-foreground/60";

function Main({ label, value, dim, testId }: { label: string; value: string; dim?: boolean; testId: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="text-[13px] text-muted-foreground">{label}</div>
      <div className={`text-[28px] font-bold leading-[1.15] tracking-[-0.01em] ${dim ? DIM : ""}`} data-testid={testId} title={dim ? PENDING_TOOLTIP : undefined}>{value}</div>
    </div>
  );
}
function Sub({ label, children, note, testId, dim }: { label: string; children: React.ReactNode; note?: string; testId: string; dim?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <div className={SUB_LABEL}>{label}</div>
      <div className={`${SUB_VALUE} ${dim ? DIM : ""}`} data-testid={testId} title={dim ? PENDING_TOOLTIP : undefined}>{children}</div>
      {note && <div className="text-[11px] text-muted-foreground">{note}</div>}
    </div>
  );
}

export function MetricTile({ col, index, count, coverage }: { col: DashboardColumn; index: number; count: number; coverage: string }) {
  const c = col.cells;
  const spend = cellText(row("spend"), c.spend);
  const due = cellText(row("refunds_due"), c.refunds_due);
  const avg = cellText(row("avg_po_value"), c.avg_po_value);
  const asin = cellText(row("asin_units"), c.asin_units);
  const ind = cellText(row("individual_units"), c.individual_units);
  const sales = cellText(row("sales"), c.sales);
  const ou = cellText(row("orders_units"), c.orders_units);
  const sameDates = col.eastern.from === col.pacific.from && col.eastern.to === col.pacific.to;
  const t = (k: string) => `tile-${col.key}-${k}`;
  return (
    <div className="rounded-[10px] border bg-card text-card-foreground overflow-hidden flex flex-col min-w-0" data-testid={`dashboard-tile-${col.key}`}>
      {/* Header band */}
      <div className="px-[18px] pt-[14px] pb-3 flex flex-col gap-0.5" style={{ backgroundColor: bandVar(index, count) }}
           title={sameDates ? undefined : `Spend (Eastern): ${fmtRangeLabel(col.eastern.from, col.eastern.to)} · Sales (Pacific): ${fmtRangeLabel(col.pacific.from, col.pacific.to)}`} data-testid={t("band")}>
        <div className="text-base font-bold" style={{ color: "#FAFAF9" }}>{col.label}</div>
        <div className="text-xs" style={{ color: "#E7E5E4" }}>{fmtRangeLabel(col.eastern.from, col.eastern.to)}</div>
      </div>
      {/* SPEND */}
      <section className={SECTION} data-testid={t("spend")}>
        <div className={LABEL}>Spend</div>
        <Main label="Spend" value={spend.main} testId={t("spend-main")} />
        <div className="grid grid-cols-2 gap-x-4 gap-y-3">
          <Sub label="Refunds due" testId={t("refunds-due")}>
            {(c.refunds_due.value ?? 0) > 0
              ? <Link href={refundsDueHref(col)} className="underline underline-offset-4 decoration-border hover:decoration-foreground" data-testid={`link-refunds-due-${col.key}`}>{due.main}</Link>
              : <span>{due.main}</span>}
          </Sub>
          <Sub label="Avg. PO value" testId={t("avg-po")}>
            <span className={avg.muted ? DIM : ""}>{avg.main}</span> <span className="text-xs font-normal text-muted-foreground">· {avg.small}</span>
          </Sub>
          <Sub label="ASIN units ordered" testId={t("asin-units")}>{asin.main}</Sub>
          <Sub label="Individual units ordered" note={ind.small} testId={t("individual-units")}>{ind.main}</Sub>
        </div>
      </section>
      {/* SALES — the coverage line is this label's tooltip (tiles patch §1.2). */}
      <section className={`${SECTION} border-t`} data-testid={t("sales")}>
        <div className={LABEL} title={coverage || undefined} data-testid={t("sales-label")}>Sales</div>
        <Main label="Sales" value={sales.main} testId={t("sales-main")} />
        {sales.small && <div className="-mt-2 text-[11px] text-muted-foreground">{sales.small}</div>}
        <div className="grid grid-cols-2 gap-x-4 gap-y-3">
          <Sub label="Orders / Units" note={ou.small} testId={t("orders-units")}><span className={ou.muted ? DIM : ""}>{ou.main}</span></Sub>
          <Sub label="Refunds" testId={t("refunds")} dim>—</Sub>
        </div>
      </section>
      {/* PROFIT — rows stay visible as dim placeholders (Maria 2026-11-04); the Finances patch fills them and drops the note. */}
      <section className={`${SECTION} border-t pb-[18px]`} data-testid={t("profit")}>
        <div className="flex items-baseline justify-between gap-3">
          <div className={LABEL}>Profit</div>
          <div className={`text-[11px] ${DIM}`} data-testid={t("profit-note")}>{PENDING_TOOLTIP}</div>
        </div>
        <Main label="Gross profit" value="—" dim testId={t("gross-profit")} />
        <div className="grid grid-cols-2 gap-x-4 gap-y-3">
          <Sub label="Net profit" testId={t("net-profit")} dim>—</Sub>
          <Sub label="Est. payout" testId={t("est-payout")} dim>—</Sub>
        </div>
      </section>
    </div>
  );
}

export function MetricTiles({ grid, loading }: { grid: DashboardGrid | null; loading: boolean }) {
  const cols = grid?.columns ?? [];
  const coverage = coverageTooltip(grid?.coverage);
  if (!grid) return <div className="text-xs text-muted-foreground" data-testid="dashboard-tiles" aria-busy={loading}>{loading ? "Loading…" : ""}</div>;
  return (
    <div className={`grid grid-cols-1 gap-4 lg:[grid-template-columns:repeat(var(--tiles),minmax(0,1fr))] transition-opacity ${loading ? "opacity-60" : ""} ${cols.length === 1 ? "lg:max-w-[28rem]" : ""}`}
         style={{ ["--tiles" as string]: String(cols.length) }} data-testid="dashboard-tiles" aria-busy={loading}>
      {cols.map((col, i) => <MetricTile key={col.key} col={col} index={i} count={cols.length} coverage={coverage} />)}
    </div>
  );
}
