// Recompute a PO's costs from its lines, promos and header (patch
// po-ai-prefill §7 as corrected 2026-11-04, formula v3; §8.4 "COGS recompute
// when counts_toward_cogs flips"). ONLY for POs saved by the form / capture
// (purchase_orders.cost_formula_version IS NOT NULL): a sheet-imported PO
// keeps the sheet's values verbatim, always (Maria 2026-10-31). A recompute
// applies the current rule and stamps its version (an edited v2 PO becomes
// v3: tax and shipping in). An ASIN row whose cost / unit was ever typed by
// hand (a po_edit_log row for cost_per_unit) keeps its COGS; its Sourcing /
// Paid cost still follow the rule. Costs come from the line totals
// (po_line_items.line_total, else price × qty). Every change is logged.
import type { QueryLike } from "./scheduler/types";
import { allocateAsinCosts, adjustedProductCost, allocationBaseOf, reflectedPromos, promoCostHeader, promoKind, lineMoney, COST_FORMULA_VERSION, type CostHeader, type CostLine } from "@shared/po-cost";
import { logEdits, changedFields } from "./po-edit";
import { weightedPaymentPctExact } from "@shared/po-form";

export interface RecomputeResult { poId: string; skipped: "imported" | null; asinRows: number; changed: number; ambiguousPromos?: boolean }

const r2 = (x: number) => Math.round(x * 100) / 100;
const costLine = (l: { price: string | null; qty_ordered: string | null; line_total?: string | null; regular_price?: string | null }): CostLine =>
  ({ price: l.price == null ? null : Number(l.price), qty: Number(l.qty_ordered) || 0, lineTotal: l.line_total == null ? null : Number(l.line_total), regularPrice: l.regular_price == null ? null : Number(l.regular_price) });

