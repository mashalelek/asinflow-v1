/**
 * PO tracking UI (SPEC §26; patch po-tracking-velocity §11): the PO's
 * Tracking tab, the POs-page "Sync tracking" button and the "Unmatched
 * tracking (N)" queue.
 */
import { useCallback, useEffect, useState } from "react";
import { RefreshCw, AlertTriangle, ExternalLink, Copy, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTable } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { PoVelocityLinks } from "@/components/velocity-links";
import { carrierStatusText } from "@shared/carrier-status";

export interface TrackingRow {
  id: number; carrier: string; tracking_number: string; retailer_order_id: string | null; shipped_at: string | null;
  ship_to_street: string | null; status: "unmatched" | "matched" | "pushed" | "push_failed" | "held"; review_reason: string | null;
  push_error: string | null; pushed_at: string | null; pushed_velocity_ids: string[] | null; source: string;
  items_json: Array<{ name: string; qty: number }> | null; suppressed_at: string | null; reassigned_at: string | null;
  reassigned_from_order_id?: string | null;
  /** 2026-11-04 (migration 086): this PO's units in the shipment, when the email states them; shared_with = the other PO(s) on the same number. */
  qty?: string | number | null; shared_with?: string[] | null;
  /** Carrier status (SPEC §26 "Carrier status — EasyPost", 2026-11-11): EasyPost's words, Velocity's as the fallback. */
  carrier_status?: string | null; est_delivery_at?: string | null; last_scan_at?: string | null; delivered_at?: string | null; carrier_checked_at?: string | null; velocity_tracking_status?: string | null; easypost_tracker_id?: string | null;
}

/** Pure (2026-11-09): "3 Product units of this PO · 36 individual" — the email's quantity is Product units; "—" when the PO's Product pack is not one value. */
export function trackingQtyText(qty: number, perProductUnit: number | null | undefined): string {
  const indiv = perProductUnit != null && perProductUnit > 0 ? String(Math.round(qty * perProductUnit * 100) / 100) : "—";
  return `${qty} Product unit${qty === 1 ? "" : "s"} of this PO · ${indiv} individual`;
}
/** Pure: the carrier's public tracking page for a number (null for OTHER). */
export function carrierTrackingUrl(carrier: string, n: string): string | null {
  const e = encodeURIComponent(n);
  switch (carrier) {
    case "UPS": return `https://www.ups.com/track?tracknum=${e}`;
    case "FEDEX": return `https://www.fedex.com/fedextrack/?trknbr=${e}`;
    case "USPS": return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${e}`;
    case "DHL": return `https://www.dhl.com/us-en/home/tracking.html?tracking-id=${e}`;
    case "AMAZON": return `https://track.amazon.com/tracking/${e}`;
    case "ONTRAC": case "LASERSHIP": return `https://www.ontrac.com/tracking/?number=${e}`;
    case "GLS": return `https://www.gls-us.com/tracking?trackingNumber=${e}`;
    default: return null;
  }
}

const STATUS_CLASS: Record<string, string> = {
  pushed: "bg-green-500/10 text-green-700 dark:text-green-400",
  matched: "bg-sky-500/10 text-sky-700 dark:text-sky-400",
  held: "bg-muted text-muted-foreground",
  push_failed: "bg-red-500/10 text-red-700 dark:text-red-400",
  unmatched: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
};
const fmt = (s: string | null) => (s ? new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—");

async function api<T = any>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: "same-origin", headers: { "Content-Type": "application/json" }, ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as any)?.message ?? (body as any)?.error ?? `HTTP ${res.status}`);
  return body as T;
}

/** Pure: find the one PO a typed order # names (exact, punctuation-insensitive), from /api/pos search results. */
export function pickPo(pos: Array<{ id: string; order_id: string; supplier: string }>, typed: string): { id: string; order_id: string; supplier: string } | { error: string } {
  const n = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const hits = pos.filter((p) => n(p.order_id) === n(typed));
  if (hits.length === 1) return hits[0];
  return { error: hits.length === 0 ? `no PO with order # ${typed}` : `${hits.length} POs have order # ${typed} — open the right PO and attach from its Tracking tab` };
}
async function findPo(typed: string) {
  const r = await api<{ pos: Array<{ id: string; order_id: string; supplier: string }> }>(`/api/pos?closed=all&search=${encodeURIComponent(typed.trim())}`);
  return pickPo(r.pos, typed.trim());
}

