// Dashboard (SPEC §28) — the grid's row model and the API shapes, shared by
// server/dashboard.ts and client/src/pages/dashboard.tsx. Row keys and the
// API shape are final; the Finances API patch only supplies the numbers the
// placeholder rows show "—" for today.

export type DashboardGroup = "spend" | "sales" | "profit";
export type DashboardRowKey =
  | "spend" | "refunds_due" | "asin_units" | "individual_units" | "avg_po_value"
  | "sales" | "orders_units" | "refunds"
  | "gross_profit" | "net_profit" | "est_payout";

export interface DashboardRowDef {
  key: DashboardRowKey;
  group: DashboardGroup;
  label: string;
  /** money = $; int = whole units; pair = "orders / units". */
  format: "money" | "int" | "pair";
  /** The group's main metric (the larger weight, like a SellerBoard tile). */
  primary?: boolean;
  /** Waits for the Finances API patch: "—" with the tooltip. */
  pending?: boolean;
  /** SellerBoard's definition (shown as the row's tooltip). */
  definition: string;
}

export const PENDING_TOOLTIP = "after the Finances API patch";

export const DASHBOARD_ROWS: readonly DashboardRowDef[] = [
  { key: "spend", group: "spend", label: "Spend", format: "money", primary: true, definition: "Σ per PO of order total − refunds (any status); a fully-canceled PO is $0; gift-card % and cashback never count" },
  { key: "refunds_due", group: "spend", label: "Refunds due", format: "money", definition: "Σ refund rows with status due over the column's POs, plus open supplier defects not yet on a refund row — click to open those POs" },
  { key: "asin_units", group: "spend", label: "ASIN units ordered", format: "int", definition: "Σ ASIN units − canceled ASIN units; a fully-canceled PO counts 0" },
  { key: "individual_units", group: "spend", label: "Individual units ordered", format: "int", definition: "Σ ASIN units × Individual units per ASIN unit; a row without a pack size contributes its ASIN units and is counted as missing" },
  { key: "avg_po_value", group: "spend", label: "Avg. PO value", format: "money", definition: "Spend ÷ PO count (fully-canceled POs not counted)" },
  { key: "sales", group: "sales", label: "Sales", format: "money", primary: true, definition: "Σ revenue from the orders report (Pacific day)" },
  { key: "orders_units", group: "sales", label: "Orders / ASIN units", format: "pair", definition: "Distinct Amazon order ids / Σ ASIN units sold (SellerBoard's Orders / Units)" },
  { key: "refunds", group: "sales", label: "Refunds", format: "money", pending: true, definition: "Σ refund amount (ASIN units in small text) — Finances API" },
  { key: "gross_profit", group: "profit", label: "Gross profit", format: "money", primary: true, pending: true, definition: "Sales − refunds − Amazon fees (referral, FBA, other) − promo / other Amazon charges" },
  { key: "net_profit", group: "profit", label: "Net profit", format: "money", pending: true, definition: "Gross profit − COGS (actual COGS + prep for the ASIN units sold) − indirect expenses" },
  { key: "est_payout", group: "profit", label: "Est. payout", format: "money", pending: true, definition: "Sales − refunds − Amazon fees (what Amazon pays out, before COGS)" },
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
  /** Sales cells: the range starts before the earliest sale_date — data from this day only. */
  dataFrom?: string | null;
  /** Orders / Units: the units (value = orders). */
  secondary?: number | null;
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
