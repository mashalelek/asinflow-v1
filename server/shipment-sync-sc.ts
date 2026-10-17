// Component B — Seller Central (Fulfillment Inbound v0) → FBA shipment ids
// and Received-by-Amazon on po_asin_shipments (patch
// docs/claude_spec-patch-shipment-reconciliation.md §4; evidence
// docs/phase2-probe-2026-10-17.md B6–B8).
//
// SC is the only place the Amazon FBA shipment ids live (Velocity's public
// API has none). One Velocity shipment fans out to N SC shipments, one per
// FC, which Velocity names "FBA STA (MM/DD/YYYY HH:MM)-<FC>" with the STA
// workflow's timestamp. PROBE FACT (overrides the patch's "same minute, ET"
// wording): that timestamp is UTC and precedes Velocity's shipped_at by a
// couple of minutes (18:01 vs 18:03:37 GMT; 19:16 vs 19:21:27 GMT), so the
// primary match is the SC name-timestamp group closest to shipped_at within
// MATCH_WINDOW_MS; the fallback is same UTC day + best SKU-set overlap; an
// exact tie → ambiguous (D4); none → unmatched.
//
// SC quantities are sellable packs — AF's unit — so QuantityReceived per
// SellerSKU sums straight into qty_received, allocated oldest PO first
// across the rows sharing an ASIN in one Velocity shipment (§4.3, D2),
// capped at each row's qty_shipped. SC QuantityShipped is never compared
// (§4.4). Fail-closed: an SP-API read error propagates before BEGIN.
import pool from "./db";
import type { QueryLike } from "./scheduler/types";
import { spApiGet } from "./spapi-auth";
import { round2 } from "./shipment-sync-velocity";

const MP = "ATVPDKIKX0DER";
export const MATCH_WINDOW_MS = 15 * 60 * 1000;
const TERMINAL = new Set(["CLOSED", "CANCELLED", "DELETED"]);
const EXCLUDED_FROM_MATCH = new Set(["CANCELLED", "DELETED"]);
const ALL_STATUSES = "WORKING,READY_TO_SHIP,SHIPPED,RECEIVING,CLOSED,CANCELLED,DELETED,ERROR,IN_TRANSIT,DELIVERED,CHECKED_IN";

export interface ScShipmentRow { ShipmentId: string; ShipmentName?: string; ShipFromAddress?: { Name?: string; [k: string]: any }; DestinationFulfillmentCenterId?: string; ShipmentStatus: string; [k: string]: any }
export interface ScItemRow { SellerSKU: string; FulfillmentNetworkSKU?: string; QuantityShipped: number; QuantityReceived?: number; [k: string]: any }

export interface ScSyncDeps {
  listShipments: (since: Date) => Promise<ScShipmentRow[]>;
  listItems: (shipmentId: string) => Promise<ScItemRow[]>;
  now?: () => Date;
}

export const liveScDeps: ScSyncDeps = {
  async listShipments(since) {
    const out: ScShipmentRow[] = []; let next: string | undefined; let pages = 0;
    do {
      const d: any = next
        ? await spApiGet("/fba/inbound/v0/shipments", { QueryType: "NEXT_TOKEN", NextToken: next, MarketplaceId: MP })
        : await spApiGet("/fba/inbound/v0/shipments", { QueryType: "DATE_RANGE", MarketplaceId: MP, LastUpdatedAfter: since.toISOString(), LastUpdatedBefore: new Date().toISOString(), ShipmentStatusList: ALL_STATUSES });
      out.push(...(d.payload?.ShipmentData ?? [])); next = d.payload?.NextToken; pages++;
    } while (next && pages < 200);
    if (next) throw new Error("SC getShipments: pagination did not terminate within 200 pages — refusing partial coverage");
    return out;
  },
  async listItems(shipmentId) {
    const out: ScItemRow[] = []; let next: string | undefined; let pages = 0;
    do {
      const d: any = next
        ? await spApiGet("/fba/inbound/v0/shipmentItems", { QueryType: "NEXT_TOKEN", NextToken: next, MarketplaceId: MP })
        : await spApiGet(`/fba/inbound/v0/shipments/${encodeURIComponent(shipmentId)}/items`, { MarketplaceId: MP });
      out.push(...(d.payload?.ItemData ?? [])); next = d.payload?.NextToken; pages++;
    } while (next && pages < 50);
    return out;
  },
};

