/**
 * POs page — PO module v1 frame, list view (docs/po-module-v1-frame-plan.md §3).
 *
 * READ-ONLY frame over the migrated 2026 data: list + filters + pagination.
 * + New PO opens the New PO form page, /pos/new (po-af-owned §4, 2026-10-18; a page since 2026-11-01). The
 * Upload to Velocity toolbar ACTION (SPEC §11) stays exactly where it was.
 * Row click navigates to the expanded-view route (placeholder until step 4).
 *
 * §7 styling: zebra + 0.5px hairlines, dark header bar, no vertical dividers,
 * no row tints; ALL money renders neutral ($0.00 muted) — semantic color is
 * reserved for warnings.
 */
import React, { useState, useEffect, useCallback, useRef } from "react";
import { readPoListUrl, writePoListUrl, rememberPoList, poListHref } from "@/lib/po-list-url";
import { useListScroll, replaceQuery } from "@/lib/list-scroll";
import { useLocation, Link } from "wouter";
import { Upload, Plus, Search, Copy, Check, ChevronRight, ChevronDown, ChevronsDownUp, ChevronsUpDown, CheckCircle2, Circle, RefreshCw, AlertTriangle, ArrowUp, ArrowDown, ArrowUpDown } from "lucide-react";
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
import { PoAsinTable, PoAsinColGroup, PoAsinHeaderRow, PoAsinRow, PO_ASIN_TABLE_MIN_WIDTH, ActionItemChips, ActionItemsEditor, poActionTitles, type ActionItemLines, type OpenDefectBrief, type PoAsinRowData, type PoAsinLine } from "@/components/po-asin-rows";
import { loadPoExpanded, savePoExpanded, isPoExpanded, togglePoExpanded, toggleExpandAll, type PoExpandedState } from "@/lib/po-expanded";
import { fmtQty, PO_ASIN_DISPLAY_COLUMNS } from "@/lib/po-qty";
import { fetchLongSync } from "@/lib/long-sync";
import { useToast } from "@/hooks/use-toast";
import { PoProductsTable, PoHistory, PoDangerActions, poApi } from "@/components/po-edit";
import { DocumentsPaperclip, PoDocumentsTab, type PoDocumentLite, type PoDocument } from "@/components/po-documents";
import { InlineNoteCell, InlineNoteBox } from "@/components/inline-note";
import { PoTrackingTab, SyncTrackingButton, UnmatchedTrackingChip } from "@/components/po-tracking";
import { PoMoneyTab, type PoPayment, type PoPromo, type PoRefund } from "@/components/po-money";
import type { PoDefect } from "@/components/po-defects";
import { Pencil } from "lucide-react";
import { weightedPaymentPct, WEIGHTED_PAYMENT_LABEL } from "@shared/po-form";
import { useColumnWidths, ResizeHandle } from "@/hooks/use-column-widths";

interface PoRow {
  id: string;
  order_id: string;
  order_date: string;
  supplier: string;
  /** §6: multi-select Action Items (the old free-text status is no longer read). */
  action_items: string[];
  /** SPEC §26: the open "Review Velocity" reasons (the chip's hover). */
  review_velocity_reasons?: string[] | null;
  /** Hover text per derived item ("No invoice saved": the reason). */
  action_item_titles?: Record<string, string>;
  /** PO table v2 §4: per stored item, lines carrying it of the PO's lines, ASINs, auto reasons. */
  action_item_lines?: Record<string, ActionItemLines>;
  /** Open supplier defects (SPEC §22 "Supplier defects") — the chip's qty and $ owed. */
  defects_open?: OpenDefectBrief[];
  ships_to?: "velocity" | "home";
  order_total: string | null;
  invoice_attached: boolean;
  /** PO documents (SPEC §22), oldest first — the paperclip. */
  documents?: PoDocumentLite[];
  asin_count: number;
  units_ordered: number;
  units_received: number | null; // null = not tracked on any line → "—"
  has_notes: boolean;
  /** The PO's own note (p.* on the list) — the Notes cell edits it inline. */
  notes?: string | null;
  /** §5: NULL = Open. closed_by 'auto' | 'sheet' | 'import' (pre-2026 history, "Imported (history)") | a user id. */
  closed_at: string | null;
  closed_by: string | null;
  /** Expand by ASIN (§3): the PO's ASIN rows, same model as the detail tab. */
  asins: PoAsinRowData[];
  /** Σ refund rows still due (Dashboard patch §2.4); 0 when none. */
  refund_due?: number;
  subtotal?: string | null;
  discount?: string | null;
  tax?: string | null;
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
  refunds?: "any" | "due" | "none";
  /** Shipment reconciliation §5.3: open unmatched Velocity lines + ambiguous SC matches. */
  unmatchedCount?: number;
  /** Per dropdown option, the POs it would match under the OTHER active filters (server/po-list-filters.ts, 2026-11-06). */
  counts?: { closed: Record<ClosedFilter, number>; refunds: Record<RefundsFilter, number>; suppliers: Record<string, number>; actionItems: Record<string, number> };
}

/** A dropdown option's count: right-aligned, tabular; a 0 option stays listed, greyed. */
function OptionCount({ n }: { n: number | undefined }) {
  if (n == null) return null;
  return <span className="ml-auto pl-3 tabular-nums text-muted-foreground" data-count={n}>{n.toLocaleString()}</span>;
}
const zeroCls = (n: number | undefined) => (n === 0 ? "text-muted-foreground/50" : "");

