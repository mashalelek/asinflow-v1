/**
 * Dashboard tiles (SPEC §28 "Layout", patch docs/claude_spec-patch-dashboard-tiles.md
 * §1.3, mockup docs/dashboard-tiles-mockup-2026-11-04.dc.html): one card per
 * range column — a coloured header band (the range name and its resolved
 * dates; --dash-band-1…5 by column position, the only colour on the page),
 * then three hairline-separated sections: SPEND (main value + a 2 × 2 grid),
 * SALES (main value + Orders / ASIN units · Refunds "33 · $962.50"), PROFIT
 * (Net profit main; Gross profit, Est. payout, Margin, ROI; a "More" link that
 * opens the breakdown panel for the tile's range — Finances API patch commit
 * 7, mockup docs/mockups/finances-breakdown-2026-11-19.html). The data shapes
 * and the cell texts are the shipped ones (shared/dashboard.ts, metric-grid.tsx).
 */
import { Link } from "wouter";
import { DASHBOARD_ROWS, PENDING_TOOLTIP, type DashboardColumn, type DashboardGrid, type DashboardRowKey } from "@shared/dashboard";
import { cellText, coverageTooltip, fmtRangeLabel, refundsDueHref, writeOffsHref, lostDamagedHref } from "@/components/metric-grid";

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
function Sub({ label, children, note, testId, dim, title }: { label: string; children: React.ReactNode; note?: string; testId: string; dim?: boolean; /** The hover text; a dim cell without one reads the Finances-patch note. */ title?: string }) {
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <div className={SUB_LABEL}>{label}</div>
      <div className={`${SUB_VALUE} ${dim ? DIM : ""}`} data-testid={testId} title={title ?? (dim ? PENDING_TOOLTIP : undefined)}>{children}</div>
      {note && <div className="text-[11px] text-muted-foreground">{note}</div>}
    </div>
  );
}

