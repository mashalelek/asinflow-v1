// Supplier defects (SPEC §22 "Supplier defects", migration 094, Maria
// 2026-11-05): per PO product line, units missing / damaged / wrong from the
// supplier, with the $ owed and how it was resolved. The line-resolution model
// of the cancellations patch (§3/§5): money lives in po_line_refunds, linked
// through po_line_defect_refunds, so a cancellation confirm can reuse it.
//
// The qty is stored, never derived from Ordered − Received. A refund
// resolution is derived from the links on every change (link, unlink, a linked
// refund marked received, edited or removed); replacement and write-off are
// set by hand. Every change is a History row (po_edit_log, entity line).
// Nothing here touches COGS, quantities or the line's own fields.
import type { QueryLike } from "./scheduler/types";
import { EditError, logEdits } from "./po-edit";
import { DEFECT_KIND_LABELS, DEFECT_KINDS, defectAmount, defectMoney, type DefectKind } from "@shared/po-defect";

export { OPEN_DEFECT_ASIN_SQL, OPEN_DEFECT_PO_SQL, OPEN_DEFECT_LINE_SQL, defectItemSql, DEFECT_UNCOVERED_PO_SQL, DEFECT_UNCOVERED_EXISTS_SQL } from "./po-defect-sql";

export interface DefectRow {
  id: number; po_id: string; po_line_item_id: string; kind: DefectKind; qty: number; amount: number | null; opened_at: string; note: string | null;
  status: "open" | "resolved"; resolution: "refund" | "replacement" | "write_off" | null; replacement_po_line_item_id: string | null;
  write_off_reason: string | null; resolved_at: string | null;
  asin: string | null; product_name: string | null; line_no: number;
  refunds: Array<{ id: number; amount: number | null; status: string; refunded_at: string | null }>;
  replacement: { po_id: string; order_id: string; supplier: string; asin: string | null; line_no: number } | null;
  owed: number | null; uncovered: number | null; received: number;
}

const num = (v: unknown) => (v == null ? null : Number(v));
const money = (v: number | null) => (v == null ? "—" : `$${v.toFixed(2)}`);
const describe = (d: { qty: number | string; kind: string; amount: number | string | null }) => `${Number(d.qty)} ${DEFECT_KIND_LABELS[d.kind as DefectKind] ?? d.kind} × ${money(num(d.amount))}`;

/** The line's 1-based number within its ASIN row (position order) — how the UI and the scripts name a line. */
const LINE_NO_SQL = (l: string) => `(SELECT COUNT(*)::int FROM po_line_items s WHERE s.po_asin_id IS NOT DISTINCT FROM ${l}.po_asin_id AND s.po_id = ${l}.po_id
  AND (COALESCE(s.position, 0), s.id) <= (COALESCE(${l}.position, 0), ${l}.id))`;

export async function loadDefects(query: QueryLike, where: { poId?: string; ids?: number[] }): Promise<DefectRow[]> {
  const cond = where.ids ? `d.id = ANY($1::bigint[])` : `d.po_id = $1`;
  const rows = (await query(
    `SELECT d.*, d.opened_at::text AS opened_at, d.resolved_at::text AS resolved_at, pa.asin, l.product_name, ${LINE_NO_SQL("l")} AS line_no,
            COALESCE((SELECT json_agg(json_build_object('id', r.id, 'amount', r.amount, 'status', r.status, 'refunded_at', r.refunded_at) ORDER BY r.id)
                        FROM po_line_defect_refunds x JOIN po_line_refunds r ON r.id = x.po_line_refund_id WHERE x.defect_id = d.id), '[]') AS refunds,
            (SELECT json_build_object('po_id', rp.id, 'order_id', rp.order_id, 'supplier', rp.supplier, 'asin', rpa.asin, 'line_no', ${LINE_NO_SQL("rl")})
               FROM po_line_items rl JOIN purchase_orders rp ON rp.id = rl.po_id LEFT JOIN po_asins rpa ON rpa.id = rl.po_asin_id
              WHERE rl.id = d.replacement_po_line_item_id) AS replacement
       FROM po_line_defects d JOIN po_line_items l ON l.id = d.po_line_item_id LEFT JOIN po_asins pa ON pa.id = l.po_asin_id
      WHERE ${cond} ORDER BY d.opened_at, d.id`, [where.ids ?? where.poId],
  )).rows as any[];
  return rows.map((r) => {
    const refunds = (r.refunds ?? []).map((x: any) => ({ id: Number(x.id), amount: num(x.amount), status: x.status, refunded_at: x.refunded_at ?? null }));
    const m = defectMoney(r.amount, refunds);
    return { ...r, id: Number(r.id), qty: Number(r.qty), amount: num(r.amount), refunds, owed: m.owed, uncovered: m.uncovered, received: m.received };
  });
}

