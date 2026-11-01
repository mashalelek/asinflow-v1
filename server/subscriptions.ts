// Subscriptions (patch docs/claude_spec-patch-po-ai-prefill.md §9; SPEC §27).
// One row per (supplier, ASIN) a retailer re-ships on a schedule: frequency
// in weeks, next order date, status, the originating PO's ASIN row and the
// last PO. Three writers: the New PO form (a capture / a form that says
// "Subscription: yes · every N weeks"), the Subscriptions page (inline
// edits, manual create) and the confirmation-email renewal (a renewal PO
// created from the email, source 'email_renewal').
//
// 00:00 pass (component 28): "Subscription renews" on the last PO's lines
// while next_order_date − 7 days ≤ today — but only for a date no older than
// 14 days (an older one is overdue on the Subscriptions page for Maria to
// pause / cancel, not an action item on a months-old PO); the item clears by
// itself when a renewal PO is created or the subscription is paused / canceled.
import type { QueryLike } from "./scheduler/types";
import { EditError, logEdits, parseEdits, isoDate, intQty, textOrNull, asinParser, requiredText, type Parsed } from "./po-edit";
import { insertLineItems } from "./line-action-items";
import { SUBSCRIPTION_RENEWS, REVIEW_RENEWAL_PO, SUBSCRIPTION_MAY_BE_ACTIVE } from "./po-status-map";
import { addWeeks } from "./po-model-backfill";
import { nameTokens, tokenOverlap } from "./asin-suggest";
import { afEntrySeq } from "./po-entry-seq";
import type { PoFormState } from "@shared/po-form";

export const ALERT_DAYS_BEFORE = 7;
export const ALERT_MAX_OVERDUE_DAYS = 14;
export const SUBSCRIPTION_STATUSES = ["active", "paused", "canceled"] as const;
const statusParser = (v: unknown): Parsed => ((SUBSCRIPTION_STATUSES as readonly string[]).includes(String(v)) ? { ok: true, value: String(v) } : { ok: false, error: "must be active, paused or canceled" });
const dateOrNull = (v: unknown): Parsed => (v == null || v === "" ? { ok: true, value: null } : isoDate(v));
const weeksOrNull = (v: unknown): Parsed => (v == null || v === "" ? { ok: true, value: null } : intQty({ min: 1 })(v));

/** Fields the page may edit. */
export const SUBSCRIPTION_FIELDS = { frequency_weeks: weeksOrNull, next_order_date: dateOrNull, status: statusParser, notes: textOrNull, product_name: textOrNull, asin: asinParser } as const;

const ymd = (v: unknown): string | null => {
  if (v == null) return null;
  if (v instanceof Date) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v)); return m ? m[1] : null;
};
const daysBetween = (a: string, b: string): number => { const [y1, m1, d1] = a.split("-").map(Number), [y2, m2, d2] = b.split("-").map(Number); return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000); };

/** Pure: should "Subscription renews" be open today for a subscription? */
export function alertDue(s: { status: string; next_order_date: string | null }, today: string): boolean {
  if (s.status !== "active" || !s.next_order_date) return false;
  const d = daysBetween(today, s.next_order_date); // positive = in the future
  return d <= ALERT_DAYS_BEFORE && d >= -ALERT_MAX_OVERDUE_DAYS;
}

export async function listSubscriptions(query: QueryLike): Promise<any[]> {
  return (await query(
    `SELECT s.*, s.next_order_date::text AS next_order_date, p.order_id AS last_order_id, p.order_date::text AS last_order_date, a.title AS asin_title, a.image_url AS thumbnail,
            (SELECT po.order_id FROM po_asins pa JOIN purchase_orders po ON po.id = pa.po_id WHERE pa.id = s.po_asin_id) AS origin_order_id
       FROM subscriptions s LEFT JOIN purchase_orders p ON p.id = s.last_po_id LEFT JOIN asins a ON a.asin = s.asin
      ORDER BY (s.status = 'active') DESC, s.next_order_date NULLS LAST, s.supplier, s.asin`,
  )).rows;
}

