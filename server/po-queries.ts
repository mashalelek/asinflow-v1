// PO module read helpers (patch docs/claude_spec-patch-po-expand-by-asin.md
// §4, §3.3). ONE query shape for the ASIN rows wherever they render — the PO
// detail ASINs tab and the POs page's nested "Expand by ASIN" rows — so the
// two can never disagree.
//
// Canceled / Returned are DERIVED on the ASIN row (pre-flight decision 1,
// 2026-10-16): the stored truth stays on po_line_items (product level);
// the ASIN value is Σ(line qty × yield) and NULL when any contributing line
// is untracked (NULL) — never a partial sum presented as a total. The six
// new quantities (cols 13–18) are stored on po_asins as ASIN qty.
import type { QueryLike } from "./scheduler/types";

/**
 * Derived ASIN-level qty from the lines: NULL if any line's value is NULL.
 * Σ(line qty × yield); for sold_as = 'bundle' divided by unique_products
 * (Col S) — each component's stored yield is its standalone yield, so the
 * plain sum counts the bundle N times (Maria 2026-10-17: fully canceled
 * Kinder's B0G6R55GNQ = 12, not 24; 1 unit of one product in a 3-product
 * bundle = 1/3). Multi-packs and non-bundle groups keep the plain sum.
 * `pa` must be the po_asins alias in the enclosing query.
 */
export const derivedFromLines = (col: string) =>
  `(SELECT CASE WHEN COUNT(*) = 0 OR COUNT(*) FILTER (WHERE l.${col} IS NULL) > 0 THEN NULL
                ELSE SUM(l.${col} * COALESCE(l.asin_qty_per_product, 1))
                     / (CASE WHEN pa.sold_as = 'bundle' AND COALESCE(pa.unique_products, 0) > 1 THEN pa.unique_products ELSE 1 END) END
      FROM po_line_items l WHERE l.po_asin_id = pa.id)`;

/** The ASIN-row SELECT. `where` is a clause on pa.* (e.g. "pa.po_id = $1" or "pa.po_id = ANY($1::uuid[])"). */
export function poAsinRowsSql(where: string): string {
  return `SELECT pa.*, (pa.qty * pa.cost_per_unit) AS total_cost,
                 a.image_url AS thumbnail,
                 ${derivedFromLines("qty_canceled")} AS qty_canceled_asin,
                 ${derivedFromLines("qty_returned")} AS qty_returned_asin
            FROM po_asins pa
            LEFT JOIN asins a ON a.asin = pa.asin
           WHERE ${where}
           ORDER BY pa.po_id, pa.asin`;
}

export interface PoAsinShipmentRow {
  id: string; po_asin_id: string; velocity_shipment_id: string; fba_shipment_ids: string[]; sc_match: string;
  qty_shipped: string; qty_received: string | null; shipped_at: string | null; source: string;
}

/** ASIN rows for one or many POs, each with its shipments (col 19) attached. */
export async function loadPoAsinRows(query: QueryLike, poIds: string[]): Promise<any[]> {
  if (poIds.length === 0) return [];
  const rows = (await query(poAsinRowsSql(`pa.po_id = ANY($1::uuid[])`), [poIds])).rows;
  const ids = rows.map((r: any) => r.id);
  const ships = ids.length === 0 ? [] : (await query(
    `SELECT id, po_asin_id, velocity_shipment_id, fba_shipment_ids, sc_match, qty_shipped, qty_received, shipped_at::text AS shipped_at, source
       FROM po_asin_shipments WHERE po_asin_id = ANY($1::uuid[]) ORDER BY shipped_at NULLS LAST, velocity_shipment_id`, [ids],
  )).rows as PoAsinShipmentRow[];
  const byAsin = new Map<string, PoAsinShipmentRow[]>();
  for (const s of ships) { const k = String(s.po_asin_id); if (!byAsin.has(k)) byAsin.set(k, []); byAsin.get(k)!.push(s); }
  return rows.map((r: any) => ({ ...r, shipments: byAsin.get(String(r.id)) ?? [] }));
}