/** Per ASIN row / per PO: the open defects' qty and $ owed (the chip text / hover). */
export async function loadOpenDefectSummaries(query: QueryLike, poIds: readonly string[]): Promise<{ byPo: Map<string, DefectRow[]>; byAsinRow: Map<string, DefectRow[]> }> {
  const byPo = new Map<string, DefectRow[]>(), byAsinRow = new Map<string, DefectRow[]>();
  if (poIds.length === 0) return { byPo, byAsinRow };
  const ids = (await query(`SELECT id FROM po_line_defects WHERE po_id = ANY($1::uuid[]) AND status = 'open'`, [poIds])).rows.map((r: any) => Number(r.id));
  if (ids.length === 0) return { byPo, byAsinRow };
  const rows = await loadDefects(query, { ids });
  const asinRow = new Map<string, string>(((await query(`SELECT id, po_asin_id FROM po_line_items WHERE id = ANY($1::uuid[])`, [rows.map((r) => r.po_line_item_id)])).rows as any[]).map((r) => [String(r.id), String(r.po_asin_id)]));
  for (const r of rows) {
    const k = String(r.po_id); if (!byPo.has(k)) byPo.set(k, []); byPo.get(k)!.push(r);
    const a = asinRow.get(String(r.po_line_item_id)); if (a) { if (!byAsinRow.has(a)) byAsinRow.set(a, []); byAsinRow.get(a)!.push(r); }
  }
  return { byPo, byAsinRow };
}

async function lineOf(query: QueryLike, poId: string, lineId: string) {
  const l = (await query(
    `SELECT l.id, l.qty_ordered, l.price, l.adjusted_product_cost, p.subtotal, p.discount, p.tax, p.sh_donations
       FROM po_line_items l JOIN purchase_orders p ON p.id = l.po_id WHERE l.id = $1 AND l.po_id = $2`, [lineId, poId])).rows[0];
  if (!l) throw new EditError(400, "po_line_item_id must be a product line of this PO");
  return l;
}

const qtyOf = (v: unknown): number => {
  const q = Number(v);
  if (!Number.isFinite(q) || q <= 0 || Math.round(q * 100) !== q * 100) throw new EditError(400, "qty must be a positive number (retailer units, up to 2 decimals)");
  return q;
};
const amountOf = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const a = Number(v);
  if (!Number.isFinite(a) || a < 0) throw new EditError(400, "amount must be a non-negative number");
  return Math.round(a * 100) / 100;
};
const kindOf = (v: unknown): DefectKind => {
  const k = String(v ?? "").trim().replace(" ", "_") as DefectKind;
  if (!(DEFECT_KINDS as readonly string[]).includes(k)) throw new EditError(400, `kind must be one of ${DEFECT_KINDS.join(", ")}`);
  return k;
};

export interface AddDefectBody { po_line_item_id: string; kind: string; qty: number | string; amount?: number | string | null; opened_at?: string | null; note?: string | null; refund_ids?: number[] }

