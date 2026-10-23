// Listing hygiene — close OOS listings (component 22) and delete long-dead
// listings (component 24). Patch docs/claude_spec-patch-listing-hygiene.md;
// SPEC §11 "Listing hygiene", §14 ownership, §18 born-closed. Decisions
// confirmed by Maria 2026-10-18/19.
//
// Per SKU, fail-closed, never in the reopen direction:
//   - every SKU in scope gets exactly one outcome (no "{} means fine");
//   - every candidate that fires — or would — gets a listing_actions row with
//     the full evidence snapshot;
//   - more than the breaker's N candidates in one run → nothing is written to
//     SC, every candidate is `held` until Release re-evaluates it live;
//   - LISTING_CLOSE_LIVE / LISTING_DELETE_LIVE unset → dry run (`would_*`,
//     dry_run = true, zero SC writes).
//
// Freshness ("this pass"). The decisions read stored state written by the
// components that own it, against the run that wrote it:
//   - inventory: the latest component-15 run must have succeeded within
//     FRESH_MS, and the SKU's sku_fba_inventory.observed_at must be from it
//     (else skip_no_fresh_inventory — "15 incomplete → zero closes");
//   - listing: the latest full-scope component-16 run must have succeeded
//     within FRESH_MS, and the SKU's listing_checked_at must be from it (else
//     skip_probe_transient — a transient ASIN keeps its old stamp).
// In a scheduled pass those runs are this job's own 15 and 16; the manual
// one-component job (POST /api/listing-hygiene/run) reads the latest pass.
//
// Before every SC write the SKU is re-read live (getListingsItem): the PATCH
// takes its productType from it, and a SKU that is already closed (close) or
// no longer closed (delete) is not written.
import { BUCKET_FIELDS, parseSkuBuckets, type BucketField, type SkuBuckets } from "./sku-fba-inventory";
import { parseListingState } from "./sku-listing-fetch";
import { isOfferClosed } from "./listing-closed";
import { closedEndAt, findForbiddenQuantityPaths } from "./offer-add";
import { loadAsinPipeline } from "./asin-po-pipeline";
import { fetchAllInboundOrders, fetchAllInventoryOrders, type VelocityInboundOrder } from "./velocity-api";
import { spApiGet, spApiPatch, spApiDelete } from "./spapi-auth";
import { COVERAGE_SETTING, todayEt } from "./ledger-sync";
import type { QueryLike } from "./scheduler/types";

const MARKETPLACE = "ATVPDKIKX0DER";

export type HygieneAction = "close" | "delete";

/** A component-15 / 16 run older than this is not "this pass". Hourly passes; 2 h covers one missed pass. */
export const FRESH_MS = 2 * 3600_000;
/** Tonight's 23 for the 00:00 pass; 26 h tolerates a late pass. */
export const LEDGER_FRESH_MS = 26 * 3600_000;
/** The ledger must reach back this far for the never-stocked branch to be trusted (18 months ≈ 548 days). */
export const LEDGER_REQUIRED_DAYS = 540;
/** …and be this recent (the report carries complete days only). */
export const LEDGER_MAX_LAG_DAYS = 2;
export const CLOCK_EVER_STOCKED_DAYS = 60;
export const CLOCK_NEVER_STOCKED_DAYS = 14;
/** Per-run breakers when settings has none (Maria 2026-10-21: close 50, delete 25; migration 065). */
export const DEFAULT_BREAKER: Record<HygieneAction, number> = { close: 50, delete: 25 };
/**
 * An accepted action not yet verified — of EITHER kind — suppresses any further
 * action on the SKU for this long (the next probe verifies it). Cross-kind on
 * purpose: CS-ZH3X-SXV9's DELETE (2026-10-20) read back open, end_at null, for
 * ~5½ min before the 404, which an hourly close pass would have taken as a
 * close candidate.
 */
export const PENDING_ACTION_MS = 3 * 3600_000;

/** Close: these buckets block. Unfulfillable and Researching do NOT (rule 2). */
export const CLOSE_BLOCKING: readonly BucketField[] = [
  "fulfillable", "inbound_working", "inbound_shipped", "inbound_receiving",
  "reserved_fc_transfer", "reserved_fc_processing", "reserved_customer", "future_supply",
];
/** Delete: every bucket blocks (rule 3). */
export const DELETE_BLOCKING: readonly BucketField[] = BUCKET_FIELDS;