/** "FBA STA (10/15/2026 18:01)-IND9" → the UTC instant in the name, or null. */
export function parseStaName(name: string | null | undefined): Date | null {
  const m = /\((\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2})\)/.exec(String(name ?? ""));
  if (!m) return null;
  return new Date(Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2]), Number(m[4]), Number(m[5])));
}
export const isVelocityShipFrom = (name: string | null | undefined): boolean => /velocity/i.test(String(name ?? ""));
const utcDay = (d: Date) => d.toISOString().slice(0, 10);

export interface ScSyncCounts {
  velocityShipments: number;
  scShipmentsListed: number;      // every SC shipment the date-range query returned
  scShipmentsVelocity: number;    // ship-from Velocity (the ones that can match)
  scShipmentsItemsFetched: number;
  scItemRows: number;
  matched: number; matchedByMinute: number; matchedByOverlap: number;
  ambiguous: number; unmatched: number;
  rowsFbaIdsUpdated: number; rowsReceivedUpdated: number; rowsUnchanged: number;
  receivedOverflowRows: number;   // SC received more than the row's qty_shipped (capped)
  posTouched: number;
}
export interface ScSyncResult {
  dryRun: boolean; wrote: boolean; counts: ScSyncCounts; samples: string[];
  ambiguous: Array<{ shipment: string; shippedAt: string | null; groups: string[][] }>;
  unmatchedShipments: Array<{ shipment: string; shippedAt: string | null }>;
  touchedPoIds: string[];
}

type Q = { query: QueryLike; connect?: () => Promise<{ query: QueryLike; release: () => void }> };
const num = (v: any): number => (v == null || v === "" ? 0 : Number(v) || 0);
const arrEq = (a: any, b: string[]) => Array.isArray(a) && a.length === b.length && a.every((x, i) => x === b[i]);

/** Oldest PO first (D2), capped at each row's qty_shipped; returns the per-row allocation. */
export function allocateReceived(rows: Array<{ id: string; qty_shipped: number; order_date: string; order_id: string }>, received: number): Map<string, number> {
  const out = new Map<string, number>();
  let left = received;
  for (const r of [...rows].sort((a, b) => (a.order_date < b.order_date ? -1 : a.order_date > b.order_date ? 1 : a.order_id < b.order_id ? -1 : a.order_id > b.order_id ? 1 : 0))) {
    const take = Math.max(0, Math.min(r.qty_shipped, left));
    out.set(r.id, round2(take)); left -= take;
  }
  return out;
}

