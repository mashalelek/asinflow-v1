// PO module read helpers (patch docs/claude_spec-patch-po-expand-by-asin.md
// §4, §3.3). ONE query shape for the ASIN rows wherever they render — the PO
// detail ASINs tab and the POs page's nested "Expand by ASIN" rows — so the
// two can never disagree.
//
// Since migration 101 (claims commit 1, D17) every quantity is STORED in
// Individual units and read through the two views (server/po-expected.ts):
// po_asin_expected overlays the row's quantity columns with their ASIN-unit
// values under the names the API has always used (qty, qty_shipped_fba, …),
// adds the Individual twins (qty_individual, …), Σ canceled / returned from
// the claims (qty_canceled_asin / qty_returned_asin), expected and
// open_claims; po_line_expected does the same for a line (Product units).
import type { QueryLike } from "./scheduler/types";
import { ASIN_ACTION_ITEMS_SQL, unionActionItems } from "./po-action-items";
import { PACK_SIZE_MISMATCH } from "./po-status-map";
import { yieldMismatchNote } from "@shared/yield-mismatch";
import { ASIN_ROW_VIEW_SELECT, LINE_VIEW_SELECT } from "./po-expected";
import { REFUNDS_DUE_EXISTS_SQL, REFUNDS_DUE_PO_SQL } from "./supplier-claim-sql";

/** A line's yield in SQL (migration 080): the exact ratio when the line carries it, else its stored 2-dp yield, else 1. `l` must be the po_line_items alias. */
export const LINE_YIELD_SQL = `COALESCE(l.retailer_units_per_product::numeric / l.asin_units_per_pack, l.asin_qty_per_product, 1)`;

/**
 * The ASIN-row SELECT. `where` is a clause on pa.* (e.g. "pa.po_id = $1" or "pa.po_id = ANY($1::uuid[])").
 * pa.* first, then the view's ASIN-unit values under the same names — the later duplicate wins in node-pg's row
 * object (server/po-expected.db.test.ts proves it on the real schema). total_cost = ASIN units × cost per ASIN unit.
 */
export function poAsinRowsSql(where: string): string {
  return `SELECT pa.*, (e.ordered_asin * pa.cost_per_unit) AS total_cost,
                 a.image_url AS thumbnail,
                 ${ASIN_ROW_VIEW_SELECT("e")},
                 ${ASIN_ACTION_ITEMS_SQL} AS action_items
            FROM po_asins pa
            JOIN po_asin_expected e ON e.id = pa.id
            LEFT JOIN asins a ON a.asin = pa.asin
           WHERE ${where}
           ORDER BY pa.po_id, pa.asin`;
}

/** The view's numerics arrive as strings; the API keeps returning numbers for the fields it always did. */
const qn = (v: unknown): number | null => (v == null || v === "" ? null : Number(v));
export function normalizeAsinRowQty<T extends Record<string, any>>(r: T): T {
  return { ...r, qty: qn(r.qty) ?? 0, unreimbursed_loss_qty: qn(r.unreimbursed_loss_qty), qty_individual: qn(r.qty_individual), open_claims: Number(r.open_claims ?? 0) };
}
export function normalizeLineQty<T extends Record<string, any>>(l: T): T {
  return { ...l, qty_ordered: qn(l.qty_ordered), qty_received: qn(l.qty_received), qty_canceled: qn(l.qty_canceled), qty_returned: qn(l.qty_returned), qty_expected: qn(l.qty_expected),
    qty_ordered_individual: qn(l.qty_ordered_individual), qty_received_individual: qn(l.qty_received_individual), qty_canceled_individual: qn(l.qty_canceled_individual), qty_returned_individual: qn(l.qty_returned_individual), qty_expected_individual: qn(l.qty_expected_individual) };
}

export interface PoAsinShipmentRow {
  id: string; po_asin_id: string; velocity_shipment_id: string; fba_shipment_ids: string[]; sc_match: string;
  /** Individual units since migration 101. */
  qty_shipped: string; qty_received: string | null; shipped_at: string | null; source: string; assigned_by?: string;
}

/** The product lines of some ASIN rows as the API serves them: Product units under the usual names, the Individual / ASIN twins beside. */
export const PO_LINES_SQL = (where: string) =>
  `SELECT l.*, ${LINE_VIEW_SELECT("le")},
          ARRAY(SELECT ai.item FROM po_line_action_items ai WHERE ai.po_line_item_id = l.id AND ai.cleared_at IS NULL) AS action_items
     FROM po_line_items l JOIN po_line_expected le ON le.line_id = l.id WHERE ${where} ORDER BY l.po_asin_id, l.position, l.id`;

