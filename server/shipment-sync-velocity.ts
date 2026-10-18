// Component A — Velocity → po_asin_shipments / qty_at_prep / shipment_unmatched
// (patch docs/claude_spec-patch-shipment-reconciliation.md §3; evidence
// docs/phase2-probe-2026-10-17.md).
//
// Every Velocity shipment line resolves to a po_asins row through
// (Order #, retailer, ASIN) — the line's order_number IS purchase_orders.
// order_id, its retailer IS the supplier (29/29 on the probed shipment).
// Velocity quantities are COMPONENT units; a row is written in ASIN qty =
// units ÷ po_asins.units_per_pack (AF's own pack size, D-probe: Equal
// Exchange 60 ÷ 6 = 10), rounded to 2 dp (fractions are legal, §3.4).
//
// Not written here (component B owns them): fba_shipment_ids, sc_match,
// qty_received. Not written at all: the manual quantity columns.
//
// Fail-closed (§3.5): any Velocity read error propagates before the
// transaction opens; the list tripwire stays in velocity-api.ts. The dry run
// computes everything and writes nothing.
import pool from "./db";
import type { QueryLike } from "./scheduler/types";
import {
  listAllShipments, getShipmentDetail, fetchAllInboundOrders, fetchAllInventoryOrders,
  type VelocityInboundOrder, type VelocityShipmentRow,
} from "./velocity-api";

export interface VelocitySyncDeps {
  listShipments: () => Promise<VelocityShipmentRow[]>;
  getShipment: (id: string) => Promise<{ orders: VelocityInboundOrder[]; [k: string]: any }>;
  listInbound: () => Promise<VelocityInboundOrder[]>;
  listInventory: () => Promise<VelocityInboundOrder[]>;
  now?: () => Date;
}

export const liveVelocityDeps: VelocitySyncDeps = {
  listShipments: listAllShipments,
  getShipment: getShipmentDetail,
  listInbound: fetchAllInboundOrders,
  listInventory: fetchAllInventoryOrders,
};

export interface VelocitySyncCounts {
  shipments: number;            // Velocity shipments listed
  shipmentsFetched: number;     // details fetched this run (new or changed)
  lines: number;                // shipment lines seen
  linesMatched: number;         // resolved to a po_asins row (incl. order-only and picker-resolved)
  linesMatchedOrderOnly: number;// resolved on (Order #, ASIN) alone — retailer spelling differed
  linesPinned: number;          // kept on a manually assigned row (assigned_by = 'manual'), never re-resolved
  linesNoOrder: number;         // no usable Order # (bundle parent without a single child order, blank)
  linesPoNotFound: number;      // Order # present but no (Order #, retailer, ASIN) in AF
  rowsInserted: number;
  rowsUpdated: number;
  rowsUnchanged: number;
  manualRowsKept: number;       // an auto-derived plan landed on a row assigned by hand — left alone (af-owned §5.2)
  manualSplitDrift: number;     // a Velocity line split by hand across rows whose units no longer add up — reported, not rewritten
  unmatchedNew: number;
  unmatchedResolved: number;    // previously unmatched lines that now resolve
  atPrepSet: number;            // po_asins.qty_at_prep changed to a number
  atPrepCleared: number;        // changed to NULL (no Velocity line references the key any more)
  atPrepUnchanged: number;
  posTouched: number;
}

export interface VelocitySyncResult {
  dryRun: boolean;
  wrote: boolean;
  counts: VelocitySyncCounts;
  /** First 10 line placements, human-readable (§6 dry-run contract). */
  samples: string[];
  unmatched: Array<{ shipment: string; shippedAt: string | null; orderId: string; orderNumber: string; retailer: string; asin: string; units: number; reason: "no_order" | "po_not_found"; note?: string }>;
  touchedPoIds: string[];
}

type Q = { query: QueryLike; connect?: () => Promise<{ query: QueryLike; release: () => void }> };

export const round2 = (n: number): number => Math.round(n * 100) / 100;
const num = (v: any): number => (v == null || v === "" ? 0 : Number(v) || 0);

const ET_DATE = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
/** Instant → America/New_York calendar date (YYYY-MM-DD); null when unparseable. */
export function etDate(ts: string | Date | null | undefined): string | null {
  if (ts == null) return null;
  const d = ts instanceof Date ? ts : new Date(ts);
  if (!Number.isFinite(d.getTime())) return null;
  const p: Record<string, string> = {};
  for (const part of ET_DATE.formatToParts(d)) if (part.type !== "literal") p[part.type] = part.value;
  return `${p.year}-${p.month}-${p.day}`;
}

