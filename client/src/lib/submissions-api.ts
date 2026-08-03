// Client API + view helpers for the post-submit verification system.
// Endpoints: server/routes.ts (/api/submissions/*).

export type VerifyStatus =
  | "pending" | "processing" | "live" | "failed" | "stale" | "deleted";

export interface SubmissionIssue {
  code: string;
  severity: string;
  message: string;
  enforcementActions?: string[];
}

export interface SubmissionRow {
  id: string;
  asin: string;
  sku: string;
  verify_status: VerifyStatus;
  verdict_source: "api" | "manual" | null;
  submitted_at: string;
  verified_at: string | null;
  issues: SubmissionIssue[] | null;
  review_flags: string[];
  terminal_conflict: boolean;
  flags_acknowledged_at?: string | null; // §19 dismiss — set = acknowledged
}

export interface UnverifiedResponse {
  // §19: non-terminal + unacknowledged attention-terminal (failed / flagged-live)
  count: number;
  needsAttention: SubmissionRow[]; // stale / unacked failed / unacked live-with-flags
  inFlight: SubmissionRow[]; // pending / processing (individually resolvable)
}

export interface VerifySummary {
  checked: number; live: number; failed: number;
  processing: number; stale: number; throttled: number;
}

export type ManualVerdict = "live" | "failed" | "deleted";

export async function getUnverified(): Promise<UnverifiedResponse> {
  const r = await fetch("/api/submissions/unverified");
  if (!r.ok) throw new Error(`unverified fetch failed (${r.status})`);
  return r.json();
}

export async function verifySubmissions(): Promise<{ summary: VerifySummary; needsAttention: SubmissionRow[] }> {
  const r = await fetch("/api/submissions/verify", { method: "POST" });
  if (!r.ok) throw new Error(`verify failed (${r.status})`);
  return r.json();
}

// Returns the HTTP status so callers can treat 409 (already resolved) as a
// benign refresh rather than an error.
export async function resolveSubmission(
  id: string,
  verdict: ManualVerdict,
): Promise<{ status: number; error?: string }> {
  const r = await fetch(`/api/submissions/${id}/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ verdict }),
  });
  if (r.ok) return { status: r.status };
  const body = await r.json().catch(() => ({}));
  return { status: r.status, error: body?.error };
}

// §19 bulk manual verdicts — already-terminal rows come back in `skipped`.
export async function resolveSubmissionsBulk(
  ids: string[],
  verdict: ManualVerdict,
): Promise<{ resolved: string[]; skipped: Array<{ id: string; reason: string }> }> {
  const r = await fetch("/api/submissions/resolve-bulk", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids, verdict }),
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body?.error ?? `bulk resolve failed (${r.status})`);
  }
  return r.json();
}

// §19 dismiss (acknowledge) — terminal rows only; non-terminal ids → skipped.
export async function dismissSubmissionFlags(
  ids: string[],
): Promise<{ dismissed: string[]; skipped: string[] }> {
  const r = await fetch("/api/submissions/dismiss-flags", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids }),
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body?.error ?? `dismiss failed (${r.status})`);
  }
  return r.json();
}

// §6 Submission column: categorical value for filtering/sorting.
// "failed" > "flags" > "clean" > "none". Acknowledged flags STILL count as
// "flags" — acknowledgment mutes the render, never the category (§6/§19).
export type SubmissionCategory = "failed" | "flags" | "clean" | "none";
export function submissionCategory(sub: {
  latest: { status: string; issues: any[]; reviewFlags: string[]; terminalConflict: boolean } | null;
} | null | undefined): SubmissionCategory {
  const latest = sub?.latest;
  if (!latest) return "none";
  if (latest.status === "failed") return "failed";
  if ((latest.issues?.length ?? 0) > 0 || (latest.reviewFlags?.length ?? 0) > 0 || latest.terminalConflict) {
    return "flags";
  }
  return "clean";
}

// ── View helpers ────────────────────────────────────────────────────────────

export const isNonTerminal = (s: VerifyStatus): boolean =>
  s === "pending" || s === "processing" || s === "stale";

const hasCode = (row: SubmissionRow, code: string): boolean =>
  (row.issues ?? []).some((i) => String(i.code) === code);

export type Treatment = "restricted" | "price" | "check";

// Precedence b → a → c (adjustment 2: treatment "price" fires on 18555 CODE
// only; a terminal_conflict without 18555 is a genuine anomaly → "check").
export function treatmentOf(row: SubmissionRow): Treatment {
  if (row.verify_status === "failed" && (hasCode(row, "5886") || hasCode(row, "13013"))) {
    return "restricted"; // b — sourcing verdict
  }
  if (hasCode(row, "18555")) return "price"; // a — expected reprice noise
  return "check"; // c — amber (stale, 100893, terminal_conflict sans 18555, other failed)
}