export async function createSubscription(query: QueryLike, body: any, userId: number | null): Promise<{ id: number }> {
  const sup = requiredText(body?.supplier); if (!sup.ok) throw new EditError(400, `supplier ${sup.error}`);
  const { supplier: _supplier, ...rest } = (body ?? {}) as Record<string, unknown>;
  const p = parseEdits({ frequency_weeks: weeksOrNull, next_order_date: dateOrNull, status: statusParser, notes: textOrNull, product_name: textOrNull, asin: (v) => (v == null || v === "" ? { ok: true, value: null } : asinParser(v)) }, { status: "active", ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) });
  if (!p.ok) throw new EditError(400, p.error);
  const e = p.edits;
  const r = await query(`INSERT INTO subscriptions (supplier, asin, product_name, frequency_weeks, next_order_date, status, created_from, notes) VALUES ($1,$2,$3,$4,$5,$6,'manual',$7) RETURNING id`,
    [sup.value, e.asin ?? null, e.product_name ?? null, e.frequency_weeks ?? null, e.next_order_date ?? null, e.status ?? "active", e.notes ?? null]);
  void userId;
  return { id: Number(r.rows[0].id) };
}

export async function updateSubscription(query: QueryLike, id: number, body: unknown, userId: number | null): Promise<{ id: number; changes: string[] }> {
  const p = parseEdits(SUBSCRIPTION_FIELDS as any, body);
  if (!p.ok) throw new EditError(400, p.error);
  const cur = (await query(`SELECT * FROM subscriptions WHERE id = $1`, [id])).rows[0];
  if (!cur) throw new EditError(404, "subscription not found");
  const changed = Object.entries(p.edits).filter(([k, v]) => String(ymd(cur[k]) ?? cur[k] ?? "") !== String(v ?? ""));
  if (changed.length === 0) return { id, changes: [] };
  await query(`UPDATE subscriptions SET ${changed.map(([k], i) => `${k} = $${i + 2}`).join(", ")}, updated_at = NOW() WHERE id = $1`, [id, ...changed.map(([, v]) => v)]);
  // A pause / cancel clears the open alert on the last PO right away.
  if (changed.some(([k, v]) => k === "status" && v !== "active") && cur.last_po_id) await clearRenewsItem(query, String(cur.last_po_id), "manual");
  // Maria confirming a renewal of a canceled subscription (status → active,
  // Maria 2026-11-01): the "Subscription may be active" item on the renewal
  // PO clears, and the next order date is set from that PO when none is set.
  if (changed.some(([k, v]) => k === "status" && v === "active") && cur.last_po_id) {
    await clearItem(query, String(cur.last_po_id), SUBSCRIPTION_MAY_BE_ACTIVE, "manual");
    if (!cur.next_order_date && !("next_order_date" in p.edits) && cur.frequency_weeks) {
      const od = ymd((await query(`SELECT order_date FROM purchase_orders WHERE id = $1`, [String(cur.last_po_id)])).rows[0]?.order_date);
      if (od) await query(`UPDATE subscriptions SET next_order_date = $2, updated_at = NOW() WHERE id = $1`, [id, addWeeks(od, Number(cur.frequency_weeks))]);
    }
  }
  if (cur.last_po_id) await logEdits(query, String(cur.last_po_id), userId, "po", String(cur.last_po_id), changed.map(([k, v]) => ({ field: `subscription ${k}`, old: ymd(cur[k]) ?? (cur[k] == null ? null : String(cur[k])), new: v == null ? null : String(v) })));
  return { id, changes: changed.map(([k]) => k) };
}

