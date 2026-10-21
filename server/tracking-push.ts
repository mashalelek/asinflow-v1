// Tracking → Velocity (SPEC §26; patch po-tracking-velocity §7, §9). The push
// half of "Sync tracking" / the 00:00 component po_tracking_push.
//
// D1: tracking-only — never creates a Velocity order, never changes a
// quantity, item or status. Only adds tracking numbers to existing inbound
// orders. Cost privacy unchanged: nothing but carrier + tracking leaves AF.
//
// Per matched row, routing (tracking-route-rules.ts) decides push / held /
// review. Target set for a PO = every GET /inbound order whose order number
// (trimmed; bundle parents through their children) equals the PO's order_id,
// status "inbound", unit_status pending / partially_received. Push to EVERY
// order in the set. Echo-merge per order, re-read with GET /inbound/:id
// immediately before its PUT: trackingNumbers = the order's existing
// trackings + the PO's numbers not already there (by tracking_number); every
// other field echoed from the fresh read (PUT is full-replace, SPEC §11).
// Never removes an entry. Idempotent: every target already has the number →
// pushed, no PUT; partial coverage → PUT only the missing orders. Any PUT
// error → push_failed with the error; the other orders still get theirs.
import { fetchAllInboundOrders, fetchAllKnownOrders, getInboundOrder, updateInboundOrder, type VelocityInboundOrder } from "./velocity-api";
import { routeTracking, joinReasons, type ShipsTo } from "./tracking-route-rules";
import { isPlaceholder } from "./tracking-ingest";
import type { QueryLike } from "./scheduler/types";

export const CARRIER_MAP_KEY = "tracking.carrier_map";
const INBOUND_UNIT_STATUSES = new Set(["pending", "partially_received"]);

/**
 * The element shape PUT /inbound/:id accepts in trackingNumbers — PLAIN
 * STRINGS. Settled by the commit-5 probe, 2026-10-21, on order be85fad3…
 * (PO 4798028553): an object element {carrier, tracking_number} is refused
 * with HTTP 400 "unhashable type: 'dict'" (nothing written); strings land and
 * GET returns them as [{tracking_number}] — Velocity stores no carrier for
 * them. Existing GET objects are re-sent as their tracking_number strings.
 */
export type TrackingElementShape = "object" | "string";
export let TRACKING_ELEMENT_SHAPE: TrackingElementShape = "string";

export interface VelocityDeps {
  /** GET /inbound — the push targets. */
  list: () => Promise<VelocityInboundOrder[]>;
  /** Every order Velocity has (inbound ∪ inventory ∪ shipments) — "is the PO in Velocity at all" (stop b). */
  known: () => Promise<VelocityInboundOrder[]>;
  get: (orderId: string) => Promise<VelocityInboundOrder>;
  put: (orderId: string, body: Record<string, any>) => Promise<any>;
}
export const realVelocityDeps: VelocityDeps = { list: fetchAllInboundOrders, known: fetchAllKnownOrders, get: getInboundOrder, put: updateInboundOrder };

/** Pure: every order number Velocity knows (own + bundle children), any lifecycle. */
export function knownOrderNumbers(orders: readonly VelocityInboundOrder[]): Set<string> {
  const s = new Set<string>();
  for (const o of orders) {
    const own = String(o.order_number ?? "").trim();
    if (own) s.add(own);
    for (const c of o.bundle_children ?? []) { const n = String(c?.order_number ?? "").trim(); if (n) s.add(n); }
  }
  return s;
}

/** Pure: Velocity's inbound orders, indexed by the PO order number they belong to (bundles through their children). */
export function indexInbound(orders: readonly VelocityInboundOrder[]): Map<string, VelocityInboundOrder[]> {
  const by = new Map<string, VelocityInboundOrder[]>();
  for (const o of orders) {
    if (String(o.status ?? "").toLowerCase() !== "inbound") continue;
    if (!INBOUND_UNIT_STATUSES.has(String(o.unit_status ?? "").toLowerCase())) continue;
    const nums = new Set<string>();
    const own = String(o.order_number ?? "").trim();
    if (own) nums.add(own);
    for (const c of o.bundle_children ?? []) { const n = String(c?.order_number ?? "").trim(); if (n) nums.add(n); }
    for (const n of Array.from(nums)) { const l = by.get(n) ?? []; l.push(o); by.set(n, l); }
  }
  return by;
}

