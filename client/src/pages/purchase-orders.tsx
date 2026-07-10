/**
 * PO List page (/purchase-orders).
 *
 * Filters (date range, supplier, status multi, payment method, subscription),
 * search across order_id / product / asin, sortable columns, pagination, and
 * a per-row ASIN expand that lazy-loads the detail. Row click navigates to
 * /purchase-orders/:id.
 */
import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Tag, Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  listPos, getPo, n,
  type PoListRow, type PoStatus, type PoListFilters,
} from "@/lib/po-api";
import { useDateRange } from "@/contexts/date-range-context";

const ALL_STATUSES: PoStatus[] = ["Ordered", "Received Partial", "Received in Full", "Canceled", "Closed"];

const STATUS_BADGE_CLASS: Record<PoStatus, string> = {
  "Ordered":          "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
  "Received in Full": "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300",
  "Received Partial": "bg-yellow-100 text-yellow-800 dark:bg-yellow-950 dark:text-yellow-300",
  "Canceled":         "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  "Closed":           "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300",
};

const fmtCurrency = (v: number | string) => `$${n(v).toFixed(2)}`;
const fmtDate = (s: string) => new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

export default function PurchaseOrders() {
  // Global date range (top-nav DataStudioDatePicker)
  const { range: dateRange } = useDateRange();
  const startDate = dateRange.start;
  const endDate = dateRange.end;
  const [supplier, setSupplier] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("");
  const [statuses, setStatuses] = useState<PoStatus[]>([]);
  const [subscription, setSubscription] = useState(false);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize] = useState(50);
  const [sortBy, setSortBy] = useState<PoListFilters["sortBy"]>("order_date");
  const [sortDir, setSortDir] = useState<"ASC" | "DESC">("DESC");

  // Debounce the search input by 300ms so we don't refetch on every keystroke.
  const [debouncedSearch, setDebouncedSearch] = useState(search);
  useEffect(() => { const t = setTimeout(() => setDebouncedSearch(search), 300); return () => clearTimeout(t); }, [search]);

  // Reset to page 1 when the global date range changes.
  useEffect(() => { setPage(1); }, [startDate, endDate]);

  const filters: PoListFilters = useMemo(() => ({
    startDate, endDate,
    supplier: supplier ? supplier.split(",").map(s => s.trim()).filter(Boolean) : undefined,
    payment_method: paymentMethod ? paymentMethod.split(",").map(s => s.trim()).filter(Boolean) : undefined,
    status: statuses.length ? statuses : undefined,
    is_subscription: subscription || undefined,
    search: debouncedSearch || undefined,
    page, pageSize, sortBy, sortDir,
  }), [startDate, endDate, supplier, paymentMethod, statuses, subscription, debouncedSearch, page, pageSize, sortBy, sortDir]);

  const q = useQuery({
    queryKey: ["pos", filters],
    queryFn: () => listPos(filters),
  });

  const toggleSort = (col: NonNullable<PoListFilters["sortBy"]>) => {
    if (sortBy === col) setSortDir(d => d === "ASC" ? "DESC" : "ASC");
    else { setSortBy(col); setSortDir("DESC"); }
  };

  const toggleStatus = (s: PoStatus) =>
    setStatuses(curr => curr.includes(s) ? curr.filter(x => x !== s) : [...curr, s]);

  return (
    <div className="px-6 py-4 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Purchase Orders</h1>
        <Link href="/purchase-orders/new">
          <Button className="bg-stone-700 hover:bg-stone-800 text-white">
            <Plus className="h-4 w-4 mr-1" /> New PO
          </Button>
        </Link>
      </div>

      {/* Filters */}
      <Card className="p-4 space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
          <div>
            <label className="text-xs text-muted-foreground">Supplier <span className="text-muted-foreground/60">(comma-sep for multi)</span></label>
            <Input value={supplier} onChange={(e) => { setPage(1); setSupplier(e.target.value); }} placeholder="Walmart, Target" />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Payment method</label>
            <Input value={paymentMethod} onChange={(e) => { setPage(1); setPaymentMethod(e.target.value); }} placeholder="Credit Card" />
          </div>
          <div className="relative">
            <label className="text-xs text-muted-foreground">Search</label>
            <Search className="absolute left-2 top-[28px] h-3.5 w-3.5 text-muted-foreground" />
            <Input className="pl-7" value={search} onChange={(e) => { setPage(1); setSearch(e.target.value); }} placeholder="Order ID / product / ASIN" />
          </div>
        </div>
        <div className="flex flex-wrap gap-2 items-center pt-2">
          <span className="text-xs text-muted-foreground mr-1">Status:</span>
          {ALL_STATUSES.map(s => (
            <button
              key={s}
              onClick={() => { setPage(1); toggleStatus(s); }}
              className={`text-xs px-2 py-1 rounded border transition ${
                statuses.includes(s)
                  ? `${STATUS_BADGE_CLASS[s]} border-transparent`
                  : "bg-transparent text-muted-foreground border-border hover:bg-muted"
              }`}
            >
              {s}
            </button>
          ))}
          <label className="flex items-center gap-1.5 ml-4 text-xs cursor-pointer">
            <Checkbox checked={subscription} onCheckedChange={(v) => { setPage(1); setSubscription(!!v); }} />
            Subscriptions only
          </label>
        </div>
      </Card>

      {/* Table */}
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8"></TableHead>
                <SortHead label="Order Date" col="order_date" sortBy={sortBy} sortDir={sortDir} onClick={toggleSort} />
                <SortHead label="Status"     col="status"     sortBy={sortBy} sortDir={sortDir} onClick={toggleSort} />
                <SortHead label="Order ID"   col="order_id"   sortBy={sortBy} sortDir={sortDir} onClick={toggleSort} />
                <SortHead label="Supplier"   col="supplier"   sortBy={sortBy} sortDir={sortDir} onClick={toggleSort} />
                <SortHead label="Total"      col="order_total" sortBy={sortBy} sortDir={sortDir} onClick={toggleSort} className="text-right" />
                <TableHead className="text-right">Units (rec/ord)</TableHead>
                <TableHead className="text-center">Sub</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {q.isLoading && (
                <TableRow><TableCell colSpan={8} className="text-center text-muted-foreground py-8">Loading…</TableCell></TableRow>
              )}
              {q.isError && (
                <TableRow><TableCell colSpan={8} className="text-center text-red-500 py-8">{(q.error as Error).message}</TableCell></TableRow>
              )}
              {q.data?.rows.length === 0 && !q.isLoading && (
                <TableRow><TableCell colSpan={8} className="text-center text-muted-foreground py-8">No purchase orders match these filters.</TableCell></TableRow>
              )}
              {q.data?.rows.map((po) => <PoRow key={po.id} po={po} />)}
            </TableBody>
          </Table>
        </div>

        <div className="flex items-center justify-between p-3 border-t text-sm">
          <div className="text-muted-foreground">
            {q.data ? `${q.data.total} total · page ${q.data.page}` : "—"}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1}>Previous</Button>
            <Button variant="outline" size="sm" onClick={() => setPage(p => p + 1)} disabled={!q.data || page * pageSize >= q.data.total}>Next</Button>
          </div>
        </div>
      </Card>
    </div>
  );
}

