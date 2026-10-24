// The run flow shared by components 22 (close) and 24 (delete) — listing
// hygiene, SPEC §11. Three modes, chosen by the job:
//   - pass     a scheduled pass, or POST /api/listing-hygiene/run (a
//              one-component lane-M job over the scheduled scope). Evaluates
//              every SKU from this pass's stored state (listing-hygiene.ts
//              header), applies the breaker, then dry-runs or fires.
//   - release  POST /api/listing-hygiene/release {job_id, action}: the held
//              candidates of that job, RE-EVALUATED LIVE (fresh listing and
//              inventory reads, live pipeline, live Velocity) — an approval is
//              a snapshot, not a mandate (the 2026-09-24 Velocity rule). Only
//              SKUs that still qualify fire; no breaker (Release is the
//              override). Refused unless the action's live gate is set.
import {
  evaluateClose, evaluateDelete, countKey, loadBasis, loadSkuFacts, attachPipeline, velocityOnHandByAsin,
  ledgerAvailability, breakerFor, liveGate, fireClose, fireDelete, readListingLive, readInventoryLive,
  realScDeps, isAmznGr, hygieneScope, type HygieneAction, type ScDeps, type SkuFacts, type Evaluation, type Basis,
} from "./listing-hygiene";
import { ComponentError, type ComponentContext, type ComponentResult, type ListingActionChange, type QueryLike } from "./scheduler/types";

/** Test seam. */
export const hygieneDeps: { sc: ScDeps; now: () => Date; env: () => NodeJS.ProcessEnv } = {
  sc: realScDeps, now: () => new Date(), env: () => process.env,
};

export interface HygieneParams { action: HygieneAction; mode?: "run" | "release"; dry_run?: boolean; release_of_job?: number }

export function hygieneParamsOf(job: { params: Record<string, any> | null }, action: HygieneAction): HygieneParams | null {
  const p = job.params?.listing_hygiene;
  return p && p.action === action ? (p as HygieneParams) : null;
}



export async function insertAction(query: QueryLike, a: {
  sku: string; asin: string; action: HygieneAction; jobId: number | null; dryRun: boolean; evidence: any;
  status: string; submissionId?: string | null; issues?: any;
}): Promise<void> {
  await query(
    `INSERT INTO listing_actions (sku, asin, action, job_id, dry_run, evidence, status, submission_id, issues)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9::jsonb)`,
    [a.sku, a.asin, a.action, a.jobId, a.dryRun, JSON.stringify(a.evidence), a.status, a.submissionId ?? null,
     a.issues == null ? null : JSON.stringify(a.issues)],
  );
}

// ── Close-after-create (2026-10-23, listing-hygiene amendment) ──────────────
// A past end_at sent at CREATE is stored by Amazon but not applied, so Add to
// SC no longer sends one. Instead, the first §19 probe that sees the new
// listing (200 with summaries) sends THIS: component 22's close PATCH through
// fireClose — the same helper, pre-flight read, forbidden-quantity guard —
// and a listing_actions row with reason born_closed, verified by component 16
// like any close. Sent once: any live close row for the SKU since the
// submission means it is done (whatever its status); a pre-flight read that
// fails sends nothing and writes nothing, so the next probe retries. If the
// ladder never sees the listing, the nightly component 22 closes it.
export const BORN_CLOSED_REASON = "born_closed";

export async function closeAfterCreate(
  query: QueryLike, sellerId: string,
  row: { asin: string; sku: string; submittedAt: Date | string },
  deps: ScDeps = hygieneDeps.sc, now: Date = new Date(),
): Promise<{ status: string; outcome: string } | null> {
  const since = new Date(row.submittedAt).toISOString();
  const prior = (await query(
    `SELECT 1 FROM listing_actions WHERE sku = $1 AND action = 'close' AND dry_run = FALSE AND fired_at >= $2::timestamptz LIMIT 1`,
    [row.sku, since],
  )).rows;
  if (prior.length > 0) return null;
  const r = await fireClose(sellerId, row.sku, deps, now);
  const sent = r.status === "accepted" || r.status === "invalid" || (r.status === "error" && !r.outcome.startsWith("error: pre-flight"));
  if (!sent) return { status: r.status, outcome: r.outcome };
  await insertAction(query, {
    sku: row.sku, asin: row.asin, action: "close", jobId: null, dryRun: false,
    evidence: { reason: BORN_CLOSED_REASON, live: true, submitted_at: since, preflight: r.preflight ?? null, outcome: r.outcome },
    status: r.status, submissionId: r.submissionId, issues: r.issues,
  });
  return { status: r.status, outcome: r.outcome };
}

class Tally {
  counts: Record<string, number> = {};
  outcomes: Record<string, string> = {};
  changes: ListingActionChange[] = [];
  set(sku: string, outcome: string) {
    const prev = this.outcomes[sku];
    if (prev) this.counts[countKey(prev)] = (this.counts[countKey(prev)] ?? 1) - 1;
    this.outcomes[sku] = outcome;
    this.counts[countKey(outcome)] = (this.counts[countKey(outcome)] ?? 0) + 1;
  }
  note(key: string, v: string) { this.outcomes[key] = v; }
  result(): ComponentResult {
    for (const k of Object.keys(this.counts)) if (this.counts[k] === 0) delete this.counts[k];
    return { counts: this.counts, outcomes: this.outcomes, listingActions: this.changes };
  }
}

