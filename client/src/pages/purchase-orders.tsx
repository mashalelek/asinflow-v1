/**
 * POs page — PO module v1 frame, list view (docs/po-module-v1-frame-plan.md §3).
 *
 * READ-ONLY frame over the migrated 2026 data: list + filters + pagination.
 * + New PO opens the New PO form (po-af-owned §4, 2026-10-18). The
 * Upload to Velocity toolbar ACTION (SPEC §11) stays exactly where it was.
 * Row click navigates to the expanded-view route (placeholder until step 4).
 *
 * §7 styling: zebra + 0.5px hairlines, dark header bar, no vertical dividers,
 * no row tints; ALL money renders neutral ($0.00 muted) — semantic color is
 * reserved for warnings.
 */
import React, { useState, useEffect, useCallback } from "react";
import { useLocation, Link } from "wouter";
import { Upload, Paperclip, StickyNote, Plus, Search, Copy, Check, ChevronRight, ChevronDown, ChevronsDownUp, ChevronsUpDown, CheckCircle2, Circle, RefreshCw, AlertTriangle } from "lucide-react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { UploadToVelocityDialog } from "@/components/upload-to-velocity-dialog";
import { PoAsinTable, PoAsinColGroup, PoAsinHeaderRow, PoAsinRow, ActionItemChips, type PoAsinRowData, type PoAsinLine } from "@/components/po-asin-rows";
import { loadPoExpanded, savePoExpanded, isPoExpanded, togglePoExpanded, toggleExpandAll, type PoExpandedState } from "@/lib/po-expanded";
import { fmtQty } from "@/lib/po-qty";
import { fetchLongSync } from "@/lib/long-sync";
import { useToast } from "@/hooks/use-toast";
import { PoHeaderDrawer, PoProductsTable, PoHistory, PoDangerActions } from "@/components/po-edit";
import { PoTrackingTab, SyncTrackingButton, UnmatchedTrackingChip } from "@/components/po-tracking";
import { NewPoDialog } from "@/components/new-po-dialog";
import { Pencil } from "lucide-react";

interface PoRow {
  id: string;
  order_id: string;
  order_date: string;
  supplier: string;
  /** §6: multi-select Action Items (the old free-text status is no longer read). */
  action_items: string[];
  /** SPEC §26: the open "Review Velocity" reasons (the chip's hover). */
  review_velocity_reasons?: string[] | null;
  ships_to?: "velocity" | "home";
  order_total: string | null;
  invoice_attached: boolean;
  asin_count: number;
  units_ordered: number;
  units_received: number | null; // null = not tracked on any line → "—"
  has_notes: boolean;
  /** §5: NULL = Open. closed_by 'auto' | 'sheet' | 'import' (pre-2026 history, "Imported (history)") | a user id. */
  closed_at: string | null;
  closed_by: string | null;
  /** Expand by ASIN (§3): the PO's ASIN rows, same model as the detail tab. */
  asins: PoAsinRowData[];
}

interface PosResponse {
  pos: PoRow[];
  total: number;
  page: number;
  pageSize: number;
  suppliers: string[];
  /** The §6.1 list, display order. */
  actionItems: string[];
  closed: "open" | "closed" | "all";
  /** Shipment reconciliation §5.3: open unmatched Velocity lines + ambiguous SC matches. */
  unmatchedCount?: number;
}

type ClosedFilter = "open" | "closed" | "all";