/** ASIN rows for one or many POs, each with its shipments (col 19) and product lines attached. */
export async function loadPoAsinRows(query: QueryLike, poIds: string[]): Promise<any[]> {
  if (poIds.length === 0) return [];
  const rows = (await query(poAsinRowsSql(`pa.po_id = ANY($1::uuid[])`), [poIds])).rows;
  const ids = rows.map((r: any) => r.id);
  const ships = ids.length === 0 ? [] : (await query(
    `SELECT id, po_asin_id, velocity_shipment_id, fba_shipment_ids, sc_match, qty_shipped, qty_received, shipped_at::text AS shipped_at, source, assigned_by
       FROM po_asin_shipments WHERE po_asin_id = ANY($1::uuid[]) ORDER BY shipped_at NULLS LAST, velocity_shipment_id`, [ids],
  )).rows as PoAsinShipmentRow[];
  const byAsin = new Map<string, PoAsinShipmentRow[]>();
  for (const s of ships) { const k = String(s.po_asin_id); if (!byAsin.has(k)) byAsin.set(k, []); byAsin.get(k)!.push(s); }
  // Product lines ride along (row-level Status 2026-10-17): the nested rows
  // edit action items per product, so the list needs them too.
  const lines = ids.length === 0 ? [] : (await query(PO_LINES_SQL(`l.po_asin_id = ANY($1::uuid[])`), [ids])).rows as any[];
  const linesByAsin = new Map<string, any[]>();
  // "Pack size mismatch" on the line itself when its stored yield and the row's pack disagree, with the note (2026-11-06).
  const rowPack = new Map(rows.map((r: any) => [String(r.id), r]));
  for (const l of lines) {
    const k = String(l.po_asin_id), r = rowPack.get(k);
    const note = r ? yieldMismatchNote(l, r.sold_as, r.units_per_pack) : null;
    if (!linesByAsin.has(k)) linesByAsin.set(k, []);
    linesByAsin.get(k)!.push({ ...normalizeLineQty(l), action_items: unionActionItems([note ? [...(l.action_items ?? []), PACK_SIZE_MISMATCH] : l.action_items]), ...(note ? { pack_mismatch_note: note } : {}) });
  }
  return rows.map((r: any) => {
    const ls = linesByAsin.get(String(r.id)) ?? [];
    const notes = ls.filter((l: any) => l.pack_mismatch_note).map((l: any) => `${r.asin} ${l.product_name ? `"${String(l.product_name).slice(0, 40)}"` : "line"}: ${l.pack_mismatch_note}`);
    return { ...normalizeAsinRowQty(r), action_items: unionActionItems([r.action_items]), shipments: byAsin.get(String(r.id)) ?? [], lines: ls, ...(notes.length ? { pack_mismatch_note: notes.join(" · ") } : {}) };
  });
}

/**
 * POs list sort (PO table v2 §4): `?sort=<key>&dir=asc|desc`, whitelisted —
 * anything else falls back to the default (PO date, newest first). Every
 * ORDER BY ends on p.id so equal keys page deterministically. The keys
 * name the list's output columns (asin_count, units_ordered,
 * action_item_count) or columns of p.
 */
export const PO_SORT_KEYS: Readonly<Record<string, string>> = {
  order_date: "p.order_date",
  order_id: "p.order_id",
  supplier: "lower(p.supplier)",
  status: "(p.closed_at IS NOT NULL)",
  order_total: "p.order_total",
  asins: "asin_count",
  units_ordered: "units_ordered",
  action_items: "action_item_count",
};
export function poListOrderBy(sort: unknown, dir: unknown): string {
  const expr = typeof sort === "string" ? PO_SORT_KEYS[sort] : undefined;
  if (!expr) return "p.order_date DESC, p.created_at DESC, p.id DESC";
  const d = dir === "asc" ? "ASC" : "DESC";
  return `${expr} ${d} NULLS LAST, p.id ${d}`;
}

/**
 * POs list — the Refunds filter (Dashboard patch §2.4, 2026-11-03; claims since migration 101): `due` =
 * the PO has an open claim with $ still owed (outcome unset or a refund / credit); `none` = no refund row
 * and nothing owed; anything else = no condition. `p` must be the purchase_orders alias.
 */
export function refundsFilterCond(raw: unknown): string | null {
  const v = String(raw ?? "").trim().toLowerCase();
  if (v === "due") return REFUNDS_DUE_EXISTS_SQL("p");
  if (v === "none") return `(NOT EXISTS (SELECT 1 FROM po_line_refunds r WHERE r.po_id = p.id) AND NOT ${REFUNDS_DUE_EXISTS_SQL("p")})`;
  return null;
}
/** The PO's refunds still due (§3.7: Σ remaining on its open refund / credit claims), for the list row's money area. */
export const REFUND_DUE_SQL = `${REFUNDS_DUE_PO_SQL("p")}::float8`;
