// Component A — Velocity → po_asin_shipments / qty_at_prep / shipment_unmatched
//
// Since migration 101 (claims commit 1, D17) every quantity this component writes — shipment rows, qty_at_prep,
// received_velocity — is INDIVIDUAL units, exactly what Velocity counts; nothing is divided by a pack size here any
// more (po_asin_expected shows the ASIN units). The pack comparison below (velocity_units_per_pack) is unchanged.
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
// Pack size (2026-10-29): the divisor is AF's units_per_pack, never Velocity's,
// and nothing is capped at Ordered. Velocity's own pack size for the row
// (1 for individual; bundles not compared) is recorded in
// po_asins.velocity_units_per_pack, so a disagreement surfaces as the derived
// "Pack size mismatch" action item instead of a silent ÷. A row whose
// sold_as is NULL (not filled in on the sheet) takes sold_as /
// units_per_pack from Velocity when every Velocity line for it agrees —
// logged in po_edit_log (user NULL) — and otherwise stays NULL, which is
// the derived "Pack size missing" item.
//
// Col P (2026-10-29 → 2026-11-13, Orders-sheet retirement commit 3): the sheet's
// FBA-shipment-id signal is gone with the sheet (po_sheet_fba_shipments dropped,
// migration 110). A line it once placed resolves through its recorded link —
// shipment_unmatched (match_reason col_p, read as a picker link) or a Velocity
// order link (migration 099); the Col P-hidden dry run of 2026-11-13 placed every
// line without it.
//
// PO matching (patch docs/claude_spec-patch-po-matching.md, amended
// 2026-10-29): past the legacy keys a line resolves through the retailer
// alias (supplier_aliases) and the normalized order # (§3 a, in the main
// pass), then, once every other line's placement is known, the base order # with
// units fit (§3 b) and the candidate rule (§4, shipment-match.ts). A §3 b /
// §4 link is recorded on shipment_unmatched exactly like a picker link
// (resolved_po_asin_id, match_reason), so later runs keep it. A line that
// still fails is unmatched with its ranked candidates or a nearest miss.
//
// Received by Velocity (2026-11-02): po_asins.received_velocity = Σ Velocity
// quantity_received over the same live lines as qty_at_prep ÷ units_per_pack
// — the cumulative check-in count, which quantity_remaining loses once the
// units ship. Never capped at Ordered; NULL when no line references the key.
//
// Order links (migration 099, 2026-11-07): a Velocity order linked to a PO
// ASIN row (velocity_order_links) goes there before every rule but a hand
// pin — its shipped lines, its Received by Velocity / At Prep (inbound,
// inventory or shipped; the at-prep pass keeps the newest shipment id of a
// partly shipped order so hand pins and picker links still apply there) and
// its pack size. An order that has not shipped and resolves nowhere is listed
// in velocity_orders_unplaced ("Velocity orders with no PO") with its ranked
// candidates.
//
// Home POs (Maria 2026-11-07): an order # match to a PO with ships_to =
// 'home' is no longer skipped — the order is matched like any other, and the
// PO's purchase_orders.velocity_home_orders names the Velocity orders, which
// raises Review Velocity "Velocity has an order for a Home PO" until ships_to
// is corrected or it is cleared by hand. Base order # and the §4 candidate
// rule still skip Home POs.
//
// Not written here (component B owns them): fba_shipment_ids, sc_match,
// qty_received. Not written at all: the manual quantity columns.
//
// Fail-closed (§3.5): any Velocity read error propagates before the
// transaction opens; the list tripwire stays in velocity-api.ts. The dry run
// computes everything and writes nothing.
import pool from "./db";
import type { QueryLike } from "./scheduler/types";
import { logEdits } from "./po-edit";
import { loadAliases, resolveRetailer, type RetailerResolution } from "./supplier-aliases";
import { buildKeyIndex, matchFullKey, baseKeyRows, rankCandidates, nearestMiss, velocityDate, capacityUnits, dayDiff, velocityIneligible, ineligibleText, type KeyIndex, type MatchCandidate } from "./shipment-match";
import { readVelocityStartDate } from "./ships-to-backfill";
import { loadOrderLinks } from "./velocity-order-links";
import { reconcileReviewVelocity } from "./line-action-items";
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
  linesMatchedAlias: number;    // the retailer resolved through supplier_aliases (§3.1)
  linesMatchedNormalized: number; // full normalized order # + ASIN (§3 a)
  linesMatchedBaseId: number;   // base order # (no _N / -N) + ASIN, units fit (§3 b)
  linesMatchedCandidate: number;// the §4 candidate rule, exactly one candidate
  linesCandidateAmbiguous: number; // §4 found several — left unmatched with them
  linesLinked: number;          // placed through velocity_order_links (migration 099)
  homeOrders: number;           // POs with ships_to = 'home' that a Velocity order resolved to (Review Velocity)
  unplacedOrders: number;       // never-shipped Velocity orders placed nowhere ("Velocity orders with no PO")
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
  receivedVelocitySet: number;  // po_asins.received_velocity changed to a number (Received by Velocity, 2026-11-02)
  receivedVelocityCleared: number; // changed to NULL (no Velocity line references the key any more)
  receivedVelocityUnchanged: number;
  packVelocitySet: number;      // po_asins.velocity_units_per_pack changed
  packFilled: number;           // sold_as NULL → filled from Velocity
  packMismatch: number;         // rows whose AF pack size disagrees with Velocity's (flagged, still ÷ AF's)
  packMissing: number;          // rows still sold_as NULL after the fill (flagged)
  packConflicting: number;      // Velocity lines for one row disagree with each other
  posTouched: number;
}

