// Keepa trend columns — the shapes the server computes and the client draws (docs/claude_spec-patch-keepa-trends.md,
// 2026-11-18; mockup docs/mockups/keepa-trends-2026-11-18.html is the UI). Bucket and scale math is server-side
// (server/keepa-trends.ts); this file holds the series names, the lines' colors / widths / labels and the API types.

export const KEEPA_SERIES = ["buy_box", "new_price", "sales_rank", "monthly_sold", "offers_new", "offers_new_fba", "rating_count"] as const;
export type KeepaSeries = (typeof KEEPA_SERIES)[number];

export type KeepaRange = "1y" | "all";
export const KEEPA_RANGES: readonly KeepaRange[] = ["1y", "all"];
/** The range is cut into this many equal time buckets; a bucket is the mean of its daily values. */
export const TREND_BUCKETS = 14;
/** 1 year = the 365 days ending today (ET). */
export const TREND_YEAR_DAYS = 365;

/** The lines (patch "Lines"; the mockup's :root colors). `width` is the SVG stroke width. */
export const KEEPA_LINE: Readonly<Record<KeepaSeries, { label: string; color: string; width: number }>> = {
  buy_box: { label: "Buy Box", color: "#ff4fb0", width: 1.5 },
  new_price: { label: "New", color: "#8f8ac4", width: 1.25 },
  monthly_sold: { label: "Monthly Sold", color: "#f5d21f", width: 1.75 },
  sales_rank: { label: "Sales Rank", color: "#7dba7d", width: 1.25 },
  offers_new: { label: "New", color: "#a3a8ff", width: 1.5 },
  offers_new_fba: { label: "New, FBA", color: "#f0713a", width: 1.25 },
  rating_count: { label: "Rating Count", color: "#a9c23f", width: 1.5 },
};
export const KEEPA_HOVER_MARKER = "#5a564f";

export type TrendScaleKey = "price" | "sold" | "rank" | "offers" | "rating";
/**
 * The four cells: which lines each draws (first listed = drawn on top), which scale each line reads, and the
 * header toggle that hides a line (patch "Header and columns").
 */
export const KEEPA_CELLS = {
  priceTrend: { label: "Price Trend", lines: ["buy_box", "new_price"], scale: { buy_box: "price", new_price: "price" }, toggle: "new_price" },
  salesVelocityTrend: { label: "Sales Velocity Trend", lines: ["monthly_sold", "sales_rank"], scale: { monthly_sold: "sold", sales_rank: "rank" }, toggle: null },
  offerCount: { label: "Offer Count", lines: ["offers_new", "offers_new_fba"], scale: { offers_new: "offers", offers_new_fba: "offers" }, toggle: "offers_new_fba" },
  ratingCount: { label: "Rating Count", lines: ["rating_count"], scale: { rating_count: "rating" }, toggle: null },
} as const satisfies Record<string, { label: string; lines: readonly KeepaSeries[]; scale: Partial<Record<KeepaSeries, TrendScaleKey>>; toggle: KeepaSeries | null }>;
export type KeepaCellId = keyof typeof KEEPA_CELLS;
export const KEEPA_CELL_IDS = Object.keys(KEEPA_CELLS) as KeepaCellId[];

/** One ASIN's trend data for the rows on screen: 14 bucket values per series it has, and the scale bounds per cell. */
export interface AsinTrends {
  asin: string;
  /** The range's first and last day (YYYY-MM-DD, ET) and its length in days. */
  start: string;
  end: string;
  days: number;
  buckets: Partial<Record<KeepaSeries, Array<number | null>>>;
  scales: Partial<Record<TrendScaleKey, [number, number]>>;
}
export interface TrendsResponse { range: KeepaRange; end: string; asins: Record<string, AsinTrends> }

/** One ASIN's daily values over the range, every series (the hover popup reads the day under the pointer). */
export interface HistoryResponse {
  asin: string;
  range: KeepaRange;
  start: string;
  end: string;
  days: number;
  series: Partial<Record<KeepaSeries, Array<number | null>>>;
}

/** Hover-row text per series (patch "Hover"): `$25.31` · `50+` · `#175,887` · `7` · `222`; `—` for no value. */
export function keepaValueText(series: KeepaSeries, v: number | null | undefined): string {
  if (v == null) return "—";
  switch (series) {
    case "buy_box": case "new_price": return `$${(v / 100).toFixed(2)}`;
    case "monthly_sold": return `${v.toLocaleString("en-US")}+`;
    case "sales_rank": return `#${v.toLocaleString("en-US")}`;
    default: return v.toLocaleString("en-US");
  }
}
