// Enqueue a job and wait for it (SPEC §11 "Refresh job", decision 9).
//
// Add to SC probes gating live for its selection and Push to Aura reads the
// PO sheet for its selection first. Neither calls SP-API or the sheet
// directly — "nothing refreshes data outside the queue" — so each enqueues a
// tiny manual job that runs ONE component (8 or 9) for the selection, and
// waits here for it. If a scheduled pass is running the job queues behind it
// and the caller waits; the queue is the lock, and the log says so.
//
// Express-free; injected query, clock and sleep so the tests drive it.
import { query as defaultQuery } from "../db";
import { enqueueJob, getJob, cancelJob, listActive, type EnqueueInput } from "./jobs-repo";
import type { JobRow, QueryLike } from "./types";

export const AWAIT_POLL_MS = 2_000;
/** A gating or PO-sheet job for a selection takes seconds; the wait is for the pass ahead of it. */
export const AWAIT_TIMEOUT_MS = 60 * 60_000;

export interface AwaitJobOptions {
  query?: QueryLike;
  pollMs?: number;
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Called when the job's visible state changes: queued (n ahead) → running component → finished. */
  onStatus?: (status: string, job: JobRow) => void;
}

export class JobFailedError extends Error {
  constructor(public readonly job: JobRow, message: string) { super(message); }
}

/** Human-readable state of a job for logs and heartbeats. */
export function describeJobState(job: JobRow, ahead: number): string {
  if (job.status === "queued") return ahead > 0 ? `queued (${ahead} ahead)` : "queued";
  if (job.status === "running") {
    const p = job.progress ?? { done: [] };
    const pos = p.position != null && p.total ? ` ${p.position}/${p.total}` : "";
    return `running component ${p.component ?? "-"}${pos}`;
  }
  return job.status;
}

/**
 * Enqueue `input` and resolve with the finished job once it is `done`.
 * Rejects with JobFailedError when the job fails or is cancelled, and
 * cancels the job then rejects when `timeoutMs` elapses first.
 */
export async function runJobAndWait(input: EnqueueInput, opts: AwaitJobOptions = {}): Promise<JobRow> {
  const query = opts.query ?? (defaultQuery as any as QueryLike);
  const pollMs = opts.pollMs ?? AWAIT_POLL_MS;
  const timeoutMs = opts.timeoutMs ?? AWAIT_TIMEOUT_MS;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const job = await enqueueJob(input, query);
  const t0 = now();
  let lastState = "";
  for (;;) {
    const cur = await getJob(job.id, query);
    if (!cur) throw new Error(`job ${job.id} vanished while waiting for it`);
    if (cur.status === "done") {
      opts.onStatus?.("done", cur);
      return cur;
    }
    if (cur.status === "failed" || cur.status === "cancelled") {
      opts.onStatus?.(cur.status, cur);
      throw new JobFailedError(cur, cur.status === "failed"
        ? `refresh job ${cur.id} failed${cur.summary?.stoppedAt ? ` at component ${cur.summary.stoppedAt}` : ""}: ${cur.error ?? "unknown error"}`
        : `refresh job ${cur.id} was cancelled`);
    }
    if (now() - t0 >= timeoutMs) {
      await cancelJob(cur.id, query);
      throw new JobFailedError(cur, `refresh job ${cur.id} did not finish within ${Math.round(timeoutMs / 60_000)} min (${describeJobState(cur, 0)}); cancelled`);
    }
    if (opts.onStatus) {
      let ahead = 0;
      if (cur.status === "queued") {
        const active = await listActive(query);
        ahead = active.filter((j) => j.id !== cur.id && (j.status === "running" || j.queued_at < cur.queued_at)).length;
      }
      const state = describeJobState(cur, ahead);
      if (state !== lastState) { lastState = state; opts.onStatus(state, cur); }
    }
    await sleep(pollMs);
  }
}