/** §5 col 1: green check when Closed, open-order outline when Open. Click toggles with confirm. */
function ClosedToggle({ po, onToggled, size = "sm" }: { po: { id: string; order_id: string; closed_at: string | null; closed_by: string | null }; onToggled: () => void; size?: "sm" | "lg" }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const isClosed = po.closed_at != null;
  const apply = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/pos/${po.id}/closed`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ closed: !isClosed }) });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || `HTTP ${res.status}`);
      onToggled();
    } finally { setBusy(false); setOpen(false); }
  };
  const icon = isClosed
    ? <CheckCircle2 className={`${size === "lg" ? "h-5 w-5" : "h-4 w-4"} text-green-600`} />
    : <Circle className={`${size === "lg" ? "h-5 w-5" : "h-4 w-4"} text-muted-foreground`} />;
  const who = po.closed_by === "auto" ? "closed automatically" : po.closed_by === "sheet" ? "closed (from the Orders sheet)" : po.closed_by === "import" ? "Imported (history)" : "closed by hand";
  return (
    <>
      <button type="button" onClick={(e) => { e.stopPropagation(); setOpen(true); }} title={isClosed ? who : "Open"}
        className="inline-flex items-center" data-testid={`button-po-closed-${po.order_id}`} aria-pressed={isClosed}>{icon}</button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent onClick={(e) => e.stopPropagation()}>
          <AlertDialogHeader>
            <AlertDialogTitle>{isClosed ? "Reopen this PO?" : "Close this PO?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {isClosed
                ? `${po.order_id} is ${who}. Reopening keeps it Open until every unit is accounted for and no action items remain.`
                : `${po.order_id} will be marked Closed by you. It will not be reopened automatically.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={busy} onClick={(e) => { e.preventDefault(); void apply(); }} data-testid="button-po-closed-confirm">{isClosed ? "Reopen" : "Close"}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// Action Items (row-level Status, 2026-10-17): the PO column is the read-only
// union over the PO's product lines; edit on the nested ASIN / product rows
// (shared ActionItemsEditor in po-asin-rows.tsx).

// Searchable multi-select facet — same interaction pattern as the main
// page's Tags/Supplier filters (type-ahead, select/clear all, checkbox
// list). OR within a facet; facets AND together server-side.
function FacetMultiSelect({ label, options, selected, onChange, testId }: {
  label: string;
  options: string[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  testId: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const filtered = q.trim() ? options.filter((o) => o.toLowerCase().includes(q.toLowerCase())) : options;
  return (
    <Popover open={open} onOpenChange={(v) => { setOpen(v); if (v) setQ(""); }}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 text-xs font-normal" data-testid={testId}>
          {label}{selected.size > 0 ? ` (${selected.size})` : ""}
          <ChevronDown className="h-3 w-3 ml-1 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-2 space-y-2" align="start">
        <Input placeholder="Search..." value={q} onChange={(e) => setQ(e.target.value)} className="h-7 text-xs" autoFocus />
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
          <button className="hover:text-foreground" onClick={() => onChange(new Set(options))}>Select all</button>
          <span>·</span>
          <button className="hover:text-foreground" onClick={() => onChange(new Set())}>Clear all</button>
          <span className="ml-auto">{selected.size} selected</span>
        </div>
        <div className="max-h-48 overflow-y-auto -mx-1 space-y-0.5">
          {filtered.map((opt) => (
            <label key={opt} className="flex items-center gap-2 px-2 py-1 rounded hover:bg-muted cursor-pointer text-xs">
              <input type="checkbox" checked={selected.has(opt)} onChange={() => {
                const next = new Set(selected);
                if (next.has(opt)) next.delete(opt); else next.add(opt);
                onChange(next);
              }} className="h-3 w-3 accent-blue-500" />
              <span className="truncate">{opt}</span>
            </label>
          ))}
          {filtered.length === 0 && <div className="px-2 py-1 text-xs text-muted-foreground">No matches</div>}
        </div>
      </PopoverContent>
    </Popover>
  );
}

const ALL = "__all__";

// ── Shipment reconciliation (patch docs/claude_spec-patch-shipment-reconciliation.md §5) ──

interface UnmatchedLine { id: string; velocity_shipment_id: string; velocity_order_id: string; reason: "no_order" | "po_not_found"; shipped_at: string | null; order_number: string | null; retailer: string | null; asin: string | null; amazon_sku: string | null; item_name: string | null; sold_as: string | null; units_per_pack: string | null; quantity_shipped: string | null;
  /** Ranked candidates, best first (PO matching §4): Col P rows (sheet FBA Shipment ID) or the ASIN + date + units rule. */
  candidates: UnmatchedCandidate[] | null;
  /** Why no PO fits (§4), when there is no candidate — or why the one Col P row was not taken. */
  nearest_miss: string | null;
  /** The Velocity retailer resolves to no AF supplier (no alias, not a supplier name) → "Map → supplier". */
  retailer_unmapped: boolean;
  dismissed_at: string | null;
  /** Optional note given when the line was dismissed (2026-10-29). */
  dismiss_note?: string | null }
interface UnmatchedCandidate { po_asin_id: string; order_id: string; supplier: string; asin: string; source?: "col_p" | "candidate"; order_date?: string; days?: number; remaining_units?: number; units?: number }
interface UnmatchedResponse { lines: UnmatchedLine[]; dismissed: UnmatchedLine[]; ambiguous: Array<{ id: string; shipped_at: string | null; rows: number }>; count: number }
interface PickerRow { id: string; asin: string; asin_name: string | null; qty: number; units_per_pack: number; order_id: string; supplier: string; order_date: string; velocity_warning?: string | null }

/** Toast text for a Sync Shipments result (§5.2). */
export function syncShipmentsToast(data: any): { title: string; description: string; failed: boolean } {
  const v = data?.velocity, sc = data?.sc;
  const vLine = !v ? "Velocity: not run" : "error" in v ? `Velocity: FAILED — ${v.error}`
    : `Velocity: ${v.counts.shipments} shipments, ${v.counts.linesMatched} of ${v.counts.lines} lines matched, ${v.counts.linesNoOrder + v.counts.linesPoNotFound} unmatched`;
  const sLine = !sc ? "SC: not run" : "error" in sc ? `SC: FAILED — ${sc.error}`
    : `SC: ${sc.counts.matched} matched, ${sc.counts.ambiguous} ambiguous, ${sc.counts.unmatched} unmatched, received updated on ${sc.counts.rowsReceivedUpdated} rows, over-received ${sc.counts.overReceivedRows ?? 0}`;
  const closeLine = data?.autoClose && !data?.dryRun ? ` Auto-close: ${data.autoClose.closed} closed, ${data.autoClose.reopened} reopened.` : "";
  const failed = !v || !sc || "error" in v || "error" in sc;
  return { title: data?.dryRun ? "Shipment sync (dry run)" : failed ? "Shipments synced with errors" : "Shipments synced", description: `${vLine}. ${sLine}.${closeLine}`, failed };
}

/** "Link to PO ASIN" picker: search PO ASIN rows by order #, ASIN or supplier. */
function LinkPicker({ line, onPick }: { line: UnmatchedLine; onPick: (r: PickerRow) => Promise<void> }) {
  const [q, setQ] = useState(line.order_number || line.asin || "");
  const [rows, setRows] = useState<PickerRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (q.trim().length < 2) { setRows([]); return; }
    const h = setTimeout(() => {
      fetch(`/api/pos/asin-rows/search?q=${encodeURIComponent(q.trim())}`).then((r) => r.json()).then((d) => setRows(d.rows ?? [])).catch(() => setRows([]));
    }, 200);
    return () => clearTimeout(h);
  }, [q]);
  const link = async (r: PickerRow) => {
    setErr(null);
    try { await onPick(r); } catch (e: any) { setErr(e.message); }
  };
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-7 text-xs" data-testid={`button-link-unmatched-${line.id}`}>Link to PO ASIN</Button>
      </PopoverTrigger>
      <PopoverContent className="w-[28rem] p-2 text-xs space-y-1" align="end">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Order #, ASIN or supplier" className="h-7 text-xs" data-testid={`input-link-search-${line.id}`} />
        <div className="max-h-64 overflow-auto divide-y divide-border/50">
          {rows.map((r) => (
            <button key={r.id} onClick={() => link(r)} className="flex w-full items-center justify-between gap-2 px-1 py-1 text-left hover:bg-muted/60" data-testid={`button-pick-${r.id}`}>
              <span className="font-mono">{r.order_id}</span>
              <span className="text-muted-foreground truncate">{r.supplier}</span>
              <span className="font-mono">{r.asin}</span>
              <span className="text-muted-foreground">{r.order_date} · {fmtQty(r.qty)}{r.units_per_pack > 1 ? ` × ${r.units_per_pack}` : ""}</span>
              {r.velocity_warning && <span className="text-amber-500" title={`Not a Velocity PO: ${r.velocity_warning}. Linking is still allowed.`} data-testid={`warn-pick-${r.id}`}>⚠ {r.velocity_warning}</span>}
            </button>
          ))}
          {q.trim().length >= 2 && rows.length === 0 && <div className="px-1 py-2 text-muted-foreground">No PO ASIN rows match.</div>}
        </div>
        {err && <div className="text-destructive">{err}</div>}
      </PopoverContent>
    </Popover>
  );
}