export interface AfAsinRow { id: string; po_id: string; asin: string; units_per_pack: number; qty_at_prep: string | null; order_id: string; supplier: string; order_date: string }
const k3 = (supplier: string, orderId: string, asin: string) => `${supplier.trim().toLowerCase()}\u0000${orderId.trim()}\u0000${asin.trim().toUpperCase()}`;
const k2 = (orderId: string, asin: string) => `${orderId.trim()}\u0000${asin.trim().toUpperCase()}`;

export interface AfIndex { byKey: Map<string, AfAsinRow>; byOrderAsin: Map<string, AfAsinRow[]>; all: AfAsinRow[] }
export function buildAfIndex(rows: AfAsinRow[]): AfIndex {
  const byKey = new Map<string, AfAsinRow>(); const byOrderAsin = new Map<string, AfAsinRow[]>();
  for (const r of rows) {
    byKey.set(k3(r.supplier, r.order_id, r.asin), r);
    const k = k2(r.order_id, r.asin); if (!byOrderAsin.has(k)) byOrderAsin.set(k, []); byOrderAsin.get(k)!.push(r);
  }
  return { byKey, byOrderAsin, all: rows };
}

export type Resolution =
  | { ok: true; row: AfAsinRow; how: "exact" | "order_only" | "picker" | "pinned" }
  | { ok: false; reason: "no_order" | "po_not_found"; note?: string; orderNumber: string; retailer: string };

/**
 * (Order #, retailer, ASIN) → po_asins row. A bundle parent (order_number
 * null) borrows its children's order numbers from the inbound / inventory
 * legs (shipment details omit bundle_children); one distinct child order →
 * that order, several → no_order (a per-order split is not inferrable).
 * Exact key first; then (Order #, ASIN) alone when unique in AF (retailer
 * spelling drift), counted separately.
 */
export function resolveLine(line: VelocityInboundOrder, idx: AfIndex, childrenByOrderId: Map<string, any[]>): Resolution {
  const asin = String(line.asin ?? "").trim().toUpperCase();
  let orderNumber = String(line.order_number ?? "").trim();
  let retailer = String(line.retailer ?? "").trim();
  if (orderNumber === "" && String(line.sold_as ?? "").toLowerCase() === "bundle") {
    const kids = (Array.isArray(line.bundle_children) && line.bundle_children.length > 0 ? line.bundle_children : childrenByOrderId.get(String(line.order_id ?? ""))) ?? [];
    const pairs = new Map<string, { orderNumber: string; retailer: string }>();
    for (const c of kids) { const n = String(c?.order_number ?? "").trim(); if (n) pairs.set(`${n}\u0000${String(c?.retailer ?? "").trim().toLowerCase()}`, { orderNumber: n, retailer: String(c?.retailer ?? "").trim() }); }
    if (pairs.size === 1) { const p = Array.from(pairs.values())[0]; orderNumber = p.orderNumber; retailer = p.retailer || retailer; }
    else if (pairs.size > 1) return { ok: false, reason: "no_order", note: `bundle spans ${pairs.size} orders`, orderNumber: "", retailer };
  }
  if (orderNumber === "") return { ok: false, reason: "no_order", orderNumber: "", retailer };
  const exact = idx.byKey.get(k3(retailer, orderNumber, asin));
  if (exact) return { ok: true, row: exact, how: "exact" };
  const alt = idx.byOrderAsin.get(k2(orderNumber, asin)) ?? [];
  if (alt.length === 1) return { ok: true, row: alt[0], how: "order_only" };
  return { ok: false, reason: "po_not_found", note: alt.length > 1 ? `Order # found under ${alt.length} suppliers` : undefined, orderNumber, retailer };
}

function parseTs(v: any): Date | null { if (v == null || v === "") return null; const d = new Date(String(v)); return Number.isFinite(d.getTime()) ? d : null; }