function MoveToPo({ row, onMoved }: { row: TrackingRow; onMoved: () => void }) {
  const [open, setOpen] = useState(false);
  const [order, setOrder] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true); setErr(null);
    try {
      const po = await findPo(order);
      if ("error" in po) { setErr(po.error); return; }
      await api(`/api/tracking/${row.id}/move`, { method: "POST", body: JSON.stringify({ po_id: po.id }) });
      setOpen(false); onMoved();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  if (!open) return <button className="text-xs text-primary hover:underline" onClick={() => setOpen(true)} data-testid={`button-move-tracking-${row.id}`}>Move to PO…</button>;
  return (
    <span className="inline-flex items-center gap-1">
      <input className="h-6 w-36 rounded border px-1 text-xs font-mono" placeholder="order #" value={order} onChange={(e) => setOrder(e.target.value)} autoFocus />
      <Button size="sm" className="h-6 text-xs" disabled={busy || !order.trim()} onClick={() => void go()}>Move</Button>
      <button className="text-xs text-muted-foreground" onClick={() => { setOpen(false); setErr(null); }}>cancel</button>
      {err && <span className="text-xs text-destructive">{err}</span>}
    </span>
  );
}

export function PoTrackingTab({ poId, onChanged, perProductUnit }: { poId: string; onChanged?: () => void; /** The PO's one Individual units per Product unit (null when the lines disagree) — the Individual equivalent of an email's quantity. */ perProductUnit?: number | null }) {
  const [rows, setRows] = useState<TrackingRow[] | null>(null);
  const [homeReview, setHomeReview] = useState<{ reason: string; orders: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [carrier, setCarrier] = useState("UPS");
  const [number, setNumber] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(() => {
    api<{ rows: TrackingRow[]; home_review?: { reason: string; orders: string } | null }>(`/api/pos/${poId}/tracking`).then((r) => { setRows(r.rows); setHomeReview(r.home_review ?? null); }).catch((e) => setErr(e.message));
  }, [poId]);
  useEffect(() => { load(); }, [load]);
  const changed = () => { load(); onChanged?.(); };
  const add = async () => {
    setMsg(null);
    try { await api(`/api/pos/${poId}/tracking`, { method: "POST", body: JSON.stringify({ carrier, tracking_number: number }) }); setNumber(""); changed(); }
    catch (e: any) { setMsg(e.message); }
  };
  const clearReview = async () => { await api(`/api/pos/${poId}/review-velocity/clear`, { method: "POST" }).catch(() => {}); changed(); };
  if (err) return <p className="text-sm text-destructive">{err}</p>;
  if (!rows) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const open = rows.filter((r) => r.review_reason && !r.suppressed_at);
  const reasons = [...Array.from(new Set(open.map((r) => r.review_reason))), ...(homeReview ? [`${homeReview.reason} (${homeReview.orders})`] : [])];
  return (
    <div className="space-y-3 text-sm" data-testid="po-tracking-tab">
      {reasons.length > 0 && (
        <div className="flex items-center gap-2 rounded border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs">
          <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />
          <span data-testid="text-review-velocity-reasons">Review Velocity: {reasons.join(" · ")}</span>
          <Button size="sm" variant="outline" className="h-6 text-xs ml-auto" onClick={() => void clearReview()} data-testid="button-clear-review-velocity">Clear</Button>
        </div>
      )}
      <PoVelocityLinks poId={poId} onChanged={onChanged} />
      {rows.length === 0 ? <p className="text-muted-foreground">No tracking for this PO yet.</p> : (
        <DialogTable><table className="w-full table-fixed text-xs">
          {/* Fixed layout (UI_RULES): the Tracking # column takes what is left; a long item line truncates with a title. */}
          <colgroup><col className="w-16" /><col /><col className="w-32" /><col className="w-20" /><col className="w-24" /><col className="w-24" /><col className="w-36" /><col className="w-28" /><col className="w-14" /></colgroup>
          <thead className="text-muted-foreground text-left">
            <tr><th className="py-1 pr-2">Carrier</th><th className="pr-2">Tracking #</th><th className="pr-2">Order # (email)</th><th className="pr-2">Shipped</th><th className="pr-2">Ship-to</th><th className="pr-2">Status</th><th className="pr-2">Carrier status</th><th className="pr-2">Velocity</th><th /></tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const url = carrierTrackingUrl(r.carrier, r.tracking_number);
              return (
                <tr key={r.id} className="border-t align-top" data-testid={`tracking-row-${r.id}`}>
                  <td className="py-1 pr-2">{r.carrier}</td>
                  <td className="pr-2 font-mono">
                    {url ? <a className="text-primary hover:underline inline-flex items-center gap-0.5" href={url} target="_blank" rel="noreferrer">{r.tracking_number}<ExternalLink className="h-3 w-3" /></a> : r.tracking_number}
                    {r.reassigned_from_order_id && <div className="text-[10px] text-muted-foreground">moved from {r.reassigned_from_order_id}</div>}
                    {(r.qty != null || r.shared_with?.length) ? <div className="text-[10px] text-muted-foreground">{r.qty != null ? <span title="Product units, as the supplier's email states them · the Individual equivalent beside it">{trackingQtyText(Number(r.qty), perProductUnit)}</span> : ""}{r.qty != null && r.shared_with?.length ? " · " : ""}{r.shared_with?.length ? `also on ${r.shared_with.join(", ")}` : ""}</div> : null}
                    {r.items_json?.length ? <div className="text-[10px] text-muted-foreground truncate" title={r.items_json.map((i) => `${i.qty} × ${i.name}`).join("; ")}>{r.items_json.map((i) => `${i.qty} × ${i.name}`).join("; ")}</div> : null}
                  </td>
                  <td className="pr-2 font-mono break-all">{r.retailer_order_id ?? "—"}</td>
                  <td className="pr-2">{fmt(r.shipped_at)}</td>
                  <td className="pr-2">{r.ship_to_street ?? "—"}</td>
                  <td className="pr-2">
                    <span className={`rounded px-1.5 py-0.5 ${STATUS_CLASS[r.status] ?? ""}`}>{r.status}</span>
                    {r.review_reason && <div className={`text-[10px] ${r.suppressed_at ? "text-muted-foreground line-through" : "text-amber-700 dark:text-amber-400"}`}>{r.review_reason}</div>}
                  </td>
                  <td className="pr-2"><CarrierStatusCell row={r} /></td>
                  <td className="pr-2">{r.pushed_at ? <span title={(r.pushed_velocity_ids ?? []).join(", ")}>{fmt(r.pushed_at)} · {(r.pushed_velocity_ids ?? []).length} order(s)</span> : "—"}</td>
                  <td><MoveToPo row={r} onMoved={changed} /></td>
                </tr>
              );
            })}
          </tbody>
        </table></DialogTable>
      )}
      <div className="flex items-center gap-2 text-xs" data-testid="add-tracking">
        <span className="text-muted-foreground">Add tracking</span>
        <select className="h-7 rounded border px-1" value={carrier} onChange={(e) => setCarrier(e.target.value)}>
          {["UPS", "FEDEX", "USPS", "DHL", "AMAZON", "ONTRAC", "LASERSHIP", "GLS", "OTHER"].map((c) => <option key={c}>{c}</option>)}
        </select>
        <input className="h-7 w-56 rounded border px-2 font-mono" placeholder="tracking number" value={number} onChange={(e) => setNumber(e.target.value)} />
        <Button size="sm" className="h-7 text-xs" disabled={!number.trim()} onClick={() => void add()}>Add</Button>
        {msg && <span className="text-destructive">{msg}</span>}
      </div>
    </div>
  );
}

