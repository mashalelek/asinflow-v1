// Replacements (claims commit 8 — docs/claude_spec-patch-supplier-claims.md §3.13 rows 1–9; §3.5 "Replacement", §3.6, D10;
// migration 114; Maria 2026-11-14). A replacement stays on its original PO; Velocity's order is NEVER altered for it (no new
// order, no order # or qty change): Maria tells Velocity on Discord, and the reship's tracking — same order # or the reship's
// own — is pushed to the ORIGINAL Velocity order like any row of the PO.
//
//   sweepReplacements    rows 3 / 4 / 5 / 6, with the timer sweep (component 30, GET /api/claims):
//                        3  an inbound tracking row that arrived on the PO after the replacement was promised is tied to
//                           the claim (po_tracking.claim_id) and ticks Shipped (source email; the carrier's first scan
//                           corrects it — applyReplacementTracker);
//                        4  an UNMATCHED shipping email from the claim's supplier, shipped after the promise, naming the
//                           claim's items (or the supplier's one open replacement) → confirm_reship_order with the row:
//                           "Shipping email M/D for order <new #> · <items> · looks like the reship" (It's the reship / It's not);
//                        5  Velocity's received count on the claim's line covers what was ordered → Arrived → Closed;
//                        6  (home PO) the replacement's row delivered → replacement_delivered_at + confirm_arrival (Arrived / Short).
//   applyReplacementTracker  every EasyPost write: the claim's inbound rows — first movement scan → Shipped (source tracking),
//                        delivery → replacement_delivered_at (home: confirm_arrival).
//   confirmReship        "It's the reship": the number joins the PO as a labeled replacement order (po-other-numbers.ts), the
//                        tracking row is attached to the PO and the claim, Shipped from its email date, the entry "Reship
//                        confirmed · Order R… kept on the PO as replacement order · tracking … tied to this claim"; the route
//                        then pushes the PO's tracking to the ORIGINAL Velocity order.
//   dismissReship        "It's not": never proposed for this claim again (event reship_dismissed with the row).
//   replacementShort     Short: N of M arrived — the claim stays open for the rest with a Contact supplier task.
import type { QueryLike } from "./scheduler/types";
import { EditError, logEdits } from "./po-edit";
import { addTask, setOutcome, logClaimEvent } from "./supplier-claims";
import { addOtherNumber } from "./po-other-numbers";
import { resolveSupplier, loadDomainMap, loadPlatformSenders } from "./tracking-match";
import { mdOf, replacementPromisedAt, type BucketClaim } from "@shared/claim-bucket";
import type { EasypostTracker } from "./easypost";
import { returnScanState } from "./claim-returns";

const noon = (ymd: string) => `${ymd}T12:00:00Z`;
const isYmd = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const iso = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));

interface OpenReplacement { id: number; po_id: string; po_line_item_id: string | null; qty: number | null; replacement_qty: number | null; replacement_shipped_at: string | null; replacement_shipped_source: string | null; replacement_delivered_at: string | null; replacement_arrived_at: string | null; replacement_order_id: string | null;
  supplier: string; order_id: string; ships_to: string | null; product_name: string | null; asin: string | null; promised: string | null; received: number | null; ordered: number | null; tasks: Array<{ kind: string; done_at: string | null }> }
