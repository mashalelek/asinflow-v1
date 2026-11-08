/**
 * Linked Velocity orders (velocity_order_links, 2026-11-07): resolved links,
 * so never under the Unmatched warning. One PO's links on its Tracking tab;
 * all of them behind a quiet "Linked Velocity orders (N)" in the POs toolbar.
 * Unlink in both places (the History row stays).
 */
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/** A stored link Velocity order → PO ASIN row, as GET /api/velocity-order-links lists it. */
export interface VelocityOrderLink { velocity_order_id: string; velocity_number: string | null; order_number: string | null; retailer: string | null; asin: string | null; quantity: string | null; source: string; note: string | null; linked_at: string; linked_by: string | null; po_id: string; po_order_id: string; supplier: string }

/** "Velocity orders" text for one order: #8785 · no_poid_at_checkout. */
export function velocityOrderText(o: { velocity_number: string | null; order_number: string | null }): string {
  return `${o.velocity_number ? `#${o.velocity_number}` : "Velocity order"} · ${o.order_number || "(no Order #)"}`;
}

const units = (q: string | null) => (q == null ? "—" : `${Number(q).toLocaleString("en-US", { maximumFractionDigits: 2 })}u`);

function useLinks(poId: string | null, reloadKey?: number) {
  const [links, setLinks] = useState<VelocityOrderLink[] | null>(null);
  const load = useCallback(() => {
    fetch(`/api/velocity-order-links${poId ? `?po_id=${encodeURIComponent(poId)}` : ""}`).then((r) => r.json()).then((d) => setLinks(d.links ?? [])).catch(() => setLinks([]));
  }, [poId]);
  useEffect(() => { load(); }, [load, reloadKey]);
  return { links, load };
}

/** The list with Unlink; `showPo` adds the PO each order is linked to (the all-links view). */
export function VelocityLinksList({ links, showPo, onChanged }: { links: VelocityOrderLink[]; showPo: boolean; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const unlink = async (id: string) => {
    setBusy(true); setErr(null);
    try {
      const res = await fetch(`/api/velocity-order-links/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || `HTTP ${res.status}`);
      onChanged();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="space-y-0.5 text-xs" data-testid="list-velocity-links">
      {err && <div className="text-destructive">{err}</div>}
      {links.map((l) => (
        <div key={l.velocity_order_id} className="flex flex-wrap items-center gap-x-2" data-testid={`row-velocity-link-${l.velocity_order_id}`}>
          <span className={`font-mono${showPo ? " w-full" : ""}`}>{velocityOrderText(l)} · {l.retailer || "—"} · {l.asin} · {units(l.quantity)}</span>
          <span className="text-muted-foreground">{showPo ? `→ ${l.supplier} ${l.po_order_id} · ` : ""}linked {String(l.linked_at).slice(0, 10)}{l.linked_by ? ` by ${l.linked_by}` : ""} ({l.source})</span>
          <Button size="sm" variant="ghost" className="h-6 text-xs" disabled={busy} onClick={() => void unlink(l.velocity_order_id)} data-testid={`button-unlink-velocity-order-${l.velocity_order_id}`}>Unlink</Button>
        </div>
      ))}
    </div>
  );
}

/** One PO's linked Velocity orders (its Tracking tab); nothing when it has none. */
export function PoVelocityLinks({ poId, onChanged }: { poId: string; onChanged?: () => void }) {
  const { links, load } = useLinks(poId);
  if (!links || links.length === 0) return null;
  return (
    <div className="space-y-1" data-testid="po-velocity-links">
      <div className="text-xs text-muted-foreground">Linked Velocity orders ({links.length}) — counted on this PO by Velocity order id</div>
      <VelocityLinksList links={links} showPo={false} onChanged={() => { load(); onChanged?.(); }} />
    </div>
  );
}

/** POs toolbar: every link in one list, neutral (quiet chrome); hidden when there are none. */
export function VelocityLinksButton({ reloadKey, onChanged }: { reloadKey?: number; onChanged?: () => void }) {
  const { links, load } = useLinks(null, reloadKey);
  const [open, setOpen] = useState(false);
  if (!links || links.length === 0) return null;
  return (
    <>
      <button className="rounded px-2 py-1 text-xs text-muted-foreground hover:text-foreground" onClick={() => setOpen(true)} data-testid="button-velocity-links">
        Linked Velocity orders ({links.length})
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent dialogId="velocity-links" className="max-w-4xl" data-testid="dialog-velocity-links">
          <DialogHeader>
            <DialogTitle>Linked Velocity orders</DialogTitle>
            <DialogDescription>Each Velocity order counted on a PO ASIN row by its Velocity order id. Unlink and the next Sync Shipments places it by the rules again.</DialogDescription>
          </DialogHeader>
          <VelocityLinksList links={links} showPo onChanged={() => { load(); onChanged?.(); }} />
        </DialogContent>
      </Dialog>
    </>
  );
}