const PENDING_SUBMISSION = new Set(["pending", "processing", "stale"]);
export const isAmznGr = (sku: string) => sku.toLowerCase().startsWith("amzn.gr.");

// ── Facts ─────────────────────────────────────────────────────────────────

export interface InventoryFacts extends Pick<SkuBuckets, BucketField> {
  observedAt: Date;
  lastNonzeroAt: Date | null;
}
export interface ListingFacts {
  checkedAt: Date | null;
  /** null with a checkedAt = probed, no listing (404 / empty summaries). */
  createdAt: Date | null;
  offerEndAt: Date | null;
  /** Live reads only (summaries BUYABLE); null = not known (component 16's stored state). */
  buyable?: boolean | null;
  /** The newest accepted / verified live close PATCH AF sent on the SKU. */
  closePatchAt?: Date | null;
}
export interface SkuFacts {
  sku: string;
  asin: string;
  /** Every ASIN in scope this SKU is recorded under (pipeline applies per ASIN). */
  asins: string[];
  listing: ListingFacts;
  inventory: InventoryFacts | null;
  /** The newest §19 submission row for the SKU is pending / processing / stale. */
  pendingSubmission: boolean;
  /** An accepted, unverified action — close OR delete — fired on this SKU recently. */
  actionPending: boolean;
  ledgerLastStocked: string | null;
  pipeline: { on_order: number; at_prep: number };
  /** Velocity units on hand for the SKU's ASIN(s) — delete only; null when not read. */
  velocityOnHand: number | null;
}

/** "This pass": when the runs the decision relies on started, or null when there is none fresh. */
export interface Basis {
  now: Date;
  inventoryFrom: Date | null;
  listingFrom: Date | null;
}

export interface Evaluation {
  outcome: string;
  candidate: boolean;
  evidence: Record<string, any>;
}

const dayMs = 86_400_000;
const etDate = (d: Date) => todayEt(d);
/** Whole days from an ET calendar date to today's ET date. */
export function daysSince(ymd: string, now: Date): number {
  return Math.round((Date.parse(`${todayEt(now)}T00:00:00Z`) - Date.parse(`${ymd}T00:00:00Z`)) / dayMs);
}

function bucketsOf(inv: InventoryFacts | null): Record<string, number> | null {
  if (!inv) return null;
  const o: Record<string, number> = {};
  for (const f of BUCKET_FIELDS) o[f] = inv[f];
  return o;
}

function baseEvidence(f: SkuFacts, b: Basis) {
  return {
    sku: f.sku, asins: f.asins,
    buckets: bucketsOf(f.inventory),
    inventory_observed_at: f.inventory?.observedAt?.toISOString() ?? null,
    inventory_last_nonzero_at: f.inventory?.lastNonzeroAt?.toISOString() ?? null,
    listing: {
      checked_at: f.listing.checkedAt?.toISOString() ?? null,
      created_at: f.listing.createdAt?.toISOString() ?? null,
      offer_end_at: f.listing.offerEndAt?.toISOString() ?? null,
    },
    basis: { inventory_from: b.inventoryFrom?.toISOString() ?? null, listing_from: b.listingFrom?.toISOString() ?? null, evaluated_at: b.now.toISOString() },
    pending_submission: f.pendingSubmission,
  };
}

const fresh = (at: Date | null | undefined, from: Date | null) => at != null && from != null && at.getTime() >= from.getTime();
// The closed test (listing-closed.ts): end_at's form + AF's own close PATCH; BUYABLE = open.
const isClosed = (l: ListingFacts, now: Date) => isOfferClosed({ endAt: l.offerEndAt, buyable: l.buyable, createdAt: l.createdAt, closePatchAt: l.closePatchAt }, now);
const hasListing = (l: ListingFacts) => l.createdAt != null;

/** Pure: the close decision for one SKU (rule 2). Pipeline stages are never read. */
export function evaluateClose(f: SkuFacts, b: Basis): Evaluation {
  const ev: Record<string, any> = { ...baseEvidence(f, b), blocking_buckets: CLOSE_BLOCKING };
  const out = (outcome: string, candidate = false): Evaluation => ({ outcome, candidate, evidence: { ...ev, outcome } });
  // The listing checks come first (2026-10-21): an amzn.gr SKU with no
  // listing reports skip_no_listing, like any other.
  if (!fresh(f.listing.checkedAt, b.listingFrom)) return out("skip_probe_transient");
  if (!hasListing(f.listing)) return out("skip_no_listing");
  // amzn.gr.* are never closed by 22 (rule 1) — only deleted by 24's amzn_gr rule.
  if (isAmznGr(f.sku)) return out("skip_amzn_gr");
  if (isClosed(f.listing, b.now)) return out("skip_already_closed");
  if (f.pendingSubmission) return out("skip_pending_submission");
  if (!f.inventory || !fresh(f.inventory.observedAt, b.inventoryFrom)) return out("skip_no_fresh_inventory");
  for (const k of CLOSE_BLOCKING) if (f.inventory[k] > 0) return out(`skip_has_stock:${k}`);
  if (f.actionPending) return out("skip_action_pending");
  return out("would_close", true);
}

