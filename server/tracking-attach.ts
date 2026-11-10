// One tracking number on more than one PO (Maria 2026-11-04 — SupplyHouse
// shipped 28686630 and 28686630_1 in one box; migration 086). The queued row
// stays the PRIMARY (first PO); every further PO gets its own row with
// split_of = the primary, so each PO routes and pushes the number to its own
// Velocity orders (tracking-push.ts reads every matched row by po_id).
// When the email states the shipped quantity ("7 of 20 units", or the
// parsed items), it is split across the POs in the order given — each PO
// filled up to its ordered units not already placed on its other tracking
// rows, the remainder to the next; otherwise no row carries a qty.
// Attached by hand: source manual, so the sync never moves them.
import type { QueryLike } from "./scheduler/types";

/** Pure: the shipped units an email states — Σ the parsed items' qty, else Σ "N of M units"; null when it states none. */
export function shippedQtyFromEmail(text: string, items: ReadonlyArray<{ qty: number }> | null): number | null {
  if (items && items.length && items.every((i) => Number.isFinite(Number(i.qty)) && Number(i.qty) > 0)) return items.reduce((t, i) => t + Number(i.qty), 0);
  const hits = Array.from((text ?? "").matchAll(/\b(\d{1,5})\s+of\s+\d{1,5}\s+units?\b/gi), (m) => Number(m[1]));
  return hits.length ? hits.reduce((t, n) => t + n, 0) : null;
}

/** Pure: fill the POs in order up to their capacity; the last takes any remainder. Null qty → null for every PO. */
export function splitShippedQty(qty: number | null, caps: ReadonlyArray<{ po_id: string; capacity: number }>): Map<string, number | null> {
  const out = new Map<string, number | null>();
  if (qty == null) { for (const c of caps) out.set(c.po_id, null); return out; }
  let left = qty;
  caps.forEach((c, i) => {
    const take = i === caps.length - 1 ? left : Math.max(0, Math.min(left, c.capacity));
    out.set(c.po_id, take);
    left -= take;
  });
  return out;
}

export interface AttachResult { row_id: number; tracking: string; pos: Array<{ po_id: string; order_id: string; qty: number | null; split: boolean }>; shipped_qty: number | null }

/**
 * Attach a queued row to one or more POs (live, or the plan only). `emailText`:
 * the email behind the row, for the shipped quantity (optional).
 */
export async function attachTrackingToPos(query: QueryLike, rowId: number, poIds: readonly string[], opts: { dryRun?: boolean; emailText?: string } = {}): Promise<AttachResult> {
  if (poIds.length === 0 || new Set(poIds).size !== poIds.length) throw new Error("one or more distinct POs required");
  const row = (await query(`SELECT * FROM po_tracking WHERE id = $1 AND split_of IS NULL`, [rowId])).rows[0];
  if (!row) throw new Error(`row ${rowId} not found (or a split row)`);
  if (String(row.tracking_number).startsWith("email:")) throw new Error(`row ${rowId} is a placeholder — no number to attach`);
  const pos: any[] = [];
  for (const id of poIds) {
    const p = (await query(
      `SELECT p.id, p.supplier, p.order_id,
              COALESCE((SELECT SUM(le.ordered_product) FROM po_line_expected le WHERE le.po_id = p.id), 0)::float
                - COALESCE((SELECT SUM(t.qty) FROM po_tracking t WHERE t.po_id = p.id AND t.qty IS NOT NULL AND t.id <> $2 AND COALESCE(t.split_of, 0) <> $2), 0)::float AS capacity
         FROM purchase_orders p WHERE p.id = $1`, [id, rowId],
    )).rows[0];
    if (!p) throw new Error(`PO ${id} not found`);
    pos.push(p);
  }
  const shipped = poIds.length > 1 || opts.emailText ? shippedQtyFromEmail(opts.emailText ?? "", row.items_json ?? null) : null;
  const split = splitShippedQty(poIds.length > 1 ? shipped : null, pos.map((p) => ({ po_id: String(p.id), capacity: Number(p.capacity) })));
  const result: AttachResult = { row_id: rowId, tracking: `${row.carrier} ${row.tracking_number}`, shipped_qty: shipped, pos: pos.map((p, i) => ({ po_id: String(p.id), order_id: String(p.order_id), qty: split.get(String(p.id)) ?? null, split: i > 0 })) };
  if (opts.dryRun) return result;
  const [first, ...rest] = pos;
  await query(
    `UPDATE po_tracking SET po_id = $2, supplier_guess = $3, status = 'matched', match_reason = NULL, source = 'manual', qty = $4, updated_at = NOW() WHERE id = $1`,
    [rowId, first.id, first.supplier, split.get(String(first.id)) ?? null],
  );
  for (const p of rest) {
    await query(
      `INSERT INTO po_tracking (po_id, carrier, tracking_number, retailer_order_id, supplier_guess, sender_domain, ship_to_street, shipped_at, items_json,
                                gmail_message_id, gmail_thread_id, email_subject, source, status, split_of, qty)
       SELECT $2, carrier, tracking_number, retailer_order_id, $3, sender_domain, ship_to_street, shipped_at, items_json,
              gmail_message_id, gmail_thread_id, email_subject, 'manual', 'matched', id, $4
         FROM po_tracking WHERE id = $1
       ON CONFLICT (split_of, po_id) WHERE split_of IS NOT NULL DO UPDATE SET qty = EXCLUDED.qty, updated_at = NOW()`,
      [rowId, p.id, p.supplier, split.get(String(p.id)) ?? null],
    );
  }
  return result;
}