export interface Overshoot { ordered: number; shipped_before: number; shipped_after: number }
/**
 * Link a line to a PO ASIN row — candidate buttons and the picker alike.
 * A link past Ordered comes back as an overshoot (nothing written) until it
 * is confirmed with a note (2026-10-29: "Extra units shipped").
 */
async function linkUnmatched(lineId: string, poAsinId: string, confirmNote?: string): Promise<{ overshoot?: Overshoot }> {
  const body = confirmNote == null ? { po_asin_id: poAsinId } : { po_asin_id: poAsinId, confirm_overshoot: true, note: confirmNote };
  const res = await fetch(`/api/pos/unmatched/${lineId}/link`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (res.status === 409 && data.code === "overshoot") return { overshoot: { ordered: data.ordered, shipped_before: data.shipped_before, shipped_after: data.shipped_after } };
  if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
  return {};
}

/** Text for a candidate button: order #, then why it ranks where it does. */
export function candidateLabel(c: UnmatchedCandidate): string {
  if (c.source === "candidate" && c.days != null) return `${c.order_id} · ${c.days === 0 ? "same day" : `${c.days > 0 ? "+" : ""}${c.days}d`} · ${c.remaining_units} left`;
  return `${c.order_id} · Col P`;
}

function whyText(l: UnmatchedLine): string {
  if (l.nearest_miss) return l.nearest_miss;
  if (l.candidates?.length) return l.candidates.some((c) => c.source === "candidate") ? `${l.candidates.length} POs fit — pick one` : `Col P names ${l.candidates.length} rows — pick one`;
  return l.reason === "no_order" ? "no Order # at Velocity" : "Order # not in AF";
}

/**
 * Unmatched shipments panel (PO matching §6): hidden when empty; only the
 * lines no rule could place — ranked candidates on the row, the nearest miss
 * when there are none, "Map → supplier" for an unmapped Velocity retailer,
 * bulk dismiss (hidden, never deleted). The count is the visible rows.
 */
function UnmatchedPanel({ onChanged, suppliers }: { onChanged: () => void; suppliers: readonly string[] }) {
  const [data, setData] = useState<UnmatchedResponse | null>(null);
  const [open, setOpen] = useState(false);
  const [showDismissed, setShowDismissed] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dismissNote, setDismissNote] = useState("");
  const load = useCallback(() => {
    fetch("/api/pos/unmatched").then((r) => r.json()).then((d) => { setData(d); setPicked(new Set()); }).catch(() => setData(null));
  }, []);
  useEffect(() => { load(); }, [load]);
  const act = async (fn: () => Promise<unknown>) => {
    setErr(null); setBusy(true);
    try { await fn(); load(); onChanged(); } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  if (!data || (data.count === 0 && (data.dismissed ?? []).length === 0)) return null;
  const lines = data.lines;
  const allPicked = lines.length > 0 && lines.every((l) => picked.has(l.id));
  const toggle = (id: string) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const dismiss = () => act(async () => {
    const res = await fetch("/api/pos/unmatched/dismiss", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: Array.from(picked), note: dismissNote }) });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || `HTTP ${res.status}`);
    setDismissNote("");
  });
  return (
    <div className="rounded-md" style={{ border: "0.5px solid hsl(var(--border))" }} data-testid="po-unmatched-panel">
      <button className="flex w-full items-center justify-between px-3 py-2 text-sm" onClick={() => setOpen((o) => !o)} data-testid="button-po-unmatched-toggle">
        <span className="inline-flex items-center gap-2"><AlertTriangle className="h-4 w-4 text-amber-600" /> Unmatched shipments
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800" data-testid="text-po-unmatched-count">{data.count}</span>
        </span>
        {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
      </button>
      {open && (
        <div className="px-3 pb-3 space-y-2 text-xs">
          {err && <div className="text-destructive">{err}</div>}
          {lines.length > 0 && (
            <>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" className="h-7 text-xs" disabled={picked.size === 0 || busy} onClick={() => void dismiss()} data-testid="button-unmatched-dismiss-selected">
                  Dismiss selected ({picked.size})
                </Button>
                <Input value={dismissNote} onChange={(e) => setDismissNote(e.target.value)} placeholder="note (optional)" className="h-7 w-72 text-xs" data-testid="input-unmatched-dismiss-note" />
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[64rem]">
                  <thead><tr className="text-muted-foreground text-left">
                    <th className="py-1 pr-2"><input type="checkbox" aria-label="Select all" checked={allPicked} onChange={() => setPicked(allPicked ? new Set() : new Set(lines.map((l) => l.id)))} /></th>
                    <th className="py-1 pr-2">Shipped</th><th className="py-1 pr-2">Order #</th><th className="py-1 pr-2">Retailer</th><th className="py-1 pr-2">ASIN</th><th className="py-1 pr-2">Item</th><th className="py-1 pr-2 text-right">Units</th><th className="py-1 pr-2">Why</th><th className="py-1">Link</th>
                  </tr></thead>
                  <tbody>
                    {lines.map((l) => (
                      <UnmatchedRow key={l.id} l={l} suppliers={suppliers} picked={picked.has(l.id)} onPick={() => toggle(l.id)} busy={busy} act={act} onLinked={() => { load(); onChanged(); }} />
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {data.ambiguous.length > 0 && (
            <div className="space-y-1">
              <div className="text-muted-foreground">Seller Central match ambiguous (two STA groups with identical SKUs on the same day) — resolve in Velocity / Seller Central, then Sync Shipments again:</div>
              {data.ambiguous.map((a) => <div key={a.id} className="font-mono" data-testid={`row-ambiguous-${a.id}`}>Velocity {a.id} · {a.shipped_at ?? "?"} · {a.rows} PO ASIN rows</div>)}
            </div>
          )}
          {(data.dismissed ?? []).length > 0 && (
            <div>
              <button className="inline-flex items-center gap-1 text-muted-foreground" onClick={() => setShowDismissed((v) => !v)} data-testid="button-unmatched-dismissed-toggle">
                {showDismissed ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />} Dismissed ({data.dismissed.length})
              </button>
              {showDismissed && (
                <div className="mt-1 space-y-0.5 text-muted-foreground" data-testid="list-unmatched-dismissed">
                  {data.dismissed.map((l) => <div key={l.id} className="font-mono">{l.shipped_at ?? "—"} · {l.order_number || "(none)"} · {l.retailer || "—"} · {l.asin} · {l.quantity_shipped}u · dismissed {String(l.dismissed_at).slice(0, 10)}{l.dismiss_note ? ` — ${l.dismiss_note}` : ""}</div>)}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function UnmatchedRow({ l, suppliers, picked, onPick, busy, act, onLinked }: {
  l: UnmatchedLine; suppliers: readonly string[]; picked: boolean; onPick: () => void; busy: boolean;
  act: (fn: () => Promise<unknown>) => Promise<void>; onLinked: () => void;
}) {
  const [supplier, setSupplier] = useState("");
  const [pending, setPending] = useState<{ poAsinId: string; label: string; o: Overshoot } | null>(null);
  const [note, setNote] = useState("");
  const cands = l.candidates ?? [];
  const tryLink = async (poAsinId: string, label: string) => {
    const r = await linkUnmatched(l.id, poAsinId);
    if (r.overshoot) { setPending({ poAsinId, label, o: r.overshoot }); setNote(""); return; }
    onLinked();
  };
  return (
    <tr className="align-top" style={{ borderTop: "0.5px solid hsl(var(--border))" }} data-testid={`row-unmatched-${l.id}`}>
      <td className="py-1 pr-2"><input type="checkbox" aria-label={`Select ${l.order_number || l.asin}`} checked={picked} onChange={onPick} /></td>
      <td className="py-1 pr-2 whitespace-nowrap">{l.shipped_at ?? "—"}</td>
      <td className="py-1 pr-2 font-mono break-all">{l.order_number || <span className="text-muted-foreground">(none)</span>}</td>
      <td className="py-1 pr-2">
        {l.retailer || "—"}
        {l.retailer_unmapped && l.retailer && (
          <div className="flex items-center gap-1 mt-0.5" data-testid={`map-retailer-${l.id}`}>
            <select className="h-6 min-w-0 max-w-[10rem] rounded border bg-background px-1 text-foreground" value={supplier} onChange={(e) => setSupplier(e.target.value)}>
              <option value="">map to supplier…</option>
              {suppliers.map((s) => <option key={s}>{s}</option>)}
            </select>
            <Button size="sm" className="h-6 text-xs" disabled={!supplier || busy} onClick={() => void act(async () => {
              const res = await fetch("/api/supplier-aliases", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ alias: l.retailer, supplier }) });
              if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || `HTTP ${res.status}`);
            })}>Map</Button>
          </div>
        )}
      </td>
      <td className="py-1 pr-2 font-mono">{l.asin}</td>
      <td className="py-1 pr-2 truncate max-w-[14rem]" title={l.item_name ?? ""}>{l.item_name}</td>
      <td className="py-1 pr-2 text-right">{l.quantity_shipped}{l.units_per_pack && Number(l.units_per_pack) > 1 ? ` (÷${l.units_per_pack})` : ""}</td>
      <td className="py-1 pr-2 text-muted-foreground" data-testid={`text-unmatched-why-${l.id}`}>{whyText(l)}</td>
      <td className="py-1">
        <div className="flex flex-wrap items-center gap-1">
          {cands.map((c) => (
            <Button key={c.po_asin_id} size="sm" variant="secondary" className="h-6 text-xs font-mono" disabled={busy} title={`${c.supplier} ${c.asin}${c.order_date ? ` · PO ${c.order_date}` : ""}`}
              onClick={() => void act(() => tryLink(c.po_asin_id, c.order_id))} data-testid={`button-link-candidate-${l.id}-${c.po_asin_id}`}>
              Link to {candidateLabel(c)}
            </Button>
          ))}
          <LinkPicker line={l} onPick={(r) => tryLink(r.id, r.order_id)} />
        </div>
        {pending && (
          <div className="mt-1 space-y-1 rounded border border-red-500/40 bg-red-500/5 p-2" data-testid={`overshoot-${l.id}`}>
            <div className="text-red-600 dark:text-red-400">
              Linking to {pending.label} puts Shipped FBA at {fmtQty(pending.o.shipped_after)} of {fmtQty(pending.o.ordered)} ordered — the row gets "Extra units shipped".
            </div>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Why (required) — stored on the row and in PO History"
              className="w-full rounded border border-input bg-background p-1 text-xs" data-testid={`input-overshoot-note-${l.id}`} />
            <div className="flex gap-1">
              <Button size="sm" variant="destructive" className="h-6 text-xs" disabled={!note.trim() || busy}
                onClick={() => void act(async () => { await linkUnmatched(l.id, pending.poAsinId, note.trim()); setPending(null); })} data-testid={`button-overshoot-confirm-${l.id}`}>Link anyway</Button>
              <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={() => setPending(null)}>Cancel</Button>
            </div>
          </div>
        )}
      </td>
    </tr>
  );
}

function fmtMoney(v: string | null): { text: string; muted: boolean } {
  const n = v != null ? parseFloat(v) : null;
  if (n == null) return { text: "—", muted: true };
  const text = `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return { text, muted: n === 0 }; // $0.00 renders muted, never colored
}

function fmtDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${Number(m)}/${Number(d)}/${y}`;
}

export default function PurchaseOrders() {
  const [, navigate] = useLocation();
  const [velocityOpen, setVelocityOpen] = useState(false);
  const [newPoOpen, setNewPoOpen] = useState(false);
  // Deep link from the ASINs page's On Order cell (patch asins-on-order §3.2):
  // /purchase-orders?asin=B0… opens the list searched on that ASIN, Open and
  // Closed (row-level Status §2.4: On Order counts closed POs too).
  const linkedAsin = (() => { try { return new URLSearchParams(window.location.search).get("asin")?.trim().toUpperCase() ?? ""; } catch { return ""; } })();
  const [search, setSearch] = useState(linkedAsin);
  const [debouncedSearch, setDebouncedSearch] = useState(linkedAsin);
  const [actionSel, setActionSel] = useState<Set<string>>(new Set());
  const [closedFilter, setClosedFilter] = useState<ClosedFilter>(linkedAsin ? "all" : "open"); // D3: default Open only; the ASINs-page link opens All
  const [supplierSel, setSupplierSel] = useState<Set<string>>(new Set());
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<PosResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Expand by ASIN (§3.4): persisted per browser, default all collapsed.
  const [expandedState, setExpandedState] = useState<PoExpandedState>(loadPoExpanded);
  const applyExpanded = (next: PoExpandedState) => { setExpandedState(next); savePoExpanded(next); };
  const { toast } = useToast();
  const [isSyncingShipments, setIsSyncingShipments] = useState(false);
  const [unmatchedKey, setUnmatchedKey] = useState(0);
  const [trackingKey, setTrackingKey] = useState(0);

  useEffect(() => {
    const h = setTimeout(() => setDebouncedSearch(search), 250);
    return () => clearTimeout(h);
  }, [search]);

  const actionKey = Array.from(actionSel).sort().join(",");
  const supplierKey = Array.from(supplierSel).sort().join(",");
  useEffect(() => { setPage(1); }, [debouncedSearch, actionKey, supplierKey, from, to, closedFilter]);

  const load = useCallback(async () => {
    setError(null);
    const params = new URLSearchParams();
    if (debouncedSearch) params.set("search", debouncedSearch);
    if (actionKey) params.set("action", actionKey);
    params.set("closed", closedFilter);
    if (supplierKey) params.set("supplier", supplierKey);
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    params.set("page", String(page));
    try {
      const res = await fetch(`/api/pos?${params.toString()}`);
      if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.message || `HTTP ${res.status}`); }
      setData(await res.json());
    } catch (e: any) {
      setError(e.message);
    }
  }, [debouncedSearch, actionKey, supplierKey, from, to, page, closedFilter]);

  useEffect(() => { load(); }, [load]);

  // Sync Shipments (§5.2, D3): component A then B as one direct call; both outcomes in the toast.
  const handleSyncShipments = useCallback(async () => {
    setIsSyncingShipments(true);
    try {
      const result = await fetchLongSync("/api/pos/sync-shipments");
      const t = syncShipmentsToast(result);
      toast({ title: t.title, description: t.description, variant: t.failed ? "destructive" : undefined });
      setUnmatchedKey((k) => k + 1);
      await load();
    } catch (err: any) {
      toast({ title: "Shipment sync failed", description: err.message, variant: "destructive" });
    } finally {
      setIsSyncingShipments(false);
    }
  }, [toast, load]);

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const showFrom = data && data.total > 0 ? (data.page - 1) * data.pageSize + 1 : 0;
  const showTo = data ? Math.min(data.page * data.pageSize, data.total) : 0;

  // Numbered pagination with a window around the current page.
  const pageNumbers = (() => {
    const nums: number[] = [];
    const lo = Math.max(1, page - 2), hi = Math.min(totalPages, page + 2);
    if (lo > 1) nums.push(1);
    for (let n = lo; n <= hi; n++) nums.push(n);
    if (hi < totalPages) nums.push(totalPages);
    return nums;
  })();

  const hairline = { borderBottom: "0.5px solid hsl(var(--border))" } as const;

  return (
    <div className="px-6 py-4 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Purchase Orders</h1>
        <div className="flex items-center gap-2">
          {/* New PO form (po-af-owned §4). */}
          <Button variant="default" size="sm" onClick={() => setNewPoOpen(true)} data-testid="button-new-po">
            <Plus className="h-4 w-4 mr-1" /> New PO
          </Button>
          <NewPoDialog open={newPoOpen} onOpenChange={setNewPoOpen} onCreated={(id) => navigate(`/purchase-orders/${id}`)} />
          <Button variant="outline" size="sm" onClick={() => applyExpanded(toggleExpandAll(expandedState))} data-testid="button-po-expand-all">
            {expandedState.all ? <ChevronsDownUp className="h-4 w-4 mr-1" /> : <ChevronsUpDown className="h-4 w-4 mr-1" />}
            {expandedState.all ? "Collapse All" : "Expand All"}
          </Button>
          <Button variant="outline" size="sm" onClick={() => setVelocityOpen(true)}>
            <Upload className="h-4 w-4 mr-1" /> Upload to Velocity
          </Button>
          <Button variant="outline" size="sm" onClick={handleSyncShipments} disabled={isSyncingShipments} data-testid="button-sync-shipments">
            <RefreshCw className={`h-4 w-4 mr-1 ${isSyncingShipments ? "animate-spin" : ""}`} /> {isSyncingShipments ? "Syncing…" : "Sync Shipments"}
          </Button>
          {/* PO tracking → Velocity (SPEC §26). */}
          <UnmatchedTrackingChip suppliers={data?.suppliers ?? []} reloadKey={trackingKey} onChanged={load} />
          <SyncTrackingButton onDone={() => { setTrackingKey((k) => k + 1); void load(); }} />
        </div>
      </div>

      <UnmatchedPanel key={unmatchedKey} onChanged={load} suppliers={data?.suppliers ?? []} />

      {/* Toolbar: search · status token · supplier · date range */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative">
          <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder="Search order ID, ASIN, product name..."
            className="h-8 w-[280px] pl-8 text-sm" data-testid="input-po-search" />
        </div>
        <Select value={closedFilter} onValueChange={(v) => setClosedFilter(v as ClosedFilter)}>
          <SelectTrigger className="h-8 w-[120px] text-xs" data-testid="select-po-closed"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="open">Open</SelectItem>
            <SelectItem value="closed">Closed</SelectItem>
            <SelectItem value="all">All</SelectItem>
          </SelectContent>
        </Select>
        <FacetMultiSelect label="Action Items" options={data?.actionItems ?? []} selected={actionSel} onChange={setActionSel} testId="select-po-action-items" />
        <FacetMultiSelect label="Supplier" options={data?.suppliers ?? []} selected={supplierSel} onChange={setSupplierSel} testId="select-po-supplier" />
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
          className="h-8 rounded-md border border-input bg-background px-2 text-sm" data-testid="input-po-from" />
        <span className="text-xs text-muted-foreground">to</span>
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
          className="h-8 rounded-md border border-input bg-background px-2 text-sm" data-testid="input-po-to" />
      </div>

      {error && <div className="text-sm text-destructive" data-testid="text-po-error">{error}</div>}

      <div className="w-full overflow-auto rounded-md" style={{ border: "0.5px solid hsl(var(--border))" }}>
        <table className="w-full border-collapse text-sm" data-testid="po-table">
          <thead>
            <tr className="table-header-stone">
              <th className="px-2 py-2 text-xs font-medium whitespace-nowrap text-left w-12">Status</th>
              <th className="w-8 px-2 py-2" aria-label="Expand by ASIN" />
              {["Action Items", "PO Date", "Order ID", "Supplier", "Order Total", "ASINs", "Units Ordered", "Invoice", "Notes"].map((h, i) => (
                <th key={h} className={`px-3 py-2 text-xs font-medium whitespace-nowrap ${i >= 4 && i <= 6 ? "text-right" : "text-left"}`}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(() => {
              const visibleIds = (data?.pos ?? []).map((p) => p.id);
              // §3.2: the nested column header appears ONCE, under the first expanded PO on the page.
              const firstExpandedId = visibleIds.find((id) => isPoExpanded(expandedState, id)) ?? null;
              return (data?.pos ?? []).map((po) => {
              const money = fmtMoney(po.order_total);
              const open = isPoExpanded(expandedState, po.id);
              return (
                <React.Fragment key={po.id}>
                <tr className="table-zebra-stone cursor-pointer hover:bg-muted/40" style={hairline}
                  onClick={() => navigate(`/purchase-orders/${po.id}`)} data-testid={`row-po-${po.order_id}`}>
                  {/* §5 col 1: Open / Closed */}
                  <td className="px-2 py-2 w-12" onClick={(e) => e.stopPropagation()}>
                    <ClosedToggle po={po} onToggled={load} />
                  </td>
                  {/* §3.1: the chevron is the ONLY expand target; the rest of the row still opens the PO. */}
                  <td className="px-2 py-2 w-8" onClick={(e) => e.stopPropagation()}>
                    <button type="button" className="text-muted-foreground hover:text-foreground"
                      onClick={() => applyExpanded(togglePoExpanded(expandedState, po.id, visibleIds))}
                      aria-expanded={open} data-testid={`button-po-expand-${po.order_id}`}>
                      {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                    </button>
                  </td>
                  <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                    <ActionItemChips items={po.action_items} reasons={po.review_velocity_reasons} testId={`po-action-items-${po.order_id}`} />
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">{fmtDate(po.order_date)}</td>
                  <td className="px-3 py-2 font-mono text-xs">{po.order_id}</td>
                  <td className="px-3 py-2">{po.supplier}</td>
                  <td className={`px-3 py-2 text-right font-mono ${money.muted ? "text-muted-foreground/50" : ""}`}>{money.text}</td>
                  <td className="px-3 py-2 text-right">{po.asin_count}</td>
                  <td className="px-3 py-2 text-right">{fmtQty(po.units_ordered)}</td>
                  <td className="px-3 py-2">
                    {po.invoice_attached
                      ? <Paperclip className="h-3.5 w-3.5 text-muted-foreground" />
                      : <span className="text-muted-foreground/40">—</span>}
                  </td>
                  <td className="px-3 py-2">{po.has_notes && <StickyNote className="h-3.5 w-3.5 text-muted-foreground" />}</td>
                </tr>
                {open && (
                  <tr data-testid={`row-po-asins-${po.order_id}`}>
                    <td colSpan={11} className="p-0 pl-6 bg-muted/20">
                      {/* Nested rows: same column model as the detail ASINs tab (§3.2, §4);
                          po_asins default order; sorting/filtering stays at PO level. */}
                      <table className="w-full border-collapse text-sm table-fixed" style={{ minWidth: "140rem" }}>
                        <PoAsinColGroup />
                        {firstExpandedId === po.id && <thead><PoAsinHeaderRow sub /></thead>}
                        <tbody>
                          {po.asins.length === 0 && (
                            <tr><td colSpan={21} className="px-3 py-2 text-xs text-muted-foreground">No ASIN rows.</td></tr>
                          )}
                          {po.asins.map((a) => <PoAsinRow key={a.id} a={a} indent editable onChanged={load} />)}
                        </tbody>
                      </table>
                    </td>
                  </tr>
                )}
                </React.Fragment>
              );
              });
            })()}
            {data && data.pos.length === 0 && (
              <tr><td colSpan={11} className="px-3 py-8 text-center text-sm text-muted-foreground">No purchase orders match.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span data-testid="text-po-pagination">Showing {showFrom} to {showTo} of {data?.total ?? 0}</span>
        <div className="flex items-center gap-1">
          {pageNumbers.map((n, i) => (
            <span key={n} className="flex items-center gap-1">
              {i > 0 && pageNumbers[i - 1] !== n - 1 && <span className="px-1">…</span>}
              <Button variant={n === page ? "secondary" : "ghost"} size="sm" className="h-7 w-7 p-0 text-xs"
                onClick={() => setPage(n)} data-testid={`button-po-page-${n}`}>{n}</Button>
            </span>
          ))}
        </div>
      </div>

      <UploadToVelocityDialog open={velocityOpen} onOpenChange={setVelocityOpen} />
    </div>
  );
}

// ── Expanded PO view (frame step 4, read-only — no edit pencil) ──────────────

// The ASIN row and its component lines are the shared §4 column model
// (client/src/components/po-asin-rows.tsx) — one definition for the
// detail tab and the POs page's nested rows.
type PoAsinDetail = PoAsinRowData & { lines: PoAsinLine[] };
type PoLine = PoAsinLine;
interface PoDetail {
  po: Record<string, any> & { invoice_file_name: string };
  summary: { asin_count: number; units_ordered: number; units_received: number | null; order_total: string | null; cogs_total: string | null };
  asins: PoAsinDetail[];
}

// NULL → muted em-dash; $0.00 muted; all money neutral.
function Money({ v }: { v: string | null | undefined }) {
  if (v == null) return <span className="text-muted-foreground/50">—</span>;
  const m = fmtMoney(v);
  return <span className={`font-mono ${m.muted ? "text-muted-foreground/50" : ""}`}>{m.text}</span>;
}
function Dash({ v }: { v: number | string | null | undefined }) {
  return v == null ? <span className="text-muted-foreground/50">—</span> : <>{v}</>;
}

function DetailCard({ title, rows }: { title: string; rows: Array<[string, React.ReactNode]> }) {
  return (
    <div className="rounded-md p-3" style={{ border: "0.5px solid hsl(var(--border))" }}>
      <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">{title}</div>
      <dl className="space-y-1.5">
        {rows.map(([k, node]) => (
          <div key={k} className="flex items-baseline justify-between gap-4 text-sm">
            <dt className="text-muted-foreground whitespace-nowrap">{k}</dt>
            <dd className="text-right">{node}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function PurchaseOrderDetailPlaceholder() {
  const [location, navigate] = useLocation();
  const id = location.split("/").pop() ?? "";
  const [data, setData] = useState<PoDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"details" | "asins" | "products" | "tracking" | "history">("details");
  const [copied, setCopied] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [version, setVersion] = useState(0); // bumps on every reload so History refetches

  const reload = useCallback(() => {
    setVersion((v) => v + 1);
    fetch(`/api/pos/${id}`)
      .then(async (r) => { if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message || `HTTP ${r.status}`); return r.json(); })
      .then(setData)
      .catch((e) => setError(e.message));
  }, [id]);
  useEffect(() => { reload(); }, [reload]);

  if (error) return (
    <div className="px-6 py-8 space-y-3">
      <button className="text-sm text-primary hover:underline" onClick={() => navigate("/purchase-orders")}>← Back to POs</button>
      <p className="text-sm text-destructive">{error}</p>
    </div>
  );
  if (!data) return <div className="px-6 py-8 text-sm text-muted-foreground">Loading…</div>;

  const { po, summary, asins } = data;
  const actionItems: string[] = Array.isArray(po.action_items) ? po.action_items : [];
  const hairline = { borderBottom: "0.5px solid hsl(var(--border))" } as const;
  // Products tab (§4.3, editable since po-af-owned §3): PoProductsTable in components/po-edit.tsx.

  const copyInvoiceName = () => {
    navigator.clipboard.writeText(po.invoice_file_name).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };


  return (
    <div className="px-6 py-4 space-y-4">
      <button className="text-sm text-primary hover:underline" onClick={() => navigate("/purchase-orders")} data-testid="button-back-to-pos">
        ← Back to POs
      </button>

      {/* Header */}
      <div className="flex items-end justify-between flex-wrap gap-2">
        <div className="flex items-start gap-3">
          <div className="pt-1.5"><ClosedToggle po={{ id: po.id, order_id: po.order_id, closed_at: po.closed_at ?? null, closed_by: po.closed_by ?? null }} onToggled={reload} size="lg" /></div>
          <div>
            <h1 className="text-2xl font-semibold font-mono" data-testid="text-po-order-id">{po.order_id}</h1>
            <p className="text-sm text-muted-foreground">{po.supplier} · {fmtDate(String(po.order_date))} · {po.closed_at ? "Closed" : "Open"}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <ActionItemChips items={actionItems} reasons={po.review_velocity_reasons} testId="po-detail-action-items" />
          <Button variant="outline" size="sm" onClick={() => setEditOpen(true)} data-testid="button-edit-po"><Pencil className="h-3.5 w-3.5 mr-1" /> Edit PO</Button>
          <PoDangerActions poId={po.id} reloadKey={version} onCanceled={reload} onDeleted={() => navigate("/purchase-orders")} />
        </div>
      </div>
      <PoHeaderDrawer po={po} open={editOpen} onOpenChange={setEditOpen} onSaved={reload} />

      {/* Summary strip */}
      <div className="flex gap-6 rounded-md px-4 py-3 text-sm" style={{ border: "0.5px solid hsl(var(--border))" }} data-testid="po-summary-strip">
        {[
          ["ASINs", String(summary.asin_count)],
          ["Units Ordered", fmtQty(summary.units_ordered)],
        ].map(([k, v]) => (
          <div key={k}><span className="text-muted-foreground mr-1.5">{k}</span><span className="font-medium">{v}</span></div>
        ))}
        <div><span className="text-muted-foreground mr-1.5">Order Total</span><Money v={summary.order_total} /></div>
        <div><span className="text-muted-foreground mr-1.5">COGS Total</span><Money v={summary.cogs_total} /></div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1" style={{ borderBottom: "0.5px solid hsl(var(--border))" }}>
        {([["details", "PO Details"], ["asins", "ASINs"], ["products", "Products"], ["tracking", "Tracking"], ["history", "History"]] as const).map(([key, label]) => (
          <button key={key} onClick={() => setTab(key)} data-testid={`tab-${key}`}
            className={`px-3 py-1.5 text-sm -mb-px ${tab === key ? "border-b-2 border-primary font-medium" : "text-muted-foreground"}`}>
            {label}
          </button>
        ))}
      </div>

      {tab === "details" && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 max-w-5xl">
          <DetailCard title="Order" rows={[
            ["Order ID", <span className="font-mono text-xs">{po.order_id}</span>],
            ["Date", fmtDate(String(po.order_date))],
            ["Supplier", po.supplier],
            ["Ships to", po.ships_to === "home" ? "Home" : "Velocity"],
            ["Status", po.closed_at ? "Closed" : "Open"],
            ["Action Items", actionItems.join(", ") || "—"],
          ]} />
          <DetailCard title="Money" rows={[
            ["Subtotal", <Money v={po.subtotal} />],
            ["Tax", <Money v={po.tax} />],
            ["S&H + Donations", <Money v={po.sh_donations} />],
            ["Discount", <Money v={po.discount} />],
            ["Refund Amount", <Money v={po.refund_amount} />],
            ["Order Total", <Money v={po.order_total} />],
          ]} />
          <DetailCard title="Payment" rows={[
            ["Method", <Dash v={po.payment_method} />],
            ["Weighted GC %", po.weighted_gc_discount_pct == null ? <span className="text-muted-foreground/50">—</span> : `${parseFloat(po.weighted_gc_discount_pct)}%`],
            ["Cashback Site", <Dash v={po.cashback_site} />],
            ["Cashback %", po.cashback_pct == null ? <span className="text-muted-foreground/50">—</span> : `${parseFloat(po.cashback_pct)}%`],
            ["Promo", <Dash v={po.promo} />],
          ]} />
          <DetailCard title="Meta" rows={[
            ["Purchased by", <Dash v={po.purchased_by} />],
            ["Email used", <Dash v={po.email_used} />],
            ["Subscription", po.subscription ? "Yes" : "No"],
            ["Invoice attached", po.invoice_attached ? "Yes" : "No"],
            ["Invoice File Name", (
              <span className="inline-flex items-center gap-1">
                <span className="font-mono text-xs break-all" data-testid="text-invoice-file-name">{po.invoice_file_name}</span>
                <button onClick={copyInvoiceName} className="text-muted-foreground/60 hover:text-foreground" title="Copy file name" data-testid="button-copy-invoice-name">
                  {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                </button>
              </span>
            )],
          ]} />
          <DetailCard title="Notes" rows={[["", po.notes ? <span className="whitespace-pre-wrap text-left block">{po.notes}</span> : <span className="text-muted-foreground/50">—</span>]]} />
        </div>
      )}

      {tab === "asins" && <PoAsinTable asins={asins} editable onChanged={reload} />}

      {tab === "products" && <PoProductsTable poId={po.id} asins={asins} onChanged={reload} />}

      {tab === "tracking" && <PoTrackingTab poId={po.id} onChanged={reload} />}

      {tab === "history" && <PoHistory poId={po.id} reloadKey={version} />}
    </div>
  );
}
