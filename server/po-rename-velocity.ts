// A PO's order # renamed after Upload to Velocity (Maria 2026-11-13; yarnspirations X7W12GQQ5 → SPIN-1744653):
// the Velocity order still carried the old number, the upload's dedup key is (order #, ASIN), so the next upload
// created a second order. Now a rename, once the PO transaction has committed, finds the Velocity orders under the
// OLD number for the PO's ASINs and:
//   - an `inbound` order gets its orderNumber PUT to the new number (the full-replace PUT, so the order's current
//     fields are echoed exactly as the Upload dialog's execute does) — "Velocity order #N renamed to <new>";
//   - an order past inbound (in inventory, shipped) — or one whose PUT failed — is linked to the PO ASIN row instead
//     (velocity_order_links, honoured by the dedup and the plan) — "linked to Velocity order #N (already shipped)";
//   - the old number is kept on the PO as an alternate order # (purchase_orders.alt_order_ids), so emails and
//     documents that quote it still match; a number with no digit (a placeholder) is not kept.
// Guard (Maria 2026-11-13): when the old number is SHARED — another AF PO has it, now or as an alternate, or more than
// one Velocity order of the same ASIN sits under it — nothing in Velocity is renamed or linked and nothing is kept
// as an alternate; the rename in AF stands and the warning says "Velocity not updated: old order # is shared by N
// orders, link by hand." Nothing here ever fails the rename: a Velocity read failure is reported in the warning.
import { fetchAllKnownOrders, updateInboundOrder, type KnownVelocityOrder } from "./velocity-api";
import { linkVelocityOrder } from "./velocity-order-links";
import { logEdits } from "./po-edit";
import { log as defaultLog } from "./log";
import type { QueryLike } from "./scheduler/types";

export interface RenameVelocityDeps {
  fetchKnown?: () => Promise<KnownVelocityOrder[]>;
  update?: (orderId: string, body: Record<string, any>) => Promise<any>;
  log?: (msg: string, tag?: string) => void;
}

export interface RenameVelocityResult {
  /** `shared` = the guard held; `none` = no Velocity order under the old number; `done` otherwise. */
  outcome: "shared" | "none" | "done" | "unavailable";
  renamed: Array<{ id: string; orderId: string; asin: string }>;
  linked: Array<{ id: string; orderId: string; asin: string; status: string }>;
  failed: Array<{ id: string; orderId: string; asin: string; error: string }>;
  /** The old number kept on the PO as an alternate order #. */
  altKept: boolean;
  warning: string;
}

const velocityLabel = (o: KnownVelocityOrder) => `#${o.id ?? o.order_id}`;
const norm = (s: unknown) => String(s ?? "").trim();

/** The Velocity-side body for a rename: the order's current documented-safe fields echoed (full-replace PUT), the new number on top. */
export function renamePutBody(current: KnownVelocityOrder, newOrderNumber: string): Record<string, any> {
  return {
    date: current.date,
    retailer: current.retailer ?? "",
    orderNumber: newOrderNumber,
    itemName: current.item_name ?? "",
    asin: current.asin,
    amazonSKU: current.amazon_sku ?? "",
    sold_as: current.sold_as ?? "",
    units_per_pack: current.units_per_pack ?? null,
    fulfilledBy: (current as any).fulfillment_type,
    trackingNumbers: current.trackings ?? [],
    quantity: current.quantity,
  };
}

/** Other AF POs that carry the number — as their order # or among their alternates. */
export async function posSharingOrderId(query: QueryLike, poId: string, orderId: string): Promise<Array<{ id: string; supplier: string; order_id: string }>> {
  return (await query(
    `SELECT id, supplier, order_id FROM purchase_orders
      WHERE id <> $1 AND (order_id = $2 OR $2 = ANY(regexp_split_to_array(COALESCE(alt_order_ids, ''), '[\\s,;/]+')))`,
    [poId, orderId],
  )).rows.map((r: any) => ({ id: String(r.id), supplier: String(r.supplier), order_id: String(r.order_id) }));
}