export async function recomputePoCosts(query: QueryLike, poId: string, userId: number | null, opts: { dryRun?: boolean } = {}): Promise<RecomputeResult & { plan?: Array<{ entity: string; id: string; field: string; old: unknown; new: unknown }> }> {
  const po = (await query(`SELECT id, subtotal, discount, tax, sh_donations, order_total, weighted_gc_discount_pct, cost_formula_version FROM purchase_orders WHERE id = $1`, [poId])).rows[0];
  if (!po) return { poId, skipped: null, asinRows: 0, changed: 0 };
  if (po.cost_formula_version == null) return { poId, skipped: "imported", asinRows: 0, changed: 0 };
  const plan: Array<{ entity: string; id: string; field: string; old: unknown; new: unknown }> = [];
  const write = async (sql: string, params: unknown[]) => { if (!opts.dryRun) await query(sql, params); };
  const promos = (await query(`SELECT type, description, amount, percent, counts_toward_cogs, in_line_prices FROM po_promos WHERE po_id = $1 ORDER BY position, id`, [poId])).rows as Array<{ type?: string | null; description?: string | null; amount: string | null; percent?: string | null; counts_toward_cogs: boolean; in_line_prices?: boolean | null }>;
  const rows = (await query(`SELECT id, asin, qty, cost_per_unit, sourcing_cost, paid_cost, cogs_adjustment FROM po_asins WHERE po_id = $1 ORDER BY asin`, [poId])).rows;
  const manual = new Set<string>(
    (await query(`SELECT DISTINCT entity_id FROM po_edit_log WHERE po_id = $1 AND entity = 'asin' AND field = 'cost_per_unit' AND NOT derived`, [poId])).rows.map((r: any) => String(r.entity_id)),
  );
  const subtotalStored = Number(po.subtotal);
  // The double-discount rule, per promo (Maria 2026-11-01; 1¢ 2026-11-04; per promo 2026-11-05): the promos already in the
  // line totals count for nothing, the rest apply as usual (reflectedPromos).
  const allLines = (await query(`SELECT price, qty_ordered, line_total, regular_price FROM po_line_items WHERE po_id = $1`, [poId])).rows as Array<{ price: string | null; qty_ordered: string | null; line_total: string | null; regular_price?: string | null }>;
  const linesSum = r2(allLines.reduce((t, l) => t + (lineMoney(costLine(l)) ?? 0), 0));
  const refl = reflectedPromos({
    linesSum, subtotal: subtotalStored > 0 ? subtotalStored : null, discount: Number(po.discount) || 0, promoAmounts: promos.map((p) => (p.amount == null ? null : Number(p.amount))), answers: promos.map((p) => p.in_line_prices ?? null), kinds: promos.map((p) => promoKind(p.type, p.description)), shipping: Number(po.sh_donations) || 0, // a rewards voucher is never in a line price (2026-11-07); a shipping discount comes off the shipping (2026-11-08)
    percents: promos.map((p) => (p.percent == null ? null : Number(p.percent))), sequenceBase: allocationBaseOf(allLines.map(costLine)) ?? (subtotalStored > 0 ? subtotalStored : linesSum), // in sequence (2026-11-06)
    postDiscountSubtotal: po.order_total == null ? null : r2((Number(po.order_total) || 0) - (Number(po.tax) || 0) - (Number(po.sh_donations) || 0)),
  });
  // Allocated over the line totals — the stored subtotal when the lines are pre-discount and it is known.
  const subtotal = subtotalStored > 0 ? subtotalStored : linesSum;
  // The GC % unrounded (2026-11-05): recomputed from the payments when they give the stored 2 dp value, else the stored value.
  const stored = po.weighted_gc_discount_pct == null ? null : Number(po.weighted_gc_discount_pct);
  const pays = (await query(`SELECT method, amount, gift_card_discount_pct, reward_pct FROM po_payments WHERE po_id = $1`, [poId])).rows;
  const exact = weightedPaymentPctExact(pays, Number(po.order_total) || 0);
  const gcPct = exact != null && stored != null && Math.abs(r2(exact) - stored) < 0.005 ? exact : stored;
  const h: CostHeader = promoCostHeader({
    subtotal, discount: Number(po.discount) || 0, gcPct, tax: Number(po.tax) || 0, shDonations: Number(po.sh_donations) || 0,
    allocationBase: allocationBaseOf(allLines.map(costLine)), // free-item deals: allocated by regular price × qty (migration 097)
  }, linesSum, promos.map((p) => ({ counts: p.counts_toward_cogs !== false })), refl);
  let changed = 0;
  for (const pa of rows) {
    const lines = (await query(`SELECT id, price, qty_ordered, line_total, regular_price, adjusted_product_cost FROM po_line_items WHERE po_asin_id = $1 ORDER BY position`, [pa.id])).rows;
    const costs = allocateAsinCosts(h, lines.map(costLine), Number(pa.qty), pa.cogs_adjustment == null ? 0 : Number(pa.cogs_adjustment));
    if (!costs) continue;
    const next: Record<string, unknown> = { sourcing_cost: costs.sourcing.toFixed(2), paid_cost: costs.paid.toFixed(2) };
    if (!manual.has(String(pa.id))) next.cost_per_unit = costs.cogs.toFixed(2);
    const changes = changedFields(pa, next);
    if (changes.length > 0) {
      const cols = changes.map((c) => c.field);
      await write(`UPDATE po_asins SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(", ")} WHERE id = $1`, [pa.id, ...cols.map((c) => next[c])]);
      if (!opts.dryRun) await logEdits(query, poId, userId, "asin", String(pa.id), changes, { derived: true });  // derived: never read back as a typed cost
      for (const c of changes) plan.push({ entity: "asin", id: String(pa.id), ...c });
      changed += changes.length;
    }
    for (const l of lines) {
      const cl = costLine(l);
      const unit = h.allocationBase != null && cl.regularPrice != null && cl.regularPrice > 0 ? cl.regularPrice : cl.lineTotal != null && cl.qty > 0 ? cl.lineTotal / cl.qty : cl.price;
      const adj = adjustedProductCost(unit, h);
      const lc = changedFields(l, { adjusted_product_cost: adj == null ? null : adj.toFixed(2) });
      if (lc.length > 0) { await write(`UPDATE po_line_items SET adjusted_product_cost = $2 WHERE id = $1`, [l.id, adj == null ? null : adj.toFixed(2)]); for (const c of lc) plan.push({ entity: "line", id: String(l.id), ...c }); changed++; }
    }
  }
  if (Number(po.cost_formula_version) !== COST_FORMULA_VERSION && (changed > 0 || rows.length > 0)) {
    await write(`UPDATE purchase_orders SET cost_formula_version = $2 WHERE id = $1`, [poId, COST_FORMULA_VERSION]);
    if (!opts.dryRun) await logEdits(query, poId, userId, "po", poId, [{ field: "cost_formula_version", old: po.cost_formula_version, new: String(COST_FORMULA_VERSION) }]);
    plan.push({ entity: "po", id: poId, field: "cost_formula_version", old: po.cost_formula_version, new: COST_FORMULA_VERSION });
  }
  return { poId, skipped: null, asinRows: rows.length, changed, ...(refl.needsAnswer.length ? { ambiguousPromos: true } : {}), ...(opts.dryRun ? { plan } : {}) };
}
