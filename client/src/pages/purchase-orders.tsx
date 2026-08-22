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
import { Upload, Paperclip, StickyNote, Plus, Search, Copy, Check, ChevronRight, ChevronDown, AlertTriangle } from "lucide-react";
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

// ── Expanded PO view (frame step 4, read-only — no edit pencil) ──────────────

interface PoAsinDetail {
  id: string;
  asin: string;
  asin_name: string | null;
  sku: string | null;
  qty: number;
  cost_per_unit: string | null;
  total_cost: string | null;
  prep_cost: string | null;
  sold_as: string;
  units_per_pack: number;
  unreimbursed_loss_qty: number;
  unreimbursed_loss_amount: string | null;
  notes: string | null;
  thumbnail: string | null;
  lines: PoLine[];
}
interface PoLine {
  id: string;
  position: number | null;
  product_name: string | null;
  supplier_sku: string | null;
  price: string | null;
  item_discount: string | null;
  qty_ordered: number | null;
  qty_received: number | null;
  qty_refunded: number | null;
  asin_qty_per_product: string | null;
  adjusted_product_cost: string | null;
  notes: string | null;
}
interface PoDetail {
  po: Record<string, any> & { invoice_file_name: string };
  summary: { asin_count: number; units_ordered: number; units_received: number | null; order_total: string | null; cogs_total: string };
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
  const [tab, setTab] = useState<"details" | "asins" | "products">("details");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetch(`/api/pos/${id}`)
      .then(async (r) => { if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message || `HTTP ${r.status}`); return r.json(); })
      .then(setData)
      .catch((e) => setError(e.message));
  }, [id]);

  if (error) return (
    <div className="px-6 py-8 space-y-3">
      <button className="text-sm text-primary hover:underline" onClick={() => navigate("/purchase-orders")}>← Back to POs</button>
      <p className="text-sm text-destructive">{error}</p>
    </div>
  );
  if (!data) return <div className="px-6 py-8 text-sm text-muted-foreground">Loading…</div>;

  const { po, summary, asins } = data;
  const tokens = String(po.status ?? "").split(",").map((x: string) => x.trim()).filter(Boolean);
  const hairline = { borderBottom: "0.5px solid hsl(var(--border))" } as const;
  const allLines: Array<PoLine & { parentAsin: string }> = asins.flatMap((a) => a.lines.map((l) => ({ ...l, parentAsin: a.asin })));

  const copyInvoiceName = () => {
    navigator.clipboard.writeText(po.invoice_file_name).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };

  const toggle = (aid: string) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(aid)) next.delete(aid); else next.add(aid);
    return next;
  });

  const thNum = "px-3 py-2 text-xs font-medium whitespace-nowrap text-right";
  const thTxt = "px-3 py-2 text-xs font-medium whitespace-nowrap text-left";

  return (
    <div className="px-6 py-4 space-y-4">
      <button className="text-sm text-primary hover:underline" onClick={() => navigate("/purchase-orders")} data-testid="button-back-to-pos">
        ← Back to POs
      </button>

      {/* Header */}
      <div className="flex items-end justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-semibold font-mono" data-testid="text-po-order-id">{po.order_id}</h1>
          <p className="text-sm text-muted-foreground">{po.supplier} · {fmtDate(String(po.order_date))}</p>
        </div>
        <div className="flex gap-1">
          {tokens.map((tk: string) => (
            <span key={tk} className="inline-block rounded-sm bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">{tk}</span>
          ))}
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
            ["Status", tokens.join(", ")],
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

      {tab === "asins" && (
        <div className="w-full overflow-auto rounded-md" style={{ border: "0.5px solid hsl(var(--border))" }}>
          <table className="w-full border-collapse text-sm" data-testid="po-asins-table">
            <thead>
              <tr className="table-header-stone">
                <th className={thTxt}></th>
                <th className={thTxt}>ASIN</th>
                <th className={thTxt}>Title</th>
                <th className={thTxt}>Amazon SKU</th>
                <th className={thNum}>Qty</th>
                <th className={thNum}>Cost/Unit</th>
                <th className={thNum}>Total Cost</th>
                <th className={thNum}>Prep</th>
                <th className={thTxt}>Sold As</th>
                <th className={thNum}>Units/Pack</th>
                <th className={thNum}>Qty (units)</th>
                <th className={thNum}>Unreimb. Loss</th>
                <th className={thTxt}></th>
              </tr>
            </thead>
            <tbody>
              {asins.map((a) => {
                const isOpen = expanded.has(a.id);
                const multi = a.lines.length >= 2;
                return (
                  <React.Fragment key={a.id}>
                    <tr className="table-zebra-stone" style={hairline} data-testid={`row-po-asin-${a.asin}`}>
                      <td className="px-2 py-1.5 w-10">
                        <span className="inline-flex items-center gap-1">
                          {multi && (
                            <button onClick={() => toggle(a.id)} className="text-muted-foreground" data-testid={`button-expand-${a.asin}`}>
                              {isOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                            </button>
                          )}
                          {a.thumbnail && <img src={a.thumbnail} alt="" className="h-7 w-7 object-contain rounded-sm" />}
                        </span>
                      </td>
                      <td className="px-3 py-1.5">
                        <Link href={`/asins?q=${a.asin}`} className="font-mono text-xs text-primary hover:underline" onClick={(e) => e.stopPropagation()}>{a.asin}</Link>
                      </td>
                      <td className="px-3 py-1.5 max-w-[280px] truncate" title={a.asin_name ?? ""}>{a.asin_name ?? <span className="text-muted-foreground/50">—</span>}</td>
                      <td className="px-3 py-1.5">
                        {a.sku ? <span className="font-mono text-xs">{a.sku}</span> : (
                          <Tooltip>
                            <TooltipTrigger asChild><AlertTriangle className="h-3.5 w-3.5 text-amber-500" /></TooltipTrigger>
                            <TooltipContent side="top"><p className="text-xs">No SKU — create offer first</p></TooltipContent>
                          </Tooltip>
                        )}
                      </td>
                      <td className="px-3 py-1.5 text-right">{a.qty}</td>
                      <td className="px-3 py-1.5 text-right"><Money v={a.cost_per_unit} /></td>
                      <td className="px-3 py-1.5 text-right"><Money v={a.total_cost} /></td>
                      <td className="px-3 py-1.5 text-right"><Money v={a.prep_cost} /></td>
                      <td className="px-3 py-1.5">{a.sold_as}</td>
                      <td className="px-3 py-1.5 text-right">{a.units_per_pack}</td>
                      <td className="px-3 py-1.5 text-right">{a.units_per_pack * a.qty}</td>
                      <td className="px-3 py-1.5 text-right">
                        {a.unreimbursed_loss_qty > 0 || parseFloat(a.unreimbursed_loss_amount ?? "0") !== 0
                          ? <span>{a.unreimbursed_loss_qty} / <Money v={a.unreimbursed_loss_amount} /></span>
                          : <span className="text-muted-foreground/50">—</span>}
                      </td>
                      <td className="px-2 py-1.5">{a.notes && <StickyNote className="h-3.5 w-3.5 text-muted-foreground" />}</td>
                    </tr>
                    {multi && isOpen && a.lines.map((l) => (
                      <tr key={l.id} style={hairline} data-testid={`row-component-${a.asin}-${l.position}`}>
                        <td className="px-2 py-1" />
                        <td className="px-3 py-1 pl-8 text-xs text-muted-foreground" colSpan={2}>{l.product_name ?? "—"}</td>
                        <td className="px-3 py-1 text-muted-foreground/50">—</td>
                        <td className="px-3 py-1 text-right text-xs text-muted-foreground"><Dash v={l.qty_ordered} /></td>
                        <td className="px-3 py-1 text-right text-xs text-muted-foreground"><Money v={l.price} /></td>
                        <td className="px-3 py-1 text-right text-xs text-muted-foreground"><Money v={l.adjusted_product_cost} /></td>
                        <td className="px-3 py-1" colSpan={6} />
                      </tr>
                    ))}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

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
                <th className={thNum}>Refunded</th>
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
                  <td className="px-3 py-1.5 text-right"><Dash v={l.qty_ordered} /></td>
                  <td className="px-3 py-1.5 text-right"><Dash v={l.qty_received} /></td>
                  <td className="px-3 py-1.5 text-right"><Dash v={l.qty_refunded} /></td>
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
