// The runner (SPEC §11 "Refresh job"; patch "Runner").
//
// A single loop: claim the oldest queued job (a `running` one first, to
// resume after a restart) with FOR UPDATE SKIP LOCKED, run it, repeat; idle
// poll every 5 s. Exactly one job runs at a time per process. Advisory lock
// 7342002 is held for the runner's lifetime on a dedicated client, so an
// overlapping instance (zero-downtime deploy) waits rather than racing.
//
// Serialisation is the lock: cron-vs-button collisions cannot happen because
// there is one consumer. No per-sync mutex.
//
// NEVER import ./index here (same rule as migrate.ts and auth.ts): the
// logger is injected, and the onboarding callback the SC-discovery component
// needs is injected by index.ts from the routes layer.
import type pg from "pg";
import { COMPONENTS } from "./components";
import { resolveBulkScope, runBulkPublic, copyMainToBulk, type BulkPasses } from "./bulk";
import {
  claimNextJob, writeProgress, readStatus, finishJob, recordComponentRun,
} from "./jobs-repo";
import {
  CancelledError, ComponentError, type ComponentContext, type ComponentDef, type ComponentResult, type JobRow, type JobSummary,
  type JobProgress, type Flip, type QueryLike,
} from "./types";

export const RUNNER_LOCK_KEY = 7342002;
export const IDLE_POLL_MS = 5000;

type Logger = (message: string, source?: string) => void;
let runnerLog: Logger = (m, s = "scheduler") => console.log(`[${s}] ${m}`);
export function setRunnerLogger(fn: Logger): void { runnerLog = fn; }
const log = (m: string) => runnerLog(m, "scheduler");

export interface RunnerDeps {
  pool: pg.Pool;
  sellerId: string;
  /**
   * Functions the routes layer owns and components need, placed in every
   * job's cache under their names: `onboardScDiscoveries` (component 1)
   * and `runSheetsSync` (component 9). Injected so this module never
   * imports routes.ts.
   */
  inject?: Record<string, unknown>;
  /** Test seams. */
  components?: readonly ComponentDef[];
  bulkPasses?: BulkPasses;
  pollMs?: number;
  now?: () => number;
}

export interface RunnerHandle {
  stop: () => Promise<void>;
  /** Resolves when the current loop iteration has finished (tests). */
  idle: () => Promise<void>;
}

/** The ordered scope for a job: explicit ASINs or the scheduled rule, both ordered by asins.id. */
export async function resolveScope(job: JobRow, query: QueryLike): Promise<string[]> {
  if (job.scope_asins && job.scope_asins.length > 0) {
    const r = await query(`SELECT asin FROM asins WHERE asin = ANY($1::text[]) ORDER BY id`, [job.scope_asins]);
    return r.rows.map((x: any) => String(x.asin));
  }
  // Scheduled rule (decision 10): active + parked; dead is never touched.
  const r = await query(`SELECT asin FROM asins WHERE status IN ('active','parked') ORDER BY id`);
  return r.rows.map((x: any) => String(x.asin));
}

/**
 * Which components a job runs, in sequence order: an explicit `components`
 * list wins (decision 9's one-component jobs, tier ignored); otherwise the
 * daily block only when include_daily.
 */
export function componentsForJob(job: JobRow, all: readonly ComponentDef[] = COMPONENTS): ComponentDef[] {
  if (job.components && job.components.length > 0) {
    const want = new Set(job.components);
    return all.filter((c) => want.has(c.n));
  }
  return all.filter((c) => c.tier === "hourly" || job.include_daily);
}

/** ASINs still to do when resuming a per-ASIN / batch component at a cursor. */
export function remainingAfterCursor(scope: string[], cursor: string | null | undefined): string[] {
  if (!cursor) return scope;
  const i = scope.indexOf(cursor);
  return i < 0 ? scope : scope.slice(i + 1);
}

