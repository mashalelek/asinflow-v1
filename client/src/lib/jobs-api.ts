// Jobs client (SPEC §11 "Refresh job", scheduler patch commit 2). API
// wrappers plus the pure helpers the toolbar, dialog and toast use — the
// pure parts are what the unit tests cover.

export type JobTrigger = "scheduled" | "manual" | "onboarding" | "bulk";
export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface Flip { asin: string; field: "gating" | "suppression"; from: string; to: string }

export interface JobSummary {
  asins: number;
  durationMs: number;
  components: Record<string, Record<string, number>>;
  flips: Flip[];
  stoppedAt?: number;
}

export interface Job {
  id: number;
  kind: "refresh";
  trigger: JobTrigger;
  target: "main" | "bulk";
  bulk_list_id: string | null;
  include_daily: boolean;
  scope_asins: string[] | null;
  /** Explicit component list (decision 9's gating / PO-sheet jobs); null = the whole sequence. */
  components: number[] | null;
  status: JobStatus;
  progress: { component?: number; asin_cursor?: string | null; position?: number; total?: number; done: number[] };
  summary: JobSummary | null;
  requested_by: number | null;
  queued_at: string;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
}

export interface ComponentRun {
  id: string;
  started_at: string;
  finished_at: string | null;
  stage: string;
  scope: string;
  requested: number;
  counts: Record<string, number>;
  outcomes: Record<string, string>;
  error: string | null;
}

export interface SchedulerInfo {
  enabled: boolean;
  scheduleDefined: boolean;
  nextPassAt: string | null;
  lastScheduled: { id: number; status: JobStatus; started_at: string | null; finished_at: string | null; summary: JobSummary | null; error: string | null } | null;
}

// ── Component names, for labels. Keys match server/scheduler/components. ──
export const COMPONENT_LABELS: Record<number, string> = {
  1: "SC discovery", 2: "catalog", 3: "catalog-deleted", 4: "BSR", 5: "meltable", 6: "dangerous good",
  7: "hazmat", 8: "gating", 9: "PO sheet", 10: "prices", 11: "sellers", 12: "CPT", 13: "fees",
  14: "profit", 15: "inventory", 16: "listings", 17: "primary SKU", 18: "suppressions",
  19: "sales", 20: "refunds", 21: "actual fees",
};

export function componentLabel(n: number | undefined): string {
  return n == null ? "" : (COMPONENT_LABELS[n] ?? `component ${n}`);
}

/** Toolbar label while a job runs: "Refresh · prices 840/2453". */
export function runningLabel(job: Job): string {
  const p = job.progress ?? { done: [] };
  const name = componentLabel(p.component);
  const pos = p.position != null && p.total ? ` ${p.position}/${p.total}` : "";
  return `Refresh · ${name || "starting"}${pos}`;
}

/** Toolbar label for a job of ours that is waiting behind others. */
export function queuedLabel(ahead: number): string {
  return ahead <= 0 ? "Refresh · queued" : `Refresh · queued (${ahead} ahead)`;
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** Completion toast title + description (decision 16: never price counts). */
export function completionText(job: Job): { title: string; description: string } {
  const s = job.summary;
  const n = s?.asins ?? job.scope_asins?.length ?? 0;
  const dur = s ? formatDuration(s.durationMs) : "";
  const who = job.trigger === "scheduled" ? "Scheduled refresh" : "Refresh";
  if (job.status === "failed") return { title: `${who} failed`, description: job.error ?? "unknown error" };
  if (job.status === "cancelled") return { title: `${who} cancelled`, description: `${n.toLocaleString()} ASINs · stopped at ${componentLabel(s?.stoppedAt)}` };
  const flips = s?.flips?.length ?? 0;
  return {
    title: `${who} done`,
    description: `${n.toLocaleString()} ASINs · ${dur}${flips ? ` · ${flips} change${flips === 1 ? "" : "s"}` : ""}`,
  };
}

export interface FlipGroups {
  gatedToUngated: string[];
  ungatedToGated: string[];
  suppressedToUnsuppressed: string[];
  unsuppressedToSuppressed: string[];
}

/** The four lists the Changes panel shows (decision 16). Everything else is ignored. */
export function groupFlips(flips: Flip[] | undefined | null): FlipGroups {
  const g: FlipGroups = { gatedToUngated: [], ungatedToGated: [], suppressedToUnsuppressed: [], unsuppressedToSuppressed: [] };
  for (const f of flips ?? []) {
    if (f.field === "gating") {
      if (f.from === "gated" && f.to === "ungated") g.gatedToUngated.push(f.asin);
      else if (f.from === "ungated" && f.to === "gated") g.ungatedToGated.push(f.asin);
    } else if (f.field === "suppression") {
      if (f.from === "suppressed" && f.to === "unsuppressed") g.suppressedToUnsuppressed.push(f.asin);
      else if (f.from === "unsuppressed" && f.to === "suppressed") g.unsuppressedToSuppressed.push(f.asin);
    }
  }
  return g;
}

/** Retry failed (N): every ASIN with an `error:` outcome in any component of the job. */
export function failedAsinsFromRuns(runs: ComponentRun[]): string[] {
  const set = new Set<string>();
  for (const r of runs) {
    for (const [asin, o] of Object.entries(r.outcomes ?? {})) {
      if (asin.startsWith("_")) continue; // component-level notes, not ASINs
      if (String(o).startsWith("error")) set.add(asin);
    }
  }
  return Array.from(set).sort();
}

// ── API ──────────────────────────────────────────────────────────────────────
async function parse<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as any)?.message ?? (body as any)?.error ?? `HTTP ${res.status}`);
  return body as T;
}

export async function enqueueRefresh(asins: string[] | null, fetchFn: typeof fetch = fetch): Promise<{ job: Job; ahead: number }> {
  return parse(await fetchFn("/api/jobs", {
    method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ asins: asins ?? [], includeDaily: true }),
  }));
}

export async function getCurrent(fetchFn: typeof fetch = fetch): Promise<{ running: Job | null; queued: Job[] }> {
  return parse(await fetchFn("/api/jobs/current", { credentials: "same-origin" }));
}

export async function listJobs(limit = 50, fetchFn: typeof fetch = fetch): Promise<Job[]> {
  const b = await parse<{ jobs: Job[] }>(await fetchFn(`/api/jobs?limit=${limit}`, { credentials: "same-origin" }));
  return b.jobs;
}

export async function getJob(id: number, fetchFn: typeof fetch = fetch): Promise<{ job: Job; components: ComponentRun[] }> {
  return parse(await fetchFn(`/api/jobs/${id}`, { credentials: "same-origin" }));
}

export async function cancelJob(id: number, fetchFn: typeof fetch = fetch): Promise<Job> {
  const b = await parse<{ job: Job }>(await fetchFn(`/api/jobs/${id}`, {
    method: "PATCH", credentials: "same-origin", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "cancelled" }),
  }));
  return b.job;
}

export async function getSchedulerInfo(fetchFn: typeof fetch = fetch): Promise<SchedulerInfo> {
  return parse(await fetchFn("/api/jobs/scheduler", { credentials: "same-origin" }));
}

/** Window event the flips panel raises so the ASINs page can focus a row. */
export const FOCUS_ASIN_EVENT = "asinflow:focus-asin";
