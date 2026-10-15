// Polls GET /api/jobs/current every 10 s while any job is queued or running
// (SPEC §11 "Refresh job", decision 16), and raises a completion callback for
// jobs the user is watching: their own manual jobs, and any scheduled job
// that finishes while the tab is open.
import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrent, getJob, type Job } from "@/lib/jobs-api";

export const JOBS_POLL_MS = 10_000;

export interface JobsState {
  running: Job | null;
  queued: Job[];
  /** The newest job this tab enqueued that is still active, with its queue position. */
  mine: { job: Job; ahead: number } | null;
}

export function useJobs(onFinished: (job: Job) => void) {
  const [state, setState] = useState<JobsState>({ running: null, queued: [], mine: null });
  const mineIds = useRef<Set<number>>(new Set());
  const activeIds = useRef<Set<number>>(new Set());
  const onFinishedRef = useRef(onFinished);
  onFinishedRef.current = onFinished;

  const poll = useCallback(async () => {
    let cur: { running: Job | null; queued: Job[] };
    try { cur = await getCurrent(); } catch { return; }
    const nowActive = new Set<number>();
    if (cur.running) nowActive.add(cur.running.id);
    for (const q of cur.queued) nowActive.add(q.id);

    // Anything that was active last time and is not now has finished.
    const finished = Array.from(activeIds.current).filter((id) => !nowActive.has(id));
    activeIds.current = nowActive;
    for (const id of finished) {
      try {
        const { job } = await getJob(id);
        if (job.status === "done" || job.status === "failed" || job.status === "cancelled") {
          if (mineIds.current.has(id) || job.trigger === "scheduled") onFinishedRef.current(job);
          mineIds.current.delete(id);
        }
      } catch { /* a job that vanished entirely is not worth a toast */ }
    }

    const all = [...(cur.running ? [cur.running] : []), ...cur.queued];
    const mineActive = all.filter((j) => mineIds.current.has(j.id));
    const mineJob = mineActive[mineActive.length - 1] ?? null;
    const ahead = mineJob ? all.findIndex((j) => j.id === mineJob.id) : 0;
    setState({ running: cur.running, queued: cur.queued, mine: mineJob ? { job: mineJob, ahead } : null });
  }, []);

  // Poll immediately on mount (a scheduled pass may already be running),
  // then every 10 s only while something is active.
  useEffect(() => { void poll(); }, [poll]);
  const anyActive = state.running != null || state.queued.length > 0;
  useEffect(() => {
    if (!anyActive) return;
    const t = setInterval(() => { void poll(); }, JOBS_POLL_MS);
    return () => clearInterval(t);
  }, [anyActive, poll]);

  /** Register a job this tab enqueued, so its completion is toasted. */
  const watch = useCallback((job: Job) => {
    mineIds.current.add(job.id);
    activeIds.current.add(job.id);
    setState((s) => ({ ...s, mine: { job, ahead: (s.running ? 1 : 0) + s.queued.length } }));
    void poll();
  }, [poll]);

  return { ...state, anyActive, refresh: poll, watch };
}
