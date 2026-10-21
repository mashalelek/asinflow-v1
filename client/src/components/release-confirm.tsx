/**
 * The in-app confirm every listing-hygiene Release goes through (Maria
 * 2026-10-21): "Delete N listings in Seller Central? Each is re-checked live
 * first." Nothing is queued until Confirm; a refusal (409 — already released,
 * superseded, gate unset) is shown inline.
 */
import { useMemo, useState } from "react";
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { releaseHeld } from "@/lib/jobs-api";
import { createReleaseFlow, type HygieneAction, type ReleasePrompt } from "@/lib/release-flow";

export function useReleaseConfirm(onQueued?: (message: string) => void) {
  const flow = useMemo(() => createReleaseFlow((jobId, action) => releaseHeld(jobId, action)), []);
  const [prompt, setPrompt] = useState<ReleasePrompt | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const request = (jobId: number, action: HygieneAction, count: number) => { setError(null); setPrompt(flow.request(jobId, action, count)); };
  const cancel = () => { flow.cancel(); setPrompt(null); setError(null); };
  const confirm = async () => {
    const p = prompt;
    setBusy(true);
    setError(null);
    try {
      const r = await flow.confirm();
      setPrompt(null);
      onQueued?.(`Release queued as job #${r.job.id} — ${r.held} held SKU(s) are re-checked live; only those that still qualify are ${p?.action === "close" ? "closed" : "deleted"}.`);
      window.dispatchEvent(new CustomEvent(HYGIENE_CHANGED_EVENT));
    } catch (err: any) {
      // Keep the prompt open with the reason; re-arm the flow for another try.
      if (p) flow.request(p.jobId, p.action, p.count);
      setError(err?.message ?? "Release failed.");
    } finally {
      setBusy(false);
    }
  };

  const dialog = (
    <AlertDialog open={prompt != null} onOpenChange={(o) => { if (!o && !busy) cancel(); }}>
      <AlertDialogContent data-testid="release-confirm">
        <AlertDialogHeader>
          <AlertDialogTitle>{prompt?.action === "close" ? "Close listings" : "Delete listings"}</AlertDialogTitle>
          <AlertDialogDescription>{prompt?.text}</AlertDialogDescription>
        </AlertDialogHeader>
        {error && <p className="text-sm text-destructive" role="alert" data-testid="release-error">{error}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <Button
            variant={prompt?.action === "delete" ? "destructive" : "default"}
            disabled={busy}
            onClick={() => void confirm()}
            data-testid="button-release-confirm"
          >
            {busy ? "Queuing…" : prompt?.action === "close" ? "Close" : "Delete"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
  return { request, dialog };
}

/** Raised after a release is queued so the Action-required indicator refreshes at once. */
export const HYGIENE_CHANGED_EVENT = "asinflow:hygiene-changed";