export const trackingNumbersOf = (o: Pick<VelocityInboundOrder, "trackings">): string[] =>
  (Array.isArray(o.trackings) ? o.trackings : []).map((t: any) => String(typeof t === "string" ? t : t?.tracking_number ?? "").trim().toUpperCase()).filter(Boolean);

export const trackingElement = (carrier: string, trackingNumber: string, shape: TrackingElementShape = TRACKING_ELEMENT_SHAPE): any =>
  shape === "string" ? trackingNumber : { carrier, tracking_number: trackingNumber };

/** Existing entries re-sent in the PUT shape (a GET object becomes a string when the PUT wants strings). */
const echoElement = (t: any, shape: TrackingElementShape): any =>
  shape === "string" ? String(typeof t === "string" ? t : t?.tracking_number ?? "") : (typeof t === "string" ? { carrier: "", tracking_number: t } : { carrier: t?.carrier ?? "", tracking_number: t?.tracking_number ?? "" });

/**
 * Pure: the echo-merge PUT body — the order's CURRENT values for the
 * documented-safe set (as the reconcile execute does, routes.ts), with
 * trackingNumbers = existing + additions. Never quantities changed, never
 * cogs / list price (cost privacy), fulfilledBy echoed verbatim.
 */
/**
 * Pure: the order date in the form the reconcile PUTs have always echoed
 * (the list's MM/DD/YYYY). GET /inbound/:id serializes it RFC-1123
 * ("Fri, 09 Oct 2026 00:00:00 GMT") — read in UTC so it cannot slip a day.
 */
export function velocityDate(d: unknown): string {
  const s = String(d ?? "").trim();
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) return s;
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return s;
  const x = new Date(t);
  return `${String(x.getUTCMonth() + 1).padStart(2, "0")}/${String(x.getUTCDate()).padStart(2, "0")}/${x.getUTCFullYear()}`;
}

export function buildTrackingPutBody(current: VelocityInboundOrder, additions: Array<{ carrier: string; tracking_number: string }>, shape: TrackingElementShape = TRACKING_ELEMENT_SHAPE): Record<string, any> {
  const existing = Array.isArray(current.trackings) ? current.trackings : [];
  const have = new Set(trackingNumbersOf(current));
  const add = additions.filter((a) => !have.has(a.tracking_number.toUpperCase()));
  return {
    date: velocityDate(current.date),
    retailer: current.retailer ?? "",
    orderNumber: String(current.order_number ?? ""),
    itemName: current.item_name ?? "",
    asin: current.asin,
    amazonSKU: current.amazon_sku ?? "",
    sold_as: current.sold_as ?? "",
    units_per_pack: current.units_per_pack ?? null,
    quantity: current.quantity,
    fulfilledBy: (current as any).fulfillment_type,
    trackingNumbers: [...existing.map((t: any) => echoElement(t, shape)), ...add.map((a) => trackingElement(a.carrier, a.tracking_number, shape))],
  };
}

export interface PoPushPlan {
  po_id: string; order_id: string; bundle_orders?: string[];
  rows: Array<{ id: number; tracking_number: string; decision: "push" | "held" | "review" | "received_by_velocity"; reasons: string[] }>;
  targets: Array<{ velocity_order_id: string; asin: string; already: string[]; to_add: string[] }>;
}
export interface PushResult {
  rows_evaluated: number; pushed: number; already_present: number; push_failed: number; held: number; review: number;
  /** PO already received / shipped by Velocity — past the push window, no warning (stop b). */
  received_by_velocity: number;
  puts: number; put_errors: number;
  plans: PoPushPlan[];
}

interface RowFacts {
  id: number; po_id: string; carrier: string; tracking_number: string; ship_to_street: string | null; status: string;
  order_id: string; ships_to: ShipsTo; canceled_or_returned: boolean; pushed_velocity_ids: string[] | null;
}