export async function runJob(
  job: JobRow,
  deps: { query: QueryLike; sellerId: string; components?: readonly ComponentDef[]; now?: () => number; cache?: Map<string, unknown>; inject?: Record<string, unknown>; bulkPasses?: BulkPasses },
): Promise<JobSummary> {
  const query = deps.query;
  const now = deps.now ?? Date.now;
  const t0 = now();
  const all = deps.components ?? COMPONENTS;

  // Bulk target (decision 5): the list's catalog ASINs go through the main
  // components below; the rest get the public pass against the bulk tables
  // after the loop; then main → bulk copy. Never bulk → main.
  const bulk = job.target === "bulk" ? await resolveBulkScope(job, query) : null;
  const scope = bulk ? bulk.inCatalog : await resolveScope(job, query);
  const ledgerScope = bulk ? `bulk:${bulk.listId}` : (job.scope_asins ? "subset" : "full");
  const progress: JobProgress = { done: [...(job.progress?.done ?? [])], component: job.progress?.component, asin_cursor: job.progress?.asin_cursor ?? null };
  const resumed = progress.done.length > 0 || progress.component != null;
  log(`job ${job.id} ${resumed ? "resumed" : "started"}: trigger=${job.trigger} scope=${job.scope_asins ? "subset" : "scheduled"} asins=${scope.length} daily=${job.include_daily}${job.components ? ` components=[${job.components.join(",")}]` : ""}${resumed ? ` done=[${progress.done.join(",")}] at=${progress.component ?? "-"}/${progress.asin_cursor ?? "-"}` : ""}`);

  const summary: JobSummary = { asins: bulk ? bulk.listAsins.length : scope.length, durationMs: 0, components: {}, flips: [] };
  const cache = deps.cache ?? new Map<string, unknown>();
  for (const [k, v] of Object.entries(deps.inject ?? {})) cache.set(k, v);
  // A bulk list with no catalog ASINs runs no main component at all.
  const plan = bulk && scope.length === 0 ? [] : componentsForJob(job, all);
  if (bulk) log(`job ${job.id} bulk list ${bulk.listId}: ${bulk.inCatalog.length} in catalog (main components), ${bulk.publicOnly.length} public-only`);

  for (const c of plan) {
    if (progress.done.includes(c.n)) continue;

    // Resume position: only the component the job stopped in restarts from
    // its cursor, and only for per-ASIN / batch kinds.
    const resumingThis = progress.component === c.n && (c.kind === "asin" || c.kind === "batch");
    const asins = resumingThis ? remainingAfterCursor(scope, progress.asin_cursor) : scope;
    if (!resumingThis) { progress.component = c.n; progress.asin_cursor = null; progress.position = 0; }
    progress.total = scope.length;
    progress.unit = undefined;
    await writeProgress(job.id, progress, query);

    const startedAt = new Date();
    const tc = now();
    const checkpoint = async (lastAsin: string | null) => {
      progress.component = c.n;
      progress.asin_cursor = lastAsin;
      progress.position = lastAsin ? scope.indexOf(lastAsin) + 1 : 0;
      progress.total = scope.length;
      progress.unit = undefined;
      await writeProgress(job.id, progress, query);
      if ((await readStatus(job.id, query)) === "cancelled") throw new CancelledError();
    };
    const setProgress = async (position: number, total: number, unit: string) => {
      progress.component = c.n;
      progress.position = position;
      progress.total = total;
      progress.unit = unit;
      await writeProgress(job.id, progress, query);
    };
    const ctx: ComponentContext = {
      job, query, log: (m) => log(`job ${job.id} ${c.key}: ${m}`), sellerId: deps.sellerId,
      asins, scopeAsins: scope, checkpoint, setProgress, cache,
    };

    let result: ComponentResult | null = null;
    try {
      result = await c.run(ctx);
    } catch (err: any) {
      const cancelled = err instanceof CancelledError;
      const msg = cancelled ? "cancelled" : (err?.message ?? String(err));
      // A ComponentError carries what the component did before it failed:
      // ledger it and show it in the summary alongside the error.
      const partial: ComponentResult | null = err instanceof ComponentError ? err.partial : null;
      await recordComponentRun({
        jobId: job.id, trigger: job.trigger, stage: c.key, scope: ledgerScope,
        requested: asins.length, startedAt, result: partial, error: msg,
      }, query);
      if (partial) summary.components[c.key] = partial.counts;
      summary.stoppedAt = c.n;
      summary.durationMs = now() - t0;
      if (cancelled) {
        log(`job ${job.id} cancelled at ${c.key}`);
        await finishJob(job.id, "cancelled", summary, null, query);
      } else {
        log(`job ${job.id} FAILED at ${c.key}: ${msg}`);
        await finishJob(job.id, "failed", summary, `component ${c.n} ${c.key}: ${msg}`, query);
      }
      return summary;
    }

    await recordComponentRun({
      jobId: job.id, trigger: job.trigger, stage: c.key, scope: ledgerScope,
      requested: asins.length, startedAt, result, error: null,
    }, query);
    summary.components[c.key] = result.counts;
    if (result.flips?.length) summary.flips.push(...result.flips);
    progress.done.push(c.n);
    progress.asin_cursor = null;
    await writeProgress(job.id, progress, query);
    log(`job ${job.id} ${c.key} done in ${now() - tc} ms: ${Object.entries(result.counts).map(([k, v]) => `${k}=${v}`).join(" ")}`);

    // Cancel between components too (an account-level component has no checkpoints).
    if ((await readStatus(job.id, query)) === "cancelled") {
      summary.stoppedAt = c.n;
      summary.durationMs = now() - t0;
      log(`job ${job.id} cancelled after ${c.key}`);
      await finishJob(job.id, "cancelled", summary, null, query);
      return summary;
    }
  }

  if (bulk) {
    try {
      const pub = await runBulkPublic({ job, query, listId: bulk.listId, asins: bulk.publicOnly, log: (m) => log(`job ${job.id} ${m}`), passes: deps.bulkPasses });
      for (const [k, r] of Object.entries(pub)) summary.components[k] = r.counts;
      const copied = await copyMainToBulk(bulk.listId, bulk.inCatalog, query);
      summary.components["bulk:copy"] = { copied };
      log(`job ${job.id} bulk: ${bulk.publicOnly.length} public-only refreshed, ${copied} catalog row(s) copied main → bulk`);
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      summary.stoppedAt = 22; // the bulk public pass, after the 21 components
      summary.durationMs = now() - t0;
      log(`job ${job.id} FAILED in the bulk public pass: ${msg}`);
      await finishJob(job.id, "failed", summary, `bulk public pass: ${msg}`, query);
      return summary;
    }
  }

  summary.durationMs = now() - t0;
  await finishJob(job.id, "done", summary, null, query);
  log(`job ${job.id} done in ${Math.round(summary.durationMs / 1000)} s: ${summary.asins} ASINs, ${summary.flips.length} flips`);
  return summary;
}

