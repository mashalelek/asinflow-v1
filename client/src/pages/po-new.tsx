/**
 * /pos/new — the New PO form as a page (Capture PO patch §4.5 / §6):
 * the extension opens /pos/new?prefill=<id> after POST /api/pos/prefill;
 * the page fetches the prefill (a 10-minute server-side cache key — not a
 * draft; nothing is stored until Save) and opens the dialog with it. With
 * no ?prefill the form opens empty. Closing returns to the POs page; a save
 * goes to the new PO.
 */
import { useEffect, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { NewPoDialog, type PrefillResponse } from "@/components/new-po-dialog";

export default function PoNew() {
  const [, navigate] = useLocation();
  const search = useSearch();
  const id = new URLSearchParams(search).get("prefill");
  const [prefill, setPrefill] = useState<PrefillResponse | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!id) { setPrefill(null); return; }
    let cancelled = false;
    fetch(`/api/pos/prefill/${encodeURIComponent(id)}`)
      .then(async (r) => { if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message || (r.status === 404 ? "This capture has expired (10 minutes) — capture the pages again" : `HTTP ${r.status}`)); return r.json(); })
      .then((d: PrefillResponse) => { if (!cancelled) setPrefill(d); })
      .catch((e) => { if (!cancelled) { setError(e.message); setPrefill(null); } });
    return () => { cancelled = true; };
  }, [id]);
  if (prefill === undefined) return <div className="px-6 py-8 text-sm text-muted-foreground" data-testid="po-new-loading">Loading the capture…</div>;
  return (
    <div className="px-6 py-4">
      {error && <p className="mb-3 text-sm text-destructive" data-testid="po-new-error">{error}</p>}
      <NewPoDialog open onOpenChange={(v) => { if (!v) navigate("/purchase-orders"); }} onCreated={(poId) => navigate(`/purchase-orders/${poId}`)} prefill={prefill} />
    </div>
  );
}
