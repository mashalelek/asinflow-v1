// ASINs page on-order figures, derived live from the PO tables (patch
// docs/claude_spec-patch-asins-on-order-from-pos.md §2–§3.1; pre-flight
// docs/asins-on-order-preflight-2026-10-17.md). No stored column (D3): the
// PO tables are the source, the Orders sheet's ordered_qty is no longer read.
//
// Per po_asins row (all ASIN / sellable-pack units). The three stages are
// mutually exclusive (Maria 2026-11-02): a unit is On Order, OR At Prep, OR
// At CQG Warehouse, never two at once.
//   expected     = qty − canceled − returned − lost/damaged by us   (NULLs read 0)
//   on_order     = max(expected − shipped_fba − at_prep − at_warehouse, 0)
//                  only for OPEN POs dated on or after the reconciliation
//                  start (earliest Velocity shipment; VELOCITY_MIN_ORDER_DATE
//                  when none is stored) — older rows have no shipment data and
//                  contribute 0, and a closed PO contributes 0, always (Maria
//                  2026-11-02: §2.4 of 2026-10-17 had counted closed POs too so
//                  a wrong Closed could not hide units, but a closed PO that
//                  never reached Velocity — ships_to 'home', or shipped before
//                  tracking — keeps shipped_fba NULL forever and so leaked its
//                  whole Ordered onto the ASINs page, e.g. walmart
//                  200014971489745 B071G486Q7, 22 rows / 108.5 units on
//                  production that day; a wrong Closed is fixed by reopening)
//   at_prep      = qty_at_prep (Velocity's quantity), every row (open or closed)
//   at_warehouse = qty_at_warehouse (At CQG Warehouse, hand-kept), every row
// Stock = available + reserved + Sent to FBA + on_order + at_prep +
// at_warehouse; FBA Stock = Stock − on_order − at_prep − at_warehouse
// (routes.ts, the ASINs list).
// Canceled / Returned are the §22 derived ASIN values (Σ line qty × yield,
// ÷ N for bundles, NULL when any line is untracked → read 0 here). Inbound FBA / Pipeline were removed on
// 2026-10-17 (clean-up): Amazon's own inbound ("Sent to FBA") covers the
// shipped-not-received units.
import type { QueryLike } from "./scheduler/types";
import { LINE_YIELD_SQL } from "./po-queries";

export interface PipelineRow {
  asin: string;
  closed: boolean;
  /** PO order date on/after the reconciliation start (computed in SQL). */
  reconciled: boolean;
  /** Ordered − Σ claims that count (po_asin_expected.expected_asin, D14). */
  qty_expected_asin: number | string | null;
  qty_lost_damaged_us: number | string | null;
  qty_at_prep: number | string | null;
  qty_at_warehouse: number | string | null;
  qty_shipped_fba: number | string | null;
  qty_received_amazon: number | string | null;
}

export interface AsinPipeline {
  on_order: number;
  at_prep: number;
  /** At CQG Warehouse (po_asins.qty_at_warehouse), every row. */
  at_warehouse: number;
  open_po_count: number;
}

const n = (v: number | string | null | undefined): number => (v == null || v === "" ? 0 : typeof v === "number" ? v : parseFloat(v) || 0);
const r2 = (x: number) => Math.round(x * 100) / 100;

/** Pure: fold po_asin_expected rows into one figure set per ASIN. Exported for tests. All quantities ASIN units (the view). */
export function computePipeline(rows: PipelineRow[]): Map<string, AsinPipeline> {
  const out = new Map<string, AsinPipeline>();
  for (const r of rows) {
    const asin = String(r.asin).trim().toUpperCase();
    const p = out.get(asin) ?? { on_order: 0, at_prep: 0, at_warehouse: 0, open_po_count: 0 };
    // Expected = ordered − Σ claims that count (the view, D14) − lost / damaged by us.
    const expected = n(r.qty_expected_asin) - n(r.qty_lost_damaged_us);
    const shipped = n(r.qty_shipped_fba), atPrep = n(r.qty_at_prep), atWarehouse = n(r.qty_at_warehouse);
    // Exclusive stages: what is at Velocity or at the warehouse is no longer on order.
    if (r.reconciled && !r.closed) p.on_order += Math.max(expected - shipped - atPrep - atWarehouse, 0);
    p.at_prep += atPrep;
    p.at_warehouse += atWarehouse;
    if (!r.closed) p.open_po_count += 1;
    out.set(asin, p);
  }
  for (const p of Array.from(out.values())) { p.on_order = r2(p.on_order); p.at_prep = r2(p.at_prep); p.at_warehouse = r2(p.at_warehouse); }
  return out;
}

/** VELOCITY_MIN_ORDER_DATE (M/D/YYYY) → YYYY-MM-DD, or null. */
export function envReconStart(raw = process.env.VELOCITY_MIN_ORDER_DATE): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(raw ?? "").trim());
  return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : null;
}

// $1 = the env fallback date (or NULL). The start is the earliest stored
// Velocity shipment (Phase 2's backfill start); with none stored, the env floor.
//
// Since migration 101 (claims commit 1) the rows come from po_asin_expected:
// expected = ordered − Σ claims that count (canceled, returned, refunded,
// written off — D14, §3.6; a bundle by the bundle rule), every stage in ASIN
// units from the stored Individual base (D17). The 2026-10-18 performance
// rule still holds — one grouped pass over the lines inside the view, never
// a correlated subquery per ASIN row.
export const PIPELINE_ROWS_SQL = `
  SELECT e.asin, (p.closed_at IS NOT NULL) AS closed,
         (p.order_date >= COALESCE((SELECT MIN(shipped_at) FROM velocity_shipments), $1::date, DATE '9999-12-31')) AS reconciled,
         e.expected_asin AS qty_expected_asin, e.lost_damaged_us_asin AS qty_lost_damaged_us, e.at_prep_asin AS qty_at_prep, e.at_warehouse_asin AS qty_at_warehouse,
         e.shipped_fba_asin AS qty_shipped_fba, e.received_amazon_asin AS qty_received_amazon
    FROM po_asin_expected e JOIN purchase_orders p ON p.id = e.po_id`;

/** All ASINs (asins = undefined) or a subset. Missing ASINs are simply absent from the map (no PO rows). */
export async function loadAsinPipeline(query: QueryLike, asins?: string[]): Promise<Map<string, AsinPipeline>> {
  const start = envReconStart();
  const rows = asins
    ? (await query(`${PIPELINE_ROWS_SQL} WHERE e.asin = ANY($2::text[])`, [start, asins.map((a) => a.trim().toUpperCase())])).rows
    : (await query(PIPELINE_ROWS_SQL, [start])).rows;
  return computePipeline(rows as PipelineRow[]);
}

export const EMPTY_PIPELINE: AsinPipeline = { on_order: 0, at_prep: 0, at_warehouse: 0, open_po_count: 0 };