function SortHead({ label, col, sortBy, sortDir, onClick, className }: {
  label: string;
  col: NonNullable<PoListFilters["sortBy"]>;
  sortBy: PoListFilters["sortBy"];
  sortDir: "ASC" | "DESC";
  onClick: (c: NonNullable<PoListFilters["sortBy"]>) => void;
  className?: string;
}) {
  const active = sortBy === col;
  return (
    <TableHead className={`cursor-pointer select-none hover:bg-muted/50 ${className ?? ""}`} onClick={() => onClick(col)}>
      <span className="inline-flex items-center gap-1">
        {label}
        {active && <span className="text-xs text-muted-foreground">{sortDir === "ASC" ? "↑" : "↓"}</span>}
      </span>
    </TableHead>
  );
}

function PoRow({ po }: { po: PoListRow }) {
  const [expanded, setExpanded] = useState(false);
  const [, setLoc] = useLocation();
  // Lazy load detail only when the user expands.
  const detail = useQuery({
    queryKey: ["po-detail", po.id],
    queryFn: () => getPo(po.id),
    enabled: expanded,
    staleTime: 30_000,
  });

  const onRowClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("button, input, label, a")) return;
    setLoc(`/purchase-orders/${po.id}`);
  };

  return (
    <>
      <TableRow onClick={onRowClick} className="cursor-pointer hover:bg-muted/40">
        <TableCell className="w-8">
          <button
            onClick={(e) => { e.stopPropagation(); setExpanded(v => !v); }}
            className="text-muted-foreground hover:text-foreground"
            title="Show ASIN breakdown"
            aria-label="Expand ASINs"
          >
            {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </button>
        </TableCell>
        <TableCell className="whitespace-nowrap">{fmtDate(po.order_date)}</TableCell>
        <TableCell>
          <Badge className={STATUS_BADGE_CLASS[po.status]}>{po.status}</Badge>
        </TableCell>
        <TableCell className="font-mono text-sm">
          <Link href={`/purchase-orders/${po.id}`} onClick={(e) => e.stopPropagation()} className="text-primary hover:underline">
            {po.order_id}
          </Link>
        </TableCell>
        <TableCell>{po.supplier}</TableCell>
        <TableCell className="text-right font-mono">{fmtCurrency(po.order_total)}</TableCell>
        <TableCell className="text-right font-mono text-sm text-muted-foreground">
          {po.total_units_received}/{po.total_units_ordered}
        </TableCell>
        <TableCell className="text-center text-xs">
          {po.is_subscription ? <Badge variant="outline">Sub</Badge> : ""}
        </TableCell>
      </TableRow>
      {expanded && (
        <TableRow className="bg-muted/30 hover:bg-muted/30">
          <TableCell colSpan={8} className="py-3">
            <div className="pl-6 flex items-center gap-2 mb-2 text-xs text-muted-foreground">
              <Tag className="h-3 w-3" />
              ASIN breakdown
            </div>
            {detail.isLoading && <div className="pl-6 text-xs text-muted-foreground">Loading…</div>}
            {detail.isError && <div className="pl-6 text-xs text-red-500">{(detail.error as Error).message}</div>}
            {detail.data && (
              detail.data.line_items.length === 0
                ? <div className="pl-6 text-xs text-muted-foreground">No line items.</div>
                : <div className="pl-6">
                    <table className="text-xs w-full max-w-3xl">
                      <thead className="text-muted-foreground">
                        <tr>
                          <th className="text-left font-medium py-1">ASIN</th>
                          <th className="text-left font-medium py-1">Title</th>
                          <th className="text-right font-medium py-1">Qty (units)</th>
                          <th className="text-right font-medium py-1">COGS / unit</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detail.data.line_items.map((li) => (
                          <tr key={li.id} className="border-t border-border/50">
                            <td className="font-mono py-1">{li.asin}</td>
                            <td className="py-1 truncate max-w-md">{li.asin_title ?? li.product_name}</td>
                            <td className="text-right py-1 font-mono">{n(li.pa_qty_received).toFixed(0)} / {n(li.qty_ordered) * n(li.asin_qty_per_product)}</td>
                            <td className="text-right py-1 font-mono">{li.cogs_per_asin_unit != null ? `$${n(li.cogs_per_asin_unit).toFixed(2)}` : "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
            )}
          </TableCell>
        </TableRow>
      )}
    </>
  );
}