/** Add one defect. amount omitted → the default (qty × the line's cost per retailer unit). refund_ids link existing refund rows of this PO. */
export async function addDefect(query: QueryLike, poId: string, body: AddDefectBody, userId: number | null): Promise<{ id: number }> {
  const line = await lineOf(query, poId, String(body?.po_line_item_id ?? ""));
  const kind = kindOf(body.kind), qty = qtyOf(body.qty);
  if (line.qty_ordered != null && qty > Number(line.qty_ordered)) throw new EditError(400, `qty (${qty}) cannot exceed the line's qty ordered (${Number(line.qty_ordered)})`);
  const amount = body.amount === undefined
    ? defectAmount({ qty, adjustedProductCost: line.adjusted_product_cost, price: line.price, subtotal: line.subtotal, discount: line.discount, tax: line.tax, shipping: line.sh_donations })
    : amountOf(body.amount);
  const opened = body.opened_at && /^\d{4}-\d{2}-\d{2}$/.test(body.opened_at) ? body.opened_at : null;
  const row = (await query(
    `INSERT INTO po_line_defects (po_id, po_line_item_id, kind, qty, amount, opened_at, note)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6::date, CURRENT_DATE), $7) RETURNING id`,
    [poId, line.id, kind, qty, amount, opened, body.note?.trim() || null])).rows[0];
  const id = Number(row.id);
  await logEdits(query, poId, userId, "line", String(line.id), [{ field: "supplier defect added", old: null, new: `${describe({ qty, kind, amount })}${body.note?.trim() ? ` — ${body.note.trim()}` : ""}` }]);
  for (const rid of body.refund_ids ?? []) await linkRefund(query, id, Number(rid), userId, { sync: false });
  await syncRefundResolution(query, [id], userId);
  return { id };
}

async function defectRow(query: QueryLike, id: number) {
  const d = (await query(`SELECT * FROM po_line_defects WHERE id = $1`, [id])).rows[0];
  if (!d) throw new EditError(404, "supplier defect not found");
  return d;
}

/** Edit qty / amount / kind / note / opened date. A change to the amount re-derives a refund resolution. */
export async function editDefect(query: QueryLike, id: number, body: Record<string, unknown>, userId: number | null): Promise<{ id: number }> {
  const d = await defectRow(query, id);
  const edits: Record<string, unknown> = {};
  if ("qty" in body) {
    const q = qtyOf(body.qty);
    const line = (await query(`SELECT qty_ordered FROM po_line_items WHERE id = $1`, [d.po_line_item_id])).rows[0];
    if (line?.qty_ordered != null && q > Number(line.qty_ordered)) throw new EditError(400, `qty (${q}) cannot exceed the line's qty ordered (${Number(line.qty_ordered)})`);
    edits.qty = q;
  }
  if ("amount" in body) edits.amount = amountOf(body.amount);
  if ("kind" in body) edits.kind = kindOf(body.kind);
  if ("note" in body) edits.note = String(body.note ?? "").trim() || null;
  if ("opened_at" in body) { if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.opened_at))) throw new EditError(400, "opened_at must be YYYY-MM-DD"); edits.opened_at = body.opened_at; }
  const cur = { ...d, opened_at: d.opened_at instanceof Date ? d.opened_at.toISOString().slice(0, 10) : d.opened_at };
  const changes = Object.entries(edits).filter(([k, v]) => String(cur[k] == null ? "" : k === "qty" || k === "amount" ? Number(cur[k]) : cur[k]) !== String(v ?? ""));
  if (changes.length === 0) return { id };
  await query(`UPDATE po_line_defects SET ${changes.map(([k], i) => `${k} = $${i + 2}`).join(", ")} WHERE id = $1`, [id, ...changes.map(([, v]) => v)]);
  await logEdits(query, String(d.po_id), userId, "line", String(d.po_line_item_id), changes.map(([k, v]) => ({ field: `supplier defect ${k}`, old: cur[k] == null ? null : String(k === "qty" || k === "amount" ? Number(cur[k]) : cur[k]), new: v == null ? null : String(v) })));
  await syncRefundResolution(query, [id], userId);
  return { id };
}

