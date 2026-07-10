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
}

export interface UnverifiedResponse {
  count: number;             // pending + processing + stale
  needsAttention: SubmissionRow[]; // failed / stale / live-with-flags
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
