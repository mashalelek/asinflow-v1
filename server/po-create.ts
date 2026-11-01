// New PO from the form (patch docs/claude_spec-patch-po-af-owned.md §4,
// 2026-10-18; costs and promos per po-ai-prefill §7 as corrected
// 2026-10-31). The form state is shared/po-form.ts's plain JSON shape; the
// same checkPoForm the browser runs live is re-run here before any write.
// Creates the PO + ASIN rows + product lines the way the importer lays them
// out (one po_asins row per ASIN, lines under it by position, ASIN title and
// primary SKU from the catalog), source 'manual', entry_seq = creation time
// (po-entry-seq.ts), Open, cost_formula_version 2 (so the editor may
// recompute its costs — a sheet-imported PO never is). Every ASIN row
// carries its three costs (Sourcing / COGS / Paid) and adjustment; promos go
// to po_promos. A hand-typed cost / unit is logged as such, so a later
// recompute leaves it alone. One po_edit_log row records the creation.
import type { QueryLike } from "./scheduler/types";
import { checkPoForm, shipsToFromForm, canonicalPaymentName, COST_FORMULA_VERSION_SAVED, type PoFormState } from "@shared/po-form";
import { afEntrySeq } from "./po-entry-seq";
import { logEdits, EditError } from "./po-edit";
import { applyAsinPackUpdate, parsePack } from "./asin-pack";
import { subscriptionsFromForm } from "./subscriptions";

const txt = (s: unknown) => { const v = typeof s === "string" ? s.trim() : ""; return v === "" ? null : v; };
const moneyOr0 = (s: unknown) => { const v = typeof s === "string" ? s.replace(/[$,\s]/g, "") : ""; return v === "" ? "0" : v; };
const moneyOrNull = (s: unknown) => { const v = typeof s === "string" ? s.replace(/[$,\s]/g, "") : ""; return v === "" ? null : v; };
const pct = (s: unknown) => { const v = typeof s === "string" ? s.replace(/[%\s]/g, "") : ""; return v === "" ? null : v; };

