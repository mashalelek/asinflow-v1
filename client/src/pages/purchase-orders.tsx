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
import { useState, useEffect, useCallback } from "react";
import { useLocation } from "wouter";
import { Upload, Paperclip, StickyNote, Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { UploadToVelocityDialog } from "@/components/upload-to-velocity-dialog";

interface PoRow {
  id: string;
  order_id: string;
  order_date: string;
  supplier: string;
  status: string;
  order_total: string | null;
  invoice_attached: boolean;
  asin_count: number;
  units_ordered: number;
  units_received: number | null; // null = not tracked on any line → "—"
  has_notes: boolean;
}

interface PosResponse {
  pos: PoRow[];
  total: number;
  page: number;
  pageSize: number;
  suppliers: string[];
  statusTokens: string[];
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
  const [statusFilter, setStatusFilter] = useState(ALL);
  const [supplierFilter, setSupplierFilter] = useState(ALL);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<PosResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const h = setTimeout(() => setDebouncedSearch(search), 250);
    return () => clearTimeout(h);
  }, [search]);

  useEffect(() => { setPage(1); }, [debouncedSearch, statusFilter, supplierFilter, from, to]);

  const load = useCallback(async () => {
    setError(null);
    const params = new URLSearchParams();
    if (debouncedSearch) params.set("search", debouncedSearch);
    if (statusFilter !== ALL) params.set("status", statusFilter);
    if (supplierFilter !== ALL) params.set("supplier", supplierFilter);
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
  }, [debouncedSearch, statusFilter, supplierFilter, from, to, page]);

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
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="h-8 w-[170px] text-sm" data-testid="select-po-status"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All statuses</SelectItem>
            {(data?.statusTokens ?? []).map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={supplierFilter} onValueChange={setSupplierFilter}>
          <SelectTrigger className="h-8 w-[200px] text-sm" data-testid="select-po-supplier"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All suppliers</SelectItem>
            {(data?.suppliers ?? []).map((sp) => <SelectItem key={sp} value={sp}>{sp}</SelectItem>)}
          </SelectContent>
        </Select>
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
              {["PO Date", "Order ID", "Supplier", "Status", "Order Total", "ASINs", "Units Ordered", "Units Received", "Invoice", "Notes"].map((h, i) => (
                <th key={h} className={`px-3 py-2 text-xs font-medium whitespace-nowrap ${i >= 4 && i <= 7 ? "text-right" : "text-left"}`}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(data?.pos ?? []).map((po) => {
              const money = fmtMoney(po.order_total);
              const tokens = po.status.split(",").map((x) => x.trim()).filter(Boolean);
              return (
                <tr key={po.id} className="table-zebra-stone cursor-pointer hover:bg-muted/40" style={hairline}
                  onClick={() => navigate(`/purchase-orders/${po.id}`)} data-testid={`row-po-${po.order_id}`}>
                  <td className="px-3 py-2 whitespace-nowrap">{fmtDate(po.order_date)}</td>
                  <td className="px-3 py-2 font-mono text-xs">{po.order_id}</td>
                  <td className="px-3 py-2">{po.supplier}</td>
                  <td className="px-3 py-2">
                    <div className="flex flex-col items-start gap-0.5">
                      {tokens.map((tk) => (
                        <span key={tk} className="inline-block rounded-sm bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground whitespace-nowrap">{tk}</span>
                      ))}
                    </div>
                  </td>
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
              );
            })}
            {data && data.pos.length === 0 && (
              <tr><td colSpan={10} className="px-3 py-8 text-center text-sm text-muted-foreground">No purchase orders match.</td></tr>
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

// Expanded-view route placeholder — replaced by the real view in step 4.
export function PurchaseOrderDetailPlaceholder() {
  const [, navigate] = useLocation();
  return (
    <div className="px-6 py-8 space-y-3">
      <button className="text-sm text-primary hover:underline" onClick={() => navigate("/purchase-orders")}>
        ← Back to POs
      </button>
      <p className="text-sm text-muted-foreground">Expanded PO view arrives in the next frame step.</p>
    </div>
  );
}
