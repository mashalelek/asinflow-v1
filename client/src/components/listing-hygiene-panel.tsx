/**
 * Listing hygiene in the jobs dialog (SPEC §11 components 22 / 24): counts
 * per outcome, expandable SKU lists (with the evidence AF recorded for every
 * candidate), Release (N) when candidates are held by the breaker, and any
 * action that did not take effect.
 */
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useReleaseConfirm } from "@/components/release-confirm";
import {
  getHygieneActions, groupHygieneOutcomes, FOCUS_ASIN_EVENT,
  type ComponentRun, type HygieneActions, type ListingActionRow,
} from "@/lib/jobs-api";

const TITLE: Record<"close" | "delete", string> = { close: "Close OOS listings", delete: "Delete dead listings" };

function asinLink(asin: string) {
  return (
    <button
      type="button"
      className="font-mono underline-offset-2 hover:underline text-primary"
      onClick={() => window.dispatchEvent(new CustomEvent(FOCUS_ASIN_EVENT, { detail: { asin } }))}
      title="Show this row"
    >
      {asin}
    </button>
  );
}

function evidenceLine(e: Record<string, any>): string {
  const parts: string[] = [];
  const b = e?.buckets as Record<string, number> | null;
  if (b) {
    const nz = Object.entries(b).filter(([, v]) => v > 0).map(([k, v]) => `${k} ${v}`);
    parts.push(nz.length ? nz.join(", ") : "all buckets 0");
  }
  if (e?.listing?.offer_end_at) parts.push(`closed (end_at ${String(e.listing.offer_end_at).slice(0, 10)})`);
  else if (e?.listing) parts.push("open");
  if (e?.clock) parts.push(`${e.clock.branch === "ever_stocked" ? `last stocked ${e.clock.last_stocked}` : `never stocked, created ${e.clock.created}`} · ${e.clock.days}d > ${e.clock.threshold}d`);
  if (e?.pipeline) parts.push(`on order ${e.pipeline.on_order}, at prep ${e.pipeline.at_prep}, Velocity on hand ${e.pipeline.velocity_on_hand ?? "?"}, in Velocity shipments ${e.pipeline.velocity_in_shipments ?? "?"}${e.pipeline.velocity_shipment_ids?.length ? ` (${e.pipeline.velocity_shipment_ids.join(", ")})` : ""}`);
  if (e?.release?.outcome) parts.push(`release → ${e.release.outcome}`);
  return parts.join(" · ");
}

export function ActionRow({ a }: { a: ListingActionRow }) {
  return (
    <details className="pl-2">
      <summary className="cursor-pointer">
        <span className="font-mono">{a.sku}</span> {asinLink(a.asin)}{" "}
        <Badge variant={a.status === "not_effective" || a.status === "error" || a.status === "invalid" ? "destructive" : "outline"} className="h-4 text-[10px]">
          {a.dry_run ? "dry run" : a.status}
        </Badge>{" "}
        <span className="text-muted-foreground">{evidenceLine(a.evidence)}</span>
      </summary>
      <pre className="mt-1 max-h-48 max-w-full overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-[10px]">{JSON.stringify({ ...a.evidence, submission_id: a.submission_id, issues: a.issues }, null, 2)}</pre>
    </details>
  );
}

export function ListingHygienePanel({ jobId, runs }: { jobId: number; runs: ComponentRun[] }) {
  const hygieneRuns = runs.filter((r) => r.stage === "22_close_oos" || r.stage === "24_delete_dead");
  const [data, setData] = useState<HygieneActions | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // Release goes through the in-app confirm; nothing is queued before it.
  const { request: requestRelease, dialog: releaseDialog } = useReleaseConfirm(setMessage);

  useEffect(() => {
    if (hygieneRuns.length === 0) return;
    let cancelled = false;
    getHygieneActions(jobId).then((d) => { if (!cancelled) setData(d); }).catch(() => {});
    return () => { cancelled = true; };
  }, [jobId, hygieneRuns.length]);

  if (hygieneRuns.length === 0) return null;


  return (
    <div className="space-y-3 min-w-0" data-testid={`hygiene-panel-${jobId}`}>
      {hygieneRuns.map((run) => {
        const action = run.stage === "22_close_oos" ? "close" : "delete";
        const groups = groupHygieneOutcomes(run.outcomes);
        const actions = (data?.actions ?? []).filter((a) => a.action === action);
        const bySku = new Map(actions.map((a) => [a.sku, a]));
        const releasable = data?.releasable?.[action] ?? 0;
        const live = data?.live?.[action] ?? false;
        const notEffective = actions.filter((a) => a.status === "not_effective");
        return (
          <div key={run.id} className="border rounded p-2 space-y-1">
            <div className="flex flex-wrap items-center gap-2 min-w-0">
              <span className="font-semibold">{TITLE[action]}</span>
              {run.outcomes?._mode && <span className="text-muted-foreground">{run.outcomes._mode}</span>}
              {releasable > 0 && (
                <Button
                  size="sm" className="h-6 text-xs ml-auto" disabled={!live}
                  title={live ? "Re-evaluate every held SKU live and fire the ones that still qualify" : `${action === "close" ? "LISTING_CLOSE_LIVE" : "LISTING_DELETE_LIVE"} is not set`}
                  onClick={() => requestRelease(jobId, action, releasable)}
                  data-testid={`button-release-${action}-${jobId}`}
                >
                  Release ({releasable})
                </Button>
              )}
            </div>
            {run.error && <p className="text-destructive">FAILED: {run.error}</p>}
            {["_breaker", "_ledger", "_velocity", "_basis", "_release"].filter((k) => run.outcomes?.[k]).map((k) => (
              <p key={k} className="text-muted-foreground">{k.slice(1)}: {run.outcomes[k]}</p>
            ))}
            {notEffective.length > 0 && (
              <div>
                <p className="font-semibold text-destructive">Not effective after two passes ({notEffective.length})</p>
                {notEffective.map((a) => <ActionRow key={a.id} a={a} />)}
              </div>
            )}
            {groups.map((g) => (
              <details key={g.outcome}>
                <summary className="cursor-pointer">{g.outcome} ({g.skus.length})</summary>
                <div className="mt-1 space-y-0.5">
                  {g.skus.map((sku) => {
                    const a = bySku.get(sku);
                    return a
                      ? <ActionRow key={sku} a={a} />
                      : <div key={sku} className="pl-2"><span className="font-mono">{sku}</span> <span className="text-muted-foreground">{run.outcomes[sku]}</span></div>;
                  })}
                </div>
              </details>
            ))}
          </div>
        );
      })}
      {message && <p className="text-xs">{message}</p>}
      {releaseDialog}
    </div>
  );
}

export function ListingChangesPanel({ closed, deleted }: { closed: { asin: string; sku: string }[]; deleted: { asin: string; sku: string }[] }) {
  const rows: Array<[string, { asin: string; sku: string }[]]> = [["Listings closed", closed], ["Listings deleted", deleted]];
  if (closed.length + deleted.length === 0) return null;
  return (
    <div className="space-y-2 text-xs" data-testid="listing-changes-panel">
      {rows.filter(([, l]) => l.length > 0).map(([label, list]) => (
        <div key={label}>
          <p className="font-semibold">{label} ({list.length})</p>
          <div className="flex flex-wrap gap-2 mt-1">
            {list.map((x) => <span key={`${x.sku}`}><span className="font-mono">{x.sku}</span> {asinLink(x.asin)}</span>)}
          </div>
        </div>
      ))}
    </div>
  );
}