async function loadRows(query: QueryLike, poId?: string): Promise<RowFacts[]> {
  const r = await query(
    `SELECT t.id, t.po_id, t.carrier, t.tracking_number, t.ship_to_street, t.status, t.pushed_velocity_ids,
            p.order_id, p.ships_to,
            (EXISTS (SELECT 1 FROM po_line_items l WHERE l.po_id = p.id)
              AND NOT EXISTS (SELECT 1 FROM po_line_items l WHERE l.po_id = p.id
                               AND COALESCE(l.qty_canceled, 0) + COALESCE(l.qty_returned, 0) < COALESCE(l.qty_ordered, 0))) AS canceled_or_returned
       FROM po_tracking t JOIN purchase_orders p ON p.id = t.po_id
      WHERE t.status IN ('matched', 'pushed', 'push_failed', 'held') AND t.tracking_number NOT LIKE 'email:%'
        ${poId ? "AND t.po_id = $1" : ""}
      ORDER BY t.po_id, t.id`,
    poId ? [poId] : [],
  );
  return r.rows.map((x: any) => ({ ...x, id: Number(x.id), po_id: String(x.po_id), canceled_or_returned: x.canceled_or_returned === true }));
}

async function loadSettings(query: QueryLike): Promise<{ velocityStreet: string; homeStreets: string[]; carrierMap: Record<string, string> }> {
  const rows = (await query(`SELECT key, value FROM settings WHERE key = ANY($1::text[])`, [["tracking.velocity_street", "tracking.home_streets", CARRIER_MAP_KEY]])).rows;
  const v = (k: string) => rows.find((r: any) => r.key === k)?.value;
  return { velocityStreet: String(v("tracking.velocity_street") ?? "805 grandy"), homeStreets: (v("tracking.home_streets") as string[]) ?? ["65 rivercrest"], carrierMap: (v(CARRIER_MAP_KEY) as Record<string, string>) ?? {} };
}

