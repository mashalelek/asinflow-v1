// Recompute a PO's costs from its lines, promos and header (patch
// po-ai-prefill §7 as corrected 2026-10-31; §8.4 "COGS recompute when
// counts_toward_cogs flips"). ONLY for POs saved under the v2 rule
// (purchase_orders.cost_formula_version IS NOT NULL): a sheet-imported PO
// keeps the sheet's values verbatim, always (Maria 2026-10-31). An ASIN row
// whose cost / unit was ever typed by hand (a po_edit_log row for
// cost_per_unit) keeps its COGS; its Sourcing / Paid cost still follow the
// rule. Every change is logged.
import type { QueryLike } from "./scheduler/types";
import { allocateAsinCosts, adjustedProductCost, type CostHeader } from "@shared/po-cost";
import { logEdits, changedFields } from "./po-edit";

export interface RecomputeResult { poId: string; skipped: "imported" | null; asinRows: number; changed: number }

export async function recomputePoCosts(query: QueryLike, poId: string, userId: number | null): Promise<RecomputeResult> {
  const po = (await query(`SELECT id, subtotal, discount, weighted_gc_discount_pct, cost_formula_version FROM purchase_orders WHERE id = $1`, [poId])).rows[0];
  if (!po) return { poId, skipped: null, asinRows: 0, changed: 0 };
  if (po.cost_formula_version == null) return { poId, skipped: "imported", asinRows: 0, changed: 0 };
  const promos = (await query(`SELECT amount, counts_toward_cogs FROM po_promos WHERE po_id = $1`, [poId])).rows as Array<{ amount: string | null; counts_toward_cogs: boolean }>;
  const nonCounting = promos.filter((p) => p.counts_toward_cogs === false && p.amount != null).reduce((t, p) => t + Number(p.amount), 0);
  const rows = (await query(`SELECT id, asin, qty, cost_per_unit, sourcing_cost, paid_cost, cogs_adjustment FROM po_asins WHERE po_id = $1 ORDER BY asin`, [poId])).rows;
  const manual = new Set<string>(
    (await query(`SELECT DISTINCT entity_id FROM po_edit_log WHERE po_id = $1 AND entity = 'asin' AND field = 'cost_per_unit'`, [poId])).rows.map((r: any) => String(r.entity_id)),
  );
  const subtotalStored = Number(po.subtotal);
  let changed = 0;
  for (const pa of rows) {
    const lines = (await query(`SELECT id, price, qty_ordered, adjusted_product_cost FROM po_line_items WHERE po_asin_id = $1 ORDER BY position`, [pa.id])).rows;
    const subtotal = subtotalStored > 0 ? subtotalStored : lines.reduce((t: number, l: any) => t + (Number(l.price) || 0) * (Number(l.qty_ordered) || 0), 0);
    const h: CostHeader = { subtotal, discount: Number(po.discount) || 0, gcPct: po.weighted_gc_discount_pct == null ? null : Number(po.weighted_gc_discount_pct), nonCountingPromoAmount: nonCounting };
    const costs = allocateAsinCosts(h, lines.map((l: any) => ({ price: l.price == null ? null : Number(l.price), qty: Number(l.qty_ordered) || 0 })), Number(pa.qty), pa.cogs_adjustment == null ? 0 : Number(pa.cogs_adjustment));
    if (!costs) continue;
    const next: Record<string, unknown> = { sourcing_cost: costs.sourcing.toFixed(2), paid_cost: costs.paid.toFixed(2) };
    if (!manual.has(String(pa.id))) next.cost_per_unit = costs.cogs.toFixed(2);
    const changes = changedFields(pa, next);
    if (changes.length > 0) {
      const cols = changes.map((c) => c.field);
      await query(`UPDATE po_asins SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(", ")} WHERE id = $1`, [pa.id, ...cols.map((c) => next[c])]);
      await logEdits(query, poId, userId, "asin", String(pa.id), changes);
      changed += changes.length;
    }
    for (const l of lines) {
      const adj = adjustedProductCost(l.price == null ? null : Number(l.price), h);
      const lc = changedFields(l, { adjusted_product_cost: adj == null ? null : adj.toFixed(2) });
      if (lc.length > 0) { await query(`UPDATE po_line_items SET adjusted_product_cost = $2 WHERE id = $1`, [l.id, adj == null ? null : adj.toFixed(2)]); changed++; }
    }
  }
  return { poId, skipped: null, asinRows: rows.length, changed };
}
