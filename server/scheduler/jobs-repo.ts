// jobs table access (SPEC §11 "Refresh job"). Express-free; injected query.
import { query as defaultQuery } from "../db";
import type { JobRow, JobTrigger, JobTarget, JobProgress, JobSummary, QueryLike, ComponentResult, Lane } from "./types";
import { LANE_TRIGGERS, laneOf } from "./types";

const COLS = `id, kind, trigger, target, bulk_list_id, include_daily, scope_asins, components, params, status, progress, summary,
              requested_by, queued_at, started_at, finished_at, error`;

function toRow(r: any): JobRow {
  return {
    ...r,
    id: Number(r.id),
    include_daily: r.include_daily === true,
    components: Array.isArray(r.components) && r.components.length > 0 ? r.components.map((n: any) => Number(n)) : null,
    params: r.params && typeof r.params === "object" ? r.params : null,
    progress: (r.progress && typeof r.progress === "object") ? { done: [], ...r.progress } : { done: [] },
    requested_by: r.requested_by == null ? null : Number(r.requested_by),
  };
}

export interface EnqueueInput {
  trigger: JobTrigger;
  target?: JobTarget;
  bulkListId?: string | null;
  includeDaily: boolean;
  /** NULL = the scheduled scope rule (active + parked). */
  scopeAsins?: string[] | null;
  /** Component numbers to run; omitted/NULL = the whole sequence (decision 9 jobs pass [8] or [9]). */
  components?: number[] | null;
  /** Per-job parameters (migration 054), e.g. { sales_window: { from, to } }. */
  params?: Record<string, any> | null;
  requestedBy?: number | null;
}

export async function enqueueJob(input: EnqueueInput, query: QueryLike = defaultQuery as any): Promise<JobRow> {
  const r = await query(
    `INSERT INTO jobs (kind, trigger, target, bulk_list_id, include_daily, scope_asins, components, params, requested_by)
     VALUES ('refresh', $1, $2, $3, $4, $5, $6, $7::jsonb, $8) RETURNING ${COLS}`,
    [input.trigger, input.target ?? "main", input.bulkListId ?? null, input.includeDaily,
     input.scopeAsins ?? null, input.components && input.components.length > 0 ? input.components : null,
     input.params ? JSON.stringify(input.params) : null, input.requestedBy ?? null],
  );
  return toRow(r.rows[0]);
}

/**
 * Claim the next job of ONE LANE to run on the given client, inside a
 * transaction: that lane's `running` job first (resume after a restart),
 * else its oldest `queued`. FOR UPDATE SKIP LOCKED so an overlapping
 * instance never claims the same row. Two running rows — one per lane —
 * are normal.
 */
export async function claimNextJob(query: QueryLike, lane: Lane): Promise<JobRow | null> {
  await query("BEGIN");
  try {
    const r = await query(
      `SELECT ${COLS} FROM jobs
        WHERE status IN ('running','queued') AND trigger = ANY($1::text[])
        ORDER BY (status = 'running') DESC, queued_at ASC, id ASC
        LIMIT 1 FOR UPDATE SKIP LOCKED`,
      [Array.from(LANE_TRIGGERS[lane])],
    );
    if (r.rows.length === 0) { await query("COMMIT"); return null; }
    const job = toRow(r.rows[0]);
    const u = await query(
      `UPDATE jobs SET status = 'running', started_at = COALESCE(started_at, NOW()) WHERE id = $1 RETURNING ${COLS}`,
      [job.id],
    );
    await query("COMMIT");
    return toRow(u.rows[0]);
  } catch (err) {
    await query("ROLLBACK").catch(() => {});
    throw err;
  }
}

export async function writeProgress(id: number, progress: JobProgress, query: QueryLike = defaultQuery as any): Promise<void> {
  await query(`UPDATE jobs SET progress = $2::jsonb WHERE id = $1`, [id, JSON.stringify(progress)]);
}

export async function readStatus(id: number, query: QueryLike = defaultQuery as any): Promise<string | null> {
  const r = await query(`SELECT status FROM jobs WHERE id = $1`, [id]);
  return r.rows[0]?.status ?? null;
}

export async function finishJob(
  id: number,
  status: "done" | "failed" | "cancelled",
  summary: JobSummary,
  error: string | null,
  query: QueryLike = defaultQuery as any,
): Promise<void> {
  await query(
    `UPDATE jobs SET status = $2, summary = $3::jsonb, error = $4, finished_at = NOW() WHERE id = $1`,
    [id, status, JSON.stringify(summary), error],
  );
}

/** Cancel: only a queued or running job; the runner honours it at its next checkpoint. */
export async function cancelJob(id: number, query: QueryLike = defaultQuery as any): Promise<JobRow | null> {
  const r = await query(
    `UPDATE jobs SET status = 'cancelled', finished_at = CASE WHEN status = 'queued' THEN NOW() ELSE finished_at END
      WHERE id = $1 AND status IN ('queued','running') RETURNING ${COLS}`,
    [id],
  );
  return r.rows[0] ? toRow(r.rows[0]) : null;
}

/** Promote a still-queued job to carry the daily block (the 00:00 tick finding an hourly pass already queued). */
export async function setIncludeDaily(id: number, query: QueryLike = defaultQuery as any): Promise<JobRow | null> {
  const r = await query(`UPDATE jobs SET include_daily = TRUE WHERE id = $1 AND status = 'queued' RETURNING ${COLS}`, [id]);
  return r.rows[0] ? toRow(r.rows[0]) : null;
}

