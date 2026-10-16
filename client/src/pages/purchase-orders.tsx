/**
 * POs page — PO module v1 frame, list view (docs/po-module-v1-frame-plan.md §3).
 *
 * READ-ONLY frame over the migrated 2026 data: list + filters + pagination.
 * + New PO is rendered disabled ("Soon") — it activates in layer 1. The
 * Upload to Velocity toolbar ACTION (SPEC §11) stays exactly where it was.
 * Row click navigates to the expanded-view route (placeholder until step 4).
 *
 * §7 styling: zebra + 0.5px hairlines, dark header bar, no vertical dividers,
 * no row tints; ALL money renders neutral ($0.00 muted) — semantic color is
 * reserved for warnings.
 */
import React, { useState, useEffect, useCallback } from "react";
import { useLocation, Link } from "wouter";
import { Upload, Paperclip, StickyNote, Plus, Search, Copy, Check, ChevronRight, ChevronDown, ChevronsDownUp, ChevronsUpDown, CheckCircle2, Circle } from "lucide-react";
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
import { PoAsinTable, PoAsinColGroup, PoAsinHeaderRow, PoAsinRow, type PoAsinRowData, type PoAsinLine } from "@/components/po-asin-rows";
import { loadPoExpanded, savePoExpanded, isPoExpanded, togglePoExpanded, toggleExpandAll, type PoExpandedState } from "@/lib/po-expanded";
import { productQtyFromAsin } from "@/lib/po-qty";

interface PoRow {
  id: string;
  order_id: string;
  order_date: string;
  supplier: string;
  /** §6: multi-select Action Items (the old free-text status is no longer read). */
  action_items: string[];
  order_total: string | null;
  invoice_attached: boolean;
  asin_count: number;
  units_ordered: number;
  units_received: number | null; // null = not tracked on any line → "—"
  has_notes: boolean;
  /** §5: NULL = Open. closed_by 'auto' | 'sheet' | a user id. */
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
}

type ClosedFilter = "open" | "closed" | "all";
/** §6.1 list, display order — the detail page has no list payload to read it from. */
const ACTION_ITEM_OPTIONS = ["Need to Return", "Missing / Damaged from Supplier", "Confirm Refund / Replacement", "ATTN: Velocity", "See Comments", "SHIP", "Received - FBM"];

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
  const who = po.closed_by === "auto" ? "closed automatically" : po.closed_by === "sheet" ? "closed (from the Orders sheet)" : "closed by hand";
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

// §7: tinted chips only, never saturated fills. Action Items (§6.1):
// needs-attention items amber; SHIP indigo; Received - FBM green;
// Need to Return orange.
function actionChipClass(item: string): string {
  const t = item.toLowerCase();
  if (t === "ship") return "bg-indigo-500/10 text-indigo-600 dark:text-indigo-400";
  if (t === "received - fbm") return "bg-green-500/10 text-green-700 dark:text-green-400";
  if (t === "need to return") return "bg-orange-500/10 text-orange-600 dark:text-orange-400";
  return "bg-amber-500/10 text-amber-600 dark:text-amber-400";
}
const chipBase = "inline-block rounded-sm px-1.5 py-0.5 text-[11px] whitespace-nowrap";

