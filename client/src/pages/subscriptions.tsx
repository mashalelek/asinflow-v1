/**
 * Subscriptions page (patch docs/claude_spec-patch-po-ai-prefill.md §9; SPEC
 * §27). One row per (supplier, ASIN) a retailer re-ships on a schedule:
 * supplier, product / ASIN, frequency, next order, status, last PO — inline
 * edit of frequency / next date / status (and notes), a link to the PO, a
 * manual "+ Subscription". Quiet chrome, the POs table's conventions
 * (sortable, resizable via the shared hook, zebra + hairlines).
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { ArrowUp, ArrowDown, ArrowUpDown, Plus, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { useColumnWidths, ResizeHandle } from "@/hooks/use-column-widths";
import { InlineEdit, SelectEdit, poApi } from "@/components/po-edit";

export interface SubscriptionRow {
  id: number; supplier: string; asin: string | null; product_name: string | null; asin_title: string | null; thumbnail: string | null;
  frequency_weeks: number | null; next_order_date: string | null; status: "active" | "paused" | "canceled" | string;
  last_po_id: string | null; last_order_id: string | null; last_order_date: string | null; origin_order_id: string | null; created_from: string; notes: string | null;
}
const COLS = [
  { id: "supplier", label: "Supplier", sort: (r: SubscriptionRow) => r.supplier.toLowerCase() },
  { id: "product", label: "Product / ASIN", sort: (r: SubscriptionRow) => (r.product_name ?? r.asin_title ?? r.asin ?? "").toLowerCase() },
  { id: "frequency", label: "Every", sort: (r: SubscriptionRow) => r.frequency_weeks ?? 9999, align: "right" as const },
  { id: "next", label: "Next order", sort: (r: SubscriptionRow) => r.next_order_date ?? "9999" },
  { id: "status", label: "Status", sort: (r: SubscriptionRow) => r.status },
  { id: "last", label: "Last PO", sort: (r: SubscriptionRow) => r.last_order_date ?? "" },
  { id: "notes", label: "Notes", sort: (r: SubscriptionRow) => r.notes ?? "" },
] as const;
type ColId = (typeof COLS)[number]["id"];
const WIDTHS_KEY = "af-subscriptions-col-widths";

/** Days from today to the next order (negative = overdue); null without a date. */
export function daysUntil(next: string | null, today = new Date()): number | null {
  if (!next) return null;
  const [y, m, d] = next.split("-").map(Number);
  const t = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((Date.UTC(y, m - 1, d) - t) / 86400000);
}
export function nextLabel(r: Pick<SubscriptionRow, "next_order_date" | "status">, today = new Date()): { text: string; tone: "due" | "overdue" | "plain" } {
  const d = daysUntil(r.next_order_date, today);
  if (d == null) return { text: "—", tone: "plain" };
  if (r.status !== "active") return { text: r.next_order_date!, tone: "plain" };
  if (d < 0) return { text: `${r.next_order_date} · ${-d} day${d === -1 ? "" : "s"} overdue`, tone: "overdue" };
  if (d <= 7) return { text: `${r.next_order_date} · in ${d} day${d === 1 ? "" : "s"}`, tone: "due" };
  return { text: r.next_order_date!, tone: "plain" };
}

