// New PO from the form (patch docs/claude_spec-patch-po-af-owned.md §4,
// 2026-10-18). The form state is shared/po-form.ts's plain JSON shape; the
// same checkPoForm the browser runs live is re-run here before any write.
// Creates the PO + ASIN rows + product lines the way the importer lays them
// out (one po_asins row per ASIN, lines under it by position, ASIN title and
// primary SKU from the catalog), source 'manual', entry_seq = creation time
// (po-entry-seq.ts), Open. One po_edit_log row records the creation.
import type { QueryLike } from "./scheduler/types";
import { checkPoForm, shipsToFromForm, type PoFormState } from "@shared/po-form";
import { afEntrySeq } from "./po-entry-seq";
import { logEdits, EditError } from "./po-edit";

const txt = (s: unknown) => { const v = typeof s === "string" ? s.trim() : ""; return v === "" ? null : v; };
const moneyOr0 = (s: unknown) => { const v = typeof s === "string" ? s.replace(/[$,\s]/g, "") : ""; return v === "" ? "0" : v; };
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
       payment_method, weighted_gc_discount_pct, promo, cashback_site, cashback_pct, purchased_by, notes, source, entry_seq, ships_to)
     VALUES ($1, $2, $3, '{}'::text[], $4, $5, $6, $7, $8, $9, $10, $11, NULL, $12, $13, $14, $15, 'manual', $16, $17) RETURNING id`,
    [orderId, form.order_date.trim(), supplier, subtotal, moneyOr0(form.tax), moneyOr0(form.sh_donations), moneyOr0(form.discount), moneyOr0(form.refund_amount),
     check.effectiveOrderTotal.toFixed(2), txt(form.payment_method), pct(form.weighted_gc_discount_pct), txt(form.cashback_site), pct(form.cashback_pct),
     txt(form.purchased_by), txt(form.notes), afEntrySeq(now),
     // As chosen on the form; absent → derived from prep cost (SPEC §26).
     form.ships_to === "home" || form.ships_to === "velocity" ? form.ships_to : shipsToFromForm(form)],
  );
  const poId = String(ins.rows[0].id);
  let lines = 0;
  for (const a of check.asins) {
    const cat = (await query(`SELECT title, primary_sku FROM asins WHERE asin = $1`, [a.asin])).rows[0];
    const pa = await query(
      `INSERT INTO po_asins (po_id, asin, asin_name, sku, qty, cost_per_unit, prep_cost, sold_as, units_per_pack, unique_products)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [poId, a.asin, cat?.title ?? null, cat?.primary_sku ?? null, a.qty, a.cost_per_unit, a.prep_cost, a.sold_as, a.units_per_pack, a.unique_products],
    );
    const paId = String(pa.rows[0].id);
    for (const l of a.lines) {
      await query(
        `INSERT INTO po_line_items (po_id, po_asin_id, position, product_name, supplier_sku, price, item_discount, qty_ordered, qty_returned, asin_qty_per_product, adjusted_product_cost, action_items)
         VALUES ($1, $2, $3, $4, $5, $6, 0, $7, 0, $8, $9, '{}'::text[])`,
        [poId, paId, l.position, l.product_name, l.supplier_sku, l.price, l.qty_ordered, l.asin_qty_per_product, l.adjusted_product_cost],
      );
      lines++;
    }
  }
  await logEdits(query, poId, userId, "po", poId, [{ field: "PO created", old: null, new: `${supplier} ${orderId} — ${check.asins.length} ASIN(s), ${lines} product(s)` }]);
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
