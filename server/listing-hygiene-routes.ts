// Listing hygiene manual entry points (SPEC §11 components 22 / 24). Mounted
// behind requireAuth; the two that enqueue are admin-only.
//   POST /api/listing-hygiene/run      {action, dryRun}   one-component lane-M job over the scheduled scope
//   POST /api/listing-hygiene/release  {job_id, action}   re-evaluate that job's held candidates live, fire the ones that still qualify
//   GET  /api/listing-hygiene/actions  ?job_id=N | ?status=not_effective   listing_actions rows (jobs dialog)
//   GET  /api/listing-hygiene/pending  the unreleased hold per action ("Action required" indicator)
// Components 22 and 24 never run in a manual Refresh; these are their only
// manual triggers (componentsForJob: listed explicitly AND params.listing_hygiene).
import express, { type Router, type Request, type Response } from "express";
import pool, { query as defaultQuery } from "./db";
import { requireRole } from "./auth";
import { enqueueJob, listActive, laneAhead } from "./scheduler/jobs-repo";
import { liveGate, pendingHolds, loadHoldGroups, type HygieneAction } from "./listing-hygiene";
import type { QueryLike } from "./scheduler/types";

const COMPONENT: Record<HygieneAction, number> = { close: 22, delete: 24 };
const GATE: Record<HygieneAction, string> = { close: "LISTING_CLOSE_LIVE", delete: "LISTING_DELETE_LIVE" };
const actionOf = (v: unknown): HygieneAction | null => (v === "close" || v === "delete" ? v : null);

/** Advisory-lock namespace for "one release per job + action" (the jobs runner holds 7342002). */
export const RELEASE_LOCK_NS = 7342101;

/**
 * Run fn in ONE transaction holding an advisory lock for (job, action): two
 * Release clicks a second apart (production jobs #137 / #138, 2026-10-21)
 * serialize, and the second sees the first's job row.
 */
async function withReleaseLock<T>(jobId: number, action: HygieneAction, fn: (q: QueryLike) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query(`SELECT pg_advisory_xact_lock($1, $2)`, [RELEASE_LOCK_NS, jobId * 2 + (action === "delete" ? 1 : 0)]);
    const out = await fn((sql, params) => c.query(sql, params) as any);
    await c.query("COMMIT");
    return out;
  } catch (err) {
    await c.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    c.release();
  }
}

/** The release job already enqueued for this job + action (queued, running or done), if any. */
export async function existingRelease(jobId: number, action: HygieneAction, query: QueryLike): Promise<{ id: number; status: string } | null> {
  const r = await query(
    `SELECT id, status FROM jobs
      WHERE params->'listing_hygiene'->>'mode' = 'release'
        AND params->'listing_hygiene'->>'action' = $2
        AND (params->'listing_hygiene'->>'release_of_job')::bigint = $1
        AND status IN ('queued','running','done')
      ORDER BY id LIMIT 1`,
    [jobId, action],
  );
  return r.rows[0] ? { id: Number(r.rows[0].id), status: String(r.rows[0].status) } : null;
}

