// Jobs client (SPEC §11 "Refresh job", scheduler patch commit 2). API
// wrappers plus the pure helpers the toolbar, dialog and toast use — the
// pure parts are what the unit tests cover.

export type JobTrigger = "scheduled" | "manual" | "onboarding" | "bulk";
export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface Flip { asin: string; field: "gating" | "suppression"; from: string; to: string }
/** A listing AF closed (component 22) or deleted (component 24) — Amazon accepted the write. */
export interface ListingActionChange { action: "close" | "delete"; asin: string; sku: string }

export interface JobSummary {
  asins: number;
  durationMs: number;
  components: Record<string, Record<string, number>>;
  flips: Flip[];
  listingActions?: ListingActionChange[];
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
  /** Per-job parameters (migration 054), e.g. { sales_window: { from, to } } for the backfill. */
  params: Record<string, any> | null;
  status: JobStatus;
  progress: { component?: number; asin_cursor?: string | null; position?: number; total?: number; unit?: string; done: number[] };
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

// ── Component names, for labels. Keys match server/scheduler/components. ──
export const COMPONENT_LABELS: Record<number, string> = {
  1: "SC discovery", 2: "catalog", 3: "catalog-deleted", 4: "BSR", 5: "meltable", 6: "dangerous good",
  7: "hazmat", 8: "gating", 9: "PO sheet", 10: "prices", 11: "sellers", 12: "CPT", 13: "fees",
  14: "profit", 15: "inventory", 16: "listings", 17: "primary SKU", 18: "suppressions",
  19: "sales", 20: "refunds", 21: "actual fees",
  22: "close OOS listings", 23: "inventory ledger", 24: "delete dead listings",
};

export function componentLabel(n: number | undefined): string {
  return n == null ? "" : (COMPONENT_LABELS[n] ?? `component ${n}`);
}

/** "840/2453", or "chunk 3/30" when the component reports another unit (sales backfill). */
export function progressText(p: Job["progress"] | undefined): string {
  if (!p || p.position == null || !p.total) return "";
  return `${p.unit ? `${p.unit} ` : ""}${p.position}/${p.total}`;
}

/** Toolbar label while a job runs: "Refresh · prices 840/2453", "Refresh · sales chunk 3/30". */
export function runningLabel(job: Job): string {
  const p = job.progress ?? { done: [] };
  const name = componentLabel(p.component);
  const pos = progressText(p);
  return `Refresh · ${name || "starting"}${pos ? ` ${pos}` : ""}`;
}

/** The name of a one-component job's component, with the backfill called out. */
export function subsetComponentName(job: Job): string {
  const comps = job.components ?? [];
  const h = job.params?.listing_hygiene;
  return comps.map((n) => {
    if (n === 19 && job.params?.sales_window) return "sales backfill";
    if (n === 23 && job.params?.ledger_window) return "ledger backfill";
    if ((n === 22 || n === 24) && h) {
      return `${componentLabel(n)} (${h.mode === "release" ? `release #${h.release_of_job}` : h.dry_run ? "dry run" : "live"})`;
    }
    return componentLabel(n);
  }).join(" + ");
}

/**
 * Jobs-dialog kind label (2026-10-16): a full pass is "<trigger> (hourly)"
 * or "<trigger> (daily)"; a job that runs a subset of the components
 * (backfill, Add to SC, Push to Aura) is "<trigger> · <component name>"
 * with no suffix — "manual · sales backfill", "manual · gating".
 */
export function jobKindLabel(job: Job): string {
  if (job.components && job.components.length > 0) return `${job.trigger} · ${subsetComponentName(job)}`;
  return `${job.trigger} (${job.include_daily ? "daily" : "hourly"})`;
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
  const flips = changeCount(s);
  return {
    title: `${who} done`,
    description: `${n.toLocaleString()} ASINs · ${dur}${flips ? ` · ${flips} change${flips === 1 ? "" : "s"}` : ""}`,
  };
}

/** What the Changes panel lists: gating / suppression flips plus listings closed / deleted (never price counts). */
export function changeCount(s: JobSummary | null | undefined): number {
  return (s?.flips?.length ?? 0) + (s?.listingActions?.length ?? 0);
}

export interface ListingActionGroups { closed: ListingActionChange[]; deleted: ListingActionChange[] }
export function groupListingActions(list: ListingActionChange[] | undefined | null): ListingActionGroups {
  const g: ListingActionGroups = { closed: [], deleted: [] };
  for (const a of list ?? []) (a.action === "close" ? g.closed : g.deleted).push(a);
  return g;
}

/** Ledger stages whose outcomes are keyed by SKU (listing hygiene), not ASIN. */
export const HYGIENE_STAGES: Record<string, "close" | "delete"> = { "22_close_oos": "close", "24_delete_dead": "delete" };

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
    // Listing hygiene outcomes are per SKU and are not refreshable data:
    // Retry failed (a Refresh) cannot redo a close or a delete.
    if (HYGIENE_STAGES[r.stage] || r.stage === "23_ledger") continue;
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

/** One running job per lane (2026-10-16): the scheduled pass and the lane M job (manual / onboarding / bulk). */
export interface CurrentJobs { scheduled: Job | null; manual: Job | null; queued: Job[] }
export const isLaneM = (j: Job) => j.trigger !== "scheduled";

export async function getCurrent(fetchFn: typeof fetch = fetch): Promise<CurrentJobs> {
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

// ── Listing hygiene (components 22 / 24) ────────────────────────────────────
export interface ListingActionRow {
  id: number; sku: string; asin: string; action: "close" | "delete"; job_id: number | null; dry_run: boolean;
  status: "would_fire" | "held" | "accepted" | "invalid" | "error" | "verified" | "not_effective";
  evidence: Record<string, any>; submission_id: string | null; issues: any; fired_at: string; verified_at: string | null; verify_passes: number;
}
export interface HygieneActions {
  actions: ListingActionRow[];
  releasable: { close: number; delete: number };
  live: { close: boolean; delete: boolean };
}
export async function getHygieneActions(jobId: number, fetchFn: typeof fetch = fetch): Promise<HygieneActions> {
  return parse(await fetchFn(`/api/listing-hygiene/actions?job_id=${jobId}`, { credentials: "same-origin" }));
}
export async function releaseHeld(jobId: number, action: "close" | "delete", fetchFn: typeof fetch = fetch): Promise<{ job: Job; held: number }> {
  return parse(await fetchFn("/api/listing-hygiene/release", {
    method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ job_id: jobId, action }),
  }));
}