export interface ClockResult { pass: boolean; days: number | null; threshold: number; branch: "ever_stocked" | "never_stocked"; last_stocked: string | null; created: string | null }

/** Pure: the OOS clock (rule 4). */
export function oosClock(f: Pick<SkuFacts, "ledgerLastStocked" | "inventory" | "listing">, now: Date): ClockResult {
  const inv = f.inventory?.lastNonzeroAt ? etDate(f.inventory.lastNonzeroAt) : null;
  const dates = [f.ledgerLastStocked, inv].filter((x): x is string => x != null).sort();
  const last = dates.length ? dates[dates.length - 1] : null;
  const created = f.listing.createdAt ? etDate(f.listing.createdAt) : null;
  if (last) {
    const days = daysSince(last, now);
    return { pass: days > CLOCK_EVER_STOCKED_DAYS, days, threshold: CLOCK_EVER_STOCKED_DAYS, branch: "ever_stocked", last_stocked: last, created };
  }
  if (!created) return { pass: false, days: null, threshold: CLOCK_NEVER_STOCKED_DAYS, branch: "never_stocked", last_stocked: null, created: null };
  const days = daysSince(created, now);
  return { pass: days > CLOCK_NEVER_STOCKED_DAYS, days, threshold: CLOCK_NEVER_STOCKED_DAYS, branch: "never_stocked", last_stocked: null, created };
}

/** Pure: the delete decision for one SKU (rule 3). Run-wide blockers (ledger / Velocity) are applied by the caller. */
export function evaluateDelete(f: SkuFacts, b: Basis): Evaluation {
  const ev: Record<string, any> = {
    ...baseEvidence(f, b), blocking_buckets: DELETE_BLOCKING,
    pipeline: { on_order: f.pipeline.on_order, at_prep: f.pipeline.at_prep, velocity_on_hand: f.velocityOnHand },
    ledger_last_stocked: f.ledgerLastStocked,
  };
  const out = (outcome: string, candidate = false, extra: Record<string, any> = {}): Evaluation =>
    ({ outcome, candidate, evidence: { ...ev, ...extra, outcome } });
  if (!fresh(f.listing.checkedAt, b.listingFrom)) return out("skip_probe_transient");
  if (!hasListing(f.listing)) return out("skip_no_listing");
  if (isAmznGr(f.sku)) return evaluateDeleteAmznGr(f, b, out);
  if (!isClosed(f.listing, b.now)) return out("skip_not_closed");
  if (!f.inventory || !fresh(f.inventory.observedAt, b.inventoryFrom)) return out("skip_no_fresh_inventory");
  for (const k of DELETE_BLOCKING) if (f.inventory[k] > 0) return out(`skip_has_stock:${k}`);
  if (f.pendingSubmission) return out("skip_pending_submission");
  if (f.pipeline.on_order > 0) return out("skip_pipeline:on_order");
  if (f.pipeline.at_prep > 0) return out("skip_pipeline:at_prep");
  if (f.velocityOnHand == null) return out("velocity_unavailable");
  if (f.velocityOnHand > 0) return out("skip_pipeline:velocity");
  const clock = oosClock(f, b.now);
  if (!clock.pass) return out(`skip_clock:${clock.days ?? "unknown"}/${clock.threshold}`, false, { clock });
  if (f.actionPending) return out("skip_action_pending", false, { clock });
  return out("would_delete", true, { clock });
}

/**
 * The amzn_gr delete rule (Maria 2026-10-21): an amzn.gr.* SKU (Amazon Grade &
 * Resell) is deleted when every FBA bucket is 0 — Unfulfillable and
 * Researching included. No closed-state requirement, no 60/14-day clock, no
 * PO / Velocity pipeline (none of those inputs is read, so a run-wide
 * ledger / Velocity outage does not block it). Kept: the listing checks
 * above, the fail-closed inventory freshness gate, the action-pending guard,
 * the delete breaker. Never closed by 22; never primary.
 */