/** Link a refund row of the same PO (any status). A received link may resolve the defect. */
export async function linkRefund(query: QueryLike, id: number, refundId: number, userId: number | null, opts: { sync?: boolean } = {}): Promise<{ id: number }> {
  const d = await defectRow(query, id);
  const r = (await query(`SELECT id, po_id, amount, status FROM po_line_refunds WHERE id = $1`, [refundId])).rows[0];
  if (!r || String(r.po_id) !== String(d.po_id)) throw new EditError(400, "the refund must be a refund row of this PO");
  const ins = await query(`INSERT INTO po_line_defect_refunds (defect_id, po_line_refund_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [id, refundId]);
  if ((ins.rowCount ?? 0) > 0) await logEdits(query, String(d.po_id), userId, "line", String(d.po_line_item_id), [{ field: "supplier defect refund linked", old: null, new: `${money(num(r.amount))} (${r.status})` }]);
  if (opts.sync !== false) await syncRefundResolution(query, [id], userId);
  return { id };
}

export async function unlinkRefund(query: QueryLike, id: number, refundId: number, userId: number | null): Promise<{ id: number }> {
  const d = await defectRow(query, id);
  const r = (await query(`SELECT amount, status FROM po_line_refunds WHERE id = $1`, [refundId])).rows[0];
  const del = await query(`DELETE FROM po_line_defect_refunds WHERE defect_id = $1 AND po_line_refund_id = $2`, [id, refundId]);
  if ((del.rowCount ?? 0) > 0) await logEdits(query, String(d.po_id), userId, "line", String(d.po_line_item_id), [{ field: "supplier defect refund unlinked", old: r ? `${money(num(r.amount))} (${r.status})` : String(refundId), new: null }]);
  await syncRefundResolution(query, [id], userId);
  return { id };
}

/** replacement: the line by id, or by the replacement PO's order # (+ line number; the defect's ASIN unless `asin` says otherwise). */
export type ResolveBody = { resolution: "replacement"; replacement_po_line_item_id?: string; replacement_order_id?: string; asin?: string; line_no?: number } | { resolution: "write_off"; reason: string };

async function replacementLine(query: QueryLike, d: any, body: Extract<ResolveBody, { resolution: "replacement" }>): Promise<string> {
  if (body.replacement_po_line_item_id) return String(body.replacement_po_line_item_id);
  const order = String(body.replacement_order_id ?? "").trim();
  if (!order) throw new EditError(400, "name the replacement: replacement_po_line_item_id or replacement_order_id");
  const asin = String(body.asin ?? "").trim() || (await query(`SELECT pa.asin FROM po_line_items l JOIN po_asins pa ON pa.id = l.po_asin_id WHERE l.id = $1`, [d.po_line_item_id])).rows[0]?.asin;
  const lines = (await query(
    `SELECT l.id FROM po_line_items l JOIN purchase_orders p ON p.id = l.po_id JOIN po_asins pa ON pa.id = l.po_asin_id
      WHERE p.order_id = $1 AND pa.asin = $2 ORDER BY COALESCE(l.position, 0), l.id`, [order, asin])).rows;
  if (lines.length === 0) throw new EditError(400, `no line of ${asin ?? "this ASIN"} on PO ${order}`);
  const n = body.line_no != null ? Number(body.line_no) : lines.length === 1 ? 1 : NaN;
  if (!(n >= 1 && n <= lines.length)) throw new EditError(400, `PO ${order} has ${lines.length} lines of ${asin} — say which (line_no)`);
  return String(lines[n - 1].id);
}

/** Resolve by replacement (the PO line that supplied it) or write-off (a reason). A refund resolution is never set here — it follows the links. */
export async function resolveDefect(query: QueryLike, id: number, body: ResolveBody, userId: number | null): Promise<{ id: number }> {
  const d = await defectRow(query, id);
  if (d.status === "resolved") throw new EditError(400, "this defect is already resolved — reopen it first");
  if (body?.resolution === "replacement") {
    const lineId = await replacementLine(query, d, body);
    const rl = (await query(
      `SELECT l.id, p.order_id, pa.asin FROM po_line_items l JOIN purchase_orders p ON p.id = l.po_id LEFT JOIN po_asins pa ON pa.id = l.po_asin_id WHERE l.id::text = $1`, [lineId])).rows[0];
    if (!rl) throw new EditError(400, "replacement_po_line_item_id must be a PO product line");
    if (String(rl.id) === String(d.po_line_item_id)) throw new EditError(400, "a line cannot replace itself");
    await query(`UPDATE po_line_defects SET status = 'resolved', resolution = 'replacement', replacement_po_line_item_id = $2, resolved_at = now() WHERE id = $1`, [id, rl.id]);
    await logEdits(query, String(d.po_id), userId, "line", String(d.po_line_item_id), [{ field: "supplier defect resolved", old: "open", new: `replacement: ${rl.order_id}${rl.asin ? ` ${rl.asin}` : ""}` }]);
    return { id };
  }
  if (body?.resolution === "write_off") {
    const reason = String((body as any).reason ?? "").trim();
    if (!reason) throw new EditError(400, "a write-off needs a reason");
    await query(`UPDATE po_line_defects SET status = 'resolved', resolution = 'write_off', write_off_reason = $2, resolved_at = now() WHERE id = $1`, [id, reason]);
    await logEdits(query, String(d.po_id), userId, "line", String(d.po_line_item_id), [{ field: "supplier defect resolved", old: "open", new: `write-off: ${reason}` }]);
    return { id };
  }
  throw new EditError(400, "resolution must be replacement or write_off (a refund resolves through linked refund rows)");
}

/** Reopen a resolved defect (replacement / write-off). A refund resolution reopens itself when its refunds no longer cover it. */
export async function reopenDefect(query: QueryLike, id: number, userId: number | null): Promise<{ id: number }> {
  const d = await defectRow(query, id);
  if (d.status === "open") return { id };
  await query(`UPDATE po_line_defects SET status = 'open', resolution = NULL, replacement_po_line_item_id = NULL, write_off_reason = NULL, resolved_at = NULL WHERE id = $1`, [id]);
  await logEdits(query, String(d.po_id), userId, "line", String(d.po_line_item_id), [{ field: "supplier defect reopened", old: d.resolution, new: "open" }]);
  // A refund link may still cover it.
  await syncRefundResolution(query, [id], userId);
  return { id };
}

export async function removeDefect(query: QueryLike, id: number, userId: number | null): Promise<{ id: number; po_id: string }> {
  const d = await defectRow(query, id);
  await query(`DELETE FROM po_line_defects WHERE id = $1`, [id]);
  await logEdits(query, String(d.po_id), userId, "line", String(d.po_line_item_id), [{ field: "supplier defect removed", old: describe(d), new: null }]);
  return { id, po_id: String(d.po_id) };
}

/**
 * Derive the refund resolution: an open defect whose linked refunds RECEIVED
 * cover its amount becomes resolved (refund); a refund-resolved one whose
 * refunds no longer cover it reopens. Replacement / write-off are left alone.
 */
export async function syncRefundResolution(query: QueryLike, defectIds: readonly number[], userId: number | null): Promise<{ resolved: number; reopened: number }> {
  let resolved = 0, reopened = 0;
  if (defectIds.length === 0) return { resolved, reopened };
  for (const d of await loadDefects(query, { ids: Array.from(new Set(defectIds)) })) {
    if (d.resolution === "replacement" || d.resolution === "write_off") continue;
    const full = defectMoney(d.amount, d.refunds).fullyRefunded;
    if (d.status === "open" && full) {
      await query(`UPDATE po_line_defects SET status = 'resolved', resolution = 'refund', resolved_at = now() WHERE id = $1`, [d.id]);
      await logEdits(query, d.po_id, userId, "line", d.po_line_item_id, [{ field: "supplier defect resolved", old: "open", new: `refund: ${money(d.received)} received` }]);
      resolved++;
    } else if (d.status === "resolved" && d.resolution === "refund" && !full) {
      await query(`UPDATE po_line_defects SET status = 'open', resolution = NULL, resolved_at = NULL WHERE id = $1`, [d.id]);
      await logEdits(query, d.po_id, userId, "line", d.po_line_item_id, [{ field: "supplier defect reopened", old: "refund", new: `open: ${money(d.owed)} still owed` }]);
      reopened++;
    }
  }
  return { resolved, reopened };
}

/** The defects linked to these refund rows (call before a refund row is deleted — the link cascades away). */
export async function defectsLinkedTo(query: QueryLike, refundIds: readonly number[]): Promise<number[]> {
  if (refundIds.length === 0) return [];
  return (await query(`SELECT DISTINCT defect_id FROM po_line_defect_refunds WHERE po_line_refund_id = ANY($1::bigint[])`, [refundIds])).rows.map((r: any) => Number(r.defect_id));
}

/** The chip / hover form of open defects: what the list rows carry. */
export interface OpenDefectBrief { id: number; po_line_item_id: string; asin: string | null; line_no: number; kind: string; qty: number; amount: number | null; owed: number | null; note: string | null }
export const briefOf = (d: DefectRow): OpenDefectBrief => ({ id: d.id, po_line_item_id: d.po_line_item_id, asin: d.asin, line_no: d.line_no, kind: d.kind, qty: d.qty, amount: d.amount, owed: d.owed, note: d.note });