export interface VelocitySyncResult {
  dryRun: boolean;
  wrote: boolean;
  counts: VelocitySyncCounts;
  /** First 10 line placements, human-readable (§6 dry-run contract). */
  samples: string[];
  /** First 10 pack-size fills / mismatches, human-readable. */
  packSamples: string[];
  unmatched: Array<{ shipment: string; shippedAt: string | null; orderId: string; orderNumber: string; retailer: string; asin: string; units: number; reason: "no_order" | "po_not_found"; note?: string; candidates?: MatchCandidate[]; miss?: string | null; vDate?: string | null }>;
  /** Every line placed by a rule past the legacy keys this run (alias / normalized / base_id / candidate), for the backfill report. */
  ruleLinks: Array<{ shipment: string; shippedAt: string | null; orderId: string; orderNumber: string; retailer: string; asin: string; units: number; how: string; poAsinId: string; poOrderId: string; supplier: string; poDate: string; vDate: string | null; days: number | null; wasUnmatched: boolean }>;
  /** Every po_asins.received_velocity change this run (set or cleared), for the backfill's per-PO report. */
  receivedVelocityOps: Array<{ id: string; poId: string; orderId: string; supplier: string; asin: string; from: number | null; to: number | null }>;
  touchedPoIds: string[];
  /** Home POs a Velocity order resolved to, with the Velocity orders (Review Velocity "Velocity has an order for a Home PO"). */
  homeOrders: Array<{ poId: string; orders: string[] }>;
  /** Never-shipped Velocity orders placed nowhere — "Velocity orders with no PO". */
  unplacedOrders: Array<{ orderId: string; orderNumber: string; retailer: string; asin: string; units: number; reason: "no_order" | "po_not_found"; candidates?: MatchCandidate[]; miss: string | null }>;
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

export interface AfAsinRow {
  id: string; po_id: string; asin: string; units_per_pack: number | null; qty_at_prep: string | null; order_id: string; supplier: string; order_date: string;
  /** individual | asin_legacy (migration 101): how qty is stored; capacityUnits reads it. */
  qty_basis?: string | null;
  /** Received by Velocity (2026-11-02): the stored cumulative count; undefined reads as NULL. */
  received_velocity?: string | null;
  /** Ordered ASIN qty (the §3 b / §4 units-fit capacity). */
  qty?: number | string | null;
  /** null = not filled in (blank on the sheet); undefined is treated as known. */
  sold_as?: string | null;
  velocity_units_per_pack?: number | null;
  /** 'velocity' | 'home' — a home PO is never a Velocity match. */
  ships_to?: string | null;
}

/** Velocity's pack size for one line: individual → 1, multi-pack → its units_per_pack; bundles and unknowns → null (not compared). */
export function velocityPack(line: { sold_as?: unknown; units_per_pack?: unknown }): { soldAs: "individual" | "multi-pack"; upp: number } | null {
  const sold = String(line.sold_as ?? "").trim().toLowerCase();
  if (sold === "individual") return { soldAs: "individual", upp: 1 };
  if (sold === "multi-pack") {
    const n = Number(line.units_per_pack);
    return Number.isInteger(n) && n >= 1 ? { soldAs: "multi-pack", upp: n } : null;
  }
  return null;
}
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
  | { ok: true; row: AfAsinRow; how: "exact" | "order_only" | "picker" | "pinned" | "linked" | "alias" | "normalized" | "base_id" | "candidate" }
  | { ok: false; reason: "no_order" | "po_not_found"; note?: string; orderNumber: string; retailer: string; candidates?: MatchCandidate[] };

/**
 * (Order #, retailer, ASIN) → po_asins row. A bundle parent (order_number
 * null) borrows its children's order numbers from the inbound / inventory
 * legs (shipment details omit bundle_children); one distinct child order →
 * that order, several → no_order (a per-order split is not inferrable).
 * Exact key first; then (Order #, ASIN) alone when unique in AF (retailer
 * spelling drift), counted separately.
 */
export interface MatchContext {
  ki: KeyIndex<AfAsinRow>; aliases: ReadonlyMap<string, string>; suppliers: readonly string[];
  /** The order # index (Home POs included, 2026-11-07); ki when absent. */
  kiOrder?: KeyIndex<AfAsinRow>;
}
export function resolveLine(line: VelocityInboundOrder, idx: AfIndex, childrenByOrderId: Map<string, any[]>, ctx?: MatchContext): Resolution {
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
  if (ctx) {
    // §3.1 / §3 a: the retailer through supplier_aliases, then the normalized order #.
    const ret = resolveRetailer(retailer, ctx.aliases, ctx.suppliers);
    if (ret.kind === "supplier" && ret.via === "alias") {
      const viaAlias = idx.byKey.get(k3(ret.supplier, orderNumber, asin));
      if (viaAlias) return { ok: true, row: viaAlias, how: "alias" };
    }
    const full = matchFullKey(orderNumber, asin, ret, ctx.kiOrder ?? ctx.ki);
    if (full) return { ok: true, row: full, how: "normalized" };
  }
  return { ok: false, reason: "po_not_found", note: alt.length > 1 ? `Order # found under ${alt.length} suppliers` : undefined, orderNumber, retailer };
}

function parseTs(v: any): Date | null { if (v == null || v === "") return null; const d = new Date(String(v)); return Number.isFinite(d.getTime()) ? d : null; }

export async function syncVelocityShipments(opts: { dryRun: boolean; deps?: VelocitySyncDeps; db?: Q; /** Backfill dry run: proposed alias seeds, in memory only. */ extraAliases?: ReadonlyMap<string, string> }): Promise<VelocitySyncResult> {
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
    `SELECT pa.id, pa.po_id, pa.asin, pa.units_per_pack, pa.qty_at_prep, p.order_id, p.supplier, p.order_date::text AS order_date,
            pa.sold_as, pa.velocity_units_per_pack, pa.qty, pa.qty_basis, p.ships_to, pa.received_velocity
       FROM po_asins pa JOIN purchase_orders p ON p.id = pa.po_id`,
  )).rows as AfAsinRow[];
  // Every rule matches only Velocity-eligible POs (not Home, not before
  // tracking.velocity_start_date; Maria 2026-10-29). afById keeps every row
  // for recorded links and hand pins.
  const velocityStart = await readVelocityStartDate(db.query.bind(db));
  const matchRows = afRows.filter((r) => velocityIneligible(r, velocityStart) == null);
  // Order # matches also reach Home POs (2026-11-07): matched, then flagged for review.
  const orderRows = afRows.filter((r) => { const why = velocityIneligible(r, velocityStart); return why == null || why === "home"; });
  const idx = buildAfIndex(orderRows);
  const existingRows = (await db.query(`SELECT id, po_asin_id, velocity_shipment_id, qty_shipped, shipped_at::text AS shipped_at, assigned_by FROM po_asin_shipments WHERE source = 'velocity'`)).rows;
  const existingByKey = new Map<string, any>(existingRows.map((r: any) => [`${r.po_asin_id}\u0000${r.velocity_shipment_id}`, r]));
  const unmatchedRows = (await db.query(`SELECT id, velocity_shipment_id, velocity_order_id, reason, resolved_at, resolved_po_asin_id, match_reason FROM shipment_unmatched`)).rows;
  const unmatchedByKey = new Map<string, any>(unmatchedRows.map((r: any) => [`${r.velocity_shipment_id}\u0000${r.velocity_order_id}`, r]));
  const afById = new Map<string, AfAsinRow>(afRows.map((r) => [String(r.id), r]));
  const kiAll = buildKeyIndex(afRows);
  // §3 / §4 context: normalized-key index, retailer aliases (+ a backfill's proposed seeds), AF suppliers.
  const aliases = new Map<string, string>(await loadAliases(db.query.bind(db)));
  for (const [k, v] of Array.from(opts.extraAliases?.entries() ?? [])) if (!aliases.has(k)) aliases.set(k, v);
  const ctx: MatchContext = { ki: buildKeyIndex(matchRows), kiOrder: buildKeyIndex(orderRows), aliases, suppliers: Array.from(new Set(afRows.map((r) => r.supplier))) };
  // Order links (migration 099): Velocity order id → PO ASIN row, asked before every rule but a hand pin.
  const linkById = new Map<string, string>((await loadOrderLinks(db.query.bind(db))).map((l) => [l.velocity_order_id, l.po_asin_id]));
  const linked = (line: VelocityInboundOrder): Resolution | null => {
    const id = linkById.get(String(line.order_id ?? ""));
    return id && afById.has(id) ? { ok: true, row: afById.get(id)!, how: "linked" } : null;
  };
  /** A line recorded as linked (picker, or a §3 b / §4 link from an earlier run). */
  const priorLink = (prior: any): Resolution | null => {
    if (!prior?.resolved_po_asin_id || !afById.has(String(prior.resolved_po_asin_id))) return null;
    // match_reason col_p (the retired sheet signal, 50 rows on production) is a recorded link like a picker's.
    const how = prior.match_reason === "candidate_unique" ? "candidate" : prior.match_reason === "base_id" ? "base_id" : "picker";
    return { ok: true, row: afById.get(String(prior.resolved_po_asin_id))!, how };
  };
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
    linesMatchedAlias: 0, linesMatchedNormalized: 0, linesMatchedBaseId: 0, linesMatchedCandidate: 0, linesCandidateAmbiguous: 0,
    linesLinked: 0, homeOrders: 0, unplacedOrders: 0,
    rowsInserted: 0, rowsUpdated: 0, rowsUnchanged: 0, manualRowsKept: 0, manualSplitDrift: 0, unmatchedNew: 0, unmatchedResolved: 0, atPrepSet: 0, atPrepCleared: 0, atPrepUnchanged: 0, receivedVelocitySet: 0, receivedVelocityCleared: 0, receivedVelocityUnchanged: 0,
    packVelocitySet: 0, packFilled: 0, packMismatch: 0, packMissing: 0, packConflicting: 0, posTouched: 0,
  };
  const samples: string[] = [];
  const packSamples: string[] = [];
  const unmatched: VelocitySyncResult["unmatched"] = [];
  const ruleLinks: VelocitySyncResult["ruleLinks"] = [];
  const touched = new Set<string>();

  // ── Pack size, before any ÷ (2026-10-29) ───────────────────────────────────
  // Every Velocity line that resolves to an AF row — shipment lines, the
  // inventory and inbound legs — contributes its own pack size. A NULL
  // sold_as is filled from them (in memory here, so the ÷ below uses it);
  // the recorded Velocity value drives the derived mismatch item.
  const resolveForPack = (line: VelocityInboundOrder, shipmentId: string | null): Resolution => {
    const pin = (shipmentId ? pinned(shipmentId, line) : null) ?? linked(line);
    if (pin) return pin;
    const prior = shipmentId ? unmatchedByKey.get(`${shipmentId}\u0000${String(line.order_id ?? "")}`) : undefined;
    return priorLink(prior) ?? resolveLine(line, idx, childrenByOrderId, ctx);
  };
  const packsByRow = new Map<string, Map<string, { soldAs: "individual" | "multi-pack"; upp: number }>>();
  const notePack = (line: VelocityInboundOrder, shipmentId: string | null) => {
    const vp = velocityPack(line);
    if (!vp) return;
    const res = resolveForPack(line, shipmentId);
    if (!res.ok) return;
    const id = String(res.row.id);
    if (!packsByRow.has(id)) packsByRow.set(id, new Map());
    packsByRow.get(id)!.set(`${vp.soldAs}:${vp.upp}`, vp);
  };
  for (const s of shipments) for (const line of details.get(s.shipment_id)!.orders) notePack(line, s.shipment_id);
  for (const o of [...inventory, ...inbound]) notePack(o, null);
  const fillOps: Array<{ id: string; poId: string; from: { sold_as: string | null; units_per_pack: number | null }; soldAs: string; upp: number }> = [];
  const packOps: Array<{ id: string; value: number | null }> = [];
  for (const r of afRows) {
    const packs = Array.from(packsByRow.get(String(r.id))?.values() ?? []);
    if (packs.length > 1) counts.packConflicting++;
    if (r.sold_as === null && packs.length === 1) {
      fillOps.push({ id: String(r.id), poId: String(r.po_id), from: { sold_as: null, units_per_pack: r.units_per_pack ?? null }, soldAs: packs[0].soldAs, upp: packs[0].upp });
      r.sold_as = packs[0].soldAs; r.units_per_pack = packs[0].upp;
      counts.packFilled++; touched.add(String(r.po_id));
      if (packSamples.length < 10) packSamples.push(`filled ${r.supplier} ${r.order_id} ${r.asin}: ${packs[0].soldAs} ×${packs[0].upp} from Velocity`);
    }
    const afUpp = Number(r.units_per_pack) || 1;
    const comparable = r.sold_as !== null && r.sold_as !== "bundle";
    // One Velocity value for the row; when its lines disagree, the one that disagrees with AF (so the row flags).
    let vUpp: number | null = null;
    if (packs.length === 1) vUpp = packs[0].upp;
    else if (packs.length > 1 && comparable) vUpp = (packs.find((p) => p.upp !== afUpp) ?? packs[0]).upp;
    const stored = r.velocity_units_per_pack == null ? null : Number(r.velocity_units_per_pack);
    if (stored !== vUpp) { packOps.push({ id: String(r.id), value: vUpp }); counts.packVelocitySet++; touched.add(String(r.po_id)); }
    if (r.sold_as === null) counts.packMissing++;
    else if (comparable && vUpp != null && vUpp !== afUpp) {
      counts.packMismatch++;
      if (packSamples.length < 10) packSamples.push(`mismatch ${r.supplier} ${r.order_id} ${r.asin}: AF ${r.sold_as} ×${afUpp}, Velocity ×${vUpp}`);
    }
  }
  type RowPlan = { poAsinId: string; shipmentId: string; units: number; upp: number; shippedAt: string | null; lines: string[] };
  const rowPlans = new Map<string, RowPlan>();
  type UnmatchedPlan = { shipmentId: string; orderId: string; line: any; reason: "no_order" | "po_not_found"; candidates: MatchCandidate[] | null; miss: string | null };
  const unmatchedPlans = new Map<string, UnmatchedPlan>();
  const resolvedNow = new Map<string, string>(); // unmatched rows whose line now resolves by rule → how
  // Lines the main pass could not place: settled after it, once every other placement is known (§3 b, §4).
  type Deferred = { key: string; shipmentId: string; shippedAt: string | null; line: VelocityInboundOrder; res: Extract<Resolution, { ok: false }>; prior: any; units: number };
  const deferred: Deferred[] = [];
  // Units-pass links (§3 b, §4), recorded on shipment_unmatched like a picker link.
  const linkPlans: Array<{ key: string; shipmentId: string; orderId: string; line: any; reason: "no_order" | "po_not_found"; poAsinId: string; poId: string; how: "base_id" | "candidate"; units: number }> = [];
  const noteRuleLink = (s: { shipment_id: string }, shippedAt: string | null, line: VelocityInboundOrder, row: AfAsinRow, how: string, units: number, wasUnmatched: boolean) => {
    const vDate = velocityDate(line);
    ruleLinks.push({ shipment: s.shipment_id, shippedAt, orderId: String(line.order_id ?? ""), orderNumber: String(line.order_number ?? ""), retailer: String(line.retailer ?? ""), asin: String(line.asin ?? ""), units, how,
      poAsinId: String(row.id), poOrderId: row.order_id, supplier: row.supplier, poDate: String(row.order_date).slice(0, 10), vDate, days: vDate ? dayDiff(String(row.order_date), vDate) : null, wasUnmatched });
  };
  type ManualLine = { rows: PinRow[]; units: number; shippedAt: string | null; label: string };
  const manualLines = new Map<string, ManualLine>();

  // Home POs a Velocity order resolved to (2026-11-07): PO id → the Velocity orders, for Review Velocity.
  const homeHits = new Map<string, Set<string>>();
  const noteHome = (row: AfAsinRow, line: VelocityInboundOrder) => {
    if (row.ships_to !== "home") return;
    const l = line as any;
    const label = l.id != null && String(l.id) !== "" ? `#${l.id}` : String(line.order_number ?? "").trim() || String(line.order_id ?? "").slice(0, 8);
    if (!homeHits.has(String(row.po_id))) homeHits.set(String(row.po_id), new Set());
    homeHits.get(String(row.po_id))!.add(label);
  };
  const unplacedPlans = new Map<string, { line: VelocityInboundOrder; reason: "no_order" | "po_not_found"; candidates: MatchCandidate[] | null; miss: string | null }>();

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
        if (prior && !prior.resolved_at) resolvedNow.set(String(prior.id), "pinned");
        const pk = pinKey(s.shipment_id, line.order_number, line.asin);
        const m = manualLines.get(pk) ?? { rows: pinRows, units: 0, shippedAt, label: `${s.shipment_id.slice(0, 8)} ${line.order_number ?? "?"} ${line.asin ?? "?"}` };
        m.units += num(line.quantity_shipped);
        manualLines.set(pk, m);
        continue;
      }
      const res: Resolution = linked(line) ?? priorLink(prior) ?? resolveLine(line, idx, childrenByOrderId, ctx);
      const units = num(line.quantity_shipped);
      if (!res.ok) { deferred.push({ key, shipmentId: s.shipment_id, shippedAt, line, res, prior, units }); continue; }
      counts.linesMatched++;
      if (res.how === "order_only") counts.linesMatchedOrderOnly++;
      if (res.how === "linked") counts.linesLinked++;
      noteHome(res.row, line);
      if (res.how === "alias") counts.linesMatchedAlias++;
      if (res.how === "normalized") counts.linesMatchedNormalized++;
      if (res.how === "alias" || res.how === "normalized") noteRuleLink(s, shippedAt, line, res.row, res.how, units, !!prior && !prior.resolved_at);
      if (prior && !prior.resolved_at) resolvedNow.set(String(prior.id), res.how);
      const rk = `${res.row.id}\u0000${s.shipment_id}`;
      const plan = rowPlans.get(rk) ?? { poAsinId: String(res.row.id), shipmentId: s.shipment_id, units: 0, upp: Number(res.row.units_per_pack) || 1, shippedAt, lines: [] };
      plan.units += units; plan.lines.push(`${res.row.supplier} ${res.row.order_id} ${res.row.asin} ${units}u`);
      rowPlans.set(rk, plan);
      if (samples.length < 10) samples.push(`${s.shipment_id.slice(0, 8)} ${shippedAt ?? "?"} · ${res.row.supplier} ${res.row.order_id} ${res.row.asin}: ${units} Individual units${res.how !== "exact" ? ` (${res.how})` : ""}`);
    }
  }

  // ── Units pass: §3 b base order #, then §4 candidates (oldest Velocity order first) ──
  // Units already on each row: every line placed above (component units) and
  // the rows assigned or entered by hand.
  const placedUnits = new Map<string, number>();
  const addPlaced = (rowId: string, u: number) => placedUnits.set(rowId, (placedUnits.get(rowId) ?? 0) + u);
  for (const plan of Array.from(rowPlans.values())) addPlaced(plan.poAsinId, plan.units);
  // Shipment rows store Individual units since migration 101 (D17): what is placed is what they hold.
  for (const m of Array.from(manualLines.values())) for (const r of m.rows) addPlaced(r.poAsinId, r.qty);
  for (const r of (await db.query(`SELECT po_asin_id, qty_shipped FROM po_asin_shipments WHERE source = 'manual'`)).rows as any[]) {
    const row = afById.get(String(r.po_asin_id)); if (row) addPlaced(String(r.po_asin_id), Number(r.qty_shipped));
  }
  const byVelocityDate = (a: Deferred, b: Deferred) => String(velocityDate(a.line) ?? "9999").localeCompare(String(velocityDate(b.line) ?? "9999")) || String(a.line.order_id ?? "").localeCompare(String(b.line.order_id ?? "")) || a.key.localeCompare(b.key);
  const remainingFor = (line: VelocityInboundOrder) => { const upp = velocityPack(line)?.upp ?? null; return (row: AfAsinRow) => capacityUnits(row, upp) - (placedUnits.get(String(row.id)) ?? 0); };
  const linkLines = (lines: Deferred[], row: AfAsinRow, how: "base_id" | "candidate") => {
    addPlaced(String(row.id), lines.reduce((t, d) => t + d.units, 0));
    for (const d of lines) {
      counts.linesMatched++;
      if (how === "base_id") counts.linesMatchedBaseId++; else counts.linesMatchedCandidate++;
      const rk = `${row.id}\u0000${d.shipmentId}`;
      const plan = rowPlans.get(rk) ?? { poAsinId: String(row.id), shipmentId: d.shipmentId, units: 0, upp: Number(row.units_per_pack) || 1, shippedAt: d.shippedAt, lines: [] };
      plan.units += d.units; plan.lines.push(`${row.supplier} ${row.order_id} ${row.asin} ${d.units}u (${how})`);
      rowPlans.set(rk, plan);
      linkPlans.push({ key: d.key, shipmentId: d.shipmentId, orderId: String(d.line.order_id ?? ""), line: d.line, reason: d.res.reason, poAsinId: String(row.id), poId: String(row.po_id), how, units: d.units });
      noteRuleLink({ shipment_id: d.shipmentId }, d.shippedAt, d.line, row, how, d.units, !!d.prior && !d.prior.resolved_at);
      if (samples.length < 10) samples.push(`${d.shipmentId.slice(0, 8)} ${d.shippedAt ?? "?"} · ${row.supplier} ${row.order_id} ${row.asin}: ${d.units} Individual units (${how})`);
    }
  };
  const rest: Deferred[] = [...deferred].sort(byVelocityDate);
  // One decision per Velocity order: its split shipments go to one row.
  const groups = new Map<string, Deferred[]>();
  for (const d of rest) { const g = String(d.line.order_id ?? "") || d.key; if (!groups.has(g)) groups.set(g, []); groups.get(g)!.push(d); }
  for (const g of Array.from(groups.values()).sort((a, b) => byVelocityDate(a[0], b[0]))) {
    const first = g[0];
    const asin = String(first.line.asin ?? "").trim().toUpperCase();
    const units = g.reduce((t, d) => t + d.units, 0);
    const remaining = remainingFor(first.line);
    const ret: RetailerResolution = resolveRetailer(first.res.retailer, ctx.aliases, ctx.suppliers);
    const orderNumber = first.res.orderNumber;
    let row: AfAsinRow | null = null; let how: "base_id" | "candidate" | null = null;
    let cands: MatchCandidate[] = [];
    let miss: string | null = null;
    // §3 b: base order #, exactly one row, units fit.
    const base = orderNumber ? baseKeyRows(orderNumber, asin, ret, ctx.ki) : [];
    if (base.length === 1) {
      if (remaining(base[0]) + 1e-9 >= units) { row = base[0]; how = "base_id"; }
      else miss = miss ?? `base PO ${base[0].order_id} (${base[0].supplier}) has ${round2(Math.max(0, remaining(base[0])))} Individual units left, the line needs ${units} — the ${orderNumber} PO may be missing from AF`;
    }
    if (miss == null && orderNumber) {
      // The line's own order # names a PO the eligibility rule excludes — say so.
      const hit = matchFullKey(orderNumber, asin, ret, kiAll) ?? baseKeyRows(orderNumber, asin, ret, kiAll)[0] ?? null;
      const why = hit ? velocityIneligible(hit, velocityStart) : null;
      if (hit && why) miss = `PO ${hit.order_id} (${hit.supplier}) ${ineligibleText(why, velocityStart)} — not offered`;
    }
    // §4: candidates.
    if (!row) {
      const ranked = rankCandidates({ asin, retailer: ret, units, vDate: velocityDate(first.line), orderNumber }, ctx.ki, remaining);
      if (ranked.candidates.length === 1) { row = ranked.candidates[0].row; how = "candidate"; }
      else if (ranked.candidates.length > 1) { cands = ranked.candidates.slice(0, 5).map(({ row: _r, ...c }) => c); counts.linesCandidateAmbiguous += g.length; }
      else miss = miss ?? ranked.miss;
    }
    if (row && how) { linkLines(g, row, how); continue; }
    if (cands.length === 0 && miss == null) miss = nearestMiss({ asin, retailer: ret, units, vDate: velocityDate(first.line), orderNumber }, ctx.ki, remaining);
    for (const d of g) {
      if (d.res.reason === "no_order") counts.linesNoOrder++; else counts.linesPoNotFound++;
      unmatchedPlans.set(d.key, { shipmentId: d.shipmentId, orderId: String(d.line.order_id ?? ""), line: d.line, reason: d.res.reason, candidates: cands.length > 0 ? cands : null, miss });
      unmatched.push({ shipment: d.shipmentId, shippedAt: d.shippedAt, orderId: String(d.line.order_id ?? ""), orderNumber: d.res.orderNumber, retailer: d.res.retailer, asin: String(d.line.asin ?? ""), units: d.units, reason: d.res.reason, note: d.res.note, candidates: cands.length > 0 ? cands : undefined, miss, vDate: velocityDate(d.line) });
    }
  }

  // ── Row diff ───────────────────────────────────────────────────────────────
  type RowOp = { kind: "insert" | "update"; plan: RowPlan; qty: number; id?: string };
  const rowOps: RowOp[] = [];
  for (const [rk, plan] of Array.from(rowPlans.entries())) {
    // Stored as Individual units (D17): no ÷ pack any more — the view shows the ASIN units.
    const qty = round2(plan.units);
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
      const qty = round2(m.units);
      if (Math.abs(r.qty - qty) > 1e-9 || String(r.shippedAt ?? "") !== String(m.shippedAt ?? "")) {
        rowOps.push({ kind: "update", plan: { poAsinId: r.poAsinId, shipmentId: "", units: m.units, upp, shippedAt: m.shippedAt, lines: [m.label] }, qty, id: r.id });
        counts.rowsUpdated++; touched.add(afById.get(r.poAsinId)!.po_id);
      } else counts.rowsUnchanged++;
      continue;
    }
    const heldUnits = m.rows.reduce((t, r) => t + r.qty, 0);
    if (Math.abs(heldUnits - m.units) > 1e-6) {
      counts.manualSplitDrift++;
      if (samples.length < 10) samples.push(`${m.label}: split by hand over ${m.rows.length} rows holding ${round2(heldUnits)} units; Velocity now says ${m.units} — not rewritten`);
    } else counts.rowsUnchanged += m.rows.length;
  }
  for (const [key] of Array.from(unmatchedPlans.entries())) if (!unmatchedByKey.has(key)) counts.unmatchedNew++;
  counts.unmatchedResolved = resolvedNow.size + linkPlans.filter((l) => { const p = unmatchedByKey.get(l.key); return p && !p.resolved_at; }).length;

  // ── qty_at_prep (§3.3, D6) and received_velocity (2026-11-02): one live line per Velocity order; inbound > inventory > newest shipment ──
  // Received by Velocity = Σ quantity_received over the same lines — Velocity's
  // cumulative check-in count, order-level (identical on every shipment's line
  // of the order; a fully shipped order keeps it in the shipment detail) —
  // ÷ AF's units_per_pack, never capped at Ordered (over-receipt stays
  // visible); NULL when no Velocity line references the key, like At Prep.
  const orderLine = new Map<string, VelocityInboundOrder>();
  const shipmentsNewestFirst = [...shipments].sort((a, b) => (parseTs(b.shipped_at)?.getTime() ?? 0) - (parseTs(a.shipped_at)?.getTime() ?? 0));
  for (const s of shipmentsNewestFirst) for (const line of details.get(s.shipment_id)!.orders) { const oid = String(line.order_id ?? ""); if (oid && !orderLine.has(oid)) orderLine.set(oid, { ...line, __shipment_id: s.shipment_id } as any); }
  // A partly shipped order is read from the list legs; it keeps its newest shipment id so hand pins and picker links still apply.
  const keepSid = (o: VelocityInboundOrder) => { const oid = String(o.order_id ?? ""); if (!oid) return; const sid = (orderLine.get(oid) as any)?.__shipment_id; orderLine.set(oid, sid ? ({ ...o, __shipment_id: sid } as any) : o); };
  for (const o of inventory) keepSid(o);
  for (const o of inbound) keepSid(o);
  const remainingByAsinRow = new Map<string, number>();
  const receivedByAsinRow = new Map<string, number>();
  for (const line of Array.from(orderLine.values())) {
    const sid = String((line as any).__shipment_id ?? "");
    const prior = sid ? unmatchedByKey.get(`${sid}\u0000${String(line.order_id ?? "")}`) : undefined;
    const res: Resolution = (sid ? pinned(sid, line) : null) ?? linked(line)
      ?? priorLink(prior) ?? resolveLine(line, idx, childrenByOrderId, ctx);
    if (!res.ok) {
      // Never shipped and placed nowhere: "Velocity orders with no PO" (a shipped line is on the shipment list already).
      if (!sid) {
        const asin = String(line.asin ?? "").trim().toUpperCase();
        const units = num(line.quantity);
        const ret = resolveRetailer(res.retailer, ctx.aliases, ctx.suppliers);
        const input = { asin, retailer: ret, units, vDate: velocityDate(line), orderNumber: res.orderNumber };
        const ranked = rankCandidates(input, ctx.ki, remainingFor(line));
        const candidates = ranked.candidates.slice(0, 5).map(({ row: _r, ...c }) => c);
        unplacedPlans.set(String(line.order_id ?? ""), { line, reason: res.reason, candidates: candidates.length > 0 ? candidates : null, miss: candidates.length > 0 ? null : (res.note ?? ranked.miss ?? nearestMiss(input, ctx.ki, remainingFor(line))) });
      }
      continue;
    }
    noteHome(res.row, line);
    remainingByAsinRow.set(String(res.row.id), (remainingByAsinRow.get(String(res.row.id)) ?? 0) + num(line.quantity_remaining));
    receivedByAsinRow.set(String(res.row.id), (receivedByAsinRow.get(String(res.row.id)) ?? 0) + num(line.quantity_received));
  }
  const atPrepOps: Array<{ id: string; poId: string; value: number | null }> = [];
  for (const r of afRows) {
    const has = remainingByAsinRow.has(String(r.id));
    const next = has ? round2(remainingByAsinRow.get(String(r.id))!) : null; // Individual units (D17)
    const cur = r.qty_at_prep == null ? null : Number(r.qty_at_prep);
    const same = (cur == null && next == null) || (cur != null && next != null && Math.abs(cur - next) < 1e-9);
    if (same) { counts.atPrepUnchanged++; continue; }
    atPrepOps.push({ id: String(r.id), poId: String(r.po_id), value: next });
    if (next == null) counts.atPrepCleared++; else counts.atPrepSet++;
    touched.add(String(r.po_id));
  }
  const receivedOps: VelocitySyncResult["receivedVelocityOps"] = [];
  for (const r of afRows) {
    const has = receivedByAsinRow.has(String(r.id));
    const next = has ? round2(receivedByAsinRow.get(String(r.id))!) : null; // Individual units (D17)
    const cur = r.received_velocity == null ? null : Number(r.received_velocity);
    const same = (cur == null && next == null) || (cur != null && next != null && Math.abs(cur - next) < 1e-9);
    if (same) { counts.receivedVelocityUnchanged++; continue; }
    receivedOps.push({ id: String(r.id), poId: String(r.po_id), orderId: String(r.order_id), supplier: String(r.supplier), asin: String(r.asin), from: cur, to: next });
    if (next == null) counts.receivedVelocityCleared++; else counts.receivedVelocitySet++;
    touched.add(String(r.po_id));
  }

  // Review Velocity "Velocity has an order for a Home PO": the Velocity orders per PO, NULL when none.
  const homeStored = new Map<string, string>((await db.query(`SELECT id, velocity_home_orders FROM purchase_orders WHERE velocity_home_orders IS NOT NULL`)).rows.map((r: any) => [String(r.id), String(r.velocity_home_orders)]));
  const homeOps: Array<{ poId: string; value: string | null; wasNull: boolean }> = [];
  for (const [poId, set] of Array.from(homeHits.entries())) {
    const value = Array.from(set).sort().join(", ");
    if (homeStored.get(poId) !== value) homeOps.push({ poId, value, wasNull: !homeStored.has(poId) });
  }
  for (const poId of Array.from(homeStored.keys())) if (!homeHits.has(poId)) homeOps.push({ poId, value: null, wasNull: false });
  counts.homeOrders = homeHits.size;
  counts.unplacedOrders = unplacedPlans.size;
  for (const l of linkPlans) touched.add(l.poId);
  counts.posTouched = touched.size;
  const result: VelocitySyncResult = {
    dryRun: opts.dryRun, wrote: false, counts, samples, packSamples, unmatched, ruleLinks, receivedVelocityOps: receivedOps, touchedPoIds: Array.from(touched),
    homeOrders: Array.from(homeHits.entries()).map(([poId, set]) => ({ poId, orders: Array.from(set).sort() })),
    unplacedOrders: Array.from(unplacedPlans.entries()).map(([orderId, u]) => ({ orderId, orderNumber: String(u.line.order_number ?? ""), retailer: String(u.line.retailer ?? ""), asin: String(u.line.asin ?? ""), units: num(u.line.quantity), reason: u.reason, candidates: u.candidates ?? undefined, miss: u.miss })),
  };
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
        `INSERT INTO shipment_unmatched (velocity_shipment_id, velocity_order_id, line, reason, candidates, nearest_miss)
         VALUES ($1, $2, $3::jsonb, $4, $5::jsonb, $6)
         ON CONFLICT (velocity_shipment_id, velocity_order_id) DO UPDATE SET line = EXCLUDED.line, reason = EXCLUDED.reason, candidates = EXCLUDED.candidates, nearest_miss = EXCLUDED.nearest_miss`,
        [u.shipmentId, u.orderId, JSON.stringify(u.line), u.reason, u.candidates ? JSON.stringify(u.candidates) : null, u.miss],
      );
    }
    for (const [id, how] of Array.from(resolvedNow.entries())) {
      await client.query(`UPDATE shipment_unmatched SET resolved_at = $2, match_reason = COALESCE(match_reason, $3) WHERE id = $1 AND resolved_at IS NULL`, [id, now, how]);
    }
    // §3 b / §4 links: recorded like a picker link so later runs keep them; one edit-log row each.
    for (const l of linkPlans) {
      const prior = unmatchedByKey.get(l.key);
      if (prior?.resolved_at) continue;
      const reason = l.how === "candidate" ? "candidate_unique" : l.how;
      await client.query(
        `INSERT INTO shipment_unmatched (velocity_shipment_id, velocity_order_id, line, reason, resolved_at, resolved_po_asin_id, match_reason)
         VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7)
         ON CONFLICT (velocity_shipment_id, velocity_order_id) DO UPDATE SET line = EXCLUDED.line, resolved_at = EXCLUDED.resolved_at,
           resolved_po_asin_id = EXCLUDED.resolved_po_asin_id, match_reason = EXCLUDED.match_reason, candidates = NULL, nearest_miss = NULL`,
        [l.shipmentId, l.orderId, JSON.stringify(l.line), l.reason, now, l.poAsinId, reason],
      );
      await logEdits(client.query.bind(client), l.poId, null, "shipment", l.poAsinId, [{
        field: "link", old: null,
        new: `Velocity ${String(l.line.order_number ?? "") || "(no Order #)"} ${String(l.line.asin ?? "")} ${l.units}u, shipment ${l.shipmentId.slice(0, 8)} (${reason})`,
      }]);
    }
    for (const op of atPrepOps) await client.query(`UPDATE po_asins SET qty_at_prep = $2 WHERE id = $1`, [op.id, op.value]);
    for (const op of receivedOps) await client.query(`UPDATE po_asins SET received_velocity = $2 WHERE id = $1`, [op.id, op.to]);
    for (const op of fillOps) {
      const r = await client.query(`UPDATE po_asins SET sold_as = $2, units_per_pack = $3 WHERE id = $1 AND sold_as IS NULL`, [op.id, op.soldAs, op.upp]);
      if ((r as any).rowCount === 0) continue; // filled by hand since the read
      await logEdits(client.query.bind(client), op.poId, null, "asin", op.id, [
        { field: "sold_as", old: null, new: op.soldAs },
        ...(op.from.units_per_pack === op.upp ? [] : [{ field: "units_per_pack", old: op.from.units_per_pack == null ? null : String(op.from.units_per_pack), new: String(op.upp) }]),
      ]);
    }
    for (const op of packOps) await client.query(`UPDATE po_asins SET velocity_units_per_pack = $2 WHERE id = $1`, [op.id, op.value]);
    // "Velocity orders with no PO": rewritten each run; a dismissal stays while the order is listed.
    const unplacedIds = Array.from(unplacedPlans.keys());
    await client.query(`DELETE FROM velocity_orders_unplaced WHERE NOT (velocity_order_id = ANY($1::text[]))`, [unplacedIds]);
    for (const [oid, u] of Array.from(unplacedPlans.entries())) {
      await client.query(
        `INSERT INTO velocity_orders_unplaced (velocity_order_id, line, reason, candidates, nearest_miss) VALUES ($1, $2::jsonb, $3, $4::jsonb, $5)
         ON CONFLICT (velocity_order_id) DO UPDATE SET line = EXCLUDED.line, reason = EXCLUDED.reason, candidates = EXCLUDED.candidates, nearest_miss = EXCLUDED.nearest_miss`,
        [oid, JSON.stringify(u.line), u.reason, u.candidates ? JSON.stringify(u.candidates) : null, u.miss],
      );
    }
    // Home POs: a new finding reopens a hand clear; none left → cleared.
    for (const op of homeOps) {
      await client.query(
        `UPDATE purchase_orders SET velocity_home_orders = $2, velocity_home_cleared_at = CASE WHEN $3 OR $2::text IS NULL THEN NULL ELSE velocity_home_cleared_at END WHERE id = $1`,
        [op.poId, op.value, op.wasNull],
      );
    }
    // Review Velocity follows (every flagged PO: a ships_to corrected by hand since the last run clears it here).
    await reconcileReviewVelocity(client.query.bind(client), Array.from(new Set([...homeOps.map((o) => o.poId), ...Array.from(homeHits.keys())])));
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
