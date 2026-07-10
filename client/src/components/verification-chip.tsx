import { ClipboardCheck } from "lucide-react";

// Toolbar status indicator for unverified submissions. Renders only when
// count > 0. Deliberately subtle (§7: no saturated accents for structural
// elements) — a muted stone pill, not a warning. Click opens the panel.
export function VerificationChip({ count, onClick }: { count: number; onClick: () => void }) {
  if (count <= 0) return null;
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid="chip-unverified-submissions"
      title="Submissions awaiting verification"
      className="inline-flex h-8 items-center gap-1.5 rounded-md bg-muted/50 px-2.5 text-xs
                 text-muted-foreground hover:bg-muted/70 hover:text-foreground transition-colors"
    >
      <ClipboardCheck className="h-3.5 w-3.5" />
      <span className="tabular-nums">{count}</span>
      <span>unverified</span>
    </button>
  );
}