async function openReplacements(query: QueryLike): Promise<OpenReplacement[]> {
  const rows = (await query(`SELECT c.id, c.po_id, c.po_line_item_id, c.qty, c.replacement_qty, c.replacement_shipped_at::text AS replacement_shipped_at, c.replacement_shipped_source, c.replacement_delivered_at::text AS replacement_delivered_at,
            c.replacement_arrived_at::text AS replacement_arrived_at, c.replacement_order_id, c.supplier_confirmed_at::text AS supplier_confirmed_at, c.last_supplier_reply_at::text AS last_supplier_reply_at, c.reported_at::text AS reported_at, c.found_at::text AS found_at,
            p.supplier, p.order_id, p.ships_to, l.product_name, pa.asin, le.received_individual AS received, le.ordered_individual AS ordered,
            COALESCE((SELECT json_agg(json_build_object('kind', t.kind, 'done_at', t.done_at) ORDER BY t.id) FROM supplier_claim_tasks t WHERE t.claim_id = c.id), '[]') AS tasks
       FROM supplier_claims c JOIN purchase_orders p ON p.id = c.po_id LEFT JOIN po_line_items l ON l.id = c.po_line_item_id LEFT JOIN po_asins pa ON pa.id = l.po_asin_id LEFT JOIN po_line_expected le ON le.line_id = l.id
      WHERE c.status = 'open' AND c.outcome = 'replacement' ORDER BY c.id`)).rows as any[];
  return rows.map((r) => {
    const tasks = (r.tasks ?? []).map((t: any) => ({ kind: String(t.kind), done_at: iso(t.done_at) }));
    const c = { ...r, status: "open", kind: "", outcome: "replacement", closed_at: null, qty_disposed: null, remaining: null, tasks } as unknown as BucketClaim;
    return { ...r, id: Number(r.id), po_id: String(r.po_id), qty: r.qty == null ? null : Number(r.qty), replacement_qty: r.replacement_qty == null ? null : Number(r.replacement_qty), received: r.received == null ? null : Number(r.received), ordered: r.ordered == null ? null : Number(r.ordered), promised: replacementPromisedAt(c), tasks };
  });
}
const WORD = /[a-z0-9]{4,}/g;
const words = (s: string | null | undefined) => new Set(String(s ?? "").toLowerCase().match(WORD) ?? []);
/** Pure: do the shipping email's items name the claim's product? (one word of 4+ letters in common, the ASIN, or no items listed at all = unknown) */
export function itemsMatchProduct(items: ReadonlyArray<{ name?: string | null }> | null | undefined, product: string | null, asin: string | null): "yes" | "no" | "unknown" {
  if (!items || !items.length) return "unknown";
  const want = words(product);
  for (const it of items) {
    const have = words(it?.name);
    if (asin && String(it?.name ?? "").toUpperCase().includes(asin)) return "yes";
    for (const w of Array.from(have)) if (want.has(w)) return "yes";
  }
  return "no";
}
export const itemsText = (items: ReadonlyArray<{ name?: string | null; qty?: number | null }> | null | undefined): string =>
  (items ?? []).slice(0, 3).map((i) => `${i.qty != null ? `${i.qty} × ` : ""}${String(i.name ?? "").slice(0, 40)}`).join(", ");

