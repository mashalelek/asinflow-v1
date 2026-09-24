import { useState, useEffect, useMemo } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

// ============================================================================
// Shapes (mirror server/sku-legend-approval.ts)
// ============================================================================
export type LegendType = "brand" | "dept";

export type ApprovalAction = "approve_new" | "approve_in_place" | "merge";

// One pending item, extracted from the preview's legend_pending outcomes.
// rawValue/type/proposedCode/legendId come from the resolver.
export interface PendingLegendItem {
  type: LegendType;
  rawValue: string;
  proposedCode: string;
  // Present when status === "proposed" (row exists in legend, unapproved).
  // Absent when "not_in_legend" (no row yet).
  legendId?: string | null;
}

export interface ApprovedBrandOption {
  legendId: string;
  rawValue: string;
  code: string;
}

interface LegendApprovalDialogProps {
  open: boolean;
  pending: PendingLegendItem[];
  onClose: () => void;
  // Called on confirm; parent posts to /api/sku-legend/approve and re-fetches preview.
  onApprove: (items: any[]) => Promise<{ results: any[] }>;
  // For the merge dropdown — fetched fresh on dialog open.
  approvedBrands: ApprovedBrandOption[];
}

// Per-row editable state.
interface RowState {
  rawValue: string;
  type: LegendType;
  proposedCode: string;
  legendId: string | null;
  // Editable
  action: ApprovalAction;       // 'approve_new' default; switches to 'approve_in_place' if legendId present; or 'merge' on toggle
  codeOverride: string;          // empty = use proposed (per spec decision 3)
  intoLegendId: string | null;   // for merge
  // Result after submit (shown back-in-row)
  result?: {
    outcome: string;
    message?: string;
    code?: string;
    intoCode?: string;
  };
}

