/**
 * Jobs / history dialog (SPEC §11 "Refresh job", scheduler patch commit 2).
 * One row per job (trigger, scope size, started, duration, status),
 * expandable to per-component counts and outcome lists, plus Retry failed
 * (N) and the Changes panel (gating / suppression flips, decision 16; listings
 * closed / deleted, listing hygiene 2026-10-19), plus the hygiene panel
 * (outcomes per SKU, evidence, Release).
 * Replaces the refresh_runs history dialog.
 */
import { useCallback, useEffect, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { StageResultsList } from "@/components/stage-results";
import { ListingHygienePanel, ListingChangesPanel } from "@/components/listing-hygiene-panel";
import {
  listJobs, getJob, cancelJob, formatDuration, groupFlips, groupListingActions, changeCount, failedAsinsFromRuns, componentLabel, jobKindLabel, progressText,
  FOCUS_ASIN_EVENT, type Job, type ComponentRun, type FlipGroups,
} from "@/lib/jobs-api";

function statusVariant(s: Job["status"]): "default" | "secondary" | "destructive" | "outline" {
  if (s === "failed") return "destructive";
  if (s === "done") return "default";
  if (s === "running") return "secondary";
  return "outline";
}

function fmt(ts: string | null): string {
  if (!ts) return "—";
  const d = new Date(ts);
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function durationOf(j: Job): string {
  if (j.summary) return formatDuration(j.summary.durationMs);
  if (j.started_at && !j.finished_at) return formatDuration(Date.now() - new Date(j.started_at).getTime()) + " so far";
  if (j.started_at && j.finished_at) return formatDuration(new Date(j.finished_at).getTime() - new Date(j.started_at).getTime());
  return "—";
}

export function FlipsPanel({ groups }: { groups: FlipGroups }) {
  const rows: Array<[string, string[]]> = [
    ["Gated → ungated", groups.gatedToUngated],
    ["Ungated → gated", groups.ungatedToGated],
    ["Suppressed → clear", groups.suppressedToUnsuppressed],
    ["Clear → suppressed", groups.unsuppressedToSuppressed],
  ];
  const total = rows.reduce((n, [, l]) => n + l.length, 0);
  if (total === 0) return <p className="text-xs text-muted-foreground">No gating or suppression changes in this job.</p>;
  return (
    <div className="space-y-2 text-xs" data-testid="flips-panel">
      {rows.filter(([, l]) => l.length > 0).map(([label, list]) => (
        <div key={label}>
          <p className="font-semibold">{label} ({list.length})</p>
          <div className="flex flex-wrap gap-1 mt-1">
            {list.map((asin) => (
              <button
                key={asin}
                type="button"
                className="font-mono underline-offset-2 hover:underline text-primary"
                onClick={() => window.dispatchEvent(new CustomEvent(FOCUS_ASIN_EVENT, { detail: { asin } }))}
                title="Show this row"
              >
                {asin}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function JobsDialog({ open, onOpenChange, onRetry, initialJobId }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Enqueue a manual job for these ASINs (Retry failed). */
  onRetry: (asins: string[]) => void;
  /** Open with this job expanded (the toast's Changes link). */
  initialJobId?: number | null;
}) {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [detail, setDetail] = useState<Record<number, { job: Job; components: ComponentRun[] }>>({});

  const reload = useCallback(async () => {
    setError(null);
    try { setJobs(await listJobs(50)); }
    catch (err: any) { setError(err?.message ?? "Could not load jobs."); }
  }, []);

  useEffect(() => { if (open) { void reload(); setExpanded(initialJobId ?? null); } }, [open, reload, initialJobId]);

  useEffect(() => {
    if (expanded == null || detail[expanded]) return;
    let cancelled = false;
    getJob(expanded).then((d) => { if (!cancelled) setDetail((m) => ({ ...m, [expanded]: d })); }).catch(() => {});
    return () => { cancelled = true; };
  }, [expanded, detail]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl max-h-[85vh] overflow-y-auto" data-testid="dialog-jobs">
        <DialogHeader>
          <DialogTitle>Refresh jobs</DialogTitle>
          <DialogDescription>
            One row per job, newest first. Scheduled passes and the Refresh button are the same job with different scopes.
          </DialogDescription>
        </DialogHeader>
        {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
        {!jobs && !error && <p className="text-xs text-muted-foreground">Loading…</p>}
        {jobs && jobs.length === 0 && <p className="text-xs text-muted-foreground">No jobs yet.</p>}
        {jobs && jobs.length > 0 && (
          <div className="divide-y text-xs">
            {jobs.map((j) => {
              const isOpen = expanded === j.id;
              const d = detail[j.id];
              const groups = groupFlips(j.summary?.flips);
              const listingGroups = groupListingActions(j.summary?.listingActions);
              const flipCount = changeCount(j.summary);
              return (
                <div key={j.id} className="py-2" data-testid={`job-row-${j.id}`}>
                  <button type="button" className="w-full text-left flex items-center gap-3" onClick={() => setExpanded(isOpen ? null : j.id)}>
                    <span className="font-mono w-10 text-muted-foreground">#{j.id}</span>
                    <Badge variant={statusVariant(j.status)} className="w-20 justify-center">{j.status}</Badge>
                    <span className="w-40">{jobKindLabel(j)}</span>
                    <span className="w-28">{(j.summary?.asins ?? j.scope_asins?.length ?? (j.scope_asins ? 0 : "all"))} ASINs</span>
                    <span className="w-32 text-muted-foreground">{fmt(j.started_at ?? j.queued_at)}</span>
                    <span className="w-24">{durationOf(j)}</span>
                    {flipCount > 0 && <span className="text-amber-600">{flipCount} change{flipCount === 1 ? "" : "s"}</span>}
                    {j.status === "running" && j.progress?.component != null && (
                      <span className="text-muted-foreground">{componentLabel(j.progress.component)} {progressText(j.progress) || `${j.progress.position ?? 0}/${j.progress.total ?? "?"}`}</span>
                    )}
                    {j.error && <span className="text-destructive truncate">{j.error}</span>}
                  </button>
                  {isOpen && (
                    <div className="mt-2 pl-3 space-y-3">
                      {(j.status === "queued" || j.status === "running") && (
                        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={async () => { await cancelJob(j.id).catch(() => {}); void reload(); }} data-testid={`button-cancel-job-${j.id}`}>
                          Cancel
                        </Button>
                      )}
                      <details open={flipCount > 0}>
                        <summary className="cursor-pointer font-semibold">Changes</summary>
                        <div className="mt-2 space-y-2">
                          {((j.summary?.flips ?? []).length > 0 || (j.summary?.listingActions ?? []).length === 0) && <FlipsPanel groups={groups} />}
                          <ListingChangesPanel closed={listingGroups.closed} deleted={listingGroups.deleted} />
                        </div>
                      </details>
                      <details>
                        <summary className="cursor-pointer font-semibold">Components{d ? ` (${d.components.length})` : ""}</summary>
                        <div className="mt-2">
                          {!d && <p className="text-muted-foreground">Loading…</p>}
                          {d && <StageResultsList stages={d.components.map((c) => ({ stage: c.error ? `${c.stage} — FAILED: ${c.error}` : c.stage, counts: c.counts ?? {}, outcomes: c.outcomes ?? {} }))} />}
                        </div>
                      </details>
                      {d && <ListingHygienePanel jobId={j.id} runs={d.components} />}
                      {d && failedAsinsFromRuns(d.components).length > 0 && (
                        <Button size="sm" className="h-7 text-xs" onClick={() => { onOpenChange(false); onRetry(failedAsinsFromRuns(d.components)); }} data-testid={`button-retry-failed-${j.id}`}>
                          Retry failed ({failedAsinsFromRuns(d.components).length})
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
