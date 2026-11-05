// Step failures (Maria 2026-11-05): a step that failed is marked failed in its job, with the reason — never "done" with
// the failures only in its outcome details (the 14-day sweep found PO documents failing 23 passes and Fees every pass,
// all under jobs that read "done").
//
// A step failed when, after the component's own retries:
//   - a whole call failed — an `error:` note on a non-ASIN key (`_ingest`, `_documents`, a 29 failure row), or a
//     failure counter (error / errors / failed / push_failed / chunks_failed / transient / sc_list_incomplete /
//     skip_probe_transient — 24's whole pass held for stale inputs, counted per SKU) larger
//     than the failures its outcomes name; or
//   - any ASIN's failure (`error: …`, `skipped_transient`, `skip_probe_transient`) is NOT known-persistent.
// Known-persistent: the same ASIN with the same outcome in this pass and the two scheduled passes before it (3 in a
// row). Those are listed on the job ("27 ASINs without fees") and do not fail the step; an ASIN leaves the list the
// moment it succeeds, because its streak breaks. No percentage threshold.
// Not failures: bad data (10 Prices `invalid_asin: …`, 19 Sales' skipped "UNKNOW") and the by-design skip_* reasons —
// neither matches the patterns below.
//
// The step's failure goes in the job summary (failedSteps) and the ledger row's outcomes (`_step_failed`), not in
// refresh_runs.error: listing hygiene reads that column as "this data cannot be trusted" (16_live_offer, 23_ledger), and
// one transient ASIN must not stop a night's closes and deletes. The job keeps running; its later steps still run.
import type { ComponentDef, ComponentResult, JobRow, QueryLike } from "./types";

export interface StepFailure { n: number; key: string; name: string; count: number; reason: string }
export interface PersistentList { label: string; asins: Array<{ asin: string; outcome: string }> }

const ASIN_KEY = /^[A-Z0-9]{10}$/;
export const ASIN_FAILURE = /^(?:error\b|skipped_transient\b|skip_probe_transient\b)/;
export const FAILURE_COUNTS: readonly string[] = ["error", "errors", "failed", "push_failed", "chunks_failed", "transient", "sc_list_incomplete", "skip_probe_transient"];
/** How many passes in a row (this one included) make an ASIN's failure known-persistent. */
export const PERSISTENT_PASSES = 3;

const PERSISTENT_LABEL: Record<string, string> = {
  "02_catalog": "without catalog data", "07_hazmat": "without hazmat data", "10_prices": "without prices",
  "13_fees": "without fees", "16_live_offer": "without a listing check",
};
export const persistentLabel = (key: string, n: number) => `${n} ASIN${n === 1 ? "" : "s"} ${PERSISTENT_LABEL[key] ?? "failing every pass"}`;

/** Pure: what failed in a step's result — per ASIN, the non-ASIN notes, and the counters' total. */
export function failuresOf(result: ComponentResult): { asins: Map<string, string>; notes: string[]; counted: number } {
  const asins = new Map<string, string>(), notes: string[] = [];
  for (const [k, v] of Object.entries(result.outcomes ?? {})) {
    const s = String(v);
    if (ASIN_KEY.test(k)) { if (ASIN_FAILURE.test(s)) asins.set(k, s); continue; }
    if (k.startsWith("_step_") || k === "_persistent") continue;
    if (/^error\b/i.test(s) || k.startsWith("failed ")) notes.push(`${k.replace(/^_/, "")}: ${s.split("\n")[0].slice(0, 200)}`);
  }
  let counted = 0;
  for (const k of FAILURE_COUNTS) { const c = Number(result.counts?.[k] ?? 0); if (Number.isFinite(c) && c > 0) counted += c; }
  return { asins, notes, counted };
}

/** Pure: the step's verdict given which failing ASINs are known-persistent. */
export function judgeStep(def: Pick<ComponentDef, "n" | "key" | "name">, result: ComponentResult, persistentAsins: ReadonlySet<string>): { failure: StepFailure | null; persistent: PersistentList | null } {
  const f = failuresOf(result);
  const fresh = Array.from(f.asins).filter(([a]) => !persistentAsins.has(a));
  const known = Array.from(f.asins).filter(([a]) => persistentAsins.has(a));
  const unattributed = Math.max(0, f.counted - f.asins.size - f.notes.length);
  const persistent = known.length ? { label: persistentLabel(def.key, known.length), asins: known.map(([asin, outcome]) => ({ asin, outcome })).sort((a, b) => a.asin.localeCompare(b.asin)) } : null;
  const count = fresh.length + f.notes.length + unattributed;
  if (!count) return { failure: null, persistent };
  const by = new Map<string, number>();
  for (const [, o] of fresh) by.set(o, (by.get(o) ?? 0) + 1);
  const parts = [
    ...f.notes,
    ...Array.from(by).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([o, n]) => `${n} ASIN${n === 1 ? "" : "s"}: ${o.slice(0, 160)}`),
    ...(by.size > 3 ? [`${by.size - 3} more kinds`] : []),
    ...(unattributed ? [`${unattributed} failure${unattributed === 1 ? "" : "s"} with no ASIN named`] : []),
  ];
  return { failure: { n: def.n, key: def.key, name: def.name, count, reason: parts.join("; ") }, persistent };
}

/**
 * The failing ASINs that failed the same way in the two scheduled passes before this job (3 in a row with this one).
 * A history read that fails counts nothing as persistent — the step then fails, never the other way round.
 */
export async function persistentAsins(query: QueryLike, stage: string, job: Pick<JobRow, "id">, failing: ReadonlyMap<string, string>): Promise<Set<string>> {
  if (!failing.size) return new Set();
  const keys = Array.from(failing.keys());
  try {
    const rows = (await query(
      `SELECT (SELECT jsonb_object_agg(k, rr.outcomes -> k) FROM unnest($3::text[]) k WHERE rr.outcomes ? k) AS o
         FROM refresh_runs rr JOIN jobs j ON j.id = rr.job_id
        WHERE rr.stage = $1 AND j.trigger = 'scheduled' AND rr.job_id <> $2
        ORDER BY rr.started_at DESC LIMIT ${PERSISTENT_PASSES - 1}`, [stage, job.id, keys])).rows as Array<{ o: Record<string, string> | null }>;
    if (rows.length < PERSISTENT_PASSES - 1) return new Set();
    return new Set(keys.filter((a) => rows.every((r) => r.o?.[a] === failing.get(a))));
  } catch { return new Set(); }
}

export async function assessStep(query: QueryLike, def: ComponentDef, job: JobRow, result: ComponentResult): Promise<{ failure: StepFailure | null; persistent: PersistentList | null }> {
  return judgeStep(def, result, await persistentAsins(query, def.key, job, failuresOf(result).asins));
}

/** The ledger notes of a judged step (kept out of failuresOf's own count). */
export function stepNotes(j: { failure: StepFailure | null; persistent: PersistentList | null }): Record<string, string> {
  const o: Record<string, string> = {};
  if (j.failure) o._step_failed = j.failure.reason;
  if (j.persistent) o._persistent = `${j.persistent.label} (known-persistent: same outcome ${PERSISTENT_PASSES} passes in a row; not counted as a failure)`;
  return o;
}