export function MetricTile({ col, index, count, coverage, onMore }: { col: DashboardColumn; index: number; count: number; coverage: string; onMore?: (col: DashboardColumn) => void }) {
  const c = col.cells;
  const spend = cellText(row("spend"), c.spend);
  const due = cellText(row("refunds_due"), c.refunds_due);
  const avg = cellText(row("avg_po_value"), c.avg_po_value);
  const asin = cellText(row("asin_units"), c.asin_units);
  const ind = cellText(row("individual_units"), c.individual_units);
  const wo = cellText(row("write_offs"), c.write_offs);
  const ld = cellText(row("lost_damaged"), c.lost_damaged);
  const LINK = "underline underline-offset-4 decoration-border hover:decoration-foreground";
  const sales = cellText(row("sales"), c.sales);
  const ou = cellText(row("orders_units"), c.orders_units);
  const rf = cellText(row("refunds"), c.refunds);
  const np = cellText(row("net_profit"), c.net_profit);
  const gp = cellText(row("gross_profit"), c.gross_profit);
  const ep = cellText(row("est_payout"), c.est_payout);
  const mg = cellText(row("margin"), c.margin);
  const roi = cellText(row("roi"), c.roi);
  const sameDates = col.eastern.from === col.pacific.from && col.eastern.to === col.pacific.to;
  const t = (k: string) => `tile-${col.key}-${k}`;
  return (
    // lg+: the card is a 4-row subgrid of the tiles grid (band / Spend / Sales / Profit), so the sections line up across a row
    // whatever wraps inside one card (headless check 2026-11-04: at 1024 and at 1280 × 5 tiles the widest card pushed its Sales
    // and Profit sections below its neighbours').
    <div className="rounded-[10px] border bg-card text-card-foreground overflow-hidden flex flex-col min-w-0 lg:grid lg:grid-rows-subgrid lg:row-span-4" data-testid={`dashboard-tile-${col.key}`}>
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
              ? <Link href={refundsDueHref(col)} className={LINK} data-testid={`link-refunds-due-${col.key}`}>{due.main}</Link>
              : <span>{due.main}</span>}
          </Sub>
          <Sub label="Avg. PO value" testId={t("avg-po")}>
            <span className={`inline-flex flex-wrap items-baseline gap-x-1 ${avg.muted ? DIM : ""}`}><span>{avg.main}</span><span className="text-xs font-normal text-muted-foreground whitespace-nowrap">· {avg.small}</span></span>
          </Sub>
          <Sub label="ASIN units ordered" testId={t("asin-units")}>{asin.main}</Sub>
          <Sub label="Individual units ordered" note={ind.small} testId={t("individual-units")}>{ind.main}</Sub>
          {/* Claims commit 9 (§3.14, mockup dashboard-writeoffs-2026-11-15): two cells under the four — a link with "· N claims" / "· N ASIN units" when there is
              something in the range, the split by kind on hover; "$0.00" dim (no link, no small text) when there is nothing. Neither changes Spend. */}
          <Sub label="Supplier write-offs" testId={t("write-offs")} dim={wo.muted} title={wo.muted ? "no write-offs dated in this range" : undefined}>
            {wo.muted
              ? <span>{wo.main}</span>
              : <Link href={writeOffsHref(col)} className={LINK} title={wo.tooltip} data-testid={`link-write-offs-${col.key}`}>{wo.main} <span className="text-xs font-normal text-muted-foreground whitespace-nowrap">· {wo.small}</span></Link>}
          </Sub>
          <Sub label="Lost / damaged by us" testId={t("lost-damaged")} dim={ld.muted} title={ld.muted ? "no lost / damaged units on POs ordered in this range" : undefined}>
            {ld.muted
              ? <span>{ld.main}</span>
              : <Link href={lostDamagedHref(col)} className={LINK} title={ld.tooltip} data-testid={`link-lost-damaged-${col.key}`}>{ld.main} <span className="text-xs font-normal text-muted-foreground whitespace-nowrap">· {ld.small}</span></Link>}
          </Sub>
        </div>
      </section>
      {/* SALES — the coverage line is this label's tooltip (tiles patch §1.2). */}
      <section className={`${SECTION} border-t`} data-testid={t("sales")}>
        <div className={LABEL} title={coverage || undefined} data-testid={t("sales-label")}>Sales</div>
        <Main label="Sales" value={sales.main} testId={t("sales-main")} />
        {sales.small && <div className="-mt-2 text-[11px] text-muted-foreground">{sales.small}</div>}
        <div className="grid grid-cols-2 gap-x-4 gap-y-3">
          <Sub label="Orders / ASIN units" note={ou.small} testId={t("orders-units")}><span className={`whitespace-nowrap text-[15px] xl:text-base ${ou.muted ? DIM : ""}`}>{ou.main}</span></Sub>
          <Sub label="Refunds" testId={t("refunds")} dim={rf.muted} title={rf.tooltip}>
            {rf.muted ? <span>—</span> : <span className="inline-flex flex-wrap items-baseline gap-x-1"><span>{rf.main}</span>{rf.small && <span className="text-xs font-normal text-muted-foreground whitespace-nowrap">· {rf.small}</span>}</span>}
          </Sub>
        </div>
      </section>
      {/* PROFIT (Finances patch commit 7): Net profit main; Gross profit · Est. payout · Margin · ROI; "More" opens the breakdown panel for this range. */}
      <section className={`${SECTION} border-t pb-[18px]`} data-testid={t("profit")}>
        <div className="flex items-baseline justify-between gap-3">
          <div className={LABEL}>Profit</div>
          <button type="button" className="text-xs" style={{ color: "#93c5fd" }} onClick={() => onMore?.(col)} data-testid={t("more")}>More</button>
        </div>
        <Main label="Net profit" value={np.main} dim={np.muted} testId={t("net-profit")} />
        {np.small && <div className="-mt-2 text-[11px] text-muted-foreground">{np.small}</div>}
        <div className="grid grid-cols-2 gap-x-4 gap-y-3">
          <Sub label="Gross profit" testId={t("gross-profit")} dim={gp.muted}>{gp.main}</Sub>
          <Sub label="Est. payout" testId={t("est-payout")} dim={ep.muted}>{ep.main}</Sub>
          <Sub label="Margin" testId={t("margin")} dim={mg.muted}>{mg.main}</Sub>
          <Sub label="ROI" testId={t("roi")} dim={roi.muted}>{roi.main}</Sub>
        </div>
      </section>
    </div>
  );
}

export function MetricTiles({ grid, loading, onMore }: { grid: DashboardGrid | null; loading: boolean; onMore?: (col: DashboardColumn) => void }) {
  const cols = grid?.columns ?? [];
  const coverage = coverageTooltip(grid?.coverage);
  if (!grid) return <div className="text-xs text-muted-foreground" data-testid="dashboard-tiles" aria-busy={loading}>{loading ? "Loading…" : ""}</div>;
  return (
    <div className={`grid grid-cols-1 gap-4 lg:[grid-template-columns:repeat(var(--tiles),minmax(0,1fr))] lg:[grid-auto-rows:auto] transition-opacity ${loading ? "opacity-60" : ""} ${cols.length === 1 ? "lg:max-w-[28rem]" : ""}`}
         style={{ ["--tiles" as string]: String(cols.length) }} data-testid="dashboard-tiles" aria-busy={loading}>
      {cols.map((col, i) => <MetricTile key={col.key} col={col} index={i} count={cols.length} coverage={coverage} onMore={onMore} />)}
    </div>
  );
}
