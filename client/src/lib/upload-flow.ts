// Upload → onboarding → Refresh, client side (fix 2026-10-18, the 11-ASIN
// diagnosis). Pure helpers so the three rules are testable without the page.
//
// 1. A pending upload exists only until the server reports its onboarding job
//    queued; after that the Refresh button runs a normal Refresh of the
//    selection, never the upload again.
// 2. Streamed rows (the onboarding placeholders carry empty catalog / pricing)
//    merge non-empty-wins: they can add a row that is not on screen, but never
//    blank a value already displayed — so "No offers" can never come from a
//    price blanked client-side.
// 3. When any job finishes whose scope overlaps the rows on screen (or that
//    covered the whole catalog), the page refetches.
import type { AsinResult, AsinInput } from "@shared/schema";
import type { Job } from "./jobs-api";

export type RefreshPlan = { kind: "onboard_upload"; asins: AsinInput[] } | { kind: "refresh" };

/** What the Refresh button does: onboard a pending upload once, otherwise a normal Refresh. */
export function refreshPlan(pendingUpload: readonly AsinInput[]): RefreshPlan {
  return pendingUpload.length > 0 ? { kind: "onboard_upload", asins: [...pendingUpload] } : { kind: "refresh" };
}

/** A stream message that means the upload has been handed to the queue: clear the pending list, watch the job. */
export function queuedJobIdFromMessage(msg: any): number | null {
  if (msg?.type !== "job_queued") return null;
  const id = Number(msg?.data?.jobId);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** The server refused the upload as a repeat of an onboarding job from the last 10 minutes (2026-10-18). */
export function duplicateJobFromMessage(msg: any): { jobId: number; status: string } | null {
  if (msg?.type !== "job_duplicate") return null;
  const id = Number(msg?.data?.jobId);
  return Number.isInteger(id) && id > 0 ? { jobId: id, status: String(msg?.data?.status ?? "") } : null;
}

const isEmpty = (v: unknown) => v === null || v === undefined || v === "";
const isPlainObject = (v: unknown): v is Record<string, unknown> => v != null && typeof v === "object" && !Array.isArray(v);

/** Non-empty-wins merge: incoming values replace existing ones only when present; nested objects merge per key. */
export function mergeNonEmpty<T>(existing: T, incoming: T): T {
  if (!isPlainObject(existing) || !isPlainObject(incoming)) return (isEmpty(incoming) ? existing : incoming) as T;
  const out: Record<string, unknown> = { ...existing };
  for (const [k, v] of Object.entries(incoming)) {
    if (isEmpty(v)) continue;
    const cur = out[k];
    out[k] = isPlainObject(v) && isPlainObject(cur) ? mergeNonEmpty(cur, v) : v;
  }
  return out as T;
}

/** Apply one streamed result row to the on-screen rows. */
export function applyStreamedRow(rows: readonly AsinResult[], incoming: AsinResult): AsinResult[] {
  const idx = rows.findIndex((r) => r.asin === incoming.asin);
  if (idx < 0) return [...rows, incoming];
  return rows.map((r, i) => {
    if (i !== idx) return r;
    const merged = mergeNonEmpty(r, incoming);
    // A placeholder's gating "check" means "not known yet" — it never replaces a known
    // yes / no, or the gating icon would vanish until the next full load (2026-10-18).
    const known = r.eligibilityData?.status;
    if (incoming.eligibilityData?.status === "check" && (known === "yes" || known === "no")) return { ...merged, eligibilityData: r.eligibilityData };
    return merged;
  });
}

/** Does a finished job touch any row on screen? A job with no scope covered the whole catalog. */
export function jobTouchesRows(job: Pick<Job, "scope_asins">, onScreen: ReadonlySet<string>): boolean {
  if (job.scope_asins == null) return true;
  return job.scope_asins.some((a) => onScreen.has(String(a).toUpperCase()));
}