export async function createPoFromForm(query: QueryLike, form: PoFormState, userId: number | null, now: Date = new Date()): Promise<{ poId: string; asins: number; lines: number }> {
  const check = checkPoForm(form);
  if (!check.ok) {
    const prod = Object.entries(check.productErrors).map(([i, m]) => `product ${Number(i) + 1}: ${m.join("; ")}`);
    throw new EditError(400, [...check.errors, ...prod].join(" · "));
  }
  const supplier = form.supplier.trim(), orderId = form.order_id.trim();
  const dup = (await query(`SELECT id FROM purchase_orders WHERE supplier = $1 AND order_id = $2`, [supplier, orderId])).rows[0];
  if (dup) throw new EditError(409, `a PO ${supplier} ${orderId} already exists`);
  const subtotal = txt(form.subtotal) == null ? check.computedSubtotal.toFixed(2) : moneyOr0(form.subtotal);
  const ins = await query(
    `INSERT INTO purchase_orders (order_id, order_date, supplier, action_items, subtotal, tax, sh_donations, discount, refund_amount, order_total,
       payment_method, weighted_gc_discount_pct, promo, cashback_site, cashback_pct, purchased_by, notes, source, entry_seq, ships_to, cost_formula_version,
       email_used, purchased_by_user_id, cashback_status, subscription)
     VALUES ($1, $2, $3, '{}'::text[], $4, $5, $6, $7, $8, $9, $10, $11, NULL, $12, $13, $14, $15, $22, $16, $17, $18, $19, $20, $21, $23) RETURNING id`,
    [orderId, form.order_date.trim(), supplier, subtotal, moneyOr0(form.tax), moneyOr0(form.sh_donations), moneyOr0(form.discount), moneyOr0(form.refund_amount),
     // Weighted GC % is computed from the gift-card payments (round 2, 2026-11-01); the typed field only stands in when no payment carries a GC %.
     check.effectiveOrderTotal.toFixed(2), txt(form.payment_method), check.weightedGcPct != null ? check.weightedGcPct.toFixed(2) : pct(form.weighted_gc_discount_pct), txt(form.cashback_site), pct(form.cashback_pct),
     txt(form.purchased_by), txt(form.notes), afEntrySeq(now),
     // As chosen on the form; absent → derived from prep cost (SPEC §26).
     form.ships_to === "home" || form.ships_to === "velocity" ? form.ships_to : shipsToFromForm(form),
     COST_FORMULA_VERSION_SAVED,
     txt(form.email_used), txt(form.purchased_by_user_id) == null ? null : Number(form.purchased_by_user_id), txt(form.cashback_status),
     form.prefill?.id ? "extension" : "manual", form.subscription?.present === true],
  );
  const poId = String(ins.rows[0].id);
  let lines = 0;
  const asinRows: Array<{ id: string; asin: string; asin_name: string | null }> = [];
  for (const a of check.asins) {
    const cat = (await query(`SELECT title, primary_sku FROM asins WHERE asin = $1`, [a.asin])).rows[0];
    const pa = await query(
      `INSERT INTO po_asins (po_id, asin, asin_name, sku, qty, cost_per_unit, prep_cost, sold_as, units_per_pack, unique_products, sourcing_cost, paid_cost, cogs_adjustment, cogs_adjustment_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id`,
      [poId, a.asin, cat?.title ?? null, cat?.primary_sku ?? null, a.qty, a.cost_per_unit, a.prep_cost, a.sold_as, a.units_per_pack, a.unique_products,
       a.sourcing_cost, a.paid_cost, a.cogs_adjustment, a.cogs_adjustment_reason],
    );
    const paId = String(pa.rows[0].id);
    asinRows.push({ id: paId, asin: a.asin, asin_name: cat?.title ?? null });
    for (const l of a.lines) {
      await query(
        `INSERT INTO po_line_items (po_id, po_asin_id, position, product_name, supplier_sku, price, item_discount, qty_ordered, qty_returned, asin_qty_per_product, adjusted_product_cost, action_items, notes)
         VALUES ($1, $2, $3, $4, $5, $6, 0, $7, 0, $8, $9, '{}'::text[], $10)`,
        [poId, paId, l.position, l.product_name, l.supplier_sku, l.price, l.qty_ordered, l.asin_qty_per_product, l.adjusted_product_cost, l.notes],
      );
      lines++;
    }
    // A typed cost / unit is a manual value: logged, and left alone by every later recompute (po-costs.ts).
    if (a.cost_per_unit != null && a.cost_per_unit !== a.computed_cost_per_unit) {
      await logEdits(query, poId, userId, "asin", paId, [{ field: "cost_per_unit", old: a.computed_cost_per_unit, new: a.cost_per_unit }]);
    }
  }
  const promos = Array.isArray(form.promos) ? form.promos : [];
  for (let i = 0; i < promos.length; i++) {
    const p = promos[i];
    await query(
      `INSERT INTO po_promos (po_id, position, type, description, amount, percent, counts_toward_cogs, raw_text, source) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'manual')`,
      [poId, i, p.type || null, txt(p.description), moneyOrNull(p.amount), pct(p.percent), p.counts_toward_cogs !== false, txt(p.description)],
    );
  }
  const payments = Array.isArray(form.payments) ? form.payments : [];
  // Nicknames through the alias table ("OnePay Cash" = "Walmart card") so history matches on the canonical name.
  const aliasRow = payments.length ? (await query(`SELECT value FROM settings WHERE key = 'po_payment_method_aliases'`)).rows[0]?.value : null;
  const aliases = aliasRow && typeof aliasRow === "object" ? (aliasRow as Record<string, string>) : {};
  for (let i = 0; i < payments.length; i++) {
    const p = payments[i];
    await query(
      `INSERT INTO po_payments (po_id, position, method, nickname, last4, amount, gift_card_discount_pct) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [poId, i, p.method, txt(canonicalPaymentName(p.nickname, aliases)), txt(p.last4), moneyOrNull(p.amount), pct(p.gift_card_discount_pct)],
    );
  }
  await logEdits(query, poId, userId, "po", poId, [{ field: "PO created", old: null, new: `${supplier} ${orderId} — ${check.asins.length} ASIN(s), ${lines} product(s)` }]);
  // §9: "Subscription: yes · every N weeks" → a subscriptions row per ASIN row (SPEC §27).
  await subscriptionsFromForm(query, poId, form, asinRows);
  // §6.5 "Update ASIN in AF": the chosen ASINs' pack fields follow this PO's rows (History row, open POs brought along).
  for (const a of check.asins) {
    if (form.pack_updates?.[a.asin] !== true) continue;
    await applyAsinPackUpdate(query, a.asin, parsePack({ sold_as: a.sold_as, units_per_pack: a.units_per_pack }), userId, "po_form");
  }
  return { poId, asins: check.asins.length, lines };
}

/** ASIN typeahead for the form: catalog ASINs by ASIN or title. */
export async function lookupAsins(query: QueryLike, q: string): Promise<Array<{ asin: string; title: string | null; primary_sku: string | null; image_url: string | null }>> {
  const s = q.trim();
  if (s.length < 2) return [];
  return (await query(
    `SELECT asin, title, primary_sku, image_url FROM asins
      WHERE asin ILIKE $1 OR title ILIKE $2
      ORDER BY (asin ILIKE $1) DESC, asin LIMIT 12`,
    [`${s.toUpperCase()}%`, `%${s}%`],
  )).rows;
}
