// Velocity order → PO ASIN row (migration 099, SPEC §22 / §26; Maria
// 2026-11-07). One stored link per Velocity order id, asked first by every
// Velocity matcher: shipment placement and Received by Velocity / At Prep
// (server/shipment-sync-velocity.ts), the Upload to Velocity plan, dedup and
// execute guard (velocity-reconcile.ts, routes.ts) and tracking push
// (tracking-push.ts). Several orders may link to one row; their quantities
// add up. Written by the Unmatched panel (one-click / picker, the shipped-line
// picker included) and the backfill; link and unlink each write a PO History
// row naming the user and the order as typed at Velocity. AF-side only —
// nothing here writes to Velocity.
import type { QueryLike } from "./scheduler/types";
import { logEdits } from "./po-edit";

export interface OrderLink { velocity_order_id: string; po_asin_id: string; po_id: string; order_id: string; supplier: string; asin: string }

export async function loadOrderLinks(query: QueryLike): Promise<OrderLink[]> {
  return ((await query(
    `SELECT l.velocity_order_id, l.po_asin_id, pa.po_id, p.order_id, p.supplier, pa.asin
       FROM velocity_order_links l JOIN po_asins pa ON pa.id = l.po_asin_id JOIN purchase_orders p ON p.id = pa.po_id`,
  )).rows as any[]).map((r) => ({ velocity_order_id: String(r.velocity_order_id), po_asin_id: String(r.po_asin_id), po_id: String(r.po_id), order_id: String(r.order_id), supplier: String(r.supplier), asin: String(r.asin) }));
}

/**
 * The (PO order #, ASIN) pairs a live Velocity order covers through its link —
 * for the readers that key Velocity by order # (Upload plan / dedup / execute):
 * a linked order marks its PO ASIN row as present in Velocity. A link whose
 * order is gone from Velocity covers nothing.
 */
export function linkedPairs(links: readonly OrderLink[], live: ReadonlyArray<{ order_id?: unknown }>): Array<{ orderNumber: string; asin: string; velocityOrderId: string }> {
  const ids = new Set(live.map((o) => String(o.order_id ?? "")).filter(Boolean));
  return links.filter((l) => ids.has(l.velocity_order_id)).map((l) => ({ orderNumber: l.order_id, asin: l.asin.toUpperCase(), velocityOrderId: l.velocity_order_id }));
}

/** A Velocity order as History names it: "#8785 no_poid_at_checkout · havalon.com · B00D79EODK · 3u". */
export function velocityOrderLabel(line: { id?: unknown; order_number?: unknown; retailer?: unknown; asin?: unknown; quantity?: unknown }): string {
  const num = line.id != null && String(line.id) !== "" ? `#${line.id} ` : "";
  return `Velocity ${num}${String(line.order_number ?? "").trim() || "(no Order #)"} · ${String(line.retailer ?? "").trim() || "—"} · ${String(line.asin ?? "").trim().toUpperCase()}${line.quantity != null && line.quantity !== "" ? ` · ${Number(line.quantity)}u` : ""}`;
}

export interface LinkInput {
  velocityOrderId: string;
  poAsinId: string;
  /** The order as Velocity holds it (order_number, retailer, asin, quantity, id) — kept for display and History. */
  line: Record<string, any>;
  source: "manual" | "picker" | "backfill";
  note?: string | null;
}
export type LinkResult = { status: 200; body: { linked: boolean; previous: string | null } } | { status: 400 | 404 | 409; body: { message: string } };

/**
 * Link (or move) one Velocity order to a PO ASIN row. Same ASIN required
 * (a bundle parent excepted). Already on that row → nothing written. On
 * another row → moved, with an unlink row on the old PO and a link row on
 * the new one. The order leaves "Velocity orders with no PO" at once.
 */