/** Evaluate every matched row; push (or, dry run, only plan). */
export async function pushTracking(opts: { query: QueryLike; deps?: VelocityDeps; dryRun?: boolean; poId?: string; log?: (m: string) => void }): Promise<PushResult> {
  const deps = opts.deps ?? realVelocityDeps;
  const settings = await loadSettings(opts.query);
  const rows = await loadRows(opts.query, opts.poId);
  const res: PushResult = { rows_evaluated: rows.length, pushed: 0, already_present: 0, push_failed: 0, held: 0, review: 0, received_by_velocity: 0, puts: 0, put_errors: 0, plans: [] };
  if (rows.length === 0) return res;
  // Both reads fail closed: a partial Velocity read would make POs look
  // never-uploaded (the coverage tripwires in velocity-api throw instead).
  const inbound = indexInbound(await deps.list());
  const known = knownOrderNumbers(await deps.known());
  const byPo = new Map<string, RowFacts[]>();
  for (const r of rows) { const l = byPo.get(r.po_id) ?? []; l.push(r); byPo.set(r.po_id, l); }

  for (const [poId, list] of Array.from(byPo.entries())) {
    const orderId = String(list[0].order_id).trim();
    const all = inbound.get(orderId) ?? [];
    // A bundle parent's PUT is unverified (full-replace could drop its
    // children): never written — the row asks for a hand push instead.
    const bundles = all.filter((o) => String(o.sold_as ?? "").toLowerCase() === "bundle");
    const targets = all.filter((o) => String(o.sold_as ?? "").toLowerCase() !== "bundle");
    const plan: PoPushPlan = { po_id: poId, order_id: orderId, rows: [], targets: [], ...(bundles.length ? { bundle_orders: bundles.map((b) => b.order_id) } : {}) };
    const toPush: RowFacts[] = [];
    for (const row of list) {
      const d = routeTracking({
        velocity: all.length > 0 ? "inbound" : known.has(orderId) ? "known" : "absent", emailStreet: row.ship_to_street, shipsTo: (row.ships_to === "home" ? "home" : "velocity"),
        velocityStreet: settings.velocityStreet, homeStreets: settings.homeStreets, poCanceledOrReturned: row.canceled_or_returned,
      });
      const decision = d.push ? "push" : d.held ? "held" : d.reasons.length ? "review" : "received_by_velocity";
      if (d.push && bundles.length > 0) d.reasons.push(`bundle order in Velocity (${bundles.map((b) => b.order_id).join(", ")}) — add tracking by hand`);
      plan.rows.push({ id: row.id, tracking_number: row.tracking_number, decision, reasons: d.reasons });
      if (d.push) toPush.push(row);
      else if (!opts.dryRun) {
        await opts.query(
          `UPDATE po_tracking SET status = $2, review_reason = $3, updated_at = NOW() WHERE id = $1`,
          [row.id, d.held ? "held" : "matched", joinReasons(d.reasons)],
        );
      }
      if (d.held) res.held++; else if (decision === "review") res.review++; else if (decision === "received_by_velocity") res.received_by_velocity++;
    }
    // Targets: what each order already has and what it needs.
    const additions = toPush.map((r) => ({ id: r.id, carrier: settings.carrierMap[r.carrier] ?? r.carrier, tracking_number: r.tracking_number.toUpperCase() }));
    const errors = new Map<number, string>();
    const landed = new Map<number, Set<string>>();
    for (const t of targets) {
      const have = new Set(trackingNumbersOf(t));
      const missing = additions.filter((a) => !have.has(a.tracking_number));
      plan.targets.push({ velocity_order_id: t.order_id, asin: t.asin, already: additions.filter((a) => have.has(a.tracking_number)).map((a) => a.tracking_number), to_add: missing.map((a) => a.tracking_number) });
      for (const a of additions) if (have.has(a.tracking_number)) (landed.get(a.id) ?? landed.set(a.id, new Set()).get(a.id)!).add(t.order_id);
      if (missing.length === 0 || opts.dryRun) continue;
      try {
        const fresh = await deps.get(t.order_id); // re-read immediately before the PUT
        const freshHave = new Set(trackingNumbersOf(fresh));
        const still = missing.filter((a) => !freshHave.has(a.tracking_number));
        if (still.length > 0) {
          await deps.put(t.order_id, buildTrackingPutBody(fresh, still.map((a) => ({ carrier: a.carrier, tracking_number: a.tracking_number }))));
          res.puts++;
        }
        for (const a of missing) (landed.get(a.id) ?? landed.set(a.id, new Set()).get(a.id)!).add(t.order_id);
      } catch (err: any) {
        res.put_errors++;
        const msg = `${t.order_id}: ${err?.message ?? err}`;
        for (const a of missing) errors.set(a.id, errors.has(a.id) ? `${errors.get(a.id)}; ${msg}` : msg);
      }
    }
    for (const row of toPush) {
      const pr = plan.rows.find((x) => x.id === row.id)!;
      const reasons = [...pr.reasons];
      const err = errors.get(row.id);
      if (err) reasons.push(err);
      const covered = targets.length > 0 && !err && targets.every((t) => landed.get(row.id)?.has(t.order_id));
      const wasMissing = plan.targets.some((t) => t.to_add.includes(row.tracking_number.toUpperCase()));
      if (err) res.push_failed++;
      else if (covered && !wasMissing) res.already_present++;
      else if (covered) res.pushed++;
      if (opts.dryRun) continue;
      await opts.query(
        `UPDATE po_tracking SET status = $2, review_reason = $3, push_error = $4,
                pushed_at = CASE WHEN $2 = 'pushed' THEN COALESCE(pushed_at, NOW()) ELSE pushed_at END,
                pushed_velocity_ids = $5::text[], updated_at = NOW()
          WHERE id = $1`,
        [row.id, err ? "push_failed" : covered ? "pushed" : "matched", joinReasons(reasons), err ?? null, Array.from(landed.get(row.id) ?? [])],
      );
    }
    res.plans.push(plan);
  }
  opts.log?.(`push: ${res.rows_evaluated} rows, ${res.pushed} pushed, ${res.already_present} already present, ${res.push_failed} failed, ${res.held} held, ${res.review} review; ${res.puts} PUTs`);
  return res;
}

/** The probe / tests: set the element shape the PUT accepts. */
export function setTrackingElementShape(shape: TrackingElementShape): void { TRACKING_ELEMENT_SHAPE = shape; }
export { isPlaceholder };