type ClosedFilter = "open" | "closed" | "all";
/** Dashboard patch §2.4: Refunds filter — any / due (a refund row still due) / none (no refund row at all); `?refunds=due` deep-links from the Dashboard's Refunds due cell. */
type RefundsFilter = "any" | "due" | "none";
/** The POs page's deep-link params (asin, refunds, closed, from, to), read once on mount. Exported for tests. */
export function readPoPageParams(search: string): { asin: string; refunds: RefundsFilter; closed: ClosedFilter | null; from: string; to: string } {
  const p = new URLSearchParams(search);
  const refundsRaw = p.get("refunds"), closedRaw = p.get("closed");
  const ymd = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : "");
  return {
    asin: p.get("asin")?.trim().toUpperCase() ?? "",
    refunds: refundsRaw === "due" || refundsRaw === "none" ? refundsRaw : "any",
    closed: closedRaw === "open" || closedRaw === "closed" || closedRaw === "all" ? closedRaw : null,
    from: ymd(p.get("from")), to: ymd(p.get("to")),
  };
}

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
        <AlertDialogContent dialogId="po-close-confirm" onClick={(e) => e.stopPropagation()}>
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
function FacetMultiSelect({ label, options, counts, selected, onChange, testId }: {
  label: string;
  options: string[];
  /** Each option's count under the other filters; absent → none shown. An option missing from a present map is 0. */
  counts?: Record<string, number>;
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
      <PopoverContent className="w-72 p-2 space-y-2" align="start">
        <Input placeholder="Search..." value={q} onChange={(e) => setQ(e.target.value)} className="h-7 text-xs" autoFocus />
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
          <button className="hover:text-foreground" onClick={() => onChange(new Set(options))}>Select all</button>
          <span>·</span>
          <button className="hover:text-foreground" onClick={() => onChange(new Set())}>Clear all</button>
          <span className="ml-auto">{selected.size} selected</span>
        </div>
        <div className="max-h-48 overflow-y-auto -mx-1 space-y-0.5">
          {filtered.map((opt) => (
            <label key={opt} className={`flex items-center gap-2 px-2 py-1 rounded hover:bg-muted cursor-pointer text-xs ${zeroCls(counts ? counts[opt] ?? 0 : undefined)}`} data-testid={`${testId}-option`}>
              <input type="checkbox" checked={selected.has(opt)} onChange={() => {
                const next = new Set(selected);
                if (next.has(opt)) next.delete(opt); else next.add(opt);
                onChange(next);
              }} className="h-3 w-3 accent-blue-500" />
              <span className="truncate">{opt}</span>
              <OptionCount n={counts ? counts[opt] ?? 0 : undefined} />
            </label>
          ))}
          {filtered.length === 0 && <div className="px-2 py-1 text-xs text-muted-foreground">No matches</div>}
        </div>
      </PopoverContent>
    </Popover>
  );
}

const ALL = "__all__";
const CLOSED_LABEL: Record<ClosedFilter, string> = { open: "Open", closed: "Closed", all: "All" };
const REFUNDS_LABEL: Record<RefundsFilter, string> = { any: "Refunds: any", due: "Refunds: due", none: "Refunds: none" };

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
/** A Velocity order that has not shipped and that no rule placed (2026-11-07, velocity_orders_unplaced). */
export interface UnplacedOrder { velocity_order_id: string; reason: "no_order" | "po_not_found"; candidates: UnmatchedCandidate[] | null; nearest_miss: string | null; dismissed_at: string | null; dismiss_note?: string | null;
  velocity_number: string | null; order_number: string | null; retailer: string | null; asin: string | null; item_name: string | null; status: string | null; date: string | null; quantity: string | null; quantity_received: string | null }