export default function Subscriptions() {
  const { toast } = useToast();
  const [rows, setRows] = useState<SubscriptionRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<{ col: ColId; dir: "asc" | "desc" }>({ col: "next", dir: "asc" });
  const [filter, setFilter] = useState<"active" | "all">("active");
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ supplier: "", asin: "", product_name: "", frequency_weeks: "", next_order_date: "" });
  const { colWidths, handleResizeStart, resetWidths } = useColumnWidths(WIDTHS_KEY);
  const load = useCallback(() => {
    fetch("/api/subscriptions").then(async (r) => { if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message || `HTTP ${r.status}`); return r.json(); })
      .then((d) => { setRows(d.subscriptions ?? []); setError(null); }).catch((e) => setError(e.message));
  }, []);
  useEffect(() => { load(); }, [load]);
  const shown = useMemo(() => {
    const col = COLS.find((c) => c.id === sort.col)!;
    const list = rows.filter((r) => filter === "all" || r.status === "active");
    return [...list].sort((a, b) => { const x = col.sort(a), y = col.sort(b); return (x < y ? -1 : x > y ? 1 : 0) * (sort.dir === "asc" ? 1 : -1); });
  }, [rows, sort, filter]);
  const patch = (r: SubscriptionRow, field: string) => async (v: string) => {
    try { await poApi(`/api/subscriptions/${r.id}`, "PATCH", { [field]: v }); load(); }
    catch (e: any) { toast({ title: "Not saved", description: e.message, variant: "destructive" }); }
  };
  const add = async () => {
    try { await poApi("/api/subscriptions", "POST", { ...draft, asin: draft.asin.trim().toUpperCase() || undefined }); setAdding(false); setDraft({ supplier: "", asin: "", product_name: "", frequency_weeks: "", next_order_date: "" }); load(); }
    catch (e: any) { toast({ title: "Not added", description: e.message, variant: "destructive" }); }
  };
  const th = (c: (typeof COLS)[number]) => {
    const active = sort.col === c.id;
    const style = colWidths[c.id] ? { width: colWidths[c.id], minWidth: colWidths[c.id], maxWidth: colWidths[c.id] } : undefined;
    return (
      <th key={c.id} style={style} className={`relative px-3 py-2 text-xs font-medium whitespace-nowrap overflow-hidden ${"align" in c && c.align === "right" ? "text-right" : "text-left"}`} data-testid={`th-subscriptions-${c.id}`}>
        <button type="button" className="inline-flex items-center gap-1" onClick={() => setSort((s) => ({ col: c.id, dir: s.col === c.id && s.dir === "asc" ? "desc" : "asc" }))}>
          {c.label}{active ? (sort.dir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />) : <ArrowUpDown className="h-3 w-3 opacity-30" />}
        </button>
        <ResizeHandle onMouseDown={(e) => handleResizeStart(e, c.id)} />
      </th>
    );
  };
  const hairline = { borderBottom: "0.5px solid hsl(var(--border))" } as const;
  const dueCount = rows.filter((r) => r.status === "active" && nextLabel(r).tone !== "plain").length;
  return (
    <div className="px-6 py-4 space-y-4">
      <div className="flex items-end justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-semibold">Subscriptions</h1>
          <p className="text-sm text-muted-foreground">{rows.filter((r) => r.status === "active").length} active · {dueCount} due or overdue · "Subscription renews" is raised on the last PO 7 days before the next order; a renewal PO is created from the confirmation email</p>
        </div>
        <div className="flex items-center gap-2">
          <select value={filter} onChange={(e) => setFilter(e.target.value as "active" | "all")} className="h-8 rounded-md border border-input bg-background px-2 text-xs" data-testid="select-subscriptions-filter"><option value="active">Active</option><option value="all">All</option></select>
          {Object.keys(colWidths).length > 0 && <Button variant="ghost" size="sm" className="h-8 text-xs text-muted-foreground" onClick={resetWidths}>Reset widths</Button>}
          <Button variant="default" size="sm" onClick={() => setAdding((v) => !v)} data-testid="button-new-subscription"><Plus className="h-3.5 w-3.5 mr-1" /> Subscription</Button>
        </div>
      </div>
      {adding && (
        <div className="flex flex-wrap items-center gap-2 rounded-md px-3 py-2" style={{ border: "0.5px solid hsl(var(--border))" }} data-testid="subscription-add">
          <Input value={draft.supplier} onChange={(e) => setDraft({ ...draft, supplier: e.target.value })} placeholder="supplier (domain)" className="h-8 w-44 text-xs" data-testid="input-subscription-supplier" />
          <Input value={draft.asin} onChange={(e) => setDraft({ ...draft, asin: e.target.value })} placeholder="ASIN" className="h-8 w-28 font-mono text-xs" data-testid="input-subscription-asin" />
          <Input value={draft.product_name} onChange={(e) => setDraft({ ...draft, product_name: e.target.value })} placeholder="product" className="h-8 w-56 text-xs" data-testid="input-subscription-product" />
          <span className="text-xs text-muted-foreground">every</span><Input value={draft.frequency_weeks} onChange={(e) => setDraft({ ...draft, frequency_weeks: e.target.value })} inputMode="numeric" className="h-8 w-14 text-right text-xs" data-testid="input-subscription-weeks" /><span className="text-xs text-muted-foreground">weeks · next</span>
          <input type="date" value={draft.next_order_date} onChange={(e) => setDraft({ ...draft, next_order_date: e.target.value })} className="h-8 rounded-md border border-input bg-background px-2 text-xs" data-testid="input-subscription-next" />
          <Button size="sm" onClick={add} data-testid="button-subscription-add">Add</Button>
        </div>
      )}
      {error && <p className="text-sm text-destructive" data-testid="subscriptions-error">{error}</p>}
      <div className="w-full overflow-auto rounded-md" style={{ border: "0.5px solid hsl(var(--border))" }}>
        <table className="w-full border-collapse text-sm" data-testid="subscriptions-table">
          <thead><tr className="table-header-stone">{COLS.map(th)}</tr></thead>
          <tbody>
            {shown.length === 0 && <tr><td colSpan={COLS.length} className="px-3 py-6 text-center text-sm text-muted-foreground">No subscriptions{filter === "active" ? " active" : ""}.</td></tr>}
            {shown.map((r) => {
              const n = nextLabel(r);
              return (
                <tr key={r.id} className="table-zebra-stone" style={hairline} data-testid={`row-subscription-${r.id}`}>
                  <td className="px-3 py-2">{r.supplier}</td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2 min-w-0">
                      {r.thumbnail ? <img src={r.thumbnail} alt="" className="h-7 w-7 rounded object-contain bg-white" /> : null}
                      <div className="min-w-0">
                        <InlineEdit value={r.product_name ?? r.asin_title} onSave={patch(r, "product_name")} width="w-64" testId={`subscription-product-${r.id}`}><span className="truncate block max-w-[22rem]" title={r.product_name ?? r.asin_title ?? ""}>{r.product_name ?? r.asin_title ?? <span className="text-muted-foreground/50">—</span>}</span></InlineEdit>
                        <InlineEdit value={r.asin} onSave={patch(r, "asin")} width="w-28" testId={`subscription-asin-${r.id}`}><span className="font-mono text-[11px] text-muted-foreground">{r.asin ?? "—"}</span></InlineEdit>
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right"><InlineEdit value={r.frequency_weeks} onSave={patch(r, "frequency_weeks")} align="right" width="w-14" testId={`subscription-weeks-${r.id}`}>{r.frequency_weeks != null ? `${r.frequency_weeks} wk` : <span className="text-amber-600 inline-flex items-center gap-1"><AlertTriangle className="h-3 w-3" /> set</span>}</InlineEdit></td>
                  <td className={`px-3 py-2 whitespace-nowrap ${n.tone === "overdue" ? "text-destructive" : n.tone === "due" ? "text-amber-700 dark:text-amber-400" : ""}`}><InlineEdit value={r.next_order_date} onSave={patch(r, "next_order_date")} width="w-32" testId={`subscription-next-${r.id}`}>{n.text}</InlineEdit></td>
                  <td className="px-3 py-2"><SelectEdit value={r.status} options={["active", "paused", "canceled"]} onSave={patch(r, "status")} testId={`subscription-status-${r.id}`} /></td>
                  <td className="px-3 py-2 whitespace-nowrap">{r.last_po_id ? <Link href={`/purchase-orders/${r.last_po_id}`} className="font-mono text-xs text-primary hover:underline" data-testid={`link-subscription-po-${r.id}`}>{r.last_order_id}</Link> : <span className="text-muted-foreground/50">—</span>}{r.last_order_date && <span className="ml-1.5 text-xs text-muted-foreground">{r.last_order_date}</span>}</td>
                  <td className="px-3 py-2"><InlineEdit value={r.notes} onSave={patch(r, "notes")} width="w-56" testId={`subscription-notes-${r.id}`}><span className="truncate block max-w-[18rem] text-xs text-muted-foreground" title={r.notes ?? ""}>{r.notes ?? "—"}</span></InlineEdit></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