async function clearItem(query: QueryLike, poId: string, item: string, by: "manual" | "auto"): Promise<number> {
  const r = await query(`UPDATE po_line_action_items a SET cleared_at = now(), cleared_by = $3 FROM po_line_items l WHERE l.id = a.po_line_item_id AND l.po_id = $1 AND a.item = $2 AND a.cleared_at IS NULL`, [poId, item, by]);
  return r.rowCount ?? 0;
}
const clearRenewsItem = (query: QueryLike, poId: string, by: "manual" | "auto") => clearItem(query, poId, SUBSCRIPTION_RENEWS, by);
async function raiseOnPo(query: QueryLike, poId: string, item: string, reason: string): Promise<void> {
  const lines = (await query(`SELECT id FROM po_line_items WHERE po_id = $1`, [poId])).rows;
  for (const l of lines) await insertLineItems(query, String(l.id), [item], "auto", reason);
}

/** The 00:00 pass: raise / clear "Subscription renews". */
export async function runSubscriptionAlerts(query: QueryLike, today: string): Promise<{ due: number; raised: number; cleared: number; overdue: number }> {
  const subs = (await query(`SELECT id, status, next_order_date::text AS next_order_date, last_po_id, supplier, asin FROM subscriptions`)).rows as Array<{ id: number; status: string; next_order_date: string | null; last_po_id: string | null; supplier: string; asin: string | null }>;
  const r = { due: 0, raised: 0, cleared: 0, overdue: 0 };
  for (const s of subs) {
    if (!s.last_po_id) continue;
    if (alertDue(s, today)) {
      r.due++;
      await raiseOnPo(query, s.last_po_id, SUBSCRIPTION_RENEWS, `${s.supplier}${s.asin ? ` ${s.asin}` : ""}: next order ${s.next_order_date}`);
      r.raised++;
    } else {
      if (s.status === "active" && s.next_order_date && daysBetween(today, s.next_order_date) < -ALERT_MAX_OVERDUE_DAYS) r.overdue++;
      r.cleared += await clearRenewsItem(query, s.last_po_id, "auto");
    }
  }
  return r;
}

/** New PO form (§9 capture hook): "Subscription: yes · every N weeks" → one row per ASIN row of the PO (upsert on supplier + ASIN). */
export async function subscriptionsFromForm(query: QueryLike, poId: string, form: Pick<PoFormState, "supplier" | "order_date" | "subscription" | "prefill">, asinRows: ReadonlyArray<{ id: string; asin: string; asin_name: string | null }>): Promise<number> {
  if (form.subscription?.present !== true) return 0;
  const weeks = /^\d+$/.test(String(form.subscription.frequency_weeks ?? "").trim()) ? Number(form.subscription.frequency_weeks) : null;
  const next = weeks ? addWeeks(form.order_date.trim(), weeks) : null;
  let n = 0;
  for (const a of asinRows) {
    const cur = (await query(`SELECT id FROM subscriptions WHERE supplier = $1 AND asin = $2`, [form.supplier.trim(), a.asin])).rows[0];
    if (cur) {
      await query(`UPDATE subscriptions SET last_po_id = $2, po_asin_id = $3, frequency_weeks = COALESCE($4, frequency_weeks), next_order_date = COALESCE($5, next_order_date), status = 'active', updated_at = NOW() WHERE id = $1`, [cur.id, poId, a.id, weeks, next]);
    } else {
      await query(`INSERT INTO subscriptions (supplier, po_asin_id, asin, product_name, frequency_weeks, next_order_date, status, last_po_id, created_from) VALUES ($1,$2,$3,$4,$5,$6,'active',$7,$8)`,
        [form.supplier.trim(), a.id, a.asin, a.asin_name, weeks, next, poId, form.prefill?.id ? "capture" : "manual"]);
    }
    n++;
  }
  return n;
}

// ── Renewal from a confirmation email (§9) ───────────────────────────────────
export interface RenewalEmail { id: string; subject: string; text: string; date: Date; orderId: string | null; total: number | null }
export interface RenewalResult { created: boolean; poId?: string; subscriptionIds?: number[]; reason?: string; item?: string }

