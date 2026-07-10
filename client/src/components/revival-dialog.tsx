import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";

export interface RevivalCandidate {
  asin: string;
  title: string | null;
  brand: string | null;
}

interface RevivalDialogProps {
  candidates: RevivalCandidate[];
  open: boolean;
  onClose: () => void;
  onConfirm: (selectedAsins: string[]) => Promise<void> | void;
}

// DA-3 revival dialog. Default selection is NONE — every revival is an
// active opt-in. "Select all" is one click for the bulk case, but no ASIN
// gets unarchived without a deliberate check.
export function RevivalDialog({ candidates, open, onClose, onConfirm }: RevivalDialogProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  // Reset to empty when the dialog re-opens with a new candidate set.
  // Critical: a stale "everything checked" from a previous open would
  // undercut the default-NONE design.
  useEffect(() => {
    if (open) setSelected(new Set());
  }, [open, candidates]);

  const allSelected = candidates.length > 0 && selected.size === candidates.length;
  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(candidates.map((c) => c.asin)));
  const toggleOne = (asin: string) => {
    const next = new Set(selected);
    if (next.has(asin)) next.delete(asin);
    else next.add(asin);
    setSelected(next);
  };

  const handleConfirm = async () => {
    setBusy(true);
    try {
      await onConfirm(Array.from(selected));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Catalog restored</DialogTitle>
          <DialogDescription>
            These ASINs are live again in Amazon's catalog. Unarchive them?
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2 border-b pb-2">
          <Checkbox
            checked={allSelected}
            onCheckedChange={toggleAll}
            data-testid="revival-select-all"
            aria-label="Select all"
          />
          <span className="text-xs text-muted-foreground">
            {selected.size} of {candidates.length} selected
          </span>
        </div>

        <div className="space-y-2 max-h-96 overflow-y-auto pr-1">
          {candidates.map((c) => (
            <label
              key={c.asin}
              className="flex items-start gap-2 text-sm cursor-pointer hover:bg-accent/50 rounded px-1 py-1"
            >
              <Checkbox
                checked={selected.has(c.asin)}
                onCheckedChange={() => toggleOne(c.asin)}
                className="mt-0.5"
              />
              <div className="flex-1 min-w-0">
                <div className="font-mono text-xs">{c.asin}</div>
                <div className="text-xs text-muted-foreground truncate">
                  {c.brand ? `${c.brand} — ` : ""}
                  {c.title ?? "(no title)"}
                </div>
              </div>
            </label>
          ))}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={busy || selected.size === 0}>
            {busy ? "Unarchiving..." : `Unarchive ${selected.size}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
