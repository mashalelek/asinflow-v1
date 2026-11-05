// Settings → AI spend (Maria 2026-11-05): every AI call's cost by calendar month (Eastern) and kind, a warning
// when a month passes the threshold in server/config/ai.ts ($20). Read-only; GET /api/ai-spend.
import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { AI_SPEND_KINDS, AI_SPEND_LABELS, type AiSpend } from "@shared/ai-spend";

const usd = (n: number) => `$${n.toFixed(2)}`;
const monthLabel = (m: string) => new Date(`${m}-15T12:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });

export function AiSpendSection({ open }: { open: boolean }) {
  const [data, setData] = useState<AiSpend | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    let live = true;
    fetch("/api/ai-spend").then(async (r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((d) => { if (live) { setData(d); setError(null); } }, (e) => { if (live) setError(String(e.message ?? e)); });
    return () => { live = false; };
  }, [open]);
  const months = data?.months ?? [];
  const cur = months[0];
  return (
    <div data-testid="section-ai-spend">
      <h3 className="text-sm font-medium text-muted-foreground mb-3">AI spend</h3>
      {error && <p className="text-xs text-destructive">Could not load AI spend ({error})</p>}
      {data && months.length === 0 && <p className="text-xs text-muted-foreground">No AI calls in the last six months.</p>}
      {months.some((m) => m.over) && (
        <p className="text-xs text-amber-700 dark:text-amber-400 flex items-center gap-1.5 mb-2" data-testid="ai-spend-warning">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          {months.filter((m) => m.over).map((m) => `${monthLabel(m.month)} ${usd(m.total)}`).join(", ")} — over the {usd(data!.warnUsd)} monthly line
        </p>
      )}
      {months.length > 0 && (
        <table className="w-full table-fixed text-xs">
          <colgroup><col /><col style={{ width: 56 }} /><col style={{ width: 72 }} /></colgroup>
          <thead><tr className="text-muted-foreground text-left"><th className="font-normal pb-1">{monthLabel(cur!.month)}</th><th className="font-normal pb-1 text-right">Calls</th><th className="font-normal pb-1 text-right">Cost</th></tr></thead>
          <tbody>
            {AI_SPEND_KINDS.map((k) => (
              <tr key={k} data-testid={`ai-spend-${k}`}>
                <td className="py-0.5 truncate">{AI_SPEND_LABELS[k]} <span className="text-muted-foreground">({k})</span></td>
                <td className="py-0.5 text-right tabular-nums">{cur!.byKind[k].calls}</td>
                <td className="py-0.5 text-right tabular-nums">{usd(cur!.byKind[k].cost)}</td>
              </tr>
            ))}
            <tr className="border-t font-medium"><td className="pt-1">Total</td><td className="pt-1 text-right tabular-nums">{cur!.calls}</td><td className={`pt-1 text-right tabular-nums ${cur!.over ? "text-amber-700 dark:text-amber-400" : ""}`} data-testid="ai-spend-total">{usd(cur!.total)}</td></tr>
          </tbody>
        </table>
      )}
      {months.length > 1 && (
        <p className="text-[11px] text-muted-foreground mt-2">Earlier: {months.slice(1).map((m) => `${monthLabel(m.month)} ${usd(m.total)}`).join(" · ")}</p>
      )}
    </div>
  );
}