export async function linkVelocityOrder(query: QueryLike, input: LinkInput, userId: number | null): Promise<LinkResult> {
  const oid = String(input.velocityOrderId ?? "").trim();
  if (!oid) return { status: 400, body: { message: "velocity_order_id is required" } };
  if (!/^[0-9a-f-]{36}$/i.test(input.poAsinId)) return { status: 400, body: { message: "po_asin_id is required" } };
  const pa = (await query(`SELECT pa.id, pa.po_id, pa.asin, p.order_id, p.supplier FROM po_asins pa JOIN purchase_orders p ON p.id = pa.po_id WHERE pa.id = $1`, [input.poAsinId])).rows[0];
  if (!pa) return { status: 404, body: { message: "ASIN row not found" } };
  const lineAsin = String(input.line?.asin ?? "").trim().toUpperCase();
  const bundle = String(input.line?.sold_as ?? "").toLowerCase() === "bundle";
  if (lineAsin && !bundle && lineAsin !== String(pa.asin).toUpperCase()) return { status: 400, body: { message: `the Velocity order is ${lineAsin}; the row is ${pa.asin}` } };
  const prev = (await query(
    `SELECT l.po_asin_id, pa.po_id, p.order_id, p.supplier FROM velocity_order_links l JOIN po_asins pa ON pa.id = l.po_asin_id JOIN purchase_orders p ON p.id = pa.po_id WHERE l.velocity_order_id = $1`, [oid],
  )).rows[0];
  if (prev && String(prev.po_asin_id) === String(pa.id)) { await query(`DELETE FROM velocity_orders_unplaced WHERE velocity_order_id = $1`, [oid]); return { status: 200, body: { linked: false, previous: null } }; }
  const label = velocityOrderLabel(input.line ?? {});
  const qty = input.line?.quantity != null && input.line.quantity !== "" && Number.isFinite(Number(input.line.quantity)) ? Number(input.line.quantity) : null;
  const note = String(input.note ?? "").trim() || null;
  await query(
    `INSERT INTO velocity_order_links (velocity_order_id, po_asin_id, order_number, retailer, asin, quantity, linked_by, source, note, velocity_number)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (velocity_order_id) DO UPDATE SET po_asin_id = EXCLUDED.po_asin_id, velocity_number = EXCLUDED.velocity_number, order_number = EXCLUDED.order_number, retailer = EXCLUDED.retailer, asin = EXCLUDED.asin,
       quantity = EXCLUDED.quantity, linked_by = EXCLUDED.linked_by, linked_at = now(), source = EXCLUDED.source, note = EXCLUDED.note`,
    [oid, pa.id, String(input.line?.order_number ?? "").trim() || null, String(input.line?.retailer ?? "").trim() || null, lineAsin || null, qty, userId, input.source, note, input.line?.id != null && String(input.line.id) !== "" ? String(input.line.id) : null],
  );
  await query(`DELETE FROM velocity_orders_unplaced WHERE velocity_order_id = $1`, [oid]);
  if (prev) await logEdits(query, String(prev.po_id), userId, "shipment", String(prev.po_asin_id), [{ field: "velocity_order_link", old: label, new: `moved to ${pa.supplier} ${pa.order_id}` }]);
  await logEdits(query, String(pa.po_id), userId, "shipment", String(pa.id), [{ field: "velocity_order_link", old: prev ? `${prev.supplier} ${prev.order_id}` : null, new: `${label}${note ? ` — ${note}` : ""}` }]);
  return { status: 200, body: { linked: true, previous: prev ? String(prev.order_id) : null } };
}

/** Unlink: the row goes, a History row stays; the next Sync Shipments places the order by the rules again (or lists it). */
export async function unlinkVelocityOrder(query: QueryLike, velocityOrderId: string, userId: number | null): Promise<{ status: 200; body: { unlinked: true } } | { status: 404; body: { message: string } }> {
  const l = (await query(
    `DELETE FROM velocity_order_links l USING po_asins pa WHERE pa.id = l.po_asin_id AND l.velocity_order_id = $1
     RETURNING l.po_asin_id, pa.po_id, l.velocity_number AS id, l.order_number, l.retailer, l.asin, l.quantity`, [String(velocityOrderId ?? "")],
  )).rows[0];
  if (!l) return { status: 404, body: { message: "no link for that Velocity order" } };
  await logEdits(query, String(l.po_id), userId, "shipment", String(l.po_asin_id), [{ field: "velocity_order_link", old: velocityOrderLabel(l), new: null }]);
  return { status: 200, body: { unlinked: true } };
}

/** The stored links as the UI lists them (2026-11-07): newest first; one PO's links with `poId` (its Tracking tab), else all (the POs toolbar). */
export async function listOrderLinks(query: QueryLike, poId?: string | null): Promise<any[]> {
  return (await query(
    `SELECT l.velocity_order_id, l.velocity_number, l.order_number, l.retailer, l.asin, l.quantity, l.source, l.note, l.linked_at,
            u.display_name AS linked_by, p.id AS po_id, p.order_id AS po_order_id, p.supplier
       FROM velocity_order_links l JOIN po_asins pa ON pa.id = l.po_asin_id JOIN purchase_orders p ON p.id = pa.po_id
       LEFT JOIN users u ON u.id = l.linked_by
      WHERE ($1::uuid IS NULL OR p.id = $1::uuid) ORDER BY l.linked_at DESC, l.velocity_order_id`,
    [poId || null],
  )).rows;
}