/**
 * Start the loop. Returns a handle; `stop()` finishes the current job's
 * current component checkpoint window and exits the loop.
 */
let runnerActive = false;
/** True once startRunner has been called in this process (and not stopped) — a job enqueued without a runner would wait forever. */
export function isRunnerActive(): boolean { return runnerActive; }

export function startRunner(deps: RunnerDeps): RunnerHandle {
  const pollMs = deps.pollMs ?? IDLE_POLL_MS;
  let stopped = false;
  runnerActive = true;
  let current: Promise<void> = Promise.resolve();
  let lockClient: pg.PoolClient | null = null;

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  const acquireLock = async (): Promise<void> => {
    for (;;) {
      if (stopped) return;
      try {
        lockClient = await deps.pool.connect();
        const r = await lockClient.query(`SELECT pg_try_advisory_lock($1) AS ok`, [RUNNER_LOCK_KEY]);
        if (r.rows[0]?.ok === true) { log(`runner lock ${RUNNER_LOCK_KEY} acquired`); return; }
        lockClient.release();
        lockClient = null;
        log(`runner lock held by another instance; retrying in ${pollMs} ms`);
      } catch (err: any) {
        log(`runner lock error: ${err?.message ?? err}; retrying`);
        if (lockClient) { lockClient.release(); lockClient = null; }
      }
      await sleep(pollMs);
    }
  };

  const loop = async () => {
    await acquireLock();
    while (!stopped) {
      let job: JobRow | null = null;
      try {
        const c = await deps.pool.connect();
        try { job = await claimNextJob((sql, params) => c.query(sql, params)); } finally { c.release(); }
      } catch (err: any) {
        log(`claim error: ${err?.message ?? err}`);
      }
      if (!job) { await sleep(pollMs); continue; }
      try {
        await runJob(job, { query: (sql, params) => deps.pool.query(sql, params), sellerId: deps.sellerId, components: deps.components, now: deps.now, inject: deps.inject });
      } catch (err: any) {
        // runJob finishes the job itself in every expected path; this is the
        // belt for an unexpected throw (e.g. a progress write failing).
        log(`job ${job.id} runner error: ${err?.message ?? err}`);
        await deps.pool.query(`UPDATE jobs SET status = 'failed', error = $2, finished_at = NOW() WHERE id = $1 AND status = 'running'`, [job.id, String(err?.message ?? err)]).catch(() => {});
      }
    }
    if (lockClient) {
      await lockClient.query(`SELECT pg_advisory_unlock($1)`, [RUNNER_LOCK_KEY]).catch(() => {});
      lockClient.release();
      lockClient = null;
    }
  };

  current = loop();
  return {
    stop: async () => { stopped = true; runnerActive = false; await current; },
    idle: () => current,
  };
}

/** Flip helper shared by components 8 and 18. */
export function flip(asin: string, field: Flip["field"], from: string, to: string): Flip {
  return { asin, field, from, to };
}
