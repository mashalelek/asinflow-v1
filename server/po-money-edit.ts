// PO editor — payments, promos, refunds per line and the per-ASIN cost
// adjustment (patch docs/claude_spec-patch-po-ai-prefill.md §8, commit 8:
// "so existing POs can be completed"). Every write validates through a
// parser, writes only what changes, logs one po_edit_log row per change
// (entity po, with the table in the field name), and — for a PO saved under
// the v2 cost rule — recomputes the costs when a promo's counts_toward_cogs,
// amount or type changes (server/po-costs.ts; an imported PO is never
// recomputed).
import type { QueryLike } from "./scheduler/types";
import { EditError, logEdits, parseEdits, money, pctOrNull, textOrNull, isoDate, decQty, type Parsed } from "./po-edit";
import { recomputePoCosts } from "./po-costs";
import { PAYMENT_METHODS, PROMO_TYPES, promoCountsByDefault } from "@shared/po-form";

const oneOf = (list: readonly string[], nullable = false) => (v: unknown): Parsed => (v == null || v === "" ? (nullable ? { ok: true, value: null } : { ok: false, error: "is required" }) : (list as readonly string[]).includes(String(v)) ? { ok: true, value: String(v) } : { ok: false, error: `must be one of ${list.join(", ")}` });
const last4 = (v: unknown): Parsed => (v == null || v === "" ? { ok: true, value: null } : /^\d{4}$/.test(String(v).trim()) ? { ok: true, value: String(v).trim() } : { ok: false, error: "must be four digits" });
const bool = (v: unknown): Parsed => (typeof v === "boolean" ? { ok: true, value: v } : v === "true" || v === "false" ? { ok: true, value: v === "true" } : { ok: false, error: "must be true or false" });
const dateOrNull = (v: unknown): Parsed => (v == null || v === "" ? { ok: true, value: null } : isoDate(v));

export const PAYMENT_FIELDS = { method: oneOf(PAYMENT_METHODS), nickname: textOrNull, last4, amount: money({ nullable: true }), gift_card_discount_pct: pctOrNull, needs_review: bool } as const;
export const PROMO_FIELDS = { type: oneOf(PROMO_TYPES, true), description: textOrNull, amount: money({ nullable: true }), percent: pctOrNull, counts_toward_cogs: bool } as const;
export const REFUND_FIELDS = { po_line_item_id: textOrNull, qty: decQty({ nullable: true }), amount: money({ nullable: true }), refunded_at: dateOrNull, method: oneOf(PAYMENT_METHODS, true), nickname: textOrNull, last4, note: textOrNull, needs_split: bool } as const;

type Table = "po_payments" | "po_promos" | "po_line_refunds";
const label: Record<Table, string> = { po_payments: "payment", po_promos: "promo", po_line_refunds: "refund" };

async function rowAndPo(query: QueryLike, table: Table, id: number): Promise<{ row: any; poId: string }> {
  const row = (await query(`SELECT * FROM ${table} WHERE id = $1`, [id])).rows[0];
  if (!row) throw new EditError(404, `${label[table]} not found`);
  return { row, poId: String(row.po_id) };
}
const summary = (table: Table, r: Record<string, any>): string =>
  table === "po_payments" ? `${r.method}${r.nickname ? ` ${r.nickname}` : ""}${r.last4 ? ` (${r.last4})` : ""}${r.amount != null ? ` $${Number(r.amount).toFixed(2)}` : ""}`
  : table === "po_promos" ? `${r.type ?? "?"}: ${r.description ?? ""}${r.amount != null ? ` $${Number(r.amount).toFixed(2)}` : ""}${r.percent != null ? ` ${Number(r.percent)}%` : ""}${r.counts_toward_cogs === false ? " (not in COGS)" : ""}`
  : `${r.qty != null ? `${r.qty} × ` : ""}$${r.amount != null ? Number(r.amount).toFixed(2) : "?"}${r.po_line_item_id ? "" : " (PO-level)"}`;

export interface MoneyEditResult { poId: string; id: number; recomputed?: { changed: number; skipped: string | null } }