export const AMZN_GR_RULE = "amzn_gr";
function evaluateDeleteAmznGr(f: SkuFacts, b: Basis, out: (o: string, c?: boolean, extra?: Record<string, any>) => Evaluation): Evaluation {
  const rule = { rule: AMZN_GR_RULE };
  if (!f.inventory || !fresh(f.inventory.observedAt, b.inventoryFrom)) return out("skip_no_fresh_inventory", false, rule);
  for (const k of DELETE_BLOCKING) if (f.inventory[k] > 0) return out(`skip_has_stock:${k}`, false, rule);
  if (f.actionPending) return out("skip_action_pending", false, rule);
  return out(`would_delete:${AMZN_GR_RULE}`, true, rule);
}

/** Ledger counts key: the clock's days vary per SKU, so they share one bucket. */
export const countKey = (outcome: string) => (outcome.startsWith("skip_clock:") ? "skip_clock" : outcome);

// ── Loading ───────────────────────────────────────────────────────────────

const d = (v: any): Date | null => (v == null ? null : v instanceof Date ? v : new Date(v));
const ymd = (v: any): string | null => (v == null ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

/** The runs "this pass" refers to (see the header). */
export async function loadBasis(query: QueryLike, now: Date = new Date()): Promise<Basis> {
  const latest = async (stage: string, fullOnly: boolean) => (await query(
    `SELECT started_at, finished_at, error FROM refresh_runs
      WHERE stage = $1 ${fullOnly ? "AND scope = 'full'" : ""}
      ORDER BY started_at DESC LIMIT 1`, [stage])).rows[0] ?? null;
  const ok = (r: any) => r && r.error == null && r.finished_at != null && now.getTime() - d(r.finished_at)!.getTime() <= FRESH_MS;
  const inv = await latest("15_inventory", false);
  const lst = await latest("16_live_offer", true);
  return { now, inventoryFrom: ok(inv) ? d(inv.started_at) : null, listingFrom: ok(lst) ? d(lst.started_at) : null };
}

/** Per-SKU facts for the SKUs of `asins` (or exactly `skus`), pipeline and Velocity left for the caller. */
export async function loadSkuFacts(query: QueryLike, sel: { asins?: string[]; skus?: string[] }, action: HygieneAction, now: Date = new Date()): Promise<SkuFacts[]> {
  const where = sel.skus ? `s.sku = ANY($1::text[])` : `a.asin = ANY($1::text[])`;
  const rows = (await query(
    `SELECT a.asin, s.sku, s.listing_created_at, s.offer_end_at, s.listing_checked_at,
            i.fulfillable, i.inbound_working, i.inbound_shipped, i.inbound_receiving, i.reserved_customer,
            i.reserved_fc_transfer, i.reserved_fc_processing, i.unfulfillable, i.researching, i.future_supply,
            i.observed_at, i.last_nonzero_at, (i.sku IS NOT NULL) AS has_inventory,
            l.last_stocked_date,
            (SELECT ls.verify_status FROM listing_submissions ls WHERE ls.sku = s.sku ORDER BY ls.submitted_at DESC LIMIT 1) AS newest_submission,
            -- ANY accepted action on the SKU, close or delete (2026-10-20): a
            -- deleting listing reads back open (end_at null) for minutes while
            -- Amazon processes the DELETE, and must not draw a close.
            EXISTS (SELECT 1 FROM listing_actions la WHERE la.sku = s.sku AND la.status = 'accepted'
                     AND la.fired_at > $2::timestamptz) AS action_pending,
            -- The closed test (2026-10-23): AF's newest live close PATCH on the SKU.
            (SELECT MAX(cp.fired_at) FROM listing_actions cp WHERE cp.sku = s.sku AND cp.action = 'close'
                     AND cp.dry_run = FALSE AND cp.status IN ('accepted', 'verified')) AS close_patch_at
       FROM asin_skus s JOIN asins a ON a.id = s.asin_id
       LEFT JOIN sku_fba_inventory i ON i.sku = s.sku
       LEFT JOIN sku_ledger_state l ON l.sku = s.sku
      WHERE ${where}
      ORDER BY s.sku, s.listing_checked_at DESC NULLS LAST`,
    [sel.skus ?? sel.asins ?? [], new Date(now.getTime() - PENDING_ACTION_MS).toISOString()],
  )).rows;
  const by = new Map<string, SkuFacts>();
  for (const r of rows) {
    const sku = String(r.sku);
    const prev = by.get(sku);
    if (prev) { if (!prev.asins.includes(String(r.asin))) prev.asins.push(String(r.asin)); continue; }
    const inv: InventoryFacts | null = r.has_inventory ? {
      fulfillable: Number(r.fulfillable), inbound_working: Number(r.inbound_working), inbound_shipped: Number(r.inbound_shipped),
      inbound_receiving: Number(r.inbound_receiving), reserved_customer: Number(r.reserved_customer),
      reserved_fc_transfer: Number(r.reserved_fc_transfer), reserved_fc_processing: Number(r.reserved_fc_processing),
      unfulfillable: Number(r.unfulfillable), researching: Number(r.researching), future_supply: Number(r.future_supply),
      observedAt: d(r.observed_at)!, lastNonzeroAt: d(r.last_nonzero_at),
    } : null;
    by.set(sku, {
      sku, asin: String(r.asin), asins: [String(r.asin)],
      listing: { checkedAt: d(r.listing_checked_at), createdAt: d(r.listing_created_at), offerEndAt: d(r.offer_end_at), buyable: null, closePatchAt: d(r.close_patch_at) },
      inventory: inv,
      pendingSubmission: r.newest_submission != null && PENDING_SUBMISSION.has(String(r.newest_submission)),
      actionPending: r.action_pending === true,
      ledgerLastStocked: ymd(r.last_stocked_date),
      pipeline: { on_order: 0, at_prep: 0 },
      velocityOnHand: null,
    });
  }
  return Array.from(by.values());
}

/** On Order + At Prep summed over every ASIN of the SKU (server/asin-po-pipeline.ts, read live). */
export async function attachPipeline(facts: SkuFacts[], query: QueryLike): Promise<void> {
  const asins = Array.from(new Set(facts.flatMap((f) => f.asins)));
  if (asins.length === 0) return;
  const p = await loadAsinPipeline(query, asins);
  for (const f of facts) {
    f.pipeline = f.asins.reduce((acc, a) => {
      const x = p.get(a.toUpperCase());
      return { on_order: acc.on_order + (x?.on_order ?? 0), at_prep: acc.at_prep + (x?.at_prep ?? 0) };
    }, { on_order: 0, at_prep: 0 });
  }
}

/** Pure: Velocity units on hand per ASIN — Σ quantity_remaining over /inbound ∪ /inventory, one count per order_id. */
export function velocityOnHandByAsin(orders: VelocityInboundOrder[]): Map<string, number> {
  const seen = new Set<string>();
  const out = new Map<string, number>();
  for (const o of orders) {
    const id = String(o.order_id ?? "");
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    const q = Number(o.quantity_remaining ?? 0);
    if (!(q > 0)) continue;
    const a = String(o.asin ?? "").toUpperCase();
    out.set(a, (out.get(a) ?? 0) + q);
  }
  return out;
}

/** Tonight's ledger, or the reason it cannot be trusted (→ ledger_unavailable for every SKU). */
export async function ledgerAvailability(query: QueryLike, now: Date = new Date()): Promise<{ ok: true; coverage: { from: string; to: string } } | { ok: false; reason: string }> {
  const run = (await query(
    `SELECT finished_at, error, counts FROM refresh_runs WHERE stage = '23_ledger' ORDER BY started_at DESC LIMIT 1`,
  )).rows[0];
  if (!run) return { ok: false, reason: "no component-23 run yet" };
  if (run.error != null) return { ok: false, reason: `latest component-23 run failed: ${run.error}` };
  if (now.getTime() - d(run.finished_at)!.getTime() > LEDGER_FRESH_MS) return { ok: false, reason: `latest component-23 run is older than ${LEDGER_FRESH_MS / 3600_000} h` };
  if (Number(run.counts?.conclusive ?? 0) !== 1) return { ok: false, reason: "latest component-23 run was inconclusive" };
  const cov = (await query(`SELECT value FROM settings WHERE key = $1`, [COVERAGE_SETTING])).rows[0]?.value;
  if (!cov?.from || !cov?.to) return { ok: false, reason: "no ledger coverage recorded — run the backfill (npm run backfill:ledger)" };
  if (daysSince(String(cov.from), now) < LEDGER_REQUIRED_DAYS) return { ok: false, reason: `ledger coverage starts ${cov.from} — needs ${LEDGER_REQUIRED_DAYS} days back; run the backfill` };
  if (daysSince(String(cov.to), now) > LEDGER_MAX_LAG_DAYS) return { ok: false, reason: `ledger coverage ends ${cov.to}` };
  return { ok: true, coverage: { from: String(cov.from), to: String(cov.to) } };
}

export async function breakerFor(action: HygieneAction, query: QueryLike): Promise<number> {
  const key = action === "close" ? "hygiene_close_breaker" : "hygiene_delete_breaker";
  const v = Number((await query(`SELECT value FROM settings WHERE key = $1`, [key])).rows[0]?.value);
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_BREAKER[action];
}

export function liveGate(action: HygieneAction, env: NodeJS.ProcessEnv = process.env): boolean {
  return (action === "close" ? env.LISTING_CLOSE_LIVE : env.LISTING_DELETE_LIVE) === "true";
}

// ── SC writes ─────────────────────────────────────────────────────────────

/**
 * The close PATCH: op "merge" on /attributes/purchasable_offer, end_at from
 * the shared helper — the same value the born-closed PUT sends. Never
 * "replace" (it swaps the array and wipes the price), never a price field
 * (an 18555 high-price error makes Amazon silently ignore the end_at). Same
 * selector set as the verified reopen body (§18, CAM-HOM-M64-RQR-003).
 */
export function buildClosePatchBody(productType: string): any {
  return {
    productType,
    patches: [{
      op: "merge",
      path: "/attributes/purchasable_offer",
      value: [{ currency: "USD", audience: "ALL", marketplace_id: MARKETPLACE, end_at: closedEndAt() }],
    }],
  };
}

export interface ScDeps {
  get: (endpoint: string, params?: Record<string, any>) => Promise<any>;
  patch: (endpoint: string, body: any, params?: Record<string, any>) => Promise<any>;
  del: (endpoint: string, params?: Record<string, any>) => Promise<any>;
  velocity: () => Promise<VelocityInboundOrder[]>;
}
export const realScDeps: ScDeps = {
  get: spApiGet, patch: spApiPatch, del: spApiDelete,
  velocity: async () => [...(await fetchAllInboundOrders()), ...(await fetchAllInventoryOrders())],
};

export interface FireResult {
  status: "accepted" | "invalid" | "error" | "skipped";
  outcome: string;
  submissionId?: string | null;
  issues?: any;
  preflight?: Record<string, any>;
}

const itemPath = (sellerId: string, sku: string) => `/listings/2021-08-01/items/${sellerId}/${encodeURIComponent(sku)}`;

/** Live re-read of one SKU's listing: present + state, absent, or a transient error. */
export async function readListingLive(sellerId: string, sku: string, deps: ScDeps): Promise<
  { ok: true; present: true; state: ReturnType<typeof parseListingState> } | { ok: true; present: false } | { ok: false; message: string }
> {
  try {
    const data = await deps.get(itemPath(sellerId, sku), { marketplaceIds: MARKETPLACE, includedData: "summaries,attributes" });
    if (!Array.isArray(data?.summaries) || data.summaries.length === 0) return { ok: true, present: false };
    return { ok: true, present: true, state: parseListingState(data) };
  } catch (err: any) {
    if (err?.response?.status === 404) return { ok: true, present: false };
    return { ok: false, message: err?.response?.data?.errors?.[0]?.message ?? err?.message ?? "unknown" };
  }
}

const respIssues = (data: any) => (Array.isArray(data?.issues) && data.issues.length ? data.issues : null);
const errMsg = (err: any) => `HTTP ${err?.response?.status ?? "?"}: ${err?.response?.data?.errors?.[0]?.message ?? err?.message ?? "unknown"}`;

export async function fireClose(sellerId: string, sku: string, deps: ScDeps, now: Date = new Date(), opts: { closePatchAt?: Date | null } = {}): Promise<FireResult> {
  const live = await readListingLive(sellerId, sku, deps);
  if (!live.ok) return { status: "error", outcome: `error: pre-flight read failed — ${live.message}` };
  if (!live.present) return { status: "skipped", outcome: "skip_no_listing", preflight: { present: false } };
  const st = live.state;
  const preflight = { present: true, offer_end_at: st.offerEndAt, product_type: st.productType, has_offer: st.hasOffer, buyable: st.buyable };
  if (isOfferClosed({ endAt: st.offerEndAt, buyable: st.buyable, createdAt: st.createdAt, closePatchAt: opts.closePatchAt }, now)) return { status: "skipped", outcome: "skip_already_closed", preflight };
  if (!st.hasOffer) return { status: "skipped", outcome: "skip_no_listing", preflight };
  if (!st.productType) return { status: "error", outcome: "error: no productType on the listing", preflight };
  const body = buildClosePatchBody(st.productType);
  // §18 MF-flip rail: the exact key "quantity" anywhere in the body aborts.
  const forbidden = findForbiddenQuantityPaths(body);
  if (forbidden.length > 0) throw new Error(`close PATCH for ${sku} carries forbidden quantity path(s) ${forbidden.join(", ")} — aborted, nothing sent`);
  try {
    const data = await deps.patch(itemPath(sellerId, sku), body, { marketplaceIds: MARKETPLACE });
    if (data?.status === "ACCEPTED") return { status: "accepted", outcome: "closed", submissionId: data?.submissionId ?? null, issues: respIssues(data), preflight };
    return { status: "invalid", outcome: "invalid", submissionId: data?.submissionId ?? null, issues: respIssues(data) ?? data ?? null, preflight };
  } catch (err: any) {
    return { status: "error", outcome: `error: ${errMsg(err)}`, issues: err?.response?.data ?? null, preflight };
  }
}

export async function fireDelete(sellerId: string, sku: string, deps: ScDeps, now: Date = new Date(), opts: { rule?: string; closePatchAt?: Date | null } = {}): Promise<FireResult> {
  const amznGr = opts.rule === AMZN_GR_RULE;
  const live = await readListingLive(sellerId, sku, deps);
  if (!live.ok) return { status: "error", outcome: `error: pre-flight read failed — ${live.message}` };
  if (!live.present) return { status: "skipped", outcome: "skip_no_listing", preflight: { present: false } };
  const st = live.state;
  const preflight = { present: true, offer_end_at: st.offerEndAt, rule: opts.rule ?? null, buyable: st.buyable };
  // The amzn_gr rule has no closed-state requirement; every other delete does.
  if (!amznGr && !isOfferClosed({ endAt: st.offerEndAt, buyable: st.buyable, createdAt: st.createdAt, closePatchAt: opts.closePatchAt }, now)) return { status: "skipped", outcome: "skip_not_closed", preflight };
  try {
    const data = await deps.del(itemPath(sellerId, sku), { marketplaceIds: MARKETPLACE });
    if (data?.status === "ACCEPTED") return { status: "accepted", outcome: amznGr ? `deleted:${AMZN_GR_RULE}` : "deleted", submissionId: data?.submissionId ?? null, issues: respIssues(data), preflight };
    return { status: "invalid", outcome: "invalid", submissionId: data?.submissionId ?? null, issues: respIssues(data) ?? data ?? null, preflight };
  } catch (err: any) {
    return { status: "error", outcome: `error: ${errMsg(err)}`, issues: err?.response?.data ?? null, preflight };
  }
}

// ── Live inventory for Release ────────────────────────────────────────────

/** getInventorySummaries for exactly these SKUs (≤ 50 per call); a SKU the answer omits is all-zero. */
export async function readInventoryLive(skus: string[], deps: ScDeps, now: Date = new Date()): Promise<Map<string, InventoryFacts>> {
  const out = new Map<string, InventoryFacts>();
  for (let i = 0; i < skus.length; i += 50) {
    const part = skus.slice(i, i + 50);
    const data = await deps.get("/fba/inventory/v1/summaries", {
      details: "true", granularityType: "Marketplace", granularityId: MARKETPLACE, marketplaceIds: MARKETPLACE, sellerSkus: part.join(","),
    });
    const got = new Map<string, SkuBuckets>();
    for (const item of data?.payload?.inventorySummaries ?? []) { const b = parseSkuBuckets(item); if (b) got.set(b.sku, b); }
    for (const sku of part) {
      const b = got.get(sku);
      const z = { fulfillable: 0, inbound_working: 0, inbound_shipped: 0, inbound_receiving: 0, reserved_customer: 0, reserved_fc_transfer: 0, reserved_fc_processing: 0, unfulfillable: 0, researching: 0, future_supply: 0 };
      const buckets = b ? Object.fromEntries(BUCKET_FIELDS.map((f) => [f, b[f]])) as Pick<SkuBuckets, BucketField> : z;
      out.set(sku, { ...buckets, observedAt: now, lastNonzeroAt: null });
    }
  }
  return out;
}

// ── Verification (component 16) ──────────────────────────────────────────

/**
 * After component 16's probe: an accepted action whose SKU this pass probed
 * is `verified` when it took effect (close → offer_end_at <= now; delete →
 * no listing). Not yet effective → verify_passes + 1; at 2 → not_effective
 * (surfaced in the jobs dialog). A SKU not probed since `since` (transient)
 * is left alone.
 */
export async function verifyListingActions(query: QueryLike, since: Date): Promise<{ verified: number; pending: number; not_effective: number }> {
  const rows = (await query(
    `SELECT la.id, la.action, la.verify_passes, la.fired_at, s.listing_checked_at, s.listing_created_at, s.offer_end_at
       FROM listing_actions la
       JOIN asins a ON a.asin = la.asin
       JOIN asin_skus s ON s.asin_id = a.id AND s.sku = la.sku
      WHERE la.status = 'accepted' AND la.dry_run = FALSE
        AND s.listing_checked_at >= $1::timestamptz AND s.listing_checked_at > la.fired_at`,
    [since.toISOString()],
  )).rows;
  const r = { verified: 0, pending: 0, not_effective: 0 };
  const now = Date.now();
  for (const x of rows) {
    // A close took effect when the closed test holds, THIS action being the PATCH.
    const effective = x.action === "close"
      ? isOfferClosed({ endAt: x.offer_end_at, createdAt: x.listing_created_at, closePatchAt: x.fired_at }, new Date(now))
      : x.listing_created_at == null;
    if (effective) {
      await query(`UPDATE listing_actions SET status = 'verified', verified_at = NOW() WHERE id = $1`, [x.id]);
      r.verified++;
    } else if (Number(x.verify_passes) + 1 >= 2) {
      await query(`UPDATE listing_actions SET status = 'not_effective', verify_passes = verify_passes + 1 WHERE id = $1`, [x.id]);
      r.not_effective++;
    } else {
      await query(`UPDATE listing_actions SET verify_passes = verify_passes + 1 WHERE id = $1`, [x.id]);
      r.pending++;
    }
  }
  return r;
}

// ── Pending holds ("Action required", Maria 2026-10-21) ────────────────────

export interface HoldGroup {
  job_id: number;
  action: HygieneAction;
  /** Rows that were ever held in this job (still held, or released). */
  total: number;
  /** Still held and not yet released. */
  open: number;
  /** A release job for (job, action) is queued, running or done. */
  released: boolean;
  held_at: string;
}
export interface PendingHold { job_id: number; action: HygieneAction; count: number; held_at: string }

/**
 * Pure: at most ONE pending hold per action — the newest job that held any
 * candidates for it. It is pending while it still has open held rows and no
 * release job; a later night's hold supersedes it (an older hold never
 * resurfaces, even when the newer one is released).
 */
export function pendingHolds(groups: HoldGroup[]): Record<HygieneAction, PendingHold | null> {
  const out: Record<HygieneAction, PendingHold | null> = { close: null, delete: null };
  for (const action of ["close", "delete"] as const) {
    const newest = groups.filter((g) => g.action === action && g.total > 0).sort((a, b) => b.job_id - a.job_id)[0];
    if (newest && newest.open > 0 && !newest.released) out[action] = { job_id: newest.job_id, action, count: newest.open, held_at: newest.held_at };
  }
  return out;
}

export async function loadHoldGroups(query: QueryLike): Promise<HoldGroup[]> {
  const r = await query(
    `SELECT la.job_id, la.action, count(*)::int AS total,
            count(*) FILTER (WHERE la.status = 'held' AND NOT (la.evidence ? 'release'))::int AS open,
            min(la.fired_at) AS held_at,
            EXISTS (SELECT 1 FROM jobs j
                     WHERE j.params->'listing_hygiene'->>'mode' = 'release'
                       AND j.params->'listing_hygiene'->>'action' = la.action
                       AND (j.params->'listing_hygiene'->>'release_of_job')::bigint = la.job_id
                       AND j.status IN ('queued','running','done')) AS released
       FROM listing_actions la
      WHERE la.job_id IS NOT NULL AND (la.status = 'held' OR la.evidence ? 'release')
      GROUP BY la.job_id, la.action`,
  );
  return r.rows.map((x: any) => ({
    job_id: Number(x.job_id), action: x.action, total: Number(x.total), open: Number(x.open),
    released: x.released === true, held_at: new Date(x.held_at).toISOString(),
  }));
}
