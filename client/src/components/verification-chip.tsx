import { ClipboardCheck } from "lucide-react";

// Toolbar status indicator for §19 submissions. ALWAYS rendered — the panel
// must stay reachable even when nothing is pending (2026-08-03 regression:
// the pill was the panel's only entry point, and hiding it at count 0 made
// "endpoint broken" and "legitimately zero" indistinguishable). At 0 it
// renders extra-muted. Deliberately subtle (§7: no saturated accents for
// structural elements) — a muted stone pill, not a warning.
export function VerificationChip({ count, onClick }: { count: number; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid="chip-unverified-submissions"
      title="Submissions needing attention: unverified, or flagged/failed awaiting acknowledgment (§19)"
      className={`inline-flex h-8 items-center gap-1.5 rounded-md bg-muted/50 px-2.5 text-xs
                 hover:bg-muted/70 hover:text-foreground transition-colors
                 ${count > 0 ? "text-muted-foreground" : "text-muted-foreground/50"}`}
    >
      <ClipboardCheck className="h-3.5 w-3.5" />
      <span className="tabular-nums">{count}</span>
      <span>submission{count === 1 ? "" : "s"}</span>
    </button>
  );
}