export async function addMoneyRow(query: QueryLike, table: Table, poId: string, body: unknown, userId: number | null): Promise<MoneyEditResult> {
  const spec = table === "po_payments" ? PAYMENT_FIELDS : table === "po_promos" ? PROMO_FIELDS : REFUND_FIELDS;
  const p = parseEdits(spec as any, { ...(table === "po_promos" ? { type: (body as any)?.type ?? null } : {}), ...(body as object) });
  if (!p.ok) throw new EditError(400, p.error);
  const po = (await query(`SELECT id FROM purchase_orders WHERE id = $1`, [poId])).rows[0];
  if (!po) throw new EditError(404, "PO not found");
  const e = { ...p.edits } as Record<string, any>;
  if (table === "po_promos" && e.counts_toward_cogs == null) e.counts_toward_cogs = e.type ? promoCountsByDefault(String(e.type)) : true;
  if (table === "po_line_refunds") await checkRefundLine(query, poId, e);
  const cols = Object.keys(e);
  const pos = table === "po_line_refunds" ? "" : `, position`;
  const posVal = table === "po_line_refunds" ? "" : `, (SELECT COALESCE(MAX(position), -1) + 1 FROM ${table} WHERE po_id = $1)`;
  const src = table === "po_promos" ? ", source" : "";
  const srcVal = table === "po_promos" ? ", 'manual'" : table === "po_line_refunds" ? "" : "";
  const refundSrc = table === "po_line_refunds" ? ", source" : "", refundSrcVal = table === "po_line_refunds" ? ", 'manual'" : "";
  const ins = await query(
    `INSERT INTO ${table} (po_id${pos}${src}${refundSrc}${cols.map((c) => `, ${c}`).join("")}) VALUES ($1${posVal}${srcVal}${refundSrcVal}${cols.map((_, i) => `, $${i + 2}`).join("")}) RETURNING *`,
    [poId, ...cols.map((c) => e[c])],
  );
  const row = ins.rows[0];
  await logEdits(query, poId, userId, "po", poId, [{ field: `${label[table]} added`, old: null, new: summary(table, row) }]);
  const out: MoneyEditResult = { poId, id: Number(row.id) };
  if (table === "po_promos") { const r = await recomputePoCosts(query, poId, userId); out.recomputed = { changed: r.changed, skipped: r.skipped }; }
  return out;
}

export async function editMoneyRow(query: QueryLike, table: Table, id: number, body: unknown, userId: number | null): Promise<MoneyEditResult> {
  const spec = table === "po_payments" ? PAYMENT_FIELDS : table === "po_promos" ? PROMO_FIELDS : REFUND_FIELDS;
  const p = parseEdits(spec as any, body);
  if (!p.ok) throw new EditError(400, p.error);
  const { row, poId } = await rowAndPo(query, table, id);
  const changes = Object.entries(p.edits).filter(([k, v]) => canon(row[k]) !== canon(v));
  const out: MoneyEditResult = { poId, id };
  if (changes.length === 0) return out;
  const next = { ...row, ...Object.fromEntries(changes) };
  if (table === "po_line_refunds") await checkRefundLine(query, poId, next);
  await query(`UPDATE ${table} SET ${changes.map(([k], i) => `${k} = $${i + 2}`).join(", ")} WHERE id = $1`, [id, ...changes.map(([, v]) => v)]);
  await logEdits(query, poId, userId, "po", poId, changes.map(([k, v]) => ({ field: `${label[table]} ${k}`, old: canon(row[k]), new: canon(v) })));
  if (table === "po_promos" && changes.some(([k]) => ["counts_toward_cogs", "amount", "type"].includes(k))) { const r = await recomputePoCosts(query, poId, userId); out.recomputed = { changed: r.changed, skipped: r.skipped }; }
  return out;
}

export async function removeMoneyRow(query: QueryLike, table: Table, id: number, userId: number | null): Promise<MoneyEditResult> {
  const { row, poId } = await rowAndPo(query, table, id);
  await query(`DELETE FROM ${table} WHERE id = $1`, [id]);
  await logEdits(query, poId, userId, "po", poId, [{ field: `${label[table]} removed`, old: summary(table, row), new: null }]);
  const out: MoneyEditResult = { poId, id };
  if (table === "po_promos") { const r = await recomputePoCosts(query, poId, userId); out.recomputed = { changed: r.changed, skipped: r.skipped }; }
  return out;
}

/** A refund on a line must name a line of this PO; its qty cannot exceed the line's qty ordered. */
async function checkRefundLine(query: QueryLike, poId: string, e: Record<string, any>): Promise<void> {
  if (e.po_line_item_id == null) return;
  const line = (await query(`SELECT qty_ordered FROM po_line_items WHERE id = $1 AND po_id = $2`, [e.po_line_item_id, poId])).rows[0];
  if (!line) throw new EditError(400, "po_line_item_id must be a product line of this PO");
  if (e.qty != null && line.qty_ordered != null && Number(e.qty) > Number(line.qty_ordered)) throw new EditError(400, `qty (${e.qty}) cannot exceed the line's qty ordered (${line.qty_ordered})`);
}

const canon = (v: unknown): string | null => {
  if (v == null) return null;
  if (v instanceof Date) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`;
  if (typeof v === "boolean") return String(v);
  const s = String(v);
  return /^-?(0|[1-9]\d*)(\.\d+)?$/.test(s) ? String(Number(s)) : s;
};

/** The three tables for GET /api/pos/:id. */
export async function loadPoMoney(query: QueryLike, poId: string): Promise<{ payments: any[]; promos: any[]; refunds: any[] }> {
  const payments = (await query(`SELECT * FROM po_payments WHERE po_id = $1 ORDER BY position, id`, [poId])).rows;
  const promos = (await query(`SELECT * FROM po_promos WHERE po_id = $1 ORDER BY position, id`, [poId])).rows;
  const refunds = (await query(`SELECT r.*, r.refunded_at::text AS refunded_at, l.product_name FROM po_line_refunds r LEFT JOIN po_line_items l ON l.id = r.po_line_item_id WHERE r.po_id = $1 ORDER BY r.id`, [poId])).rows;
  return { payments, promos, refunds };
}