export async function syncScShipments(opts: { dryRun: boolean; deps?: ScSyncDeps; db?: Q; minDate?: Date }): Promise<ScSyncResult> {
  const deps = opts.deps ?? liveScDeps;
  const db: Q = opts.db ?? (pool as unknown as Q);
  const now = deps.now ? deps.now() : new Date();
  const counts: ScSyncCounts = {
    velocityShipments: 0, scShipmentsListed: 0, scShipmentsVelocity: 0, scShipmentsItemsFetched: 0, scItemRows: 0,
    matched: 0, matchedByMinute: 0, matchedByOverlap: 0, ambiguous: 0, unmatched: 0,
    rowsFbaIdsUpdated: 0, rowsReceivedUpdated: 0, rowsUnchanged: 0, receivedOverflowRows: 0, posTouched: 0,
  };
  const result: ScSyncResult = { dryRun: opts.dryRun, wrote: false, counts, samples: [], ambiguous: [], unmatchedShipments: [], touchedPoIds: [] };

  const vs = (await db.query(`SELECT id, shipped_at::text AS shipped_at, shipped_at_ts, status, raw, sc_shipment_ids, sc_match FROM velocity_shipments ORDER BY shipped_at_ts NULLS LAST, id`)).rows as any[];
  counts.velocityShipments = vs.length;
  if (vs.length === 0) return result;

  // ── SC reads (all before any write) ────────────────────────────────────────
  const earliest = vs.map((v) => (v.shipped_at_ts ? new Date(v.shipped_at_ts).getTime() : NaN)).filter((n) => Number.isFinite(n));
  const since = opts.minDate ?? new Date((earliest.length ? Math.min(...earliest) : now.getTime()) - 86_400_000);
  const scAll = await deps.listShipments(since);
  counts.scShipmentsListed = scAll.length;
  const sc = scAll.filter((s) => isVelocityShipFrom(s.ShipFromAddress?.Name));
  counts.scShipmentsVelocity = sc.length;
  const cached = new Map<string, any>((await db.query(`SELECT shipment_id, status FROM sc_inbound_shipments`)).rows.map((r: any) => [String(r.shipment_id), r]));
  const cachedItems = new Map<string, ScItemRow[]>();
  for (const r of (await db.query(`SELECT shipment_id, seller_sku, fnsku, qty_shipped, qty_received FROM sc_inbound_items`)).rows as any[]) {
    const k = String(r.shipment_id); if (!cachedItems.has(k)) cachedItems.set(k, []);
    cachedItems.get(k)!.push({ SellerSKU: r.seller_sku, FulfillmentNetworkSKU: r.fnsku, QuantityShipped: Number(r.qty_shipped), QuantityReceived: Number(r.qty_received) });
  }
  const items = new Map<string, ScItemRow[]>();
  const fetchedIds = new Set<string>();
  for (const s of sc) {
    const prev = cached.get(s.ShipmentId);
    const needs = !prev || !cachedItems.has(s.ShipmentId) || !TERMINAL.has(String(prev.status)) || prev.status !== s.ShipmentStatus;
    if (needs) {
      const raw = await deps.listItems(s.ShipmentId);
      // One row per SellerSKU (summed if SC ever repeats a SKU).
      const bySku = new Map<string, ScItemRow>();
      for (const it of raw) { const e = bySku.get(it.SellerSKU); if (e) { e.QuantityShipped += num(it.QuantityShipped); e.QuantityReceived = num(e.QuantityReceived) + num(it.QuantityReceived); } else bySku.set(it.SellerSKU, { ...it, QuantityShipped: num(it.QuantityShipped), QuantityReceived: num(it.QuantityReceived) }); }
      items.set(s.ShipmentId, Array.from(bySku.values())); fetchedIds.add(s.ShipmentId);
    } else items.set(s.ShipmentId, cachedItems.get(s.ShipmentId)!);
  }
  counts.scShipmentsItemsFetched = fetchedIds.size;
  counts.scItemRows = Array.from(items.values()).reduce((a, b) => a + b.length, 0);
  const skuToAsin = new Map<string, string>();
  for (const r of (await db.query(`SELECT s.sku, a.asin FROM asin_skus s JOIN asins a ON a.id = s.asin_id UNION SELECT primary_sku, asin FROM asins WHERE primary_sku IS NOT NULL`)).rows as any[]) skuToAsin.set(String(r.sku), String(r.asin));

  // ── Group SC shipments by STA name timestamp ───────────────────────────────
  interface Group { key: string; ts: Date; ids: string[]; skus: Set<string>; claimedBy: string | null }
  const groups = new Map<string, Group>();
  const nameTs = new Map<string, Date | null>();
  for (const s of sc) {
    const ts = parseStaName(s.ShipmentName); nameTs.set(s.ShipmentId, ts);
    if (!ts || EXCLUDED_FROM_MATCH.has(s.ShipmentStatus)) continue;
    const key = ts.toISOString();
    const g = groups.get(key) ?? { key, ts, ids: [], skus: new Set<string>(), claimedBy: null };
    g.ids.push(s.ShipmentId); for (const it of items.get(s.ShipmentId) ?? []) g.skus.add(it.SellerSKU);
    groups.set(key, g);
  }

  // ── Match each Velocity shipment ───────────────────────────────────────────
  type Match = { v: any; match: "matched" | "ambiguous" | "unmatched"; ids: string[]; how?: "minute" | "overlap"; delta?: number };
  const matches: Match[] = [];
  for (const v of vs) {
    const ts = v.shipped_at_ts ? new Date(v.shipped_at_ts) : null;
    const lines: any[] = Array.isArray(v.raw?.detail?.orders) ? v.raw.detail.orders : [];
    const vSkus = new Set<string>(lines.map((l) => String(l.amazon_sku ?? "")).filter(Boolean));
    let pick: Group | null = null; let how: Match["how"]; let delta: number | undefined; let tie: Group[] = [];
    if (ts) {
      const near = Array.from(groups.values()).filter((g) => !g.claimedBy && Math.abs(g.ts.getTime() - ts.getTime()) <= MATCH_WINDOW_MS)
        .sort((a, b) => Math.abs(a.ts.getTime() - ts.getTime()) - Math.abs(b.ts.getTime() - ts.getTime()));
      if (near.length > 0 && (near.length === 1 || Math.abs(near[0].ts.getTime() - ts.getTime()) !== Math.abs(near[1].ts.getTime() - ts.getTime()))) { pick = near[0]; how = "minute"; delta = Math.round(Math.abs(pick.ts.getTime() - ts.getTime()) / 60000); }
      if (!pick) {
        const day = utcDay(ts);
        const scored = Array.from(groups.values()).filter((g) => !g.claimedBy && utcDay(g.ts) === day)
          .map((g) => ({ g, score: Array.from(vSkus).filter((k) => g.skus.has(k)).length })).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
        if (scored.length === 1 || (scored.length > 1 && scored[0].score > scored[1].score)) { pick = scored[0].g; how = "overlap"; }
        else if (scored.length > 1) tie = scored.filter((x) => x.score === scored[0].score).map((x) => x.g);
      }
    }
    if (pick) {
      pick.claimedBy = v.id; const ids = [...pick.ids].sort(); matches.push({ v, match: "matched", ids, how, delta }); counts.matched++; if (how === "minute") counts.matchedByMinute++; else counts.matchedByOverlap++;
      if (result.samples.length < 10) result.samples.push(`${String(v.id).slice(0, 8)} ${v.shipped_at ?? "?"} → ${ids.length} SC shipment(s) ${ids.join(", ")} by ${how}${delta != null ? ` (Δ ${delta} min)` : ""}`);
    }
    else if (tie.length > 1) { matches.push({ v, match: "ambiguous", ids: [] }); counts.ambiguous++; result.ambiguous.push({ shipment: v.id, shippedAt: v.shipped_at, groups: tie.map((g) => g.ids) }); }
    else { matches.push({ v, match: "unmatched", ids: [] }); counts.unmatched++; result.unmatchedShipments.push({ shipment: v.id, shippedAt: v.shipped_at }); }
  }

  // ── Received allocation + row diff ─────────────────────────────────────────
  const rows = (await db.query(
    `SELECT s.id, s.po_asin_id, s.velocity_shipment_id, s.qty_shipped, s.qty_received, s.fba_shipment_ids, s.sc_match, pa.asin, pa.po_id, p.order_date::text AS order_date, p.order_id
       FROM po_asin_shipments s JOIN po_asins pa ON pa.id = s.po_asin_id JOIN purchase_orders p ON p.id = pa.po_id
      WHERE s.source = 'velocity'`,
  )).rows as any[];
  const rowsByShipment = new Map<string, any[]>();
  for (const r of rows) { const k = String(r.velocity_shipment_id); if (!rowsByShipment.has(k)) rowsByShipment.set(k, []); rowsByShipment.get(k)!.push(r); }
  type RowOp = { id: string; poId: string; set: Record<string, any> };
  const rowOps: RowOp[] = [];
  const vsOps: Array<{ id: string; ids: string[]; match: string }> = [];
  const touched = new Set<string>();
  for (const m of matches) {
    if (!arrEq(m.v.sc_shipment_ids, m.ids) || m.v.sc_match !== m.match) vsOps.push({ id: m.v.id, ids: m.ids, match: m.match });
    const vRows = rowsByShipment.get(String(m.v.id)) ?? [];
    const recvByRow = new Map<string, number | null>();
    if (m.match === "matched") {
      const lines: any[] = Array.isArray(m.v.raw?.detail?.orders) ? m.v.raw.detail.orders : [];
      const lineSkuToAsin = new Map<string, string>(); for (const l of lines) if (l.amazon_sku && l.asin) lineSkuToAsin.set(String(l.amazon_sku), String(l.asin).toUpperCase());
      const recvByAsin = new Map<string, number>();
      for (const sid of m.ids) for (const it of items.get(sid) ?? []) {
        const asin = lineSkuToAsin.get(it.SellerSKU) ?? skuToAsin.get(it.SellerSKU); if (!asin) continue;
        recvByAsin.set(asin, (recvByAsin.get(asin) ?? 0) + num(it.QuantityReceived));
      }
      const byAsin = new Map<string, any[]>(); for (const r of vRows) { const a = String(r.asin).toUpperCase(); if (!byAsin.has(a)) byAsin.set(a, []); byAsin.get(a)!.push(r); }
      for (const [asin, ars] of Array.from(byAsin.entries())) {
        const total = recvByAsin.get(asin) ?? 0;
        const alloc = allocateReceived(ars.map((r) => ({ id: String(r.id), qty_shipped: Number(r.qty_shipped), order_date: String(r.order_date), order_id: String(r.order_id) })), total);
        const shippedSum = ars.reduce((a, r) => a + Number(r.qty_shipped), 0);
        if (total > shippedSum + 1e-9) counts.receivedOverflowRows++;
        for (const r of ars) recvByRow.set(String(r.id), alloc.get(String(r.id)) ?? 0);
        if (result.samples.length < 10 && ars.length > 1) result.samples.push(`${String(m.v.id).slice(0, 8)} ${m.v.shipped_at ?? "?"} · ${asin}: SC received ${total} of ${shippedSum} → ${ars.sort((a, b) => (a.order_date < b.order_date ? -1 : 1)).map((r) => `${r.order_id} ${alloc.get(String(r.id)) ?? 0}/${Number(r.qty_shipped)}`).join(", ")} (oldest PO first)`);
      }
    } else for (const r of vRows) recvByRow.set(String(r.id), null);
    for (const r of vRows) {
      const set: Record<string, any> = {};
      if (!arrEq(r.fba_shipment_ids, m.ids) || r.sc_match !== m.match) { set.fba_shipment_ids = m.ids; set.sc_match = m.match; }
      const nr = recvByRow.get(String(r.id)) ?? null; const cur = r.qty_received == null ? null : Number(r.qty_received);
      if (!((cur == null && nr == null) || (cur != null && nr != null && Math.abs(cur - nr) < 1e-9))) set.qty_received = nr;
      if (Object.keys(set).length === 0) { counts.rowsUnchanged++; continue; }
      if ("fba_shipment_ids" in set) counts.rowsFbaIdsUpdated++; if ("qty_received" in set) counts.rowsReceivedUpdated++;
      rowOps.push({ id: String(r.id), poId: String(r.po_id), set }); touched.add(String(r.po_id));
    }
  }
  counts.posTouched = touched.size; result.touchedPoIds = Array.from(touched);
  if (opts.dryRun) return result;

  // ── Apply ──────────────────────────────────────────────────────────────────
  const client = await (db.connect ? db.connect() : (pool as any).connect());
  try {
    await client.query("BEGIN");
    for (const s of sc) {
      await client.query(
        `INSERT INTO sc_inbound_shipments (shipment_id, name, name_ts, status, ship_from, fc, raw, synced_at) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
         ON CONFLICT (shipment_id) DO UPDATE SET name = EXCLUDED.name, name_ts = EXCLUDED.name_ts, status = EXCLUDED.status, ship_from = EXCLUDED.ship_from, fc = EXCLUDED.fc, raw = EXCLUDED.raw, synced_at = EXCLUDED.synced_at`,
        [s.ShipmentId, s.ShipmentName ?? null, nameTs.get(s.ShipmentId) ?? null, s.ShipmentStatus, s.ShipFromAddress?.Name ?? null, s.DestinationFulfillmentCenterId ?? null, JSON.stringify(s), now],
      );
      if (fetchedIds.has(s.ShipmentId)) {
        await client.query(`DELETE FROM sc_inbound_items WHERE shipment_id = $1`, [s.ShipmentId]);
        for (const it of items.get(s.ShipmentId) ?? []) {
          await client.query(`INSERT INTO sc_inbound_items (shipment_id, seller_sku, fnsku, asin, qty_shipped, qty_received) VALUES ($1,$2,$3,$4,$5,$6)`,
            [s.ShipmentId, it.SellerSKU, it.FulfillmentNetworkSKU ?? null, skuToAsin.get(it.SellerSKU) ?? null, num(it.QuantityShipped), num(it.QuantityReceived)]);
        }
      }
    }
    for (const op of vsOps) await client.query(`UPDATE velocity_shipments SET sc_shipment_ids = $2::text[], sc_match = $3, synced_at = $4 WHERE id = $1`, [op.id, op.ids, op.match, now]);
    for (const op of rowOps) {
      const ks = Object.keys(op.set); const params: any[] = [op.id];
      const sets = ks.map((k) => { params.push(op.set[k]); return k === "fba_shipment_ids" ? `fba_shipment_ids = $${params.length}::text[]` : `${k} = $${params.length}`; });
      params.push(now);
      await client.query(`UPDATE po_asin_shipments SET ${sets.join(", ")}, updated_at = $${params.length} WHERE id = $1`, params);
    }
    await client.query("COMMIT");
    result.wrote = true;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return result;
}
