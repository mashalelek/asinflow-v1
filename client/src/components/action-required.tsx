/**
 * "Action required" (listing hygiene, Maria 2026-10-21): a held close or
 * delete run never sits silently. Persistent amber control in the top nav on
 * every AF page — §7 amber, not a toast — whenever a hold is unreleased:
 * "Action required: 30 deletes held for review". Clicking it opens the held
 * list with Release (through the in-app confirm). It clears once the hold is
 * released, or when a newer night's hold supersedes it (the server keeps one
 * pending hold per action — GET /api/listing-hygiene/pending).
 */
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/auth-context";
import { ActionRow } from "@/components/listing-hygiene-panel";
import { useReleaseConfirm, HYGIENE_CHANGED_EVENT } from "@/components/release-confirm";
import { getPendingHolds, getHygieneActions, pendingLabel, type PendingHolds, type PendingHold, type ListingActionRow } from "@/lib/jobs-api";

const POLL_MS = 60_000;

export function ActionRequired() {
  const [state, setState] = useState<PendingHolds | null>(null);
  const [open, setOpen] = useState(false);

  const refresh = useCallback(async () => {
    try { setState(await getPendingHolds()); } catch { /* transient — the next poll retries */ }
  }, []);

  useEffect(() => {
    void refresh();
    const t = window.setInterval(refresh, POLL_MS);
    const on = () => void refresh();
    window.addEventListener(HYGIENE_CHANGED_EVENT, on);
    window.addEventListener("focus", on);
    return () => { window.clearInterval(t); window.removeEventListener(HYGIENE_CHANGED_EVENT, on); window.removeEventListener("focus", on); };
  }, [refresh]);

  const label = pendingLabel(state?.pending);
  if (!label) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 rounded bg-amber-500 px-3 py-1.5 text-xs font-medium text-black shadow hover:bg-amber-400"
        data-testid="action-required"
        title="Open the held list"
      >
        <AlertTriangle className="h-3.5 w-3.5" />
        {label}
      </button>
      <HeldReviewDialog open={open} onOpenChange={setOpen} state={state!} onChanged={refresh} />
    </>
  );
}

function HeldReviewDialog({ open, onOpenChange, state, onChanged }: {
  open: boolean; onOpenChange: (v: boolean) => void; state: PendingHolds; onChanged: () => void;
}) {
  const { user } = useAuth();
  const [rows, setRows] = useState<Record<string, ListingActionRow[]>>({});
  const [message, setMessage] = useState<string | null>(null);
  const { request, dialog } = useReleaseConfirm((m) => { setMessage(m); onChanged(); });
  const holds = (["close", "delete"] as const).map((a) => state.pending[a]).filter((h): h is PendingHold => h != null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setMessage(null);
    for (const h of holds) {
      getHygieneActions(h.job_id).then((d) => {
        if (cancelled) return;
        setRows((m) => ({ ...m, [`${h.job_id}:${h.action}`]: d.actions.filter((a) => a.action === h.action && a.status === "held" && !(a.evidence && "release" in a.evidence)) }));
      }).catch(() => {});
    }
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, holds.map((h) => `${h.job_id}:${h.action}:${h.count}`).join(",")]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl max-h-[85vh] overflow-y-auto overflow-x-hidden [overflow-wrap:anywhere] [&>*]:min-w-0" data-testid="dialog-held">
        <DialogHeader>
          <DialogTitle>Held for review</DialogTitle>
          <DialogDescription>
            The breaker held these candidates — nothing was written to Seller Central. Release re-checks every SKU live and acts only on those that still qualify.
          </DialogDescription>
        </DialogHeader>
        {holds.map((h) => {
          const list = rows[`${h.job_id}:${h.action}`];
          const live = state.live[h.action];
          const admin = user?.role === "admin";
          return (
            <div key={`${h.job_id}:${h.action}`} className="border rounded p-2 space-y-1 text-xs min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{h.count} {h.action === "close" ? "close" : "delete"}{h.count === 1 ? "" : "s"} held · job #{h.job_id} · {new Date(h.held_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
                <Button
                  size="sm" className="h-6 text-xs ml-auto"
                  disabled={!live || !admin}
                  title={!admin ? "Admins only" : live ? "Re-check every held SKU live and act on the ones that still qualify" : `${h.action === "close" ? "LISTING_CLOSE_LIVE" : "LISTING_DELETE_LIVE"} is not set`}
                  onClick={() => request(h.job_id, h.action, h.count)}
                  data-testid={`button-release-held-${h.action}`}
                >
                  Release ({h.count})
                </Button>
              </div>
              {!list && <p className="text-muted-foreground">Loading…</p>}
              {list && list.map((a) => <ActionRow key={a.id} a={a} />)}
            </div>
          );
        })}
        {message && <p className="text-xs">{message}</p>}
        {dialog}
      </DialogContent>
    </Dialog>
  );
}
