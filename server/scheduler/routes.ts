// Job routes (SPEC §11 "Refresh job"). Mounted behind requireAuth.
//   POST  /api/jobs              enqueue a manual refresh { asins?, includeDaily? }
//   GET   /api/jobs/current      running + queued (the client polls this)
//   GET   /api/jobs              recent jobs (history dialog)
//   GET   /api/jobs/:id          one job + its per-component ledger rows
//   PATCH /api/jobs/:id          { status: 'cancelled' }
import express, { type Router, type Request, type Response } from "express";
import { query as defaultQuery } from "../db";
import { enqueueJob, listActive, listJobs, getJob, listComponentRuns, cancelJob } from "./jobs-repo";
import type { QueryLike } from "./types";

export function createJobsRouter(deps: { query?: QueryLike; nextPassAt?: () => Promise<string | null> } = {}): Router {
  const query = deps.query ?? (defaultQuery as any as QueryLike);
  const router = express.Router();

  router.post("/api/jobs", async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { asins?: unknown; includeDaily?: unknown };
    const asins = Array.isArray(body.asins) ? body.asins.filter((a) => typeof a === "string").map((a) => String(a).trim().toUpperCase()).filter(Boolean) : [];
    // A manual Refresh runs everything (decision 4): the daily block included
    // unless the caller says otherwise.
    const includeDaily = body.includeDaily === undefined ? true : body.includeDaily === true;
    try {
      const job = await enqueueJob({
        trigger: "manual", includeDaily,
        scopeAsins: asins.length > 0 ? asins : null,
        requestedBy: req.session?.userId ?? null,
      }, query);
      const active = await listActive(query);
      const ahead = active.filter((j) => j.id !== job.id && (j.status === "running" || j.queued_at < job.queued_at)).length;
      res.status(201).json({ job, ahead });
    } catch (err: any) {
      res.status(500).json({ error: "enqueue_failed", message: err?.message ?? String(err) });
    }
  });

  // Settings → Scheduler (read-only): enabled, next pass, last scheduled job.
  // nextPassAt is filled by the schedule definition (commit 5 of the patch);
  // until then it is null and `scheduleDefined` says so.
  router.get("/api/jobs/scheduler", async (_req: Request, res: Response) => {
    try {
      const enabled = process.env.ENABLE_CRONS === "true";
      const last = (await query(
        `SELECT id, status, started_at, finished_at, summary, error FROM jobs WHERE trigger = 'scheduled' ORDER BY queued_at DESC LIMIT 1`,
      )).rows[0] ?? null;
      const nextPassAt = (deps as any).nextPassAt ? await (deps as any).nextPassAt() : null;
      res.json({ enabled, scheduleDefined: !!(deps as any).nextPassAt, nextPassAt, lastScheduled: last });
    } catch (err: any) {
      res.status(500).json({ error: "jobs_failed", message: err?.message ?? String(err) });
    }
  });

  router.get("/api/jobs/current", async (_req: Request, res: Response) => {
    try {
      const active = await listActive(query);
      res.json({ running: active.find((j) => j.status === "running") ?? null, queued: active.filter((j) => j.status === "queued") });
    } catch (err: any) {
      res.status(500).json({ error: "jobs_failed", message: err?.message ?? String(err) });
    }
  });

  router.get("/api/jobs", async (req: Request, res: Response) => {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 50) || 50));
    try { res.json({ jobs: await listJobs(limit, query) }); }
    catch (err: any) { res.status(500).json({ error: "jobs_failed", message: err?.message ?? String(err) }); }
  });

  router.get("/api/jobs/:id", async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "invalid_id" }); return; }
    try {
      const job = await getJob(id, query);
      if (!job) { res.status(404).json({ error: "not_found" }); return; }
      res.json({ job, components: await listComponentRuns(id, query) });
    } catch (err: any) { res.status(500).json({ error: "jobs_failed", message: err?.message ?? String(err) }); }
  });

  router.patch("/api/jobs/:id", async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "invalid_id" }); return; }
    const status = (req.body ?? {}).status;
    if (status !== "cancelled") { res.status(400).json({ error: "only_cancel_supported" }); return; }
    try {
      const job = await cancelJob(id, query);
      if (!job) { res.status(409).json({ error: "not_cancellable" }); return; }
      res.json({ job });
    } catch (err: any) { res.status(500).json({ error: "jobs_failed", message: err?.message ?? String(err) }); }
  });

  return router;
}