/** A stored link Velocity order → PO ASIN row (velocity_order_links). */
export interface VelocityOrderLink { velocity_order_id: string; velocity_number: string | null; order_number: string | null; retailer: string | null; asin: string | null; quantity: string | null; source: string; note: string | null; linked_at: string; linked_by: string | null; po_id: string; po_order_id: string; supplier: string }
interface UnmatchedResponse { lines: UnmatchedLine[]; dismissed: UnmatchedLine[]; ambiguous: Array<{ id: string; shipped_at: string | null; rows: number }>; orders?: UnplacedOrder[]; ordersDismissed?: UnplacedOrder[]; links?: VelocityOrderLink[]; count: number }
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
function LinkPicker({ id, seed, onPick }: { id: string; seed: string; onPick: (r: PickerRow) => Promise<void> }) {
  const [q, setQ] = useState(seed);
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
        <Button variant="outline" size="sm" className="h-7 text-xs" data-testid={`button-link-unmatched-${id}`}>Link to PO ASIN</Button>
      </PopoverTrigger>
      <PopoverContent className="w-[28rem] p-2 text-xs space-y-1" align="end">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Order #, ASIN or supplier" className="h-7 text-xs" data-testid={`input-link-search-${id}`} />
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
  if (!data || (data.count === 0 && (data.dismissed ?? []).length === 0 && (data.ordersDismissed ?? []).length === 0 && (data.links ?? []).length === 0)) return null;
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
          {data.count > 0 && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800" data-testid="text-po-unmatched-count">{data.count}</span>}
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
          <VelocityOrdersSection orders={data.orders ?? []} dismissed={data.ordersDismissed ?? []} links={data.links ?? []} busy={busy} act={act} />
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

/** "Velocity orders" text for one order: #8785 · no_poid_at_checkout. */
export function velocityOrderText(o: { velocity_number: string | null; order_number: string | null }): string {
  return `${o.velocity_number ? `#${o.velocity_number}` : "Velocity order"} · ${o.order_number || "(no Order #)"}`;
}

async function postJson(url: string, body: unknown, method = "POST"): Promise<any> {
  const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body == null ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
  return data;
}

/**
 * "Velocity orders with no PO" (2026-11-07): orders still at Velocity that no
 * rule placed — one click when a single PO fits, else the picker; dismiss
 * hides one while it stays listed. Under it, the linked orders with Unlink.
 */
function VelocityOrdersSection({ orders, dismissed, links, busy, act }: {
  orders: UnplacedOrder[]; dismissed: UnplacedOrder[]; links: VelocityOrderLink[]; busy: boolean; act: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [showDismissed, setShowDismissed] = useState(false);
  const [showLinks, setShowLinks] = useState(false);
  if (orders.length === 0 && dismissed.length === 0 && links.length === 0) return null;
  const link = (o: UnplacedOrder, poAsinId: string) => act(() => postJson(`/api/velocity-orders/${encodeURIComponent(o.velocity_order_id)}/link`, { po_asin_id: poAsinId }));
  return (
    <div className="space-y-1" data-testid="section-velocity-orders">
      {orders.length > 0 && (
        <>
          <div className="text-muted-foreground">Velocity orders with no PO — still at Velocity, not shipped; link one so Received by Velocity and At Prep count it:</div>
          <div className="overflow-x-auto">
            <table className="w-full table-fixed">
              <colgroup><col style={{ width: 150 }} /><col style={{ width: 90 }} /><col style={{ width: 110 }} /><col style={{ width: 110 }} /><col style={{ width: 160 }} /><col style={{ width: 70 }} /><col style={{ width: 170 }} /><col style={{ width: 300 }} /><col /></colgroup>
              <thead><tr className="text-muted-foreground text-left">
                <th className="py-1 pr-2">Velocity order</th><th className="py-1 pr-2">Date</th><th className="py-1 pr-2">Retailer</th><th className="py-1 pr-2">ASIN</th><th className="py-1 pr-2">Item</th><th className="py-1 pr-2 text-right" title="Ordered at Velocity · checked in">Qty · in</th><th className="py-1 pr-2">Why</th><th className="py-1">Link</th><th />
              </tr></thead>
              <tbody>
                {orders.map((o) => {
                  const cands = o.candidates ?? [];
                  return (
                    <tr key={o.velocity_order_id} className="align-top" style={{ borderTop: "0.5px solid hsl(var(--border))" }} data-testid={`row-velocity-order-${o.velocity_order_id}`}>
                      <td className="py-1 pr-2 font-mono" title={`Velocity ${o.status ?? ""}`}>
                        <div>{o.velocity_number ? `#${o.velocity_number}` : "—"}</div>
                        <div className="break-all text-muted-foreground">{o.order_number || "(no Order #)"}</div>
                      </td>
                      <td className="py-1 pr-2">{o.date ?? "—"}</td>
                      <td className="py-1 pr-2 truncate" title={o.retailer ?? ""}>{o.retailer || "—"}</td>
                      <td className="py-1 pr-2 font-mono">{o.asin}</td>
                      <td className="py-1 pr-2 truncate" title={o.item_name ?? ""}>{o.item_name}</td>
                      <td className="py-1 pr-2 text-right">{fmtQty(Number(o.quantity ?? 0))} · {fmtQty(Number(o.quantity_received ?? 0))}</td>
                      <td className="py-1 pr-2 text-muted-foreground" data-testid={`text-velocity-order-why-${o.velocity_order_id}`}>{o.nearest_miss ?? (cands.length > 1 ? `${cands.length} POs fit — pick one` : cands.length === 1 ? "one PO fits" : o.reason === "no_order" ? "no Order # at Velocity" : "Order # not in AF")}</td>
                      <td className="py-1">
                        <div className="flex flex-wrap items-center gap-1">
                          {cands.map((c) => (
                            <Button key={c.po_asin_id} size="sm" variant="secondary" className="h-6 text-xs font-mono" disabled={busy} title={`${c.supplier} ${c.asin}${c.order_date ? ` · PO ${c.order_date}` : ""}`}
                              onClick={() => void link(o, c.po_asin_id)} data-testid={`button-link-velocity-order-${o.velocity_order_id}-${c.po_asin_id}`}>
                              Link to {candidateLabel(c)}
                            </Button>
                          ))}
                          <LinkPicker id={o.velocity_order_id} seed={o.order_number || o.asin || ""} onPick={(r) => link(o, r.id)} />
                          <Button size="sm" variant="ghost" className="h-6 text-xs" disabled={busy} onClick={() => void act(() => postJson("/api/velocity-orders/dismiss", { ids: [o.velocity_order_id] }))} data-testid={`button-dismiss-velocity-order-${o.velocity_order_id}`}>Dismiss</Button>
                        </div>
                      </td>
                      <td />
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
      {dismissed.length > 0 && (
        <div>
          <button className="inline-flex items-center gap-1 text-muted-foreground" onClick={() => setShowDismissed((v) => !v)} data-testid="button-velocity-orders-dismissed-toggle">
            {showDismissed ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />} Dismissed Velocity orders ({dismissed.length})
          </button>
          {showDismissed && (
            <div className="mt-1 space-y-0.5 text-muted-foreground">
              {dismissed.map((o) => <div key={o.velocity_order_id} className="font-mono">{velocityOrderText(o)} · {o.retailer || "—"} · {o.asin} · {fmtQty(Number(o.quantity ?? 0))}u · dismissed {String(o.dismissed_at).slice(0, 10)}{o.dismiss_note ? ` — ${o.dismiss_note}` : ""}</div>)}
            </div>
          )}
        </div>
      )}
      {links.length > 0 && (
        <div>
          <button className="inline-flex items-center gap-1 text-muted-foreground" onClick={() => setShowLinks((v) => !v)} data-testid="button-velocity-links-toggle">
            {showLinks ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />} Linked Velocity orders ({links.length})
          </button>
          {showLinks && (
            <div className="mt-1 space-y-0.5" data-testid="list-velocity-links">
              {links.map((l) => (
                <div key={l.velocity_order_id} className="flex flex-wrap items-center gap-2" data-testid={`row-velocity-link-${l.velocity_order_id}`}>
                  <span className="font-mono">{velocityOrderText(l)} · {l.retailer || "—"} · {l.asin} · {l.quantity != null ? `${fmtQty(Number(l.quantity))}u` : "—"}</span>
                  <span className="text-muted-foreground">→ {l.supplier} {l.po_order_id} · {String(l.linked_at).slice(0, 10)}{l.linked_by ? ` by ${l.linked_by}` : ""} ({l.source})</span>
                  <Button size="sm" variant="ghost" className="h-6 text-xs" disabled={busy}
                    onClick={() => void act(() => postJson(`/api/velocity-order-links/${encodeURIComponent(l.velocity_order_id)}`, null, "DELETE"))} data-testid={`button-unlink-velocity-order-${l.velocity_order_id}`}>Unlink</Button>
                </div>
              ))}
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
          <LinkPicker id={l.id} seed={l.order_number || l.asin || ""} onPick={(r) => tryLink(r.id, r.order_id)} />
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

/** Product lines on a PO (they ride the list payload under each ASIN row). */
export const poLineCount = (po: { asins?: ReadonlyArray<{ lines?: readonly unknown[] }> }): number =>
  (po.asins ?? []).reduce((t, a) => t + (a.lines?.length ?? 0), 0);

/**
 * The POs list columns (PO table v2 §4): sort key (the server whitelist,
 * PO_SORT_KEYS in server/po-queries.ts) where the column sorts.
 */
export const PO_LIST_COLUMNS: ReadonlyArray<{ id: string; label: string; sortKey?: string; align?: "right" }> = [
  { id: "action_items", label: "Action Items", sortKey: "action_items" },
  { id: "order_date", label: "PO Date", sortKey: "order_date" },
  { id: "order_id", label: "Order ID", sortKey: "order_id" },
  { id: "supplier", label: "Supplier", sortKey: "supplier" },
  { id: "order_total", label: "Order Total", sortKey: "order_total", align: "right" },
  { id: "asins", label: "ASINs", sortKey: "asins", align: "right" },
  { id: "units_ordered", label: "Units Ordered", sortKey: "units_ordered", align: "right" },
  { id: "invoice", label: "Invoice" },
  { id: "notes", label: "Notes" },
];
/** Column widths: the ASINs table's shared mechanism under the POs table's own key (§4). */
export const PO_COL_WIDTHS_KEY = "af-po-col-widths";
/**
 * Default widths, px (Maria 2026-11-04; docs/UI_RULES.md): every column has one and the table is
 * table-layout fixed — auto layout gave Order ID and Supplier a third of the page each and pushed
 * Units Ordered / Invoice / Notes off-screen at 1440. Σ + the expand column = 1,142 px, inside 1280.
 */
export const PO_DEFAULT_COL_WIDTHS: Readonly<Record<string, number>> = {
  status: 60, action_items: 170, order_date: 100, order_id: 170, supplier: 200, order_total: 110, asins: 60, units_ordered: 110, invoice: 70, notes: 60,
};
/** The chevron ("Expand by ASIN") column — not resizable. */
export const PO_EXPAND_COL_WIDTH = 32;
export const PO_COL_IDS = ["status", ...PO_LIST_COLUMNS.map((c) => c.id)] as const;
export const poColWidth = (widths: Record<string, number>, id: string): number => widths[id] ?? PO_DEFAULT_COL_WIDTHS[id];
/** The table's width: the columns' sum (saved widths over defaults), never auto. */
export const poTableWidth = (widths: Record<string, number>): number => PO_COL_IDS.reduce((t, id) => t + poColWidth(widths, id), PO_EXPAND_COL_WIDTH);
export function poColStyle(widths: Record<string, number>, id: string): React.CSSProperties | undefined {
  const w = poColWidth(widths, id);
  return w != null ? { width: w, minWidth: w, maxWidth: w, overflow: "hidden" } : undefined;
}

export type PoSort = { key: string; dir: "asc" | "desc" } | null;
/** One key at a time; a click cycles asc → desc → off (off = the default order, newest PO first). */
export function nextPoSort(cur: PoSort, key: string): PoSort {
  if (!cur || cur.key !== key) return { key, dir: "asc" };
  return cur.dir === "asc" ? { key, dir: "desc" } : null;
}

function SortHeader({ label, sortKey, sort, onSort, className, style, children }: { label: string; sortKey: string; sort: PoSort; onSort: (k: string) => void; className?: string; style?: React.CSSProperties; children?: React.ReactNode }) {
  const active = sort?.key === sortKey;
  return (
    <th className={className} style={style} aria-sort={active ? (sort!.dir === "asc" ? "ascending" : "descending") : "none"}>
      <button type="button" onClick={() => onSort(sortKey)} className="inline-flex items-center gap-1 hover:text-foreground" data-testid={`sort-po-${sortKey}`}>
        {label}
        {active ? (sort!.dir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />) : <ArrowUpDown className="h-3 w-3 opacity-30" />}
      </button>
      {children}
    </th>
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
  // Deep link from the ASINs page's On Order cell (patch asins-on-order §3.2):
  // /purchase-orders?asin=B0… opens the list searched on that ASIN, Open POs
  // only — the ones On Order counts (2026-11-02); the Closed filter is a click away.
  // The Dashboard's Refunds due cell links /purchase-orders?refunds=due&closed=all&from=…&to=… (SPEC §28).
  // Every filter, the sort and the page live in the URL (2026-11-06, lib/po-list-url.ts): Back to the list restores it exactly.
  const [linked] = useState(() => readPoListUrl(window.location.search));
  const [search, setSearch] = useState(linked.search);
  const [debouncedSearch, setDebouncedSearch] = useState(linked.search);
  const [actionSel, setActionSel] = useState<Set<string>>(() => new Set(linked.action));
  const [closedFilter, setClosedFilter] = useState<ClosedFilter>(linked.closed); // D3: default Open only — the ASINs-page On Order link too (open POs are what it counts)
  const [refundsFilter, setRefundsFilter] = useState<RefundsFilter>(linked.refunds);
  const [supplierSel, setSupplierSel] = useState<Set<string>>(() => new Set(linked.supplier));
  const [from, setFrom] = useState(linked.from);
  const [to, setTo] = useState(linked.to);
  const [page, setPage] = useState(linked.page);
  const [sort, setSort] = useState<PoSort>(linked.sort);
  const { colWidths, handleResizeStart, resetWidths } = useColumnWidths(PO_COL_WIDTHS_KEY);
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
  const sortKey = sort ? `${sort.key}:${sort.dir}` : "";
  // A filter or sort change goes back to page 1 — not the first render, whose page came from the URL.
  const filterKey = [debouncedSearch, actionKey, supplierKey, from, to, closedFilter, refundsFilter, sortKey].join("|");
  const lastFilterKey = useRef(filterKey);
  useEffect(() => { if (lastFilterKey.current !== filterKey) { lastFilterKey.current = filterKey; setPage(1); } }, [filterKey]);

  // The URL follows the list (replaceState: a filter change is not a history step); remembered for "← Back to POs".
  const listQuery = writePoListUrl({ search: debouncedSearch, action: Array.from(actionSel), supplier: Array.from(supplierSel), closed: closedFilter, refunds: refundsFilter, from, to, sort, page });
  useEffect(() => { replaceQuery("/purchase-orders", listQuery); rememberPoList(listQuery); }, [listQuery]);

  const load = useCallback(async () => {
    setError(null);
    const params = new URLSearchParams();
    if (debouncedSearch) params.set("search", debouncedSearch);
    if (actionKey) params.set("action", actionKey);
    params.set("closed", closedFilter);
    if (refundsFilter !== "any") params.set("refunds", refundsFilter);
    if (supplierKey) params.set("supplier", supplierKey);
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    if (sort) { params.set("sort", sort.key); params.set("dir", sort.dir); }
    params.set("page", String(page));
    try {
      const res = await fetch(`/api/pos?${params.toString()}`);
      if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.message || `HTTP ${res.status}`); }
      setData(await res.json());
    } catch (e: any) {
      setError(e.message);
    }
  }, [debouncedSearch, actionKey, supplierKey, from, to, page, closedFilter, refundsFilter, sort]);

  useEffect(() => { load(); }, [load]);
  useListScroll("pos", data != null); // restored once the first list renders (lib/list-scroll.ts)

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
          {/* New PO form (po-af-owned §4) — a full page since 2026-11-01. */}
          <Button variant="default" size="sm" onClick={() => navigate("/pos/new")} data-testid="button-new-po">
            <Plus className="h-4 w-4 mr-1" /> New PO
          </Button>
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
            placeholder="Search order #, ASIN, product, notes"
            className="h-8 w-[280px] pl-8 text-sm" data-testid="input-po-search" />
        </div>
        {/* Each option shows its count under the other filters (2026-11-06); the trigger keeps the plain label. */}
        <Select value={closedFilter} onValueChange={(v) => setClosedFilter(v as ClosedFilter)}>
          <SelectTrigger className="h-8 w-[120px] text-xs" data-testid="select-po-closed"><SelectValue>{CLOSED_LABEL[closedFilter]}</SelectValue></SelectTrigger>
          <SelectContent className="min-w-[10rem]">
            {(["open", "closed", "all"] as const).map((k) => (
              <SelectItem key={k} value={k} className={zeroCls(data?.counts?.closed[k])} data-testid={`option-po-closed-${k}`}>
                <span className="flex min-w-[6.5rem] items-center">{CLOSED_LABEL[k]}<OptionCount n={data?.counts?.closed[k]} /></span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={refundsFilter} onValueChange={(v) => setRefundsFilter(v as RefundsFilter)}>
          <SelectTrigger className="h-8 w-[140px] text-xs" data-testid="select-po-refunds"><SelectValue>{REFUNDS_LABEL[refundsFilter]}</SelectValue></SelectTrigger>
          <SelectContent className="min-w-[11rem]">
            {(["any", "due", "none"] as const).map((k) => (
              <SelectItem key={k} value={k} className={zeroCls(data?.counts?.refunds[k])} data-testid={`option-po-refunds-${k}`}>
                <span className="flex min-w-[8.5rem] items-center">{REFUNDS_LABEL[k]}<OptionCount n={data?.counts?.refunds[k]} /></span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FacetMultiSelect label="Action Items" options={data?.actionItems ?? []} counts={data?.counts?.actionItems} selected={actionSel} onChange={setActionSel} testId="select-po-action-items" />
        <FacetMultiSelect label="Supplier" options={data?.suppliers ?? []} counts={data?.counts?.suppliers} selected={supplierSel} onChange={setSupplierSel} testId="select-po-supplier" />
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
          className="h-8 rounded-md border border-input bg-background px-2 text-sm" data-testid="input-po-from" />
        <span className="text-xs text-muted-foreground">to</span>
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
          className="h-8 rounded-md border border-input bg-background px-2 text-sm" data-testid="input-po-to" />
        {Object.keys(colWidths).length > 0 && (
          <Button variant="ghost" size="sm" className="h-8 text-xs text-muted-foreground" onClick={resetWidths} data-testid="button-po-reset-widths">Reset widths</Button>
        )}
      </div>

      {error && <div className="text-sm text-destructive" data-testid="text-po-error">{error}</div>}

      <div className="w-full overflow-auto rounded-md" style={{ border: "0.5px solid hsl(var(--border))" }}>
        <table className="border-collapse text-sm table-fixed" style={{ width: poTableWidth(colWidths), minWidth: "100%" }} data-testid="po-table">
          <colgroup>
            <col style={{ width: poColWidth(colWidths, "status") }} />
            <col style={{ width: PO_EXPAND_COL_WIDTH }} />
            {PO_LIST_COLUMNS.map((c) => <col key={c.id} style={{ width: poColWidth(colWidths, c.id) }} />)}
            {/* Filler: takes the page's spare width so every column keeps its own (fixed layout would spread it). */}
            <col />
          </colgroup>
          <thead>
            <tr className="table-header-stone">
              <SortHeader label="Status" sortKey="status" sort={sort} onSort={(k) => setSort((s) => nextPoSort(s, k))} className="relative px-2 py-2 text-xs font-medium whitespace-nowrap overflow-hidden text-left" style={poColStyle(colWidths, "status")}>
                <ResizeHandle onMouseDown={(e) => handleResizeStart(e, "status")} />
              </SortHeader>
              <th className="px-2 py-2" style={{ width: PO_EXPAND_COL_WIDTH }} aria-label="Expand by ASIN" />
              {PO_LIST_COLUMNS.map((c) => {
                const cls = `relative px-3 py-2 text-xs font-medium whitespace-nowrap overflow-hidden ${c.align === "right" ? "text-right" : "text-left"}`;
                const style = poColStyle(colWidths, c.id);
                const handle = <ResizeHandle onMouseDown={(e) => handleResizeStart(e, c.id)} />;
                return c.sortKey
                  ? <SortHeader key={c.id} label={c.label} sortKey={c.sortKey} sort={sort} onSort={(k) => setSort((s) => nextPoSort(s, k))} className={cls} style={style}>{handle}</SortHeader>
                  : <th key={c.id} className={cls} style={style} data-testid={`th-po-${c.id}`}>{c.label}{handle}</th>;
              })}
              <th aria-hidden />
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
                  <td style={poColStyle(colWidths, "status")} className="px-2 py-2" onClick={(e) => e.stopPropagation()}>
                    <ClosedToggle po={po} onToggled={load} />
                  </td>
                  {/* §3.1: the chevron is the ONLY expand target; the rest of the row still opens the PO. */}
                  <td className="px-2 py-2" onClick={(e) => e.stopPropagation()}>
                    <button type="button" className="text-muted-foreground hover:text-foreground"
                      onClick={() => applyExpanded(togglePoExpanded(expandedState, po.id, visibleIds))}
                      aria-expanded={open} data-testid={`button-po-expand-${po.order_id}`}>
                      {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                    </button>
                  </td>
                  <td style={poColStyle(colWidths, "action_items")} className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                    {/* PO table v2: set on the PO row = set on every product line (confirm when > 1). */}
                    <ActionItemsEditor items={po.action_items} reasons={po.review_velocity_reasons} titles={poActionTitles(po.action_item_titles, po.asins)} lines={po.action_item_lines} defects={po.defects_open}
                      url={`/api/pos/${po.id}/action-items`} onSaved={() => void load()} lineCount={poLineCount(po)} testId={`po-action-items-${po.order_id}`} />
                  </td>
                  <td style={poColStyle(colWidths, "order_date")} className="px-3 py-2 whitespace-nowrap">{fmtDate(po.order_date)}</td>
                  <td style={poColStyle(colWidths, "order_id")} className="px-3 py-2 font-mono text-xs truncate" title={po.order_id} data-testid={`po-order-id-${po.order_id}`}>{po.order_id}</td>
                  <td style={poColStyle(colWidths, "supplier")} className="px-3 py-2 truncate" title={po.supplier}>{po.supplier}</td>
                  <td style={poColStyle(colWidths, "order_total")} className={`px-3 py-2 text-right font-mono ${money.muted ? "text-muted-foreground/50" : ""}`}>
                    {money.text}
                    {/* §2.4: a quiet "refund due" line under the total when the PO has due rows — text, no chip. */}
                    {Number(po.refund_due) > 0 && <div className="text-[10px] font-sans text-muted-foreground whitespace-nowrap" data-testid={`po-refund-due-${po.order_id}`}>refund due {fmtMoney(String(po.refund_due)).text}</div>}
                  </td>
                  <td style={poColStyle(colWidths, "asins")} className="px-3 py-2 text-right">{po.asin_count}</td>
                  <td style={poColStyle(colWidths, "units_ordered")} className="px-3 py-2 text-right">{fmtQty(po.units_ordered)}</td>
                  {/* PO documents (SPEC §22): download one, a menu for several, none → the Documents tab. */}
                  <td style={poColStyle(colWidths, "invoice")} className="px-2 py-1.5" onClick={(e) => e.stopPropagation()}>
                    <DocumentsPaperclip docs={po.documents ?? []} orderId={po.order_id} poId={po.id} onOpenTab={() => navigate(`/purchase-orders/${po.id}?tab=documents`)} />
                  </td>
                  {/* Inline note (2026-11-04): the PO's own note; ASIN-row / line notes are edited on the expanded rows. */}
                  <td style={poColStyle(colWidths, "notes")} className="p-0" onClick={(e) => e.stopPropagation()}>
                    <InlineNoteCell value={po.notes} label="PO note" className="px-3 py-2" testId={`po-${po.order_id}`}
                      onSave={async (v) => { await poApi(`/api/pos/${po.id}`, "PATCH", { notes: v }); void load(); }} />
                  </td>
                  <td aria-hidden />
                </tr>
                {open && (
                  <tr data-testid={`row-po-asins-${po.order_id}`}>
                    <td colSpan={12} className="p-0 pl-6 bg-muted/20">
                      {/* Nested rows: same column model as the detail ASINs tab (§3.2, §4);
                          po_asins default order; sorting/filtering stays at PO level. */}
                      {/* The nested table fits the POs table from 1024 (2026-11-05); below its minimum it scrolls in its own box — never the page (docs/UI_RULES.md). */}
                      <div className="overflow-x-auto">
                      <table className="w-full border-collapse text-sm table-fixed" style={{ minWidth: PO_ASIN_TABLE_MIN_WIDTH }}>
                        <PoAsinColGroup />
                        {firstExpandedId === po.id && <thead><PoAsinHeaderRow sub /></thead>}
                        <tbody>
                          {po.asins.length === 0 && (
                            <tr><td colSpan={PO_ASIN_DISPLAY_COLUMNS.length + 2} className="px-3 py-2 text-xs text-muted-foreground">No ASIN rows.</td></tr>
                          )}
                          {po.asins.map((a) => <PoAsinRow key={a.id} a={a} indent editable onChanged={load} po={{ id: po.id, subtotal: po.subtotal, discount: po.discount, tax: po.tax }} />)}
                        </tbody>
                      </table>
                      </div>
                    </td>
                  </tr>
                )}
                </React.Fragment>
              );
              });
            })()}
            {data && data.pos.length === 0 && (
              <tr><td colSpan={12} className="px-3 py-8 text-center text-sm text-muted-foreground">No purchase orders match.</td></tr>
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
  /** Capture PO patch §8: the Payments tab. */
  payments?: PoPayment[];
  promos?: PoPromo[];
  refunds?: PoRefund[];
  defects?: PoDefect[];
  /** PO documents (SPEC §22): the Documents tab. */
  documents?: PoDocument[];
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

/**
 * PO Details → Payment card (round 2, Maria 2026-11-01): the po_payments rows (method · nickname · last 4, the amount) and the
 * po_promos rows (type · description, the amount / %) — no longer the legacy payment_method / promo text — with the weighted GC %
 * computed from the gift-card payments (Σ amount × GC % ÷ order total), the stored value when no payment carries one. Pure.
 */
export function paymentCardRows(po: Record<string, any>, payments: PoPayment[], promos: PoPromo[]): Array<[string, React.ReactNode]> {
  const method = (m: string) => m.replace("_", " ");
  const rows: Array<[string, React.ReactNode]> = [];
  if (payments.length === 0) rows.push(["Payment", <span className="text-muted-foreground/50">—</span>]);
  payments.forEach((p, i) => rows.push([`Payment${payments.length > 1 ? ` ${i + 1}` : ""}`, <span data-testid={`po-payment-card-${p.id}`}>{[method(p.method), p.nickname, p.last4 ? `•••• ${p.last4}` : null].filter(Boolean).join(" · ")}{p.amount != null ? <> · <Money v={p.amount} /></> : null}{p.method === "gift_card" && p.gift_card_discount_pct != null ? ` · GC ${Number(p.gift_card_discount_pct)}%` : ""}</span>]));
  const total = Number(po.order_total);
  // Gift-card GC % and card reward % (2026-11-04), weighted by amount.
  const weighted = weightedPaymentPct(payments, total > 0 ? total : 0);
  const stored = po.weighted_gc_discount_pct == null ? null : parseFloat(po.weighted_gc_discount_pct);
  rows.push([WEIGHTED_PAYMENT_LABEL, weighted != null ? `${weighted}%` : stored != null ? `${stored}%` : <span className="text-muted-foreground/50">—</span>]);
  rows.push(["Cashback Site", <Dash v={po.cashback_site} />]);
  rows.push(["Cashback %", po.cashback_pct == null ? <span className="text-muted-foreground/50">—</span> : `${parseFloat(po.cashback_pct)}%`]);
  if (promos.length === 0) rows.push(["Promo", <span className="text-muted-foreground/50">—</span>]);
  promos.forEach((p, i) => rows.push([`Promo${promos.length > 1 ? ` ${i + 1}` : ""}`, <span data-testid={`po-promo-card-${p.id}`}>{[p.type ?? "choose", p.description].filter(Boolean).join(" · ")}{p.amount != null ? <> · <Money v={p.amount} /></> : p.percent != null ? ` · ${Number(p.percent)}%` : ""}{p.counts_toward_cogs ? "" : " · not in COGS"}</span>]));
  return rows;
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
  // ?tab=documents: the paperclip of a PO with no documents opens straight onto its Documents tab.
  const [tab, setTab] = useState<"details" | "asins" | "products" | "payments" | "documents" | "tracking" | "history">(() =>
    new URLSearchParams(window.location.search).get("tab") === "documents" ? "documents" : "details");
  const [copied, setCopied] = useState(false);
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
      <button className="text-sm text-primary hover:underline" onClick={() => navigate(poListHref())}>← Back to POs</button>
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
      <button className="text-sm text-primary hover:underline" onClick={() => navigate(poListHref())} data-testid="button-back-to-pos">
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
          <ActionItemChips items={actionItems} reasons={po.review_velocity_reasons} titles={poActionTitles(po.action_item_titles, po.asins)} testId="po-detail-action-items" defects={po.defects_open} />
          <Button variant="outline" size="sm" onClick={() => navigate(`/pos/${po.id}/edit`, { state: { fromPoDetail: true } })} data-testid="button-edit-po"><Pencil className="h-3.5 w-3.5 mr-1" /> Edit PO</Button>
          <PoDangerActions poId={po.id} reloadKey={version} onCanceled={reload} onDeleted={() => navigate("/purchase-orders")} />
        </div>
      </div>

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
        {([["details", "PO Details"], ["asins", "ASINs"], ["products", "Products"], ["payments", "Payments"], ["documents", "Documents"], ["tracking", "Tracking"], ["history", "History"]] as const).map(([key, label]) => (
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
          <DetailCard title="Payment" rows={paymentCardRows(po, data.payments ?? [], data.promos ?? [])} />
          <DetailCard title="Meta" rows={[
            ["Purchased by", <Dash v={po.purchased_by} />],
            ["Email used", <Dash v={po.email_used} />],
            ...(po.alt_order_ids ? [["Alternate order #s", <span className="font-mono text-xs">{po.alt_order_ids}</span>] as [string, JSX.Element]] : []),
            ["Source", <Dash v={po.source === "sheet_import" ? "Orders sheet" : po.source === "extension" ? "Capture PO" : po.source === "email_renewal" ? "Subscription renewal (email)" : po.source === "manual" ? "New PO form" : po.source} />],
            ["Subscription", po.subscription ? "Yes" : "No"],
            // Derived (SPEC §22 "PO documents"): Yes when the PO has a document; the sheet's old Rcpt flag is not read.
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
          {/* Click-to-edit in place (2026-11-04) — no Edit PO round trip. */}
          <div className="rounded-md p-3" style={{ border: "0.5px solid hsl(var(--border))" }} data-testid="po-detail-notes">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">Notes</div>
            <InlineNoteBox value={po.notes} label="PO note" testId="po-detail" onSave={async (v) => { await poApi(`/api/pos/${po.id}`, "PATCH", { notes: v }); reload(); }} />
          </div>
        </div>
      )}

      {tab === "asins" && <PoAsinTable asins={asins} editable onChanged={reload} po={{ id: po.id, subtotal: po.subtotal, discount: po.discount, tax: po.tax }} />}

      {tab === "products" && <PoProductsTable poId={po.id} asins={asins} onChanged={reload} po={{ id: po.id, subtotal: po.subtotal, discount: po.discount, tax: po.tax }} shipsTo={po.ships_to} />}

      {tab === "documents" && <PoDocumentsTab poId={po.id} documents={data.documents ?? []} onChanged={reload} />}

      {tab === "payments" && <PoMoneyTab po={po} asins={asins} payments={data.payments ?? []} promos={data.promos ?? []} refunds={data.refunds ?? []} defects={data.defects ?? []} onChanged={reload} />}

      {tab === "tracking" && <PoTrackingTab poId={po.id} onChanged={reload} />}

      {tab === "history" && <PoHistory poId={po.id} reloadKey={version} />}
    </div>
  );
}