/** The carrier's word on the row: EasyPost's status (ETA while undelivered, the delivery time once delivered, the last scan), else Velocity's tracking status, else "—". */
export function CarrierStatusCell({ row }: { row: Pick<TrackingRow, "carrier_status" | "est_delivery_at" | "last_scan_at" | "delivered_at" | "velocity_tracking_status"> }) {
  const s = carrierStatusText(row);
  if (!s) return <span className="text-muted-foreground">—</span>;
  const delivered = row.carrier_status === "delivered";
  return (
    <div data-testid="carrier-status" title={s.source === "velocity" ? "Velocity's tracking status — EasyPost does not track this carrier" : "EasyPost"}>
      <span className={delivered ? "text-emerald-700 dark:text-emerald-400" : s.source === "velocity" ? "text-muted-foreground" : ""}>{s.text}</span>
      {delivered && row.delivered_at ? <div className="text-[10px] text-muted-foreground">delivered {fmt(row.delivered_at ?? null)}</div> : null}
      {!delivered && row.est_delivery_at ? <div className="text-[10px] text-muted-foreground">ETA {fmt(row.est_delivery_at ?? null)}</div> : null}
      {row.last_scan_at ? <div className="text-[10px] text-muted-foreground">last scan {fmt(row.last_scan_at ?? null)}</div> : null}
    </div>
  );
}

