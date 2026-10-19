// Listing hygiene manual entry points (SPEC §11 components 22 / 24). Mounted
// behind requireAuth; the two that enqueue are admin-only.
//   POST /api/listing-hygiene/run      {action, dryRun}   one-component lane-M job over the scheduled scope
//   POST /api/listing-hygiene/release  {job_id, action}   re-evaluate that job's held candidates live, fire the ones that still qualify
//   GET  /api/listing-hygiene/actions  ?job_id=N | ?status=not_effective   listing_actions rows (jobs dialog)
// Components 22 and 24 never run in a manual Refresh; these are their only
// manual triggers (componentsForJob: listed explicitly AND params.listing_hygiene).
import express, { type Router, type Request, type Response } from "express";
import { query as defaultQuery } from "./db";
import { requireRole } from "./auth";
import { enqueueJob, listActive, laneAhead } from "./scheduler/jobs-repo";
import { liveGate, type HygieneAction } from "./listing-hygiene";
import type { QueryLike } from "./scheduler/types";

const COMPONENT: Record<HygieneAction, number> = { close: 22, delete: 24 };
const GATE: Record<HygieneAction, string> = { close: "LISTING_CLOSE_LIVE", delete: "LISTING_DELETE_LIVE" };
const actionOf = (v: unknown): HygieneAction | null => (v === "close" || v === "delete" ? v : null);

export function createListingHygieneRouter(deps: { query?: QueryLike; env?: () => NodeJS.ProcessEnv } = {}): Router {
  const query = deps.query ?? (defaultQuery as any as QueryLike);
  const env = deps.env ?? (() => process.env);
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
      const n = Number((await query(
        `SELECT count(*)::int AS n FROM listing_actions WHERE job_id = $1 AND action = $2 AND status = 'held' AND NOT (evidence ? 'release')`,
        [jobId, action],
      )).rows[0]?.n ?? 0);
      if (n === 0) { res.status(409).json({ error: "nothing_held", message: `job #${jobId} has no held ${action} candidates left` }); return; }
      const job = await enqueueJob({
        trigger: "manual", includeDaily: false, components: [COMPONENT[action]], scopeAsins: null,
        params: { listing_hygiene: { action, mode: "release", release_of_job: jobId } },
        requestedBy: req.session?.userId ?? null,
      }, query);
      res.status(202).json({ job, held: n, ahead: laneAhead(job, await listActive(query)) });
    } catch (err: any) {
      res.status(500).json({ error: "enqueue_failed", message: err?.message ?? String(err) });
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
