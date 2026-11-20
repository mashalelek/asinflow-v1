// Dashboard (SPEC §28) — the grid's row model and the API shapes, shared by
// server/dashboard.ts and client/src/pages/dashboard.tsx. Since the Finances
// API patch (commit 7, 2026-11-20) the SALES and PROFIT rows read
// finances_daily through readBreakdown (server/finances-aggregate.ts): the
// "—" placeholders and the "after the Finances API patch" note are gone.

export type DashboardGroup = "spend" | "sales" | "profit";
export type DashboardRowKey =
  | "spend" | "refunds_due" | "asin_units" | "individual_units" | "avg_po_value" | "write_offs" | "lost_damaged"
  | "sales" | "orders_units" | "refunds"
  | "gross_profit" | "net_profit" | "est_payout" | "margin" | "roi";

export interface DashboardRowDef {
  key: DashboardRowKey;
  group: DashboardGroup;
  label: string;
  /** money = $; int = whole units; pair = "orders / units"; count_money = "33 · $962.50"; pct = "10.48%". */
  format: "money" | "int" | "pair" | "count_money" | "pct";
  /** The group's main metric (the larger weight, like a SellerBoard tile). */
  primary?: boolean;
  /** Kept for the shape only (nothing is pending since commit 7). */
  pending?: boolean;
  /** SellerBoard's definition (shown as the row's tooltip). */
  definition: string;
}

/** The hover text of a profit cell with no Finances data yet (before `npm run backfill:finances` has run). */
export const PENDING_TOOLTIP = "no Finances data for this range yet — run backfill:finances";

export const DASHBOARD_ROWS: readonly DashboardRowDef[] = [
  { key: "spend", group: "spend", label: "Spend", format: "money", primary: true, definition: "Σ per PO of order total − refunds (any status); a fully-canceled PO is $0; gift-card % and cashback never count" },
  { key: "refunds_due", group: "spend", label: "Refunds due", format: "money", definition: "Σ still owed on the column's POs' open supplier claims whose outcome is unset or a refund / credit (suggested, dismissed, replacement, write-off and claims with no quantity add nothing) — click to open the Claims page, Waiting on refund to post + Waiting on supplier" },
  { key: "asin_units", group: "spend", label: "ASIN units ordered", format: "int", definition: "Σ ASIN units − canceled ASIN units; a fully-canceled PO counts 0" },
  { key: "individual_units", group: "spend", label: "Individual units ordered", format: "int", definition: "Σ ASIN units × Individual units per ASIN unit; a row without a pack size contributes its ASIN units and is counted as missing" },
  { key: "avg_po_value", group: "spend", label: "Avg. PO value", format: "money", definition: "Spend ÷ PO count (fully-canceled POs not counted)" },
  { key: "write_offs", group: "spend", label: "Supplier write-offs", format: "money", definition: "Σ written off on closed supplier claims (Write off: the $ owed; Write off remainder: what the refunds left) whose write-off date is in the range; a reopened claim leaves; never in Spend — click to open Claims › Closed, those write-offs" },
  { key: "lost_damaged", group: "spend", label: "Lost / damaged by us", format: "money", definition: "Σ Lost/damaged by us ASIN units × the row's cost per unit on POs ordered in the range (AF does not record when a unit was lost); never in Spend — click to open the POs with lost / damaged units" },
  { key: "sales", group: "sales", label: "Sales", format: "money", primary: true, definition: "Product principal net of promotion, by the order's Pacific purchase day (pending orders included, cancelled excluded; tax, shipping and shipping discounts out)" },
  { key: "orders_units", group: "sales", label: "Orders / ASIN units", format: "pair", definition: "Distinct Amazon order ids / Σ ASIN units ordered (SellerBoard's Orders / Units)" },
  { key: "refunds", group: "sales", label: "Refunds", format: "count_money", definition: "Refunds posted in the range (Pacific day) · the refunded amount" },
  { key: "net_profit", group: "profit", label: "Net profit", format: "money", primary: true, definition: "Gross profit − indirect expenses ($0)" },
  { key: "gross_profit", group: "profit", label: "Gross profit", format: "money", definition: "Sales + Refund cost + Amazon fees + Cost of goods (COGS, Prep, Disposal of sellable products, Lost/damaged by Amazon)" },
  { key: "est_payout", group: "profit", label: "Est. payout", format: "money", definition: "Sales + Refund cost without Value of returned items + Amazon fees (cash only)" },
  { key: "margin", group: "profit", label: "Margin", format: "pct", definition: "Net profit ÷ Sales" },
  { key: "roi", group: "profit", label: "ROI", format: "pct", definition: "Net profit ÷ |Cost of goods|" },
];

export interface Ymd { from: string; to: string }

export interface DashboardCell {
  /** null = no value (a placeholder, or Avg. PO value with 0 POs). */
  value: number | null;
  /** Waits for the Finances API patch. */
  pending?: boolean;
  /** Avg. PO value: the POs counted. */
  poCount?: number;
  /** Individual units: rows that contributed their ASIN units because units_per_pack is NULL. */
  missingPackSize?: number;
  /** Sales cells: the range starts before the earliest sale_date — data from this day only. Profit cells: before the first Finances day. */
  dataFrom?: string | null;
  /** Orders / Units: the units (value = orders); Lost / damaged by us: the ASIN units (value = $). */
  secondary?: number | null;
  /** Supplier write-offs: the claims counted and the split by kind for the hover ("missing $38.42 · can't sell $19.98"). */
  claimCount?: number;
  byKind?: Record<string, number>;
}

export interface DashboardColumn {
  key: string;
  label: string;
  /** The Spend range (purchase_orders.order_date, "today" in America/New_York). */
  eastern: Ymd;
  /** The Sales range (sales_daily.sale_date, "today" in America/Los_Angeles). */
  pacific: Ymd;
  cells: Record<DashboardRowKey, DashboardCell>;
}

export interface DashboardCoverage {
  earliestSaleDate: string | null;
  newestSaleDate: string | null;
  /** Newest finished component-19 run (refresh_runs). */
  lastSalesSyncAt: string | null;
  /** Earliest sales_orders.sale_date — null until the Pacific-day re-backfill has run. */
  ordersFrom: string | null;
  /** sales_orders is still empty: `npm run backfill:sales` has not run since the Pacific switch (rows before its start day stay on the old basis — ordersFrom later than earliestSaleDate is the normal end state). */
  rebackfillPending: boolean;
  /** Earliest finances_daily day with sales — null until `npm run backfill:finances` has run (Finances patch, commit 7). */
  financesFrom?: string | null;
}

export interface DashboardGrid {
  set: 1 | 2 | 3 | 4;
  columns: DashboardColumn[];
  coverage: DashboardCoverage;
  generatedAt: string;
}

export type SeriesKind = "running30" | "monthly" | "weekly";
export const SERIES_KINDS: readonly SeriesKind[] = ["running30", "monthly", "weekly"];

export interface SeriesPoint {
  /** running30: the day; monthly: the 1st; weekly: the Monday (YYYY-MM-DD). */
  period: string;
  /** null before sales coverage starts. */
  sales: number | null;
  spend: number;
  poCount: number;
  units: number | null;
  orders: number | null;
  /** The period contains today ("to date"). */
  partial: boolean;
}

export interface DashboardSeries {
  kind: SeriesKind;
  from: string;
  to: string;
  /** The sales series starts here when the range starts before coverage; null otherwise. */
  salesFrom: string | null;
  points: SeriesPoint[];
}