/** Run-wide blockers for delete: ledger, then Velocity. Returns the outcome every SKU gets, or null. */
async function deleteRunBlocker(facts: SkuFacts[], query: QueryLike, t: Tally, now: Date): Promise<string | null> {
  const ledger = await ledgerAvailability(query, now);
  if (!ledger.ok) { t.note("_ledger", ledger.reason); return "ledger_unavailable"; }
  t.note("_ledger", `coverage ${ledger.coverage.from}..${ledger.coverage.to}`);
  let orders;
  try { orders = await hygieneDeps.sc.velocity(); }
  catch (err: any) { t.note("_velocity", `unavailable: ${err?.message ?? err}`); return "velocity_unavailable"; }
  const onHand = velocityOnHandByAsin(orders);
  for (const f of facts) f.velocityOnHand = f.asins.reduce((s, a) => s + (onHand.get(a.toUpperCase()) ?? 0), 0);
  t.note("_velocity", `${orders.length} order(s) read, ${onHand.size} ASIN(s) with units on hand`);
  return null;
}

async function fire(action: HygieneAction, sellerId: string, f: SkuFacts, now: Date, e: Evaluation) {
  const closePatchAt = f.listing.closePatchAt ?? null;
  return action === "close" ? fireClose(sellerId, f.sku, hygieneDeps.sc, now, { closePatchAt }) : fireDelete(sellerId, f.sku, hygieneDeps.sc, now, { rule: e.evidence?.rule, closePatchAt });
}

export async function runHygiene(action: HygieneAction, ctx: ComponentContext): Promise<ComponentResult> {
  const params = hygieneParamsOf(ctx.job, action);
  if (params?.mode === "release") return runRelease(action, ctx, params);

  const now = hygieneDeps.now();
  const t = new Tally();
  const gate = liveGate(action, hygieneDeps.env());
  // A manual run may ask for a dry run; it can never be MORE live than the gate.
  const live = gate && params?.dry_run !== true;
  t.note("_mode", `${live ? "LIVE" : "dry run"} (${action === "close" ? "LISTING_CLOSE_LIVE" : "LISTING_DELETE_LIVE"} ${gate ? "set" : "unset"}${params ? `, manual run dryRun=${params.dry_run === true}` : ""})`);

  const basis: Basis = await loadBasis(ctx.query, now);
  t.note("_basis", `inventory from ${basis.inventoryFrom?.toISOString() ?? "none fresh"} · listings from ${basis.listingFrom?.toISOString() ?? "none fresh"}`);
  // Every SKU with an SC listing, whatever its ASIN's AF status (Maria 2026-10-24).
  const scope = await hygieneScope(ctx.query, ctx.scopeAsins, ctx.job.scope_asins);
  let facts = await loadSkuFacts(ctx.query, { asins: scope }, action, now);

  if (action === "delete") {
    await attachPipeline(facts, ctx.query);
    const blocker = await deleteRunBlocker(facts, ctx.query, t, now);
    if (blocker) {
      // The amzn_gr rule reads neither the ledger nor Velocity, so a run-wide
      // outage blocks only the regular deletes (2026-10-21).
      for (const f of facts) if (!isAmznGr(f.sku)) t.set(f.sku, blocker);
      facts = facts.filter((f) => isAmznGr(f.sku));
    }
  }

  const evals: Array<{ f: SkuFacts; e: Evaluation }> = facts.map((f) => ({ f, e: action === "close" ? evaluateClose(f, basis) : evaluateDelete(f, basis) }));
  for (const { f, e } of evals) t.set(f.sku, e.outcome);
  const candidates = evals.filter((x) => x.e.candidate);
  const breaker = await breakerFor(action, ctx.query);
  const trips = candidates.length > breaker;
  t.note("_breaker", `${candidates.length} candidate(s), breaker ${breaker}${trips ? (live ? " — TRIPPED: nothing written, every candidate held for Release" : " — would trip when live") : ""}`);

  for (const { f, e } of candidates) {
    const evidence = { ...e.evidence, live, breaker, candidates: candidates.length, job_id: ctx.job.id };
    if (!live) {
      await insertAction(ctx.query, { sku: f.sku, asin: f.asin, action, jobId: ctx.job.id, dryRun: true, evidence, status: "would_fire" });
      t.set(f.sku, e.outcome);
    } else if (trips) {
      await insertAction(ctx.query, { sku: f.sku, asin: f.asin, action, jobId: ctx.job.id, dryRun: false, evidence, status: "held" });
      t.set(f.sku, "held");
    }
  }
  if (!live || trips) return t.result();

  for (const { f, e } of candidates) {
    const r = await fire(action, ctx.sellerId, f, now, e);
    t.set(f.sku, r.outcome);
    if (r.status === "skipped") continue;
    await insertAction(ctx.query, {
      sku: f.sku, asin: f.asin, action, jobId: ctx.job.id, dryRun: false,
      evidence: { ...e.evidence, live: true, breaker, candidates: candidates.length, job_id: ctx.job.id, preflight: r.preflight ?? null },
      status: r.status, submissionId: r.submissionId, issues: r.issues,
    });
    if (r.status === "accepted") t.changes.push({ action, asin: f.asin, sku: f.sku });
    await ctx.checkpoint(null);
  }
  return t.result();
}