// ============================================================================
// Component
// ============================================================================
export function LegendApprovalDialog({
  open,
  pending,
  onClose,
  onApprove,
  approvedBrands,
}: LegendApprovalDialogProps) {
  const [rows, setRows] = useState<RowState[]>([]);
  const [busy, setBusy] = useState(false);

  // Initialize rows from pending. Default action: approve_in_place when a
  // legendId is present (existing proposed row), approve_new otherwise.
  useEffect(() => {
    if (!open) return;
    setRows(
      // §18 (2026-09-24): a blank raw value is not an approvable entry. A
      // brandless ASIN takes the reserved code NUL automatically, so no row
      // should ever arrive with an empty value — this filter is the last
      // guard against the one that did (brand "" → HAU, 2026-09-10), which
      // made both Approve and Merge fail with an unfixable error.
      pending
        .filter((p) => (p.rawValue ?? "").trim() !== "")
        .map((p) => ({
          rawValue: p.rawValue,
          type: p.type,
          proposedCode: p.proposedCode,
          legendId: p.legendId ?? null,
          action: p.legendId ? "approve_in_place" : "approve_new",
          codeOverride: "",
          intoLegendId: null,
        })),
    );
  }, [open, pending]);

  const allDone = useMemo(
    () => rows.length > 0 && rows.every((r) => r.result && r.result.outcome !== "error"),
    [rows],
  );

  function setRow(idx: number, patch: Partial<RowState>) {
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }

  // Sanitize code input: uppercase, [A-Z] only, max 3
  function onCodeChange(idx: number, value: string) {
    const sanitized = value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 3);
    setRow(idx, { codeOverride: sanitized });
  }

  // Build the items payload for the bulk endpoint.
  function buildPayload() {
    return rows
      .filter((r) => !r.result || r.result.outcome === "error") // skip already-successful rows on retry
      .map((r) => {
        const effectiveCode = r.codeOverride || r.proposedCode; // empty = use proposed
        if (r.action === "merge") {
          const target = approvedBrands.find((b) => b.legendId === r.intoLegendId);
          return {
            type: "brand" as const,
            rawValue: r.rawValue,
            action: "merge" as const,
            intoRawValue: target?.rawValue ?? "",
          };
        }
        if (r.action === "approve_in_place" && r.legendId) {
          return {
            type: r.type,
            rawValue: r.rawValue,
            action: "approve_in_place" as const,
            legendId: r.legendId,
            code: effectiveCode,
          };
        }
        return {
          type: r.type,
          rawValue: r.rawValue,
          action: "approve_new" as const,
          code: effectiveCode,
        };
      });
  }

  async function handleApprove() {
    setBusy(true);
    try {
      const payload = buildPayload();
      const { results } = await onApprove(payload);
      // Stitch per-item results back onto rows (position-correlated within the filter)
      let resIdx = 0;
      setRows((prev) =>
        prev.map((r) => {
          if (r.result && r.result.outcome !== "error") return r; // already succeeded; skipped
          const res = results[resIdx++];
          if (!res) return r;
          return {
            ...r,
            result: {
              outcome: res.outcome,
              message: res.message,
              code: res.code,
              intoCode: res.intoCode,
            },
          };
        }),
      );
    } finally {
      setBusy(false);
    }
  }

  const successCount = rows.filter((r) => r.result && r.result.outcome !== "error").length;
  const errorCount = rows.filter((r) => r.result?.outcome === "error").length;
  const pendingCount = rows.length - successCount - errorCount;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Legend approvals</DialogTitle>
          <DialogDescription>
            {pendingCount > 0 && (
              <>{pendingCount} pending. Review proposed codes, edit any, choose action per row.</>
            )}
            {successCount > 0 && <> {successCount} succeeded.</>}
            {errorCount > 0 && <> {errorCount} errored — fix and retry.</>}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1 my-2">
          <div className="grid grid-cols-[60px_1fr_70px_90px_1fr_1fr] gap-2 text-xs font-semibold text-muted-foreground border-b pb-1">
            <span>Type</span>
            <span>Raw value</span>
            <span>Proposed</span>
            <span>My code</span>
            <span>Action</span>
            <span>Result</span>
          </div>

          {rows.map((r, idx) => {
            const isBrand = r.type === "brand";
            const succeeded = r.result && r.result.outcome !== "error";
            return (
              <div
                key={r.rawValue + r.type}
                className={`grid grid-cols-[60px_1fr_70px_90px_1fr_1fr] gap-2 items-center text-sm py-1 px-1 rounded ${
                  succeeded ? "bg-green-50/30 dark:bg-green-950/20" : ""
                }`}
              >
                <Badge variant={isBrand ? "default" : "secondary"} className="text-xs">
                  {r.type}
                </Badge>
                <span className="text-xs truncate" title={r.rawValue}>
                  {r.rawValue}
                </span>
                <code className="font-mono text-xs">{r.proposedCode}</code>
                <Input
                  className="h-7 text-xs font-mono"
                  placeholder={r.proposedCode}
                  value={r.codeOverride}
                  onChange={(e) => onCodeChange(idx, e.target.value)}
                  disabled={busy || succeeded || r.action === "merge"}
                  maxLength={3}
                />
                <div className="flex items-center gap-2 text-xs">
                  {!succeeded && (
                    <>
                      <label className="flex items-center gap-1 cursor-pointer">
                        <input
                          type="radio"
                          name={`action-${idx}`}
                          checked={r.action === "approve_new" || r.action === "approve_in_place"}
                          onChange={() => setRow(idx, { action: r.legendId ? "approve_in_place" : "approve_new", intoLegendId: null })}
                          disabled={busy}
                        />
                        <span>{r.legendId ? "Approve in place" : "Approve"}</span>
                      </label>
                      {isBrand && (
                        <label className="flex items-center gap-1 cursor-pointer">
                          <input
                            type="radio"
                            name={`action-${idx}`}
                            checked={r.action === "merge"}
                            onChange={() => setRow(idx, { action: "merge" })}
                            disabled={busy}
                          />
                          <span>Merge →</span>
                          {r.action === "merge" && (
                            <select
                              className="h-6 text-xs border rounded px-1"
                              value={r.intoLegendId ?? ""}
                              onChange={(e) => setRow(idx, { intoLegendId: e.target.value || null })}
                              disabled={busy}
                            >
                              <option value="">— select brand —</option>
                              {approvedBrands.map((b) => (
                                <option key={b.legendId} value={b.legendId}>
                                  {b.rawValue} ({b.code})
                                </option>
                              ))}
                            </select>
                          )}
                        </label>
                      )}
                    </>
                  )}
                </div>
                <div className="text-xs">
                  {r.result ? (
                    <span className={r.result.outcome === "error" ? "text-destructive" : "text-green-700 dark:text-green-400"}>
                      {r.result.outcome}
                      {r.result.code && ` ${r.result.code}`}
                      {r.result.intoCode && ` → ${r.result.intoCode}`}
                      {r.result.message && (
                        <div className="text-muted-foreground text-[10px] mt-0.5">
                          {r.result.message}
                        </div>
                      )}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <p className="text-xs text-muted-foreground italic">
          Empty "My code" means use the proposed code. Code field: 3 uppercase letters only. Merge is brand-only.
        </p>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            {allDone ? "Done" : "Cancel"}
          </Button>
          {!allDone && (
            <Button onClick={handleApprove} disabled={busy || rows.length === 0}>
              {busy
                ? "Approving..."
                : errorCount > 0
                  ? `Retry ${errorCount} errored`
                  : `Approve all (${rows.length})`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
