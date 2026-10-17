// ASINs page on-order figures, derived live from the PO tables (patch
// docs/claude_spec-patch-asins-on-order-from-pos.md §2–§3.1; pre-flight
// docs/asins-on-order-preflight-2026-10-17.md). No stored column (D3): the
// PO tables are the source, the Orders sheet's ordered_qty is no longer read.
//
// Per po_asins row (all ASIN / sellable-pack units):
//   expected    = qty − canceled − returned − lost/damaged by us   (NULLs read 0)
//   on_order    = max(expected − shipped_fba, 0)        OPEN POs only (D1)
//   at_prep     = qty_at_prep                            OPEN POs only (D1)
// Canceled / Returned are the §22 derived ASIN values (Σ line qty × yield,
// NULL when any line is untracked → read 0 here). A closed PO has nothing
// left to ship by definition, which also neutralises pre-May POs that have
// no shipment rows (shipped_fba NULL would otherwise count the whole
// expected quantity as On Order). Inbound FBA / Pipeline were removed on
// 2026-10-17 (clean-up): Amazon's own inbound ("Sent to FBA") covers the
// shipped-not-received units.
import type { QueryLike } from "./scheduler/types";
import { derivedFromLines } from "./po-queries";

export interface PipelineRow {
  asin: string;
  closed: boolean;
  qty: number | string | null;
  qty_canceled_asin: number | string | null;
  qty_returned_asin: number | string | null;
  qty_lost_damaged_us: number | string | null;
  qty_at_prep: number | string | null;
  qty_shipped_fba: number | string | null;
  qty_received_amazon: number | string | null;
}

export interface AsinPipeline {
  on_order: number;
  at_prep: number;
  open_po_count: number;
}

const n = (v: number | string | null | undefined): number => (v == null || v === "" ? 0 : typeof v === "number" ? v : parseFloat(v) || 0);
const r2 = (x: number) => Math.round(x * 100) / 100;

/** Pure: fold po_asins rows into one figure set per ASIN. Exported for tests. */
export function computePipeline(rows: PipelineRow[]): Map<string, AsinPipeline> {
  const out = new Map<string, AsinPipeline>();
  for (const r of rows) {
    const asin = String(r.asin).trim().toUpperCase();
    const p = out.get(asin) ?? { on_order: 0, at_prep: 0, open_po_count: 0 };
    const expected = n(r.qty) - n(r.qty_canceled_asin) - n(r.qty_returned_asin) - n(r.qty_lost_damaged_us);
    const shipped = n(r.qty_shipped_fba);
    if (!r.closed) {
      p.on_order += Math.max(expected - shipped, 0);
      p.at_prep += n(r.qty_at_prep);
      p.open_po_count += 1;
    }
    out.set(asin, p);
  }
  for (const p of Array.from(out.values())) { p.on_order = r2(p.on_order); p.at_prep = r2(p.at_prep); }
  return out;
}

const derived = derivedFromLines; // one definition (server/po-queries.ts), bundle ÷ N included

export const PIPELINE_ROWS_SQL = `
  SELECT pa.asin, (p.closed_at IS NOT NULL) AS closed, pa.qty, pa.qty_lost_damaged_us, pa.qty_at_prep, pa.qty_shipped_fba, pa.qty_received_amazon,
         ${derived("qty_canceled")} AS qty_canceled_asin,
         ${derived("qty_returned")} AS qty_returned_asin
    FROM po_asins pa JOIN purchase_orders p ON p.id = pa.po_id`;

/** All ASINs (asins = undefined) or a subset. Missing ASINs are simply absent from the map (no PO rows). */
export async function loadAsinPipeline(query: QueryLike, asins?: string[]): Promise<Map<string, AsinPipeline>> {
  const rows = asins
    ? (await query(`${PIPELINE_ROWS_SQL} WHERE pa.asin = ANY($1::text[])`, [asins.map((a) => a.trim().toUpperCase())])).rows
    : (await query(PIPELINE_ROWS_SQL)).rows;
  return computePipeline(rows as PipelineRow[]);
}

export const EMPTY_PIPELINE: AsinPipeline = { on_order: 0, at_prep: 0, open_po_count: 0 };
