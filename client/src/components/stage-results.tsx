// Per-stage run results with expandable per-ASIN outcomes.
//
// Extracted from the Prices & Stock dialog (2026-10-07) so the Product Info
// results dialog renders through the SAME code rather than a near-copy. The
// §21/§6 one-accessor lesson applies to rendering too: two renderers for one
// shape drift, and the Product Info half would have been the one to rot.
//
// Shape is the Prices & Stock stage record — `counts` is a free-form object
// printed as "key n, key n", `outcomes` is the ASIN -> outcome map every stage
// now writes (§11, 2026-10-07). `status`, `durationMs` and `error` are
// optional: the Prices & Stock long-sync supplies them per stage, Product
// Info's stream summary does not.

export interface StageResult {
  stage: string;
  status?: string;
  durationMs?: number;
  error?: string | null;
  counts?: Record<string, unknown>;
  outcomes?: Record<string, string>;
}

/**
 * Every ASIN that Retry failed should re-ask, across all given stages.
 *
 * RETRYABLE — the run got no answer for this ASIN:
 *   error: <msg>   the call failed
 *   inconclusive   catalog's partial-batch state: the response came back
 *                  WITHOUT this ASIN and without proving its absence, so it
 *                  is fail-closed precisely so it can be asked again (§11).
 *
 * NOT retryable — the run DID get an answer, or there was nothing to ask:
 *   updated            succeeded
 *   absent             conclusive: missing from a COMPLETE batch (the DA-2
 *                      catalog-deleted signal). Re-asking cannot change it.
 *   skipped_no_price   a missing INPUT (no stored price), not a failed call.
 */
export function failedAsinsFrom(stages: StageResult[]): string[] {
  const out = new Set<string>();
  for (const s of stages) {
    for (const [asin, outcome] of Object.entries(s.outcomes ?? {})) {
      const o = String(outcome);
      if (o.startsWith("error") || o === "inconclusive") out.add(asin);
    }
  }
  return Array.from(out).sort();
}

export function StageResultsList({ stages }: { stages: StageResult[] }) {
  return (
    <>
      {stages.map((s) => (
        <details key={s.stage} className="border rounded p-2" data-testid={`stage-${s.stage}`}>
          <summary className="cursor-pointer">
            <span className={`font-semibold ${s.status === "failed" ? "text-destructive" : ""}`}>{s.stage}</span>
            {s.status ? <>{" — "}{s.status}</> : null}
            {s.error ? `: ${s.error}` : ""}
            {s.durationMs != null ? ` · ${Math.round(s.durationMs / 1000)}s` : ""}
            {" · "}
            {Object.entries(s.counts ?? {}).map(([k, v]) => `${k} ${v}`).join(", ") || "no counts"}
          </summary>
          {Object.keys(s.outcomes ?? {}).length > 0 ? (
            <div className="mt-2 max-h-48 overflow-y-auto font-mono">
              {Object.entries(s.outcomes!).map(([asin, o]) => (
                <p key={asin} className={String(o).startsWith("error") ? "text-destructive" : undefined}>
                  {asin}: {String(o)}
                </p>
              ))}
            </div>
          ) : (
            <p className="mt-2 text-muted-foreground">No per-item exceptions.</p>
          )}
        </details>
      ))}
    </>
  );
}