async function runRelease(action: HygieneAction, ctx: ComponentContext, params: HygieneParams): Promise<ComponentResult> {
  const now = hygieneDeps.now();
  const t = new Tally();
  if (!liveGate(action, hygieneDeps.env())) {
    throw new ComponentError(`release refused: ${action === "close" ? "LISTING_CLOSE_LIVE" : "LISTING_DELETE_LIVE"} is not set`, { counts: {}, outcomes: {} });
  }
  const jobId = Number(params.release_of_job);
  const held = (await ctx.query(
    `SELECT id, sku, asin FROM listing_actions
      WHERE job_id = $1 AND action = $2 AND status = 'held' AND NOT (evidence ? 'release')
      ORDER BY id`, [jobId, action],
  )).rows as Array<{ id: number; sku: string; asin: string }>;
  t.note("_release", `job #${jobId}: ${held.length} held ${action} candidate(s), re-evaluated live`);
  if (held.length === 0) return t.result();

  const skus = held.map((h) => String(h.sku));
  let facts = await loadSkuFacts(ctx.query, { skus }, action, now);
  // Live re-reads: listing state per SKU, inventory per SKU (≤ 50 per call).
  const inventory = await readInventoryLive(skus, hygieneDeps.sc, now);
  for (const f of facts) {
    const l = await readListingLive(ctx.sellerId, f.sku, hygieneDeps.sc);
    f.listing = !l.ok
      ? { checkedAt: null, createdAt: null, offerEndAt: null } // transient → skip_probe_transient
      : !l.present
        ? { checkedAt: now, createdAt: null, offerEndAt: null }
        : { checkedAt: now, createdAt: l.state.createdAt ? new Date(l.state.createdAt) : null, offerEndAt: l.state.offerEndAt ? new Date(l.state.offerEndAt) : null, buyable: l.state.buyable, closePatchAt: f.listing.closePatchAt ?? null };
    const inv = inventory.get(f.sku);
    f.inventory = inv ? { ...inv, lastNonzeroAt: f.inventory?.lastNonzeroAt ?? null } : null;
  }
  const basis: Basis = { now, inventoryFrom: now, listingFrom: now };
  const byId = new Map(held.map((h) => [String(h.sku), h]));
  // A held SKU AF no longer records (its ASIN removed since) gets an outcome too.
  const known = new Set(facts.map((f) => f.sku));
  for (const h of held) if (!known.has(String(h.sku))) t.set(String(h.sku), "skip_no_listing");

  if (action === "delete") {
    await attachPipeline(facts, ctx.query);
    const blocker = await deleteRunBlocker(facts, ctx.query, t, now);
    if (blocker) {
      for (const f of facts) if (!isAmznGr(f.sku)) t.set(f.sku, blocker);
      facts = facts.filter((f) => isAmznGr(f.sku));
    }
  }

  for (const f of facts) {
    const h = byId.get(f.sku)!;
    const e = action === "close" ? evaluateClose(f, basis) : evaluateDelete(f, basis);
    const release: Record<string, any> = { at: now.toISOString(), job_id: ctx.job.id, reevaluated: e.evidence };
    if (!e.candidate) {
      release.outcome = e.outcome;
      await ctx.query(`UPDATE listing_actions SET evidence = evidence || jsonb_build_object('release', $2::jsonb) WHERE id = $1`, [h.id, JSON.stringify(release)]);
      t.set(f.sku, e.outcome);
      continue;
    }
    const r = await fire(action, ctx.sellerId, f, now, e);
    release.outcome = r.outcome;
    release.preflight = r.preflight ?? null;
    t.set(f.sku, r.outcome);
    if (r.status === "skipped") {
      await ctx.query(`UPDATE listing_actions SET evidence = evidence || jsonb_build_object('release', $2::jsonb) WHERE id = $1`, [h.id, JSON.stringify(release)]);
      continue;
    }
    await ctx.query(
      `UPDATE listing_actions SET status = $2, submission_id = $3, issues = $4::jsonb, fired_at = NOW(),
              evidence = evidence || jsonb_build_object('release', $5::jsonb)
        WHERE id = $1`,
      [h.id, r.status, r.submissionId ?? null, r.issues == null ? null : JSON.stringify(r.issues), JSON.stringify(release)],
    );
    if (r.status === "accepted") t.changes.push({ action, asin: f.asin, sku: f.sku });
    await ctx.checkpoint(null);
  }
  return t.result();
}