/** POs toolbar: "Sync tracking" (ingest → match → push), with a dry run. */
export function SyncTrackingButton({ onDone }: { onDone?: () => void }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any | null>(null);
  const run = async (dryRun: boolean) => {
    setBusy(true);
    try {
      const r = await api("/api/tracking/sync", { method: "POST", body: JSON.stringify({ dryRun }) });
      setResult(r);
      if (!dryRun) {
        toast({ title: "Tracking synced", description: `${r.ingest.inserted} new · ${r.match.matched} matched · ${r.push.pushed} pushed · ${r.push.push_failed} failed · ${r.push.review} to review` });
        onDone?.();
      }
    } catch (e: any) {
      toast({ title: "Sync tracking failed", description: e.message, variant: "destructive" });
    } finally { setBusy(false); }
  };
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => void run(false)} disabled={busy} data-testid="button-sync-tracking">
        <RefreshCw className={`h-4 w-4 mr-1 ${busy ? "animate-spin" : ""}`} /> {busy ? "Syncing…" : "Sync tracking"}
      </Button>
      <button className="text-xs text-muted-foreground hover:underline" onClick={() => void run(true)} disabled={busy} data-testid="button-sync-tracking-dry">dry run</button>
      <Dialog open={result?.dryRun === true} onOpenChange={(o) => { if (!o) setResult(null); }}>
        <DialogContent dialogId="tracking-dry-run" className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Sync tracking — dry run</DialogTitle>
            <DialogDescription>Nothing was written to AF or Velocity.</DialogDescription>
          </DialogHeader>
          {result && (
            <div className="text-xs space-y-2">
              <p>Gmail: {result.ingest.scanned} scanned · {result.ingest.candidates} candidates · {result.ingest.rows} rows · {result.ingest.placeholders} without a number</p>
              <p>Match: {result.match.matched} matched · {Object.entries(result.match.unmatched).map(([k, v]) => `${v} ${k}`).join(" · ") || "none unmatched"}</p>
              <p>Push: {result.push.plans.filter((p: any) => p.targets.some((t: any) => t.to_add.length)).length} POs to push · {result.push.review} to review · {result.push.received_by_velocity} already received by Velocity · {result.push.held} held</p>
              <DialogTable><table className="w-full"><tbody>
                {result.push.plans.filter((p: any) => p.targets.some((t: any) => t.to_add.length)).map((p: any) => (
                  <tr key={p.po_id} className="border-t"><td className="py-1 pr-2 font-mono">{p.order_id}</td><td>{p.targets.map((t: any) => `${t.asin}: +${t.to_add.join(", ")}${t.already.length ? ` (has ${t.already.join(", ")})` : ""}`).join(" · ")}</td></tr>
                ))}
              </tbody></table></DialogTable>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

interface UnmatchedRow {
  id: number; carrier: string; tracking_number: string; retailer_order_id: string | null; sender_domain: string | null; supplier_guess?: string | null; email_subject: string | null; match_reason: string | null; shipped_at: string | null;
  /** 2026-11-04: "needs_you" counts toward the badge; "no_number" (the AI found no number, or no single PO) does not. */
  tab?: "needs_you" | "no_number";
  /** The message in Gmail, orders@ mailbox (server: authuser); null for a row typed by hand. */
  gmail_url?: string | null;
  /** Up to 3 likely POs (server: guessed supplier's PO, then digits-only order # hits). */
  suggestions?: Array<{ po_id: string; order_id: string; supplier: string }>;
}

/** POs toolbar: "Unmatched tracking (N)" → the queue; N = the "Needs you" rows. Hidden when the queue is empty. */
export function UnmatchedTrackingChip({ suppliers, reloadKey, onChanged }: { suppliers: readonly string[]; reloadKey?: number; onChanged?: () => void }) {
  const [all, setAll] = useState<UnmatchedRow[]>([]);
  const [tab, setTab] = useState<"needs_you" | "no_number">("needs_you");
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { api<{ rows: UnmatchedRow[] }>("/api/tracking/unmatched").then((r) => { setAll(r.rows); setPicked((p) => new Set(Array.from(p).filter((id) => r.rows.some((x) => x.id === id)))); }).catch(() => {}); }, []);
  const needs = all.filter((r) => (r.tab ?? "needs_you") === "needs_you");
  const noNumber = all.filter((r) => r.tab === "no_number");
  const rows = tab === "needs_you" ? needs : noNumber;
  useEffect(() => { load(); }, [load, reloadKey]);
  const act = async (fn: () => Promise<any>) => { setErr(null); try { await fn(); load(); onChanged?.(); } catch (e: any) { setErr(e.message); } };
  const toggle = (id: number) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allPicked = rows.length > 0 && rows.every((r) => picked.has(r.id));
  const dismissPicked = async () => {
    setBusy(true);
    await act(async () => {
      const failed: number[] = [];
      for (const id of Array.from(picked)) await api(`/api/tracking/${id}/dismiss`, { method: "POST" }).catch(() => failed.push(id));
      setPicked(new Set());
      if (failed.length) throw new Error(`${failed.length} row(s) could not be dismissed`);
    });
    setBusy(false);
  };
  if (all.length === 0) return null;
  return (
    <>
      <button className={needs.length ? "inline-flex items-center gap-1 rounded bg-amber-500/15 px-2 py-1 text-xs text-amber-800 dark:text-amber-300" : "inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:text-foreground"} onClick={() => { setTab(needs.length ? "needs_you" : "no_number"); setOpen(true); }} data-testid="chip-unmatched-tracking">
        <AlertTriangle className="h-3.5 w-3.5" /> Unmatched tracking ({needs.length})
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent dialogId="unmatched-tracking" className="max-w-6xl" data-testid="dialog-unmatched-tracking">
          <DialogHeader>
            <DialogTitle>Unmatched tracking</DialogTitle>
            <DialogDescription>Attach a number to its PO, map a sender to a supplier once, or dismiss it.</DialogDescription>
          </DialogHeader>
          {err && <p className="text-xs text-destructive">{err}</p>}
          <div className="flex items-center gap-1 border-b text-xs" role="tablist" data-testid="tabs-unmatched-tracking">
            {([["needs_you", `Needs you (${needs.length})`], ["no_number", `No number in email (${noNumber.length})`]] as const).map(([k, label]) => (
              <button key={k} role="tab" aria-selected={tab === k} onClick={() => { setTab(k); setPicked(new Set()); }}
                className={`-mb-px border-b-2 px-2 py-1 ${tab === k ? "border-foreground font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`} data-testid={`tab-unmatched-${k}`}>{label}</button>
            ))}
          </div>
          {tab === "no_number" && <p className="text-xs text-muted-foreground">The email prints no tracking number (the AI read it), or its order # names no single AF PO. Not counted in the badge.</p>}
          <div className="flex items-center gap-2 text-xs">
            <Button size="sm" variant="outline" className="h-7 text-xs" disabled={picked.size === 0 || busy} onClick={() => void dismissPicked()} data-testid="button-dismiss-selected">
              Dismiss selected ({picked.size})
            </Button>
          </div>
          <DialogTable>
            <table className="w-full min-w-[60rem] table-fixed text-xs">
              <colgroup>
                <col className="w-7" /><col className="w-28" /><col className="w-44" /><col className="w-36" /><col className="w-44" /><col /><col className="w-72" />
              </colgroup>
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th className="py-1"><input type="checkbox" aria-label="Select all" checked={allPicked} onChange={() => setPicked(allPicked ? new Set() : new Set(rows.map((r) => r.id)))} /></th>
                  <th className="pr-2">Reason</th><th className="pr-2">Supplier</th><th className="pr-2">Order #</th><th className="pr-2">Tracking</th><th className="pr-2">Email</th><th>Attach</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => <UnmatchedQueueRow key={r.id} r={r} suppliers={suppliers} act={act} picked={picked.has(r.id)} onPick={() => toggle(r.id)} />)}
              </tbody>
            </table></DialogTable>
        </DialogContent>
      </Dialog>
    </>
  );
}

function UnmatchedQueueRow({ r, suppliers, act, picked, onPick }: { r: UnmatchedRow; suppliers: readonly string[]; act: (fn: () => Promise<any>) => Promise<void>; picked: boolean; onPick: () => void }) {
  const [supplier, setSupplier] = useState("");
  const [order, setOrder] = useState("");
  const [override, setOverride] = useState(false);
  const placeholder = r.tracking_number.startsWith("email:");
  const attach = (poId: string) => act(() => api(`/api/tracking/${r.id}/attach`, { method: "POST", body: JSON.stringify({ po_id: poId }) }));
  const suggestions = r.suggestions ?? [];
  return (
    <tr className="border-t align-top" data-testid={`row-unmatched-${r.id}`}>
      <td className="py-1"><input type="checkbox" aria-label={`Select ${r.tracking_number}`} checked={picked} onChange={onPick} /></td>
      <td className="py-1 pr-2 whitespace-nowrap">{r.match_reason ?? "—"}</td>
      <td className="py-1 pr-2 break-words">
        {r.supplier_guess ?? r.sender_domain ?? "—"}
        {r.supplier_guess && r.sender_domain && r.supplier_guess !== r.sender_domain && <div className="text-[11px] text-muted-foreground">via {r.sender_domain}</div>}
        {r.match_reason === "unknown_sender" && r.sender_domain && (
          <div className="flex items-center gap-1 mt-0.5">
            <select className="h-6 min-w-0 flex-1 rounded border bg-background px-1 text-foreground" value={supplier} onChange={(e) => setSupplier(e.target.value)}>
              <option value="">map to supplier…</option>
              {suppliers.map((s) => <option key={s}>{s}</option>)}
            </select>
            <Button size="sm" className="h-6 text-xs" disabled={!supplier} onClick={() => void act(() => api("/api/tracking/domain-map", { method: "POST", body: JSON.stringify({ domain: r.sender_domain, supplier }) }))}>Map</Button>
          </div>
        )}
      </td>
      <td className="py-1 pr-2 font-mono break-all">{r.retailer_order_id ?? "—"}</td>
      <td className="py-1 pr-2 font-mono break-all">{placeholder ? <span className="font-sans text-muted-foreground">no number in the email</span> : `${r.carrier} ${r.tracking_number}`}</td>
      <td className="py-1 pr-2 break-words">
        <div><span className="text-muted-foreground">{r.shipped_at ? new Date(r.shipped_at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "—"}</span> · {r.email_subject ?? ""}</div>
        {r.gmail_url && <GmailLink url={r.gmail_url} />}
      </td>
      <td className="py-1">
        <div className="flex flex-wrap items-center gap-1">
          {!placeholder && suggestions.map((sg) => (
            <Button key={sg.po_id} size="sm" className="h-6 text-xs" title={sg.supplier} onClick={() => void attach(sg.po_id)} data-testid={`button-attach-suggested-${r.id}`}>
              Attach to {sg.order_id}
            </Button>
          ))}
          {!placeholder && !override && (
            <button className="text-primary hover:underline" onClick={() => setOverride(true)}>{suggestions.length ? "other PO…" : "attach to PO…"}</button>
          )}
          <button className="text-muted-foreground hover:underline" onClick={() => void act(() => api(`/api/tracking/${r.id}/dismiss`, { method: "POST" }))}>dismiss</button>
        </div>
        {!placeholder && override && (
          <div className="mt-1 flex items-center gap-1">
            <input className="h-6 w-36 rounded border bg-background px-1 font-mono" placeholder="PO order #" value={order} autoFocus onChange={(e) => setOrder(e.target.value)} />
            <Button size="sm" variant="outline" className="h-6 text-xs" disabled={!order.trim()} onClick={() => void act(async () => {
              const po = await findPo(order);
              if ("error" in po) throw new Error(po.error);
              await api(`/api/tracking/${r.id}/attach`, { method: "POST", body: JSON.stringify({ po_id: po.id }) });
            })}>Attach</Button>
            <button className="text-muted-foreground hover:underline" onClick={() => setOverride(false)}>cancel</button>
          </div>
        )}
      </td>
    </tr>
  );
}

/** "Open in Gmail" (the orders@ mailbox) and a copy-link icon copying the same URL. */
function GmailLink({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => { void navigator.clipboard?.writeText(url).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {}); };
  return (
    <span className="mt-0.5 inline-flex items-center gap-1.5 text-[11px]">
      <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-primary hover:underline" data-testid="link-open-in-gmail"><ExternalLink className="h-3 w-3" /> Open in Gmail</a>
      <button type="button" onClick={copy} className="text-muted-foreground/70 hover:text-foreground" title="Copy Gmail link" aria-label="Copy Gmail link" data-testid="button-copy-gmail-link">
        {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      </button>
    </span>
  );
}