export async function syncVelocityShipments(opts: { dryRun: boolean; deps?: VelocitySyncDeps; db?: Q }): Promise<VelocitySyncResult> {
  const deps = opts.deps ?? liveVelocityDeps;
  const db: Q = opts.db ?? (pool as unknown as Q);
  const now = deps.now ? deps.now() : new Date();

  // ── Velocity reads (all before any write) ──────────────────────────────────
  const shipments = await deps.listShipments();
  const stored = new Map<string, any>((await db.query(`SELECT id, status, shipped_at_ts, raw FROM velocity_shipments`)).rows.map((r: any) => [String(r.id), r]));
  const details = new Map<string, { orders: VelocityInboundOrder[]; [k: string]: any }>();
  const fetchedIds = new Set<string>();
  for (const s of shipments) {
    const prev = stored.get(s.shipment_id);
    const changed = !prev || prev.status !== s.status || String(prev.raw?.list?.shipped_at ?? "") !== String(s.shipped_at ?? "") || !prev.raw?.detail;
    if (changed) { details.set(s.shipment_id, await deps.getShipment(s.shipment_id)); fetchedIds.add(s.shipment_id); }
    else details.set(s.shipment_id, prev.raw.detail);
  }
  const inbound = await deps.listInbound();
  const inventory = await deps.listInventory();

  // ── AF state ───────────────────────────────────────────────────────────────
  const afRows = (await db.query(
    `SELECT pa.id, pa.po_id, pa.asin, pa.units_per_pack, pa.qty_at_prep, p.order_id, p.supplier, p.order_date::text AS order_date
       FROM po_asins pa JOIN purchase_orders p ON p.id = pa.po_id`,
  )).rows as AfAsinRow[];
  const idx = buildAfIndex(afRows);
  const existingRows = (await db.query(`SELECT id, po_asin_id, velocity_shipment_id, qty_shipped, shipped_at::text AS shipped_at, assigned_by FROM po_asin_shipments WHERE source = 'velocity'`)).rows;
  const existingByKey = new Map<string, any>(existingRows.map((r: any) => [`${r.po_asin_id}\u0000${r.velocity_shipment_id}`, r]));
  const unmatchedRows = (await db.query(`SELECT id, velocity_shipment_id, velocity_order_id, reason, resolved_at, resolved_po_asin_id FROM shipment_unmatched`)).rows;
  const unmatchedByKey = new Map<string, any>(unmatchedRows.map((r: any) => [`${r.velocity_shipment_id}\u0000${r.velocity_order_id}`, r]));
  const afById = new Map<string, AfAsinRow>(afRows.map((r) => [String(r.id), r]));
  // Manual assignments (assigned_by = 'manual', 2026-10-18; Reassign
  // shipment, af-owned §5.2): a Velocity line (shipment, Velocity Order #,
  // ASIN) pinned to one or more PO ASIN rows stays there — never moved or
  // re-resolved. One pinned row: its quantity refreshes from Velocity. A line
  // split by hand across several rows: compared with Velocity's units and
  // reported when they no longer add up, never rewritten.
  const pinKey = (shipmentId: string, orderNumber: unknown, asin: unknown) => `${shipmentId}\u0000${String(orderNumber ?? "").trim()}\u0000${String(asin ?? "").trim().toUpperCase()}`;
  type PinRow = { id: string; poAsinId: string; qty: number; shippedAt: string | null };
  const pins = new Map<string, PinRow[]>();
  for (const r of (await db.query(`SELECT s.id, s.velocity_shipment_id, s.velocity_order_number, s.qty_shipped, s.shipped_at::text AS shipped_at, pa.asin, s.po_asin_id FROM po_asin_shipments s JOIN po_asins pa ON pa.id = s.po_asin_id WHERE s.assigned_by = 'manual' AND s.source = 'velocity' ORDER BY s.created_at, s.id`)).rows as any[]) {
    const k = pinKey(String(r.velocity_shipment_id), r.velocity_order_number, r.asin);
    if (!pins.has(k)) pins.set(k, []);
    pins.get(k)!.push({ id: String(r.id), poAsinId: String(r.po_asin_id), qty: Number(r.qty_shipped), shippedAt: r.shipped_at ?? null });
  }
  const pinRowsFor = (shipmentId: string, line: VelocityInboundOrder): PinRow[] => (pins.get(pinKey(shipmentId, line.order_number, line.asin)) ?? []).filter((p) => afById.has(p.poAsinId));
  const pinned = (shipmentId: string, line: VelocityInboundOrder): Resolution | null => {
    const rows = pinRowsFor(shipmentId, line);
    return rows.length > 0 ? { ok: true, row: afById.get(rows[0].poAsinId)!, how: "pinned" } : null;
  };

  // Bundle children live only on the list legs; a fully shipped bundle parent
  // has left both, so the §11 Part C.2 identity record (velocity_bundle_identity)
  // is the fallback — child order numbers only, no retailer, which resolves
  // through the (Order #, ASIN) path when unique.
  const childrenByOrderId = new Map<string, any[]>();
  for (const o of [...inbound, ...inventory]) if (Array.isArray(o.bundle_children) && o.bundle_children.length > 0) childrenByOrderId.set(String(o.order_id), o.bundle_children);
  for (const r of (await db.query(`SELECT velocity_order_id, child_order_numbers FROM velocity_bundle_identity`)).rows as any[]) {
    const oid = String(r.velocity_order_id); const nums: string[] = Array.isArray(r.child_order_numbers) ? r.child_order_numbers : [];
    if (!childrenByOrderId.has(oid) && nums.length > 0) childrenByOrderId.set(oid, nums.map((n) => ({ order_number: String(n), retailer: "" })));
  }

  // ── Resolve every shipment line ────────────────────────────────────────────
  const counts: VelocitySyncCounts = {
    shipments: shipments.length, shipmentsFetched: fetchedIds.size, lines: 0, linesMatched: 0, linesMatchedOrderOnly: 0, linesPinned: 0, linesNoOrder: 0, linesPoNotFound: 0,
    rowsInserted: 0, rowsUpdated: 0, rowsUnchanged: 0, manualRowsKept: 0, manualSplitDrift: 0, unmatchedNew: 0, unmatchedResolved: 0, atPrepSet: 0, atPrepCleared: 0, atPrepUnchanged: 0, posTouched: 0,
  };
  const samples: string[] = [];
  const unmatched: VelocitySyncResult["unmatched"] = [];
  const touched = new Set<string>();
  type RowPlan = { poAsinId: string; shipmentId: string; units: number; upp: number; shippedAt: string | null; lines: string[] };
  const rowPlans = new Map<string, RowPlan>();
  type UnmatchedPlan = { shipmentId: string; orderId: string; line: any; reason: "no_order" | "po_not_found" };
  const unmatchedPlans = new Map<string, UnmatchedPlan>();
  const resolvedNow = new Set<string>(); // unmatched rows whose line now resolves by key
  type ManualLine = { rows: PinRow[]; units: number; shippedAt: string | null; label: string };
  const manualLines = new Map<string, ManualLine>();

  for (const s of shipments) {
    const det = details.get(s.shipment_id)!;
    const shippedAt = etDate(s.shipped_at);
    for (const line of det.orders) {
      counts.lines++;
      const key = `${s.shipment_id}\u0000${String(line.order_id ?? "")}`;
      const prior = unmatchedByKey.get(key);
      const pinRows = pinRowsFor(s.shipment_id, line);
      if (pinRows.length > 0) {
        // Assigned by hand: the rows stay put; only quantities are compared below.
        counts.linesMatched++; counts.linesPinned++;
        if (prior && !prior.resolved_at) resolvedNow.add(String(prior.id));
        const pk = pinKey(s.shipment_id, line.order_number, line.asin);
        const m = manualLines.get(pk) ?? { rows: pinRows, units: 0, shippedAt, label: `${s.shipment_id.slice(0, 8)} ${line.order_number ?? "?"} ${line.asin ?? "?"}` };
        m.units += num(line.quantity_shipped);
        manualLines.set(pk, m);
        continue;
      }
      let res: Resolution;
      if (prior?.resolved_po_asin_id && afById.has(String(prior.resolved_po_asin_id))) res = { ok: true, row: afById.get(String(prior.resolved_po_asin_id))!, how: "picker" };
      else res = resolveLine(line, idx, childrenByOrderId);
      const units = num(line.quantity_shipped);
      if (!res.ok) {
        if (res.reason === "no_order") counts.linesNoOrder++; else counts.linesPoNotFound++;
        unmatchedPlans.set(key, { shipmentId: s.shipment_id, orderId: String(line.order_id ?? ""), line, reason: res.reason });
        unmatched.push({ shipment: s.shipment_id, shippedAt, orderId: String(line.order_id ?? ""), orderNumber: res.orderNumber, retailer: res.retailer, asin: String(line.asin ?? ""), units, reason: res.reason, note: res.note });
        continue;
      }
      counts.linesMatched++;
      if (res.how === "order_only") counts.linesMatchedOrderOnly++;
      if (prior && !prior.resolved_at) resolvedNow.add(String(prior.id));
      const rk = `${res.row.id}\u0000${s.shipment_id}`;
      const plan = rowPlans.get(rk) ?? { poAsinId: String(res.row.id), shipmentId: s.shipment_id, units: 0, upp: Number(res.row.units_per_pack) || 1, shippedAt, lines: [] };
      plan.units += units; plan.lines.push(`${res.row.supplier} ${res.row.order_id} ${res.row.asin} ${units}u`);
      rowPlans.set(rk, plan);
      if (samples.length < 10) samples.push(`${s.shipment_id.slice(0, 8)} ${shippedAt ?? "?"} · ${res.row.supplier} ${res.row.order_id} ${res.row.asin}: ${units} units ÷ ${plan.upp} → ${round2(units / plan.upp)}${res.how !== "exact" ? ` (${res.how})` : ""}`);
    }
  }

  // ── Row diff ───────────────────────────────────────────────────────────────
  type RowOp = { kind: "insert" | "update"; plan: RowPlan; qty: number; id?: string };
  const rowOps: RowOp[] = [];
  for (const [rk, plan] of Array.from(rowPlans.entries())) {
    const qty = round2(plan.units / plan.upp);
    const ex = existingByKey.get(rk);
    if (ex && ex.assigned_by === "manual") { counts.manualRowsKept++; continue; } // a hand assignment is never overwritten by derivation
    if (!ex) { rowOps.push({ kind: "insert", plan, qty }); counts.rowsInserted++; touched.add(afById.get(plan.poAsinId)!.po_id); continue; }
    if (Math.abs(Number(ex.qty_shipped) - qty) > 1e-9 || String(ex.shipped_at ?? "") !== String(plan.shippedAt ?? "")) { rowOps.push({ kind: "update", plan, qty, id: ex.id }); counts.rowsUpdated++; touched.add(afById.get(plan.poAsinId)!.po_id); }
    else counts.rowsUnchanged++;
  }
  // Lines assigned by hand (§5.2): one row → refresh its quantity / ship date; split → compare only.
  for (const m of Array.from(manualLines.values())) {
    if (m.rows.length === 1) {
      const r = m.rows[0];
      const upp = Number(afById.get(r.poAsinId)!.units_per_pack) || 1;
      const qty = round2(m.units / upp);
      if (Math.abs(r.qty - qty) > 1e-9 || String(r.shippedAt ?? "") !== String(m.shippedAt ?? "")) {
        rowOps.push({ kind: "update", plan: { poAsinId: r.poAsinId, shipmentId: "", units: m.units, upp, shippedAt: m.shippedAt, lines: [m.label] }, qty, id: r.id });
        counts.rowsUpdated++; touched.add(afById.get(r.poAsinId)!.po_id);
      } else counts.rowsUnchanged++;
      continue;
    }
    const heldUnits = m.rows.reduce((t, r) => t + r.qty * (Number(afById.get(r.poAsinId)!.units_per_pack) || 1), 0);
    if (Math.abs(heldUnits - m.units) > 1e-6) {
      counts.manualSplitDrift++;
      if (samples.length < 10) samples.push(`${m.label}: split by hand over ${m.rows.length} rows holding ${round2(heldUnits)} units; Velocity now says ${m.units} — not rewritten`);
    } else counts.rowsUnchanged += m.rows.length;
  }
  for (const [key] of Array.from(unmatchedPlans.entries())) if (!unmatchedByKey.has(key)) counts.unmatchedNew++;
  counts.unmatchedResolved = resolvedNow.size;

  // ── qty_at_prep (§3.3, D6): one live line per Velocity order; inbound > inventory > newest shipment ──
  const orderLine = new Map<string, VelocityInboundOrder>();
  const shipmentsNewestFirst = [...shipments].sort((a, b) => (parseTs(b.shipped_at)?.getTime() ?? 0) - (parseTs(a.shipped_at)?.getTime() ?? 0));
  for (const s of shipmentsNewestFirst) for (const line of details.get(s.shipment_id)!.orders) { const oid = String(line.order_id ?? ""); if (oid && !orderLine.has(oid)) orderLine.set(oid, { ...line, __shipment_id: s.shipment_id } as any); }
  for (const o of inventory) { const oid = String(o.order_id ?? ""); if (oid) orderLine.set(oid, o); }
  for (const o of inbound) { const oid = String(o.order_id ?? ""); if (oid) orderLine.set(oid, o); }
  const remainingByAsinRow = new Map<string, number>();
  for (const line of Array.from(orderLine.values())) {
    const sid = String((line as any).__shipment_id ?? "");
    const prior = sid ? unmatchedByKey.get(`${sid}\u0000${String(line.order_id ?? "")}`) : undefined;
    const res: Resolution = (sid ? pinned(sid, line) : null)
      ?? (prior?.resolved_po_asin_id && afById.has(String(prior.resolved_po_asin_id)) ? { ok: true, row: afById.get(String(prior.resolved_po_asin_id))!, how: "picker" } : resolveLine(line, idx, childrenByOrderId));
    if (!res.ok) continue;
    remainingByAsinRow.set(String(res.row.id), (remainingByAsinRow.get(String(res.row.id)) ?? 0) + num(line.quantity_remaining));
  }
  const atPrepOps: Array<{ id: string; poId: string; value: number | null }> = [];
  for (const r of afRows) {
    const has = remainingByAsinRow.has(String(r.id));
    const next = has ? round2(remainingByAsinRow.get(String(r.id))! / (Number(r.units_per_pack) || 1)) : null;
    const cur = r.qty_at_prep == null ? null : Number(r.qty_at_prep);
    const same = (cur == null && next == null) || (cur != null && next != null && Math.abs(cur - next) < 1e-9);
    if (same) { counts.atPrepUnchanged++; continue; }
    atPrepOps.push({ id: String(r.id), poId: String(r.po_id), value: next });
    if (next == null) counts.atPrepCleared++; else counts.atPrepSet++;
    touched.add(String(r.po_id));
  }
  counts.posTouched = touched.size;

  const result: VelocitySyncResult = { dryRun: opts.dryRun, wrote: false, counts, samples, unmatched, touchedPoIds: Array.from(touched) };
  if (opts.dryRun) return result;

  // ── Apply ──────────────────────────────────────────────────────────────────
  const client = await (db.connect ? db.connect() : (pool as any).connect());
  try {
    await client.query("BEGIN");
    for (const s of shipments) {
      const ts = parseTs(s.shipped_at);
      await client.query(
        `INSERT INTO velocity_shipments (id, shipped_at, shipped_at_ts, status, raw, synced_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)
         ON CONFLICT (id) DO UPDATE SET shipped_at = EXCLUDED.shipped_at, shipped_at_ts = EXCLUDED.shipped_at_ts, status = EXCLUDED.status,
           raw = CASE WHEN $7 THEN EXCLUDED.raw ELSE velocity_shipments.raw END, synced_at = EXCLUDED.synced_at`,
        [s.shipment_id, etDate(s.shipped_at), ts, s.status, JSON.stringify({ list: s, detail: details.get(s.shipment_id) }), now, fetchedIds.has(s.shipment_id)],
      );
    }
    for (const op of rowOps) {
      if (op.kind === "insert") {
        await client.query(
          `INSERT INTO po_asin_shipments (po_asin_id, velocity_shipment_id, qty_shipped, shipped_at, source) VALUES ($1, $2, $3, $4, 'velocity')`,
          [op.plan.poAsinId, op.plan.shipmentId, op.qty, op.plan.shippedAt],
        );
      } else {
        await client.query(`UPDATE po_asin_shipments SET qty_shipped = $2, shipped_at = $3, updated_at = $4 WHERE id = $1`, [op.id, op.qty, op.plan.shippedAt, now]);
      }
    }
    for (const [key, u] of Array.from(unmatchedPlans.entries())) {
      const prior = unmatchedByKey.get(key);
      if (prior?.resolved_at) continue; // resolved by hand and still unresolvable by key: leave the record alone
      await client.query(
        `INSERT INTO shipment_unmatched (velocity_shipment_id, velocity_order_id, line, reason)
         VALUES ($1, $2, $3::jsonb, $4)
         ON CONFLICT (velocity_shipment_id, velocity_order_id) DO UPDATE SET line = EXCLUDED.line, reason = EXCLUDED.reason`,
        [u.shipmentId, u.orderId, JSON.stringify(u.line), u.reason],
      );
    }
    if (resolvedNow.size > 0) await client.query(`UPDATE shipment_unmatched SET resolved_at = $2 WHERE id = ANY($1::uuid[]) AND resolved_at IS NULL`, [Array.from(resolvedNow), now]);
    for (const op of atPrepOps) await client.query(`UPDATE po_asins SET qty_at_prep = $2 WHERE id = $1`, [op.id, op.value]);
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