/** Pure: the email's qty and unit price printed near a product name, when any. */
export function qtyPriceNear(text: string, productName: string): { qty: number | null; price: number | null } {
  const toks = nameTokens(productName);
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (tokenOverlap(toks, nameTokens(lines[i])) < 0.5) continue;
    const window = lines.slice(i, i + 4).join("\n");
    const q = /\b(?:qty|quantity)\s*[:.]?\s*(\d+)\b|\b(\d+)\s*[x×]\s*\$|[x×]\s*(\d+)\s*$/im.exec(window);
    const p = /\$\s?(\d[\d,]*\.\d{2})/.exec(window);
    return { qty: q ? Number(q[1] ?? q[2] ?? q[3]) : null, price: p ? Number(p[1].replace(/,/g, "")) : null };
  }
  return { qty: null, price: null };
}

/**
 * An order-confirmation email that matched no PO: when the sender's supplier
 * has active subscriptions whose last PO's product names appear in the
 * email, create the renewal PO (lines copied from the last PO with the
 * email's quantities / prices where printed, payments from the email where
 * present), raise "Review renewal PO", advance next_order_date, clear the
 * previous PO's "Subscription renews".
 */
export async function tryRenewalFromEmail(query: QueryLike, supplier: string | null, email: RenewalEmail): Promise<RenewalResult> {
  if (!supplier) return { created: false, reason: "unknown sender" };
  // Active AND canceled subscriptions (Maria 2026-11-01): the sheet backfill
  // marked every one canceled, and a confirmation for one of those is the
  // evidence it still runs — the PO is created either way; a canceled
  // subscription gets "Subscription may be active" instead of "Review
  // renewal PO" and stays canceled until Maria flips it (updateSubscription).
  const subs = (await query(`SELECT s.id, s.status, s.last_po_id, s.frequency_weeks, s.asin FROM subscriptions s WHERE s.status IN ('active', 'canceled') AND lower(s.supplier) = lower($1) AND s.last_po_id IS NOT NULL`, [supplier])).rows;
  if (subs.length === 0) return { created: false, reason: "no active or canceled subscription for the supplier" };
  const byPo = new Map<string, any[]>();
  for (const s of subs) { const k = String(s.last_po_id); if (!byPo.has(k)) byPo.set(k, []); byPo.get(k)!.push(s); }
  for (const [lastPoId, group] of Array.from(byPo.entries())) {
    const po = (await query(`SELECT * FROM purchase_orders WHERE id = $1`, [lastPoId])).rows[0];
    if (!po) continue;
    const rows = (await query(`SELECT * FROM po_asins WHERE po_id = $1 ORDER BY asin`, [lastPoId])).rows;
    const lines = (await query(`SELECT * FROM po_line_items WHERE po_id = $1 ORDER BY po_asin_id, position`, [lastPoId])).rows;
    const matched = lines.filter((l: any) => l.product_name && tokenOverlap(nameTokens(l.product_name), nameTokens(email.text)) >= 0.5 || (l.product_name && email.text.toLowerCase().includes(String(l.product_name).toLowerCase())));
    if (matched.length === 0) continue;
    const orderId = email.orderId ?? `renewal-${email.id}`;
    const dup = (await query(`SELECT id FROM purchase_orders WHERE supplier = $1 AND order_id = $2`, [po.supplier, orderId])).rows[0];
    if (dup) return { created: false, reason: `PO ${po.supplier} ${orderId} already exists` };
    const orderDate = ymd(email.date)!;
    const ins = await query(
      `INSERT INTO purchase_orders (order_id, order_date, supplier, action_items, subtotal, tax, sh_donations, discount, refund_amount, order_total, payment_method, weighted_gc_discount_pct, promo, cashback_site, cashback_pct, purchased_by, purchased_by_user_id, subscription, email_used, notes, source, entry_seq, ships_to, cost_formula_version)
       VALUES ($1, $2, $3, '{}'::text[], $4, 0, 0, 0, 0, $5, $6, $7, NULL, NULL, NULL, $8, $9, true, $10, $11, 'email_renewal', $12, $13, NULL) RETURNING id`,
      [orderId, orderDate, po.supplier, email.total ?? po.subtotal, email.total ?? po.order_total, po.payment_method, po.weighted_gc_discount_pct, po.purchased_by, po.purchased_by_user_id, po.email_used,
       `Renewal PO created from the confirmation email "${email.subject.slice(0, 120)}" (${orderDate}); review the lines and prices.`, afEntrySeq(email.date), po.ships_to],
    );
    const newPoId = String(ins.rows[0].id);
    const idMap = new Map<string, string>();
    for (const r of rows) {
      const pa = await query(
        `INSERT INTO po_asins (po_id, asin, asin_name, sku, qty, cost_per_unit, prep_cost, sold_as, units_per_pack, unique_products, sourcing_cost, paid_cost) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [newPoId, r.asin, r.asin_name, r.sku, r.qty, r.cost_per_unit, r.prep_cost, r.sold_as, r.units_per_pack, r.unique_products, r.sourcing_cost, r.paid_cost],
      );
      idMap.set(String(r.id), String(pa.rows[0].id));
    }
    const newLineIds: string[] = [];
    for (const l of lines) {
      const near = l.product_name ? qtyPriceNear(email.text, String(l.product_name)) : { qty: null, price: null };
      const li = await query(
        `INSERT INTO po_line_items (po_id, po_asin_id, position, product_name, supplier_sku, price, item_discount, qty_ordered, qty_returned, asin_qty_per_product, adjusted_product_cost, action_items) VALUES ($1,$2,$3,$4,$5,$6,0,$7,0,$8,$9,'{}'::text[]) RETURNING id`,
        [newPoId, l.po_asin_id ? idMap.get(String(l.po_asin_id)) ?? null : null, l.position, l.product_name, l.supplier_sku, near.price != null ? near.price.toFixed(2) : l.price, near.qty ?? l.qty_ordered, l.asin_qty_per_product, l.adjusted_product_cost],
      );
      newLineIds.push(String(li.rows[0].id));
    }
    // Payments from the email where present ("•••• 1234" / "ending in 1234"), else none.
    const pay = /(?:•{4}|\*{4}|ending in|ending with)\s*(\d{4})/i.exec(email.text);
    if (pay) await query(`INSERT INTO po_payments (po_id, position, method, nickname, last4, amount) VALUES ($1, 0, 'card', $2, $3, $4)`, [newPoId, /(visa|amex|mastercard|discover|chase|citi)[^\n]{0,20}?(?=•|\*|ending)/i.exec(email.text)?.[1] ?? null, pay[1], email.total]);
    const wasCanceled = group.some((s) => s.status === "canceled");
    for (const id of newLineIds) await insertLineItems(query, id, [wasCanceled ? SUBSCRIPTION_MAY_BE_ACTIVE : REVIEW_RENEWAL_PO], "auto", wasCanceled ? `confirmation "${email.subject.slice(0, 80)}" for a canceled subscription — review the lines; set it active on the Subscriptions page if it still runs` : `renewal from "${email.subject.slice(0, 80)}"`);
    await logEdits(query, newPoId, null, "po", newPoId, [{ field: "PO created", old: null, new: `renewal of ${po.supplier} ${po.order_id} from the confirmation email` }]);
    for (const s of group) {
      // A canceled subscription keeps its status and date; only the link to the new PO moves.
      const next = s.status === "active" && s.frequency_weeks ? addWeeks(orderDate, Number(s.frequency_weeks)) : null;
      await query(`UPDATE subscriptions SET last_po_id = $2, next_order_date = COALESCE($3, next_order_date), updated_at = NOW() WHERE id = $1`, [s.id, newPoId, next]);
    }
    await clearRenewsItem(query, lastPoId, "auto");
    return { created: true, poId: newPoId, subscriptionIds: group.map((s) => Number(s.id)), item: wasCanceled ? SUBSCRIPTION_MAY_BE_ACTIVE : REVIEW_RENEWAL_PO };
  }
  return { created: false, reason: "no subscription product named in the email" };
}