export function createListingHygieneRouter(deps: {
  query?: QueryLike; env?: () => NodeJS.ProcessEnv;
  /** Test seam: the transaction + lock around the release checks and enqueue. */
  inReleaseLock?: <T>(jobId: number, action: HygieneAction, fn: (q: QueryLike) => Promise<T>) => Promise<T>;
} = {}): Router {
  const query = deps.query ?? (defaultQuery as any as QueryLike);
  const env = deps.env ?? (() => process.env);
  const inReleaseLock = deps.inReleaseLock ?? withReleaseLock;
  const router = express.Router();

  router.post("/api/listing-hygiene/run", requireRole("admin"), async (req: Request, res: Response) => {
    const action = actionOf(req.body?.action);
    if (!action) { res.status(400).json({ error: "invalid_action", message: "action must be close or delete" }); return; }
    if (typeof req.body?.dryRun !== "boolean") { res.status(400).json({ error: "invalid_dry_run", message: "dryRun must be true or false" }); return; }
    const dryRun = req.body.dryRun as boolean;
    if (!dryRun && !liveGate(action, env())) {
      res.status(409).json({ error: "not_live", message: `${GATE[action]} is not set — only a dry run is possible` });
      return;
    }
    try {
      const job = await enqueueJob({
        trigger: "manual", includeDaily: false, components: [COMPONENT[action]], scopeAsins: null,
        params: { listing_hygiene: { action, mode: "run", dry_run: dryRun } },
        requestedBy: req.session?.userId ?? null,
      }, query);
      res.status(202).json({ job, ahead: laneAhead(job, await listActive(query)) });
    } catch (err: any) {
      res.status(500).json({ error: "enqueue_failed", message: err?.message ?? String(err) });
    }
  });

  router.post("/api/listing-hygiene/release", requireRole("admin"), async (req: Request, res: Response) => {
    const action = actionOf(req.body?.action);
    const jobId = Number(req.body?.job_id);
    if (!action) { res.status(400).json({ error: "invalid_action", message: "action must be close or delete" }); return; }
    if (!Number.isInteger(jobId) || jobId <= 0) { res.status(400).json({ error: "invalid_job_id" }); return; }
    if (!liveGate(action, env())) {
      res.status(409).json({ error: "not_live", message: `${GATE[action]} is not set — nothing can be released` });
      return;
    }
    try {
      // One release per job + action, ever (queued, running or done) — checked
      // and enqueued under the lock, in one transaction. A failed or
      // cancelled release does not count, so it can be retried.
      const out = await inReleaseLock(jobId, action, async (q) => {
        const prior = await existingRelease(jobId, action, q);
        if (prior) return { status: 409, body: { error: "already_released", message: `job #${jobId}'s held ${action}s were already released (job #${prior.id}, ${prior.status})` } };
        // A later night's hold supersedes this one: only the newest hold per action is releasable.
        const newer = (await loadHoldGroups(q)).filter((g) => g.action === action && g.total > 0 && g.job_id > jobId).sort((a, b) => b.job_id - a.job_id)[0];
        if (newer) return { status: 409, body: { error: "superseded", message: `job #${jobId}'s held ${action}s are superseded by job #${newer.job_id}'s hold — review that one` } };
        const n = Number((await q(
          `SELECT count(*)::int AS n FROM listing_actions WHERE job_id = $1 AND action = $2 AND status = 'held' AND NOT (evidence ? 'release')`,
          [jobId, action],
        )).rows[0]?.n ?? 0);
        if (n === 0) return { status: 409, body: { error: "nothing_held", message: `job #${jobId} has no held ${action} candidates left` } };
        const job = await enqueueJob({
          trigger: "manual", includeDaily: false, components: [COMPONENT[action]], scopeAsins: null,
          params: { listing_hygiene: { action, mode: "release", release_of_job: jobId } },
          requestedBy: req.session?.userId ?? null,
        }, q);
        return { status: 202, body: { job, held: n } };
      });
      if (out.status !== 202) { res.status(out.status).json(out.body); return; }
      res.status(202).json({ ...out.body, ahead: laneAhead((out.body as any).job, await listActive(query)) });
    } catch (err: any) {
      res.status(500).json({ error: "enqueue_failed", message: err?.message ?? String(err) });
    }
  });

  router.get("/api/listing-hygiene/pending", async (_req: Request, res: Response) => {
    try {
      res.json({ pending: pendingHolds(await loadHoldGroups(query)), live: { close: liveGate("close", env()), delete: liveGate("delete", env()) } });
    } catch (err: any) {
      res.status(500).json({ error: "pending_failed", message: err?.message ?? String(err) });
    }
  });

  router.get("/api/listing-hygiene/actions", async (req: Request, res: Response) => {
    const jobId = req.query.job_id != null ? Number(req.query.job_id) : null;
    const status = typeof req.query.status === "string" ? req.query.status : null;
    if (jobId == null && status !== "not_effective") { res.status(400).json({ error: "job_id or status=not_effective required" }); return; }
    if (jobId != null && (!Number.isInteger(jobId) || jobId <= 0)) { res.status(400).json({ error: "invalid_job_id" }); return; }
    try {
      const rows = (await query(
        `SELECT id, sku, asin, action, job_id, dry_run, status, evidence, submission_id, issues, fired_at, verified_at, verify_passes
           FROM listing_actions
          WHERE ${jobId != null ? "job_id = $1" : "status = 'not_effective'"}
          ORDER BY action, sku
          LIMIT 5000`,
        jobId != null ? [jobId] : [],
      )).rows;
      const releasable = (a: HygieneAction) => rows.filter((r: any) => r.action === a && r.status === "held" && !(r.evidence && "release" in r.evidence)).length;
      res.json({
        actions: rows,
        releasable: { close: releasable("close"), delete: releasable("delete") },
        live: { close: liveGate("close", env()), delete: liveGate("delete", env()) },
      });
    } catch (err: any) {
      res.status(500).json({ error: "actions_failed", message: err?.message ?? String(err) });
    }
  });

  return router;
}