export interface ReplacementSweep { tied: number; suggested: number; arrived: number; delivered: number; rows: Array<{ claim_id: number; what: string }> }
export async function sweepReplacements(query: QueryLike, now = new Date(), userId: number | null = null): Promise<ReplacementSweep> {
  const r: ReplacementSweep = { tied: 0, suggested: 0, arrived: 0, delivered: 0, rows: [] };
  const claims = await openReplacements(query);
  if (!claims.length) return r;
  const domainMap = await loadDomainMap(query), platforms = await loadPlatformSenders(query);
  const suppliers = Array.from(new Set(claims.map((c) => c.supplier)));
  const unmatched = (await query(`SELECT id, carrier, tracking_number, retailer_order_id, sender_domain, supplier_guess, shipped_at::text AS shipped_at, items_json, gmail_message_id, email_subject
      FROM po_tracking WHERE status = 'unmatched' AND po_id IS NULL AND direction = 'inbound' AND tracking_number NOT LIKE 'email:%' AND COALESCE(match_reason, '') NOT IN ('dismissed', 'return')`)).rows as any[];
  for (const c of claims) {
    const promised = c.promised ? Date.parse(c.promised.length === 10 ? noon(c.promised) : c.promised) - 86_400_000 : 0;
    // row 3: the PO's own inbound rows that came after the promise are the replacement's
    const own = (await query(`SELECT id, carrier, tracking_number, shipped_at::text AS shipped_at, pushed_velocity_ids, delivered_at::text AS delivered_at FROM po_tracking
        WHERE po_id = $1 AND direction = 'inbound' AND claim_id IS NULL AND tracking_number NOT LIKE 'email:%' AND status IN ('matched', 'pushed', 'push_failed', 'held') AND shipped_at >= $2::timestamptz ORDER BY shipped_at, id`, [c.po_id, new Date(promised).toISOString()])).rows as any[];
    for (const t of own) {
      await query(`UPDATE po_tracking SET claim_id = $2, updated_at = NOW() WHERE id = $1`, [t.id, c.id]);
      r.tied++;
      const pushed = Array.isArray(t.pushed_velocity_ids) && t.pushed_velocity_ids.length ? ` · pushed to Velocity order #${t.pushed_velocity_ids.join(", #")}` : "";
      if (!c.replacement_shipped_at) {
        await query(`UPDATE supplier_claims SET replacement_shipped_at = $2::timestamptz, replacement_shipped_source = 'email', updated_at = now() WHERE id = $1`, [c.id, t.shipped_at]);
        await query(`UPDATE supplier_claim_tasks SET done_at = $2::timestamptz, done_by = NULL WHERE claim_id = $1 AND kind = 'tell_velocity_replacement' AND done_at IS NULL`, [c.id, t.shipped_at]);
        await query(`INSERT INTO supplier_claim_events (claim_id, at, type, summary, by, po_tracking_id) VALUES ($1, $2::timestamptz, 'replacement_shipped', $3, $4, $5)`, [c.id, t.shipped_at, `${t.carrier} ${t.tracking_number} · arrived on the PO's order # after the claim was opened, so AF tied it to this claim${pushed}`, userId, t.id]);
        c.replacement_shipped_at = t.shipped_at;
      } else await query(`INSERT INTO supplier_claim_events (claim_id, type, summary, by, po_tracking_id) VALUES ($1, 'task_done', $2, $3, $4)`, [c.id, `tracking ${t.carrier} ${t.tracking_number} tied to this claim (arrived on the PO after the replacement was promised)${pushed}`, userId, t.id]);
      await logEdits(query, c.po_id, userId, "claim", String(c.id), [{ field: "claim tracking tied", old: null, new: `${t.carrier} ${t.tracking_number}` }]);
      r.rows.push({ claim_id: c.id, what: `tied ${t.carrier} ${t.tracking_number}` });
    }
    // row 4: an unmatched shipping email from the supplier, after the promise, naming the items — a reship under a new order #
    if (!c.replacement_shipped_at && !c.tasks.some((t) => t.kind === "confirm_reship_order" && !t.done_at)) {
      const dismissed = new Set((await query(`SELECT po_tracking_id FROM supplier_claim_events WHERE claim_id = $1 AND type = 'reship_dismissed' AND po_tracking_id IS NOT NULL`, [c.id])).rows.map((x: any) => Number(x.po_tracking_id)));
      const supplierOpen = claims.filter((x) => x.supplier === c.supplier).length;
      for (const u of unmatched) {
        if (dismissed.has(Number(u.id))) continue;
        if (!u.shipped_at || Date.parse(u.shipped_at) < promised) continue;
        const sup = resolveSupplier(u.sender_domain, domainMap, suppliers, platforms).supplier ?? (u.supplier_guess && suppliers.includes(String(u.supplier_guess)) ? String(u.supplier_guess) : null);
        if (sup !== c.supplier) continue;
        const items = Array.isArray(u.items_json) ? u.items_json : null;
        const fit = itemsMatchProduct(items, c.product_name, c.asin);
        if (fit === "no" || (fit === "unknown" && supplierOpen !== 1)) continue;
        const md = mdOf(u.shipped_at);
        const reason = `Shipping email ${md} for order ${u.retailer_order_id ?? "?"} · ${itemsText(items) || "items not listed"} · looks like the reship`;
        await addTask(query, c.id, "confirm_reship_order", reason);
        await query(`UPDATE supplier_claim_tasks SET gmail_message_id = $3, mailbox = $4, payload = $5::jsonb WHERE claim_id = $1 AND kind = $2 AND done_at IS NULL`,
          [c.id, "confirm_reship_order", u.gmail_message_id ?? null, "orders@coastalqualitygoods.com", JSON.stringify({ tracking_id: Number(u.id), order_id: u.retailer_order_id ?? null, carrier: u.carrier, tracking_number: u.tracking_number, items: items ?? [], subject: u.email_subject ?? null, date: String(u.shipped_at).slice(0, 10) })]);
        r.suggested++; r.rows.push({ claim_id: c.id, what: `confirm_reship_order: ${reason}` });
        break;
      }
    }
    // row 5: Velocity's received count on the line covers what was ordered → Arrived → Closed
    if (c.ships_to !== "home" && c.po_line_item_id && c.ordered != null && c.ordered > 0 && c.received != null && c.received >= c.ordered - 1e-9) {
      await setOutcome(query, c.id, { outcome: "replacement", arrived: true }, userId);
      await query(`UPDATE supplier_claim_events SET summary = $2 WHERE id = (SELECT id FROM supplier_claim_events WHERE claim_id = $1 AND type = 'replacement_arrived' ORDER BY id DESC LIMIT 1)`, [c.id, `Velocity received ${c.received} of ${c.ordered}`]);
      r.arrived++; r.rows.push({ claim_id: c.id, what: `arrived: Velocity received ${c.received} of ${c.ordered}` });
      continue;
    }
    // row 6 (home PO): a tied row delivered → the carrier's scan is the delivery; Arrived / Short is Maria's
    if (c.ships_to === "home" && !c.replacement_delivered_at && !c.replacement_arrived_at) {
      const d = (await query(`SELECT id, carrier, tracking_number, delivered_at::text AS delivered_at FROM po_tracking WHERE claim_id = $1 AND direction = 'inbound' AND delivered_at IS NOT NULL ORDER BY delivered_at LIMIT 1`, [c.id])).rows[0];
      if (d) { await markDelivered(query, c.id, d, userId); r.delivered++; r.rows.push({ claim_id: c.id, what: `delivered ${d.delivered_at}` }); }
    }
  }
  return r;
}
async function markDelivered(query: QueryLike, claimId: number, t: { id: number; carrier: string; tracking_number: string; delivered_at: string }, userId: number | null): Promise<void> {
  const c = (await query(`SELECT ships_to, replacement_delivered_at FROM supplier_claims sc JOIN purchase_orders p ON p.id = sc.po_id WHERE sc.id = $1`, [claimId])).rows[0];
  if (!c || c.replacement_delivered_at) return;
  await query(`UPDATE supplier_claims SET replacement_delivered_at = $2::timestamptz, updated_at = now() WHERE id = $1`, [claimId, t.delivered_at]);
  await query(`INSERT INTO supplier_claim_events (claim_id, at, type, summary, by, po_tracking_id) VALUES ($1, $2::timestamptz, 'replacement_delivered', $3, $4, $5)`, [claimId, t.delivered_at, `${t.carrier} ${t.tracking_number} delivered · from tracking`, userId, t.id]);
  if (c.ships_to === "home") await addTask(query, claimId, "confirm_arrival", `replacement delivered ${mdOf(t.delivered_at)} · did all arrive?`);
}
/** Every EasyPost write: the claim-tied inbound rows move the replacement — the first movement scan is Shipped (source tracking, never over a hand-set date), the delivery is Delivered. */
export async function applyReplacementTracker(query: QueryLike, t: EasypostTracker, userId: number | null = null): Promise<{ shipped: number; delivered: number }> {
  const out = { shipped: 0, delivered: 0 };
  const code = String(t.tracking_code ?? "").toUpperCase();
  const rows = (await query(`SELECT tr.id, tr.claim_id, tr.carrier, tr.tracking_number, tr.shipped_at::text AS shipped_at, tr.delivered_at::text AS delivered_at, c.replacement_shipped_at::text AS rs, c.replacement_shipped_source AS rss, c.replacement_delivered_at::text AS rd, c.status, c.outcome
      FROM po_tracking tr JOIN supplier_claims c ON c.id = tr.claim_id WHERE tr.direction = 'inbound' AND tr.claim_id IS NOT NULL AND (tr.easypost_tracker_id = $1 OR upper(tr.tracking_number) = $2)`, [String(t.id), code])).rows as any[];
  for (const row of rows) {
    if (row.status !== "open" || row.outcome !== "replacement") continue;
    const s = returnScanState(t, row.shipped_at ? new Date(Date.parse(row.shipped_at) - 86_400_000) : null);
    if (s.first_scan_at && row.rss !== "manual" && (row.rs == null || row.rss !== "tracking")) {
      await query(`UPDATE supplier_claims SET replacement_shipped_at = $2::timestamptz, replacement_shipped_source = 'tracking', updated_at = now() WHERE id = $1`, [row.claim_id, s.first_scan_at]);
      await query(`UPDATE supplier_claim_tasks SET done_at = $2::timestamptz, done_by = NULL WHERE claim_id = $1 AND kind = 'tell_velocity_replacement' AND done_at IS NULL`, [row.claim_id, s.first_scan_at]);
      const prev = (await query(`SELECT id FROM supplier_claim_events WHERE claim_id = $1 AND type = 'replacement_shipped' AND po_tracking_id = $2 ORDER BY id DESC LIMIT 1`, [row.claim_id, row.id])).rows[0];
      const summary = `${row.carrier} ${row.tracking_number}${s.first_scan_location ? ` picked up in ${s.first_scan_location}` : ""}${s.est_delivery_at ? ` · due ${mdOf(s.est_delivery_at)}` : ""} · from tracking`;
      if (prev) await query(`UPDATE supplier_claim_events SET at = $2::timestamptz, summary = $3 WHERE id = $1`, [prev.id, s.first_scan_at, summary]);
      else await query(`INSERT INTO supplier_claim_events (claim_id, at, type, summary, by, po_tracking_id) VALUES ($1, $2::timestamptz, 'replacement_shipped', $3, $4, $5)`, [row.claim_id, s.first_scan_at, summary, userId, row.id]);
      out.shipped++;
    }
    if (s.delivered_at && !row.rd) { await markDelivered(query, Number(row.claim_id), { id: Number(row.id), carrier: String(row.carrier), tracking_number: String(row.tracking_number), delivered_at: s.delivered_at }, userId); out.delivered++; }
  }
  return out;
}