export async function getJob(id: number, query: QueryLike = defaultQuery as any): Promise<JobRow | null> {
  const r = await query(`SELECT ${COLS} FROM jobs WHERE id = $1`, [id]);
  return r.rows[0] ? toRow(r.rows[0]) : null;
}

export async function listJobs(limit = 50, query: QueryLike = defaultQuery as any): Promise<JobRow[]> {
  const r = await query(`SELECT ${COLS} FROM jobs ORDER BY queued_at DESC, id DESC LIMIT $1`, [limit]);
  return r.rows.map(toRow);
}

/** Running + queued, oldest first — the "current" view and queue positions. */
export async function listActive(query: QueryLike = defaultQuery as any): Promise<JobRow[]> {
  const r = await query(
    `SELECT ${COLS} FROM jobs WHERE status IN ('running','queued')
      ORDER BY (status = 'running') DESC, queued_at ASC, id ASC`,
  );
  return r.rows.map(toRow);
}

/** Queue position of a lane M job: lane M jobs running or queued ahead of it. Lane S never counts. */
export function laneAhead(job: JobRow, active: JobRow[]): number {
  return active.filter((j) => j.id !== job.id && laneOf(j.trigger) === "M" && (j.status === "running" || j.queued_at < job.queued_at)).length;
}

/** ASINs already covered by a queued or running onboarding job. */
export async function asinsCoveredByActiveOnboarding(query: QueryLike = defaultQuery as any): Promise<Set<string>> {
  const r = await query(`SELECT unnest(scope_asins) AS asin FROM jobs WHERE trigger = 'onboarding' AND status IN ('queued','running')`);
  return new Set(r.rows.map((x: any) => String(x.asin)));
}

/**
 * Enqueue ONE onboarding job for `asins`, dropping any ASIN a queued or
 * running onboarding job already covers (belt and braces against two
 * lanes discovering the same ASIN). Returns the job, or null when nothing
 * was left to enqueue, plus what was dropped.
 */
/** Onboarding dedupe window (2026-10-18): the same ASIN set within this many minutes is refused. */
export const ONBOARDING_DEDUPE_MINUTES = 10;

/**
 * An onboarding job for EXACTLY this ASIN set (order and case ignored) queued in the
 * last ONBOARDING_DEDUPE_MINUTES, in any status — the same upload sent again (a stale
 * tab resent one 11-ASIN upload as jobs 59–68 on 2026-10-18). Null when none.
 */
export async function findRecentSameOnboarding(asins: readonly string[], query: QueryLike = defaultQuery as any): Promise<{ id: number; status: string; queued_at: Date } | null> {
  const set = Array.from(new Set(asins.map((a) => String(a).trim().toUpperCase()).filter(Boolean))).sort();
  if (set.length === 0) return null;
  const r = await query(
    `SELECT id, status, queued_at FROM jobs
      WHERE trigger = 'onboarding' AND queued_at > NOW() - make_interval(mins => $2)
        AND (SELECT array_agg(x ORDER BY x) FROM unnest(scope_asins) x) = $1::text[]
      ORDER BY id DESC LIMIT 1`,
    [set, ONBOARDING_DEDUPE_MINUTES],
  );
  const row = r.rows[0];
  return row && Number.isInteger(Number(row.id)) && Number(row.id) > 0 ? { id: Number(row.id), status: String(row.status), queued_at: row.queued_at } : null;
}

export async function enqueueOnboardingJob(
  asins: string[],
  opts: { requestedBy?: number | null } = {},
  query: QueryLike = defaultQuery as any,
): Promise<{ job: JobRow | null; enqueued: string[]; covered: string[]; duplicateOf?: number }> {
  const wanted = Array.from(new Set(asins.map((a) => String(a).trim().toUpperCase()).filter(Boolean)));
  if (wanted.length === 0) return { job: null, enqueued: [], covered: [] };
  const dup = await findRecentSameOnboarding(wanted, query);
  if (dup) return { job: null, enqueued: [], covered: wanted, duplicateOf: dup.id };
  const already = await asinsCoveredByActiveOnboarding(query);
  const enqueued = wanted.filter((a) => !already.has(a));
  const covered = wanted.filter((a) => already.has(a));
  if (enqueued.length === 0) return { job: null, enqueued, covered };
  const job = await enqueueJob({ trigger: "onboarding", includeDaily: true, scopeAsins: enqueued, requestedBy: opts.requestedBy ?? null }, query);
  return { job, enqueued, covered };
}

/** Per-component ledger row (refresh_runs), linked to the job. */
export async function recordComponentRun(
  input: {
    jobId: number; trigger: JobTrigger; stage: string; scope: string; requested: number;
    startedAt: Date; result: ComponentResult | null; error: string | null;
  },
  query: QueryLike = defaultQuery as any,
): Promise<void> {
  await query(
    `INSERT INTO refresh_runs (started_at, finished_at, trigger, stage, scope, requested, counts, outcomes, error, job_id)
     VALUES ($1, NOW(), $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9)`,
    [input.startedAt, input.trigger, input.stage, input.scope, input.requested,
     JSON.stringify(input.result?.counts ?? {}), JSON.stringify(input.result?.outcomes ?? {}), input.error, input.jobId],
  );
}

export async function listComponentRuns(jobId: number, query: QueryLike = defaultQuery as any): Promise<any[]> {
  const r = await query(
    `SELECT id, started_at, finished_at, stage, scope, requested, counts, outcomes, error
       FROM refresh_runs WHERE job_id = $1 ORDER BY started_at, id`,
    [jobId],
  );
  return r.rows;
}