export async function syncVelocityAfterOrderIdRename(
  query: QueryLike,
  po: { poId: string; oldOrderId: string; newOrderId: string },
  userId: number | null,
  deps: RenameVelocityDeps = {},
): Promise<RenameVelocityResult> {
  const log = deps.log ?? defaultLog;
  const fetchKnown = deps.fetchKnown ?? fetchAllKnownOrders;
  const update = deps.update ?? updateInboundOrder;
  const oldId = norm(po.oldOrderId), newId = norm(po.newOrderId);
  const result: RenameVelocityResult = { outcome: "none", renamed: [], linked: [], failed: [], altKept: false, warning: "" };

  const rows = (await query(`SELECT id, asin FROM po_asins WHERE po_id = $1`, [po.poId])).rows as Array<{ id: string; asin: string }>;
  const rowByAsin = new Map(rows.map((r) => [String(r.asin).toUpperCase(), String(r.id)]));

  let known: KnownVelocityOrder[];
  try {
    known = await fetchKnown();
  } catch (err: any) {
    result.outcome = "unavailable";
    result.warning = `Velocity not updated: could not read Velocity (${err?.message ?? err}); link by hand or run Sync Shipments later`;
    log(`PO ${po.poId} order # ${oldId} → ${newId}: ${result.warning}`, "po");
    return result;
  }
  // Every Velocity order under the old number (flat orders; a bundle parent has no order number of its own).
  const underOld = known.filter((o) => norm(o.order_number) === oldId && oldId !== "");
  const perAsin = new Map<string, KnownVelocityOrder[]>();
  for (const o of underOld) { const a = String(o.asin ?? "").toUpperCase(); if (!perAsin.has(a)) perAsin.set(a, []); perAsin.get(a)!.push(o); }

  // The guard: a shared old number is nobody's to rename.
  const otherPos = await posSharingOrderId(query, po.poId, oldId);
  const ambiguous = Array.from(perAsin.values()).some((list) => list.length > 1);
  if (otherPos.length > 0 || ambiguous) {
    const n = otherPos.length + underOld.length;
    result.outcome = "shared";
    result.warning = `Velocity not updated: old order # is shared by ${n} order${n === 1 ? "" : "s"}, link by hand`;
    log(`PO ${po.poId} order # ${oldId} → ${newId}: shared (${otherPos.length} other AF PO(s), ${underOld.length} Velocity order(s)) — nothing renamed or linked`, "po");
    return result;
  }

  const mine = underOld.filter((o) => rowByAsin.has(String(o.asin ?? "").toUpperCase()));
  if (mine.length === 0) {
    result.outcome = "none";
    result.warning = `Velocity: no order under ${oldId} — shipments re-match on the next Sync Shipments`;
    return result;
  }
  result.outcome = "done";
  const parts: string[] = [];
  for (const o of mine) {
    const asin = String(o.asin ?? "").toUpperCase();
    const poAsinId = rowByAsin.get(asin)!;
    const status = String(o.status ?? "").toLowerCase();
    const inbound = status === "inbound" && (o.lifecycleSource == null || o.lifecycleSource === "inbound");
    if (inbound) {
      try {
        await update(String(o.order_id), renamePutBody(o, newId));
        await logEdits(query, po.poId, userId, "shipment", poAsinId, [{ field: "velocity_order_number", old: `${velocityLabel(o)} ${oldId}`, new: `${velocityLabel(o)} ${newId}` }]);
        result.renamed.push({ id: velocityLabel(o), orderId: String(o.order_id), asin });
        parts.push(`Velocity order ${velocityLabel(o)} renamed to ${newId}`);
        continue;
      } catch (err: any) {
        result.failed.push({ id: velocityLabel(o), orderId: String(o.order_id), asin, error: err?.message ?? String(err) });
        log(`PO ${po.poId} order # ${oldId} → ${newId}: PUT on Velocity order ${velocityLabel(o)} failed (${err?.message ?? err}) — linking instead`, "po");
      }
    }
    const r = await linkVelocityOrder(query, {
      velocityOrderId: String(o.order_id), poAsinId, source: "manual", line: o,
      note: `order # renamed ${oldId} → ${newId}; Velocity order ${inbound ? "not renamed (PUT failed)" : status}`,
    }, userId);
    if (r.status === 200) {
      result.linked.push({ id: velocityLabel(o), orderId: String(o.order_id), asin, status });
      parts.push(`linked to Velocity order ${velocityLabel(o)} (${inbound ? "rename failed" : status === "shipped" || status === "outbound" ? "already shipped" : `already ${status}`})`);
    } else {
      result.failed.push({ id: velocityLabel(o), orderId: String(o.order_id), asin, error: r.body.message });
      parts.push(`Velocity order ${velocityLabel(o)} not linked: ${r.body.message}`);
    }
  }
  // The old number stays matchable (emails, documents, Sync Shipments) as an alternate — unless it is a placeholder.
  if (/\d/.test(oldId)) {
    const cur = (await query(`SELECT alt_order_ids FROM purchase_orders WHERE id = $1`, [po.poId])).rows[0];
    const have = String(cur?.alt_order_ids ?? "").split(/[\s,;/]+/).filter(Boolean);
    if (!have.includes(oldId)) {
      const next = [...have, oldId].join(", ");
      await query(`UPDATE purchase_orders SET alt_order_ids = $2, updated_at = NOW() WHERE id = $1`, [po.poId, next]);
      await logEdits(query, po.poId, userId, "po", po.poId, [{ field: "alt_order_ids", old: have.join(", ") || null, new: next }]);
      result.altKept = true;
      parts.push(`${oldId} kept as an alternate order #`);
    }
  }
  result.warning = parts.join(" · ");
  log(`PO ${po.poId} order # ${oldId} → ${newId}: ${result.warning}`, "po");
  return result;
}