/** "It's the reship" (row 4): the number joins the PO labeled, the tracking row is tied to the PO and the claim; the route pushes it to the ORIGINAL Velocity order. */
export async function confirmReship(query: QueryLike, claimId: number, payload: { tracking_id?: number | null; order_id?: string | null; carrier?: string | null; tracking_number?: string | null } | null, typedOrderId: string | null, userId: number | null): Promise<{ po_id: string; order_id: string | null; tracking: string | null }> {
  const c = (await query(`SELECT c.id, c.po_id, c.replacement_shipped_at, p.order_id FROM supplier_claims c JOIN purchase_orders p ON p.id = c.po_id WHERE c.id = $1`, [claimId])).rows[0];
  if (!c) throw new EditError(404, "claim not found");
  const poId = String(c.po_id);
  const number = String(typedOrderId ?? payload?.order_id ?? "").trim();
  if (!number && payload?.tracking_id == null) throw new EditError(400, "the reship order # is required");
  if (number && number !== String(c.order_id)) await addOtherNumber(query, poId, { number, kind: "replacement_order", claim_id: claimId }, userId);
  let tracking: string | null = null;
  if (payload?.tracking_id != null) {
    const t = (await query(`UPDATE po_tracking SET po_id = $2, claim_id = $3, status = 'matched', match_reason = 'replacement claim', review_reason = NULL, updated_at = NOW() WHERE id = $1 AND (po_id IS NULL OR po_id = $2::uuid) RETURNING id, carrier, tracking_number, shipped_at::text AS shipped_at`, [payload.tracking_id, poId, claimId])).rows[0];
    if (t) {
      tracking = `${t.carrier} ${t.tracking_number}`;
      if (!c.replacement_shipped_at) await query(`UPDATE supplier_claims SET replacement_shipped_at = $2::timestamptz, replacement_shipped_source = 'email', updated_at = now() WHERE id = $1`, [claimId, t.shipped_at]);
      await query(`UPDATE supplier_claim_tasks SET done_at = now(), done_by = $2 WHERE claim_id = $1 AND kind = 'tell_velocity_replacement' AND done_at IS NULL`, [claimId, userId]);
    }
  }
  if (number) await query(`UPDATE supplier_claims SET replacement_order_id = $2, updated_at = now() WHERE id = $1`, [claimId, number]);
  const trackingId = payload?.tracking_id ?? null;
  await query(`INSERT INTO supplier_claim_events (claim_id, type, summary, by, po_tracking_id) VALUES ($1, 'reship_confirmed', $2, $3, $4)`,
    [claimId, `Order ${number || c.order_id} kept on the PO as replacement order${tracking ? ` · tracking ${tracking} tied to this claim` : ""}`, userId, trackingId]);
  if (tracking) await query(`INSERT INTO supplier_claim_events (claim_id, type, summary, by, po_tracking_id) VALUES ($1, 'replacement_shipped', $2, $3, $4)`, [claimId, `${tracking}${number ? ` on order ${number}` : ""} · from the shipping email`, userId, trackingId]);
  await logEdits(query, poId, userId, "claim", String(claimId), [{ field: "claim reship confirmed", old: null, new: `${number || c.order_id}${tracking ? ` · ${tracking}` : ""}` }]);
  return { po_id: poId, order_id: number || null, tracking };
}
/** "It's not" (row 4): the row is never proposed for this claim again. */
export async function dismissReship(query: QueryLike, claimId: number, payload: { tracking_id?: number | null; order_id?: string | null } | null, userId: number | null): Promise<void> {
  const c = (await query(`SELECT po_id FROM supplier_claims WHERE id = $1`, [claimId])).rows[0];
  if (!c) throw new EditError(404, "claim not found");
  await query(`INSERT INTO supplier_claim_events (claim_id, type, summary, by, po_tracking_id) VALUES ($1, 'reship_dismissed', $2, $3, $4)`, [claimId, `not the reship: order ${payload?.order_id ?? "?"}`, userId, payload?.tracking_id ?? null]);
  await logEdits(query, String(c.po_id), userId, "claim", String(claimId), [{ field: "claim reship", old: `order ${payload?.order_id ?? "?"}`, new: "not the reship" }]);
}
/** Short (row 6): N of M arrived — the claim stays open for the rest, reported again to the supplier. */
export async function replacementShort(query: QueryLike, claimId: number, arrivedQtyIn: unknown, userId: number | null): Promise<{ id: number; po_id: string }> {
  const arrived = Number(arrivedQtyIn);
  const c = (await query(`SELECT po_id, qty, replacement_qty, replacement_delivered_at FROM supplier_claims WHERE id = $1 AND status = 'open'`, [claimId])).rows[0];
  if (!c) throw new EditError(404, "open claim not found");
  const expected = Number(c.replacement_qty ?? c.qty ?? 0);
  if (!Number.isFinite(arrived) || arrived < 0 || arrived >= expected) throw new EditError(400, `arrived must be a number below ${expected} (Individual units); for all of them tick Arrived`);
  const missing = Math.round((expected - arrived) * 100) / 100;
  await query(`UPDATE supplier_claims SET replacement_short_qty = $2, replacement_arrived_at = NULL, updated_at = now() WHERE id = $1`, [claimId, arrived]);
  await query(`UPDATE supplier_claim_tasks SET done_at = now(), done_by = $2 WHERE claim_id = $1 AND done_at IS NULL AND kind IN ('confirm_arrival', 'replacement_arrived')`, [claimId, userId]);
  await addTask(query, claimId, "contact_supplier", `replacement short: ${arrived} of ${expected} arrived · ${missing} still missing — report the rest`);
  await logClaimEvent(query, claimId, "task_done", `confirm_arrival: short — ${arrived} of ${expected} arrived, ${missing} still missing`, userId);
  await logEdits(query, String(c.po_id), userId, "claim", String(claimId), [{ field: "claim replacement short", old: String(expected), new: `${arrived} arrived · ${missing} missing` }]);
  return { id: claimId, po_id: String(c.po_id) };
}
