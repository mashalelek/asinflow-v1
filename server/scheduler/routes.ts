// Job routes (SPEC §11 "Refresh job"). Mounted behind requireAuth.
//   POST  /api/jobs              enqueue a manual refresh { asins?, includeDaily? }
//   GET   /api/jobs/current      { scheduled, manual, queued } — one running job per lane (the client polls this)
//   GET   /api/jobs              recent jobs (history dialog)
//   GET   /api/jobs/:id          one job + its per-component ledger rows
//   PATCH /api/jobs/:id          { status: 'cancelled' }
//   POST  /api/jobs/backfill-sales / backfill-ledger   admin: one-component backfill jobs
import express, { type Router, type Request, type Response } from "express";
import { query as defaultQuery } from "../db";
import { enqueueJob, listActive, listJobs, getJob, listComponentRuns, cancelJob, laneAhead } from "./jobs-repo";
import { requireRole } from "../auth";
import type { QueryLike } from "./types";
import { todayEt } from "../ledger-sync";

/** 18 months back (548 days) to yesterday, America/New_York. */
export function defaultLedgerBackfillWindow(now: Date = new Date()): { from: string; to: string } {
  const day = (ymd: string, d: number) => { const t = new Date(`${ymd}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + d); return t.toISOString().slice(0, 10); };
  const to = day(todayEt(now), -1);
  return { from: day(to, -547), to };
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;
/** Validate a backfill window: YYYY-MM-DD pair, from ≤ to, to ≤ today (local). */
export function parseBackfillWindow(body: any, today: string): { from: string; to: string } | { error: string } {
  const from = String(body?.from ?? "");
  const to = String(body?.to ?? "");
  if (!YMD.test(from) || !YMD.test(to)) return { error: "from and to must be YYYY-MM-DD" };
  if (from > to) return { error: "from must not be after to" };
  if (to > today) return { error: `to must not be after today (${today})` };
  return { from, to };
}

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
      const ahead = laneAhead(job, await listActive(query)); // lane M only
      res.status(201).json({ job, ahead });
    } catch (err: any) {
      res.status(500).json({ error: "enqueue_failed", message: err?.message ?? String(err) });
    }
  });

  // Sales history backfill (2026-10-16): admin-only. ONE manual job running
  // component 19 alone over params.sales_window, serialized behind the
  // hourly passes like any job. Writes sales_daily units/revenue (and the
  // jobs row); ASINs the report names that AF lacks are onboarded by the
  // component. No UI button — `npm run backfill:sales` or this route.
  router.post("/api/jobs/backfill-sales", requireRole("admin"), async (req: Request, res: Response) => {
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const w = parseBackfillWindow(req.body, today);
    if ("error" in w) { res.status(400).json({ error: "invalid_window", message: w.error }); return; }
    try {
      const job = await enqueueJob({
        trigger: "manual", includeDaily: false, components: [19], scopeAsins: null,
        params: { sales_window: { from: w.from, to: w.to } },
        requestedBy: req.session?.userId ?? null,
      }, query);
      const ahead = laneAhead(job, await listActive(query)); // lane M only
      res.status(202).json({ job, ahead });
    } catch (err: any) {
      res.status(500).json({ error: "enqueue_failed", message: err?.message ?? String(err) });
    }
  });

  // Inventory Ledger backfill (listing hygiene, 2026-10-19): admin-only. ONE
  // manual job running component 23 alone over params.ledger_window — 92-day
  // chunks, spaced for the report quota, QuotaExceeded retried on the same
  // chunk. Default window: 18 months back to yesterday. No UI button —
  // `npm run backfill:ledger` or this route.
  router.post("/api/jobs/backfill-ledger", requireRole("admin"), async (req: Request, res: Response) => {
    const def = defaultLedgerBackfillWindow();
    const w = parseBackfillWindow({ from: req.body?.from ?? def.from, to: req.body?.to ?? def.to }, todayEt());
    if ("error" in w) { res.status(400).json({ error: "invalid_window", message: w.error }); return; }
    try {
      const job = await enqueueJob({
        trigger: "manual", includeDaily: false, components: [23], scopeAsins: null,
        params: { ledger_window: { from: w.from, to: w.to } },
        requestedBy: req.session?.userId ?? null,
      }, query);
      const ahead = laneAhead(job, await listActive(query));
      res.status(202).json({ job, ahead });
    } catch (err: any) {
      res.status(500).json({ error: "enqueue_failed", message: err?.message ?? String(err) });
    }
  });

  // GET /api/jobs/scheduler (read-only API): enabled, next pass, last scheduled job.
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
      // Two lanes (2026-10-16): the scheduled pass and the lane M job
      // (manual / onboarding / bulk) can both be running. `queued` carries
      // both lanes' waiting jobs; the client counts lane M positions itself.
      const active = await listActive(query);
      res.json({
        scheduled: active.find((j) => j.status === "running" && j.trigger === "scheduled") ?? null,
        manual: active.find((j) => j.status === "running" && j.trigger !== "scheduled") ?? null,
        queued: active.filter((j) => j.status === "queued"),
      });
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
