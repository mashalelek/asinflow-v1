import { useState } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronRight, ChevronDown } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  verifySubmissions, resolveSubmission, isNonTerminal, treatmentOf,
  type UnverifiedResponse, type SubmissionRow, type VerifySummary, type ManualVerdict,
} from "@/lib/submissions-api";

interface Props {
  open: boolean;
  onClose: () => void;
  data: UnverifiedResponse | null;
  onRefetch: () => Promise<void>;
}

function VerdictSource({ row }: { row: SubmissionRow }) {
  if (!row.verdict_source) return null;
  return row.verdict_source === "manual"
    ? <Badge variant="secondary" className="text-[10px]">manual</Badge>
    : <span className="text-[10px] text-muted-foreground">api</span>;
}

// Text shown for a needs-attention row, tone per treatment.
function rowMessage(row: SubmissionRow): string {
  const t = treatmentOf(row);
  if (t === "restricted") return "Restricted generic — do not source.";
  if (t === "price") return "Suppressed pending reprice — expected for new offers.";
  // check: prefer the surfaced review flags, else the first issue message.
  if (row.terminal_conflict) return row.review_flags[0] ?? "Terminal signal on a live listing — verify in SC.";
  if (row.review_flags.length) return row.review_flags.join(" · ");
  if (row.verify_status === "stale") return "No SC signal after 48h — confirm in Seller Central.";
  return (row.issues?.[0]?.message) ?? "Check in Seller Central.";
}

export function VerificationPanel({ open, onClose, data, onRefetch }: Props) {
  const { toast } = useToast();
  const [verifying, setVerifying] = useState(false);
  const [summary, setSummary] = useState<VerifySummary | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showInFlight, setShowInFlight] = useState(false);

  const handleVerify = async () => {
    setVerifying(true);
    try {
      const res = await verifySubmissions();
      setSummary(res.summary);
      await onRefetch();
    } catch (err: any) {
      toast({ title: "Verify failed", description: err.message, variant: "destructive" });
    } finally {
      setVerifying(false);
    }
  };

  const handleResolve = async (id: string, verdict: ManualVerdict) => {
    setBusyId(id);
    try {
      const { status, error } = await resolveSubmission(id, verdict);
      // 200 = resolved; 409 = already resolved by a concurrent sweep → both just
      // refetch (the row updates to its real state). No error toast for 409.
      if (status !== 200 && status !== 409) {
        toast({ title: "Resolve failed", description: error ?? `HTTP ${status}`, variant: "destructive" });
      }
      await onRefetch();
    } finally {
      setBusyId(null);
    }
  };

  const ResolveActions = ({ row }: { row: SubmissionRow }) =>
    isNonTerminal(row.verify_status) ? (
      <div className="flex items-center gap-1 ml-auto">
        <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" disabled={busyId === row.id}
          onClick={() => handleResolve(row.id, "live")}>Confirmed live</Button>
        <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" disabled={busyId === row.id}
          onClick={() => handleResolve(row.id, "failed")}>Confirmed failed</Button>
        <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" disabled={busyId === row.id}
          onClick={() => handleResolve(row.id, "deleted")}>I deleted this</Button>
      </div>
    ) : <div className="ml-auto"><VerdictSource row={row} /></div>;

  const needs = data?.needsAttention ?? [];
  const restricted = needs.filter((r) => treatmentOf(r) === "restricted");
  const price = needs.filter((r) => treatmentOf(r) === "price");
  const check = needs.filter((r) => treatmentOf(r) === "check");
  const inFlight = data?.inFlight ?? [];

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Submission verification</DialogTitle>
          <DialogDescription>
            ACCEPTED is not live — Amazon processes offers asynchronously. Verify resolves each submission against Seller Central.
          </DialogDescription>
        </DialogHeader>

        {/* Verify now + last sweep summary */}
        <div className="flex items-center gap-3">
          <Button size="sm" className="h-8 text-xs" onClick={handleVerify} disabled={verifying}>
            {verifying ? "Verifying…" : "Verify now"}
          </Button>
          {summary && (
            <div className="text-xs text-muted-foreground">
              checked {summary.checked} · live {summary.live} · failed {summary.failed} · processing {summary.processing} · stale {summary.stale}
              {summary.throttled > 0 && (
                <span className="text-amber-500"> · throttled {summary.throttled} (re-run to converge)</span>
              )}
            </div>
          )}
        </div>

        <div className="space-y-4 text-sm mt-1">
          {/* b — restricted generic: calm sourcing verdict, muted */}
          {restricted.length > 0 && (
            <Section title="Restricted generic — do not source" count={restricted.length}>
              {restricted.map((r) => (
                <RowShell key={r.id}>
                  <code className="font-mono text-xs">{r.asin}</code>
                  <code className="font-mono text-[11px] text-muted-foreground">{r.sku}</code>
                  <span className="text-xs text-muted-foreground">{rowMessage(r)}</span>
                  <ResolveActions row={r} />
                </RowShell>
              ))}
            </Section>
          )}

          {/* a — 18555 price-suppression: informational, muted (not an error) */}
          {price.length > 0 && (
            <Section title="Suppressed pending reprice" count={price.length}>
              {price.map((r) => (
                <RowShell key={r.id}>
                  <code className="font-mono text-xs">{r.asin}</code>
                  <code className="font-mono text-[11px] text-muted-foreground">{r.sku}</code>
                  <span className="text-xs text-muted-foreground">{rowMessage(r)}</span>
                  <ResolveActions row={r} />
                </RowShell>
              ))}
              <p className="text-[11px] text-muted-foreground italic mt-1">
                Expected for new offers — the repricer + FBA check-in own the real price.
              </p>
            </Section>
          )}

          {/* c — genuine check-in-SC: amber */}
          {check.length > 0 && (
            <Section title="Needs a look in Seller Central" count={check.length}>
              {check.map((r) => (
                <RowShell key={r.id}>
                  <code className="font-mono text-xs">{r.asin}</code>
                  <code className="font-mono text-[11px] text-muted-foreground">{r.sku}</code>
                  <span className="text-xs text-amber-500 flex-1">{rowMessage(r)}</span>
                  <ResolveActions row={r} />
                </RowShell>
              ))}
            </Section>
          )}

          {/* In flight (pending/processing) — collapsed, resolvable per row */}
          {inFlight.length > 0 && (
            <Collapsible open={showInFlight} onOpenChange={setShowInFlight}>
              <CollapsibleTrigger className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground">
                {showInFlight ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                In flight ({inFlight.length})
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-2 space-y-1">
                <p className="text-[11px] text-muted-foreground">
                  Submitted, still processing at Amazon. Use “Verify now,” or resolve manually if you already acted in SC.
                </p>
                {inFlight.map((r) => (
                  <RowShell key={r.id}>
                    <code className="font-mono text-xs">{r.asin}</code>
                    <code className="font-mono text-[11px] text-muted-foreground">{r.sku}</code>
                    <Badge variant="secondary" className="text-[10px]">{r.verify_status}</Badge>
                    <ResolveActions row={r} />
                  </RowShell>
                ))}
              </CollapsibleContent>
            </Collapsible>
          )}

          {needs.length === 0 && inFlight.length === 0 && (
            <div className="text-xs text-muted-foreground py-6 text-center">All submissions verified.</div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Section header + rows. Hierarchy via spacing, no container border (§7).
function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title} ({count})</div>
      {children}
    </div>
  );
}

function RowShell({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center gap-2 py-1 px-1 rounded odd:bg-muted/30">{children}</div>;
}