/** Action Items chips + inline multi-select editor (§6.1). Saving re-runs the auto-close rule server-side. */
function ActionItemsEditor({ po, options, onSaved, align = "start" }: { po: { id: string; order_id: string; action_items: string[] }; options: string[]; onSaved: () => void; align?: "start" | "end" }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Set<string>>(new Set(po.action_items));
  const [err, setErr] = useState<string | null>(null);
  const save = async (next: Set<string>) => {
    setDraft(next); setErr(null);
    try {
      const res = await fetch(`/api/pos/${po.id}/action-items`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action_items: Array.from(next) }) });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || `HTTP ${res.status}`);
      onSaved();
    } catch (e: any) { setErr(e.message); }
  };
  return (
    <Popover open={open} onOpenChange={(v) => { setOpen(v); if (v) setDraft(new Set(po.action_items)); }}>
      <PopoverTrigger asChild>
        <button type="button" onClick={(e) => e.stopPropagation()} className="flex flex-col items-start gap-0.5 min-h-[1.25rem] min-w-[4rem] text-left" data-testid={`button-action-items-${po.order_id}`} title="Edit action items">
          {po.action_items.length === 0
            ? <span className="text-muted-foreground/40 text-[11px]">—</span>
            : po.action_items.map((it) => <span key={it} className={`${chipBase} ${actionChipClass(it)}`}>{it}</span>)}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-2 space-y-1" align={align} onClick={(e) => e.stopPropagation()}>
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground px-1">Action items</div>
        {options.map((opt) => (
          <label key={opt} className="flex items-center gap-2 px-2 py-1 rounded hover:bg-muted cursor-pointer text-xs">
            <input type="checkbox" checked={draft.has(opt)} onChange={() => { const next = new Set(draft); if (next.has(opt)) next.delete(opt); else next.add(opt); void save(next); }} className="h-3 w-3 accent-blue-500" data-testid={`checkbox-action-${opt}`} />
            <span className={`${chipBase} ${actionChipClass(opt)}`}>{opt}</span>
          </label>
        ))}
        {err && <div className="px-2 text-xs text-destructive">{err}</div>}
      </PopoverContent>
    </Popover>
  );
}

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
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [actionSel, setActionSel] = useState<Set<string>>(new Set());
  const [closedFilter, setClosedFilter] = useState<ClosedFilter>("open"); // D3: default Open only
  const [supplierSel, setSupplierSel] = useState<Set<string>>(new Set());
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<PosResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Expand by ASIN (§3.4): persisted per browser, default all collapsed.
  const [expandedState, setExpandedState] = useState<PoExpandedState>(loadPoExpanded);
  const applyExpanded = (next: PoExpandedState) => { setExpandedState(next); savePoExpanded(next); };

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
          <Tooltip>
            <TooltipTrigger asChild>
              {/* Disabled buttons swallow pointer events — wrap so the tooltip fires. */}
              <span tabIndex={0}>
                <Button variant="default" size="sm" disabled data-testid="button-new-po">
                  <Plus className="h-4 w-4 mr-1" /> New PO
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom"><p className="text-xs">Soon — arrives with the entry form</p></TooltipContent>
          </Tooltip>
          <Button variant="outline" size="sm" onClick={() => applyExpanded(toggleExpandAll(expandedState))} data-testid="button-po-expand-all">
            {expandedState.all ? <ChevronsDownUp className="h-4 w-4 mr-1" /> : <ChevronsUpDown className="h-4 w-4 mr-1" />}
            {expandedState.all ? "Collapse All" : "Expand All"}
          </Button>
          <Button variant="outline" size="sm" onClick={() => setVelocityOpen(true)}>
            <Upload className="h-4 w-4 mr-1" /> Upload to Velocity
          </Button>
        </div>
      </div>

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
              {["Action Items", "PO Date", "Order ID", "Supplier", "Order Total", "ASINs", "Units Ordered", "Units Received", "Invoice", "Notes"].map((h, i) => (
                <th key={h} className={`px-3 py-2 text-xs font-medium whitespace-nowrap ${i >= 4 && i <= 7 ? "text-right" : "text-left"}`}>{h}</th>
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
                    <ActionItemsEditor po={po} options={data?.actionItems ?? []} onSaved={load} />
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">{fmtDate(po.order_date)}</td>
                  <td className="px-3 py-2 font-mono text-xs">{po.order_id}</td>
                  <td className="px-3 py-2">{po.supplier}</td>
                  <td className={`px-3 py-2 text-right font-mono ${money.muted ? "text-muted-foreground/50" : ""}`}>{money.text}</td>
                  <td className="px-3 py-2 text-right">{po.asin_count}</td>
                  <td className="px-3 py-2 text-right">{po.units_ordered}</td>
                  <td className="px-3 py-2 text-right">{po.units_received == null ? <span className="text-muted-foreground/50">—</span> : po.units_received}</td>
                  <td className="px-3 py-2">
                    {po.invoice_attached
                      ? <Paperclip className="h-3.5 w-3.5 text-muted-foreground" />
                      : <span className="text-muted-foreground/40">—</span>}
                  </td>
                  <td className="px-3 py-2">{po.has_notes && <StickyNote className="h-3.5 w-3.5 text-muted-foreground" />}</td>
                </tr>
                {open && (
                  <tr data-testid={`row-po-asins-${po.order_id}`}>
                    <td colSpan={12} className="p-0 pl-6 bg-muted/20">
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
// Qty rendering (§22): NULL = not tracked → muted em-dash; explicit 0 muted.
function Qty({ v }: { v: number | null | undefined }) {
  if (v == null) return <span className="text-muted-foreground/50">—</span>;
  return <span className={v === 0 ? "text-muted-foreground/50" : ""}>{v}</span>;
}
// Product-unit view of an ASIN quantity (§4.3): fractional values show 2 dp.
function ProductQty({ v }: { v: number | null }) {
  if (v == null) return <span className="text-muted-foreground/50">—</span>;
  const t = Number.isInteger(v) ? String(v) : v.toFixed(2);
  return <span className={v === 0 ? "text-muted-foreground/50" : ""}>{t}</span>;
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
  const [tab, setTab] = useState<"details" | "asins" | "products">("details");
  const [copied, setCopied] = useState(false);

  const reload = useCallback(() => {
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
  // Products tab (§4.3): the three manual ASIN quantities convert to product
  // units through the line's yield for 1:1 lines (one line per ASIN row);
  // a bundle component line (≥2 lines on the ASIN) shows a dash — a
  // per-component split is not inferrable from an ASIN-level number.
  const allLines: Array<PoLine & { parentAsin: string; parent: PoAsinDetail; soleLine: boolean }> =
    asins.flatMap((a) => a.lines.map((l) => ({ ...l, parentAsin: a.asin, parent: a, soleLine: a.lines.length === 1 })));

  const copyInvoiceName = () => {
    navigator.clipboard.writeText(po.invoice_file_name).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };

  const thNum = "px-3 py-2 text-xs font-medium whitespace-nowrap text-right";
  const thTxt = "px-3 py-2 text-xs font-medium whitespace-nowrap text-left";

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
        <div className="flex gap-1">
          <ActionItemsEditor po={{ id: po.id, order_id: po.order_id, action_items: actionItems }} options={ACTION_ITEM_OPTIONS} onSaved={reload} align="end" />
        </div>
      </div>

      {/* Summary strip */}
      <div className="flex gap-6 rounded-md px-4 py-3 text-sm" style={{ border: "0.5px solid hsl(var(--border))" }} data-testid="po-summary-strip">
        {[
          ["ASINs", String(summary.asin_count)],
          ["Units Ordered", String(summary.units_ordered)],
          ["Units Received", summary.units_received == null ? "—" : String(summary.units_received)],
        ].map(([k, v]) => (
          <div key={k}><span className="text-muted-foreground mr-1.5">{k}</span><span className="font-medium">{v}</span></div>
        ))}
        <div><span className="text-muted-foreground mr-1.5">Order Total</span><Money v={summary.order_total} /></div>
        <div><span className="text-muted-foreground mr-1.5">COGS Total</span><Money v={summary.cogs_total} /></div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1" style={{ borderBottom: "0.5px solid hsl(var(--border))" }}>
        {([["details", "PO Details"], ["asins", "ASINs"], ["products", "Products"]] as const).map(([key, label]) => (
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

      {tab === "products" && (
        <div className="w-full overflow-auto rounded-md" style={{ border: "0.5px solid hsl(var(--border))" }}>
          <table className="w-full border-collapse text-sm" data-testid="po-products-table">
            <thead>
              <tr className="table-header-stone">
                <th className={thTxt}>Product Name</th>
                <th className={thTxt}>Supplier SKU / UPC</th>
                <th className={thNum}>Price</th>
                <th className={thNum}>Item Discount</th>
                <th className={thNum}>Ordered</th>
                <th className={thNum}>Received</th>
                <th className={thNum}>Canceled</th>
                <th className={thNum}>Returned</th>
                <th className={thNum}>At Prep Center</th>
                <th className={thNum}>At CQG Warehouse</th>
                <th className={thNum}>Lost/damaged by us</th>
                <th className={thNum}>Final</th>
                <th className={thTxt}>ASIN</th>
                <th className={thTxt}></th>
              </tr>
            </thead>
            <tbody>
              {allLines.map((l) => (
                <tr key={l.id} className="table-zebra-stone" style={hairline} data-testid={`row-product-${l.id}`}>
                  <td className="px-3 py-1.5 max-w-[320px] truncate" title={l.product_name ?? ""}>{l.product_name ?? <span className="text-muted-foreground/50">—</span>}</td>
                  <td className="px-3 py-1.5 font-mono text-xs"><Dash v={l.supplier_sku} /></td>
                  <td className="px-3 py-1.5 text-right"><Money v={l.price} /></td>
                  <td className="px-3 py-1.5 text-right"><Money v={l.item_discount} /></td>
                  <td className="px-3 py-1.5 text-right"><Qty v={l.qty_ordered} /></td>
                  <td className="px-3 py-1.5 text-right"><Qty v={l.qty_received} /></td>
                  <td className="px-3 py-1.5 text-right"><Qty v={l.qty_canceled} /></td>
                  <td className="px-3 py-1.5 text-right"><Qty v={l.qty_returned} /></td>
                  <td className="px-3 py-1.5 text-right"><ProductQty v={l.soleLine ? productQtyFromAsin(l.parent.qty_at_prep, l.asin_qty_per_product) : null} /></td>
                  <td className="px-3 py-1.5 text-right"><ProductQty v={l.soleLine ? productQtyFromAsin(l.parent.qty_at_warehouse, l.asin_qty_per_product) : null} /></td>
                  <td className="px-3 py-1.5 text-right"><ProductQty v={l.soleLine ? productQtyFromAsin(l.parent.qty_lost_damaged_us, l.asin_qty_per_product) : null} /></td>
                  <td className="px-3 py-1.5 text-right"><Qty v={l.final_qty} /></td>
                  <td className="px-3 py-1.5">
                    <span className="inline-block rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">→ {l.parentAsin}</span>
                  </td>
                  <td className="px-3 py-1.5">{l.notes && <StickyNote className="h-3.5 w-3.5 text-muted-foreground" />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