/** Pure: a hygiene ledger row's SKU outcomes grouped by outcome (clock days folded into one group), largest first. */
export function groupHygieneOutcomes(outcomes: Record<string, string> | undefined | null): Array<{ outcome: string; skus: string[] }> {
  const m = new Map<string, string[]>();
  for (const [sku, o] of Object.entries(outcomes ?? {})) {
    if (sku.startsWith("_")) continue;
    const key = String(o).startsWith("skip_clock:") ? "skip_clock" : String(o).startsWith("error") ? "error" : String(o);
    const l = m.get(key) ?? [];
    l.push(sku);
    m.set(key, l);
  }
  return Array.from(m.entries()).map(([outcome, skus]) => ({ outcome, skus: skus.sort() })).sort((a, b) => b.skus.length - a.skus.length || a.outcome.localeCompare(b.outcome));
}

// ── "Action required" (Maria 2026-10-21) ───────────────────────────────────
export interface PendingHold { job_id: number; action: "close" | "delete"; count: number; held_at: string }
export interface PendingHolds { pending: { close: PendingHold | null; delete: PendingHold | null }; live: { close: boolean; delete: boolean } }
export async function getPendingHolds(fetchFn: typeof fetch = fetch): Promise<PendingHolds> {
  return parse(await fetchFn("/api/listing-hygiene/pending", { credentials: "same-origin" }));
}

/** "Action required: 30 deletes held for review" — or both kinds; null when nothing is held. */
export function pendingLabel(p: PendingHolds["pending"] | null | undefined): string | null {
  const parts: string[] = [];
  const n = (c: number, w: string) => `${c} ${w}${c === 1 ? "" : "s"}`;
  if (p?.close) parts.push(n(p.close.count, "close"));
  if (p?.delete) parts.push(n(p.delete.count, "delete"));
  return parts.length ? `Action required: ${parts.join(" and ")} held for review` : null;
}

/** The breaker toast for a finished pass: "Daily pass held 60 closes / 30 deletes — review needed"; null when nothing tripped. */
export function breakerHeldText(job: Job): string | null {
  const c = job.summary?.components ?? {};
  const closes = Number(c["22_close_oos"]?.held ?? 0);
  const deletes = Number(c["24_delete_dead"]?.held ?? 0);
  if (closes + deletes === 0) return null;
  const who = job.trigger === "scheduled" ? (job.include_daily ? "Daily pass" : "Scheduled pass") : "Job";
  const parts = [closes ? `${closes} close${closes === 1 ? "" : "s"}` : null, deletes ? `${deletes} delete${deletes === 1 ? "" : "s"}` : null].filter(Boolean);
  return `${who} held ${parts.join(" / ")} — review needed`;
}

/** Window event the flips panel raises so the ASINs page can focus a row. */
export const FOCUS_ASIN_EVENT = "asinflow:focus-asin";
