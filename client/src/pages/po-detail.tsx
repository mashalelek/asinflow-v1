/**
 * PO Detail page (/purchase-orders/:id).
 *
 * Layout: two-column. Left = order-level data (read-only with Edit toggle that
 * becomes an inline editable form; calls PUT /api/pos/:id). Right = summary
 * cards (Total Products / Units Ordered / Units Received / Refund / Weighted
 * GC %). Below: gift cards used, line items table with inline-editable qty
 * fields, refund_amount, status, and an expand panel that shows the LI's COGS
 * breakdown. Refund warning banner appears when server flags a mismatch.
 *
 * Inline edits PATCH on blur via updateLineItem / updatePo. TanStack Query
 * invalidates ["pos"] + ["po-detail", id] on every mutation.
 */
import { useState } from "react";
import { Link, useLocation, useRoute } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ChevronDown, ChevronRight, Trash2, Pencil, X, Save, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  getPo, updatePo, deletePo, updateLineItem, deleteLineItem,
  n, type PoDetail, type PoDetailLineItem, type LiStatus, type PoStatus, type PoOrderFields,
} from "@/lib/po-api";

const LI_STATUSES: LiStatus[] = ["Ordered", "Received Partial", "Received in Full", "Returned", "Canceled", "Shipped FBA", "FBM"];

const PO_STATUS_BADGE: Record<PoStatus, string> = {
  "Ordered":          "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
  "Received in Full": "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300",
  "Received Partial": "bg-yellow-100 text-yellow-800 dark:bg-yellow-950 dark:text-yellow-300",
  "Canceled":         "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  "Closed":           "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300",
};

const fmt = (v: any) => `$${n(v).toFixed(2)}`;
const fmtDate = (s: string | null | undefined) => s ? new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—";

export default function PoDetail() {
  const [match, params] = useRoute("/purchase-orders/:id");
  const [, setLoc] = useLocation();
  const qc = useQueryClient();
  const id = match ? params!.id : "";

  const q = useQuery({
    queryKey: ["po-detail", id],
    queryFn: () => getPo(id),
    enabled: !!id,
  });

  const removePo = useMutation({
    mutationFn: () => deletePo(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pos"] });
      setLoc("/purchase-orders");
    },
  });

  if (!match)         return <div className="p-6">Invalid URL.</div>;
  if (q.isLoading)    return <div className="p-6 text-muted-foreground">Loading…</div>;
  if (q.isError)      return <div className="p-6 text-red-500">{(q.error as Error).message}</div>;
  if (!q.data)        return <div className="p-6">Not found.</div>;

  const d = q.data;
  const po = d.po;

  // Derived summary metrics
  const totalProducts = d.line_items.length;
  const totalUnitsOrdered = d.line_items.reduce((s, li) => s + Number(li.qty_ordered), 0);
  const totalUnitsReceived = d.line_items.reduce((s, li) => s + Number(li.qty_received ?? 0), 0);
  const totalRefund = d.line_items.reduce((s, li) => s + n(li.refund_amount), 0);
  // Weighted GC discount % across this PO: sum(amount_used × discount%) / order_total
  const gcWeightedPct = (() => {
    const orderTotal = n(po.order_total);
    if (!(orderTotal > 0) || d.gift_cards.length === 0) return 0;
    const value = d.gift_cards.reduce((s, g) => s + n(g.amount_used) * n(g.discount_percentage) / 100, 0);
    return value / orderTotal * 100;
  })();

  return (
    <div className="px-6 py-4 space-y-4 max-w-7xl mx-auto">
      {/* Top bar */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Link href="/purchase-orders"><Button variant="ghost" size="sm"><ArrowLeft className="h-4 w-4 mr-1" /> Back</Button></Link>
          <div>
            <h1 className="text-2xl font-semibold inline-flex items-center gap-3">
              <span className="font-mono">{po.order_id}</span>
              <Badge className={PO_STATUS_BADGE[po.status]}>{po.status}</Badge>
            </h1>
            <p className="text-xs text-muted-foreground">{po.supplier} · {fmtDate(po.order_date)}</p>
          </div>
        </div>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="outline" className="border-red-300 text-red-600 hover:bg-red-50 dark:hover:bg-red-950">
              <Trash2 className="h-4 w-4 mr-1" /> Delete PO
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete this purchase order?</AlertDialogTitle>
              <AlertDialogDescription>
                This removes the PO and all its line items, po_asins, and gift card links. The underlying gift_cards
                themselves are NOT deleted. This cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => removePo.mutate()} className="bg-red-600 hover:bg-red-700">Delete</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>

      {d.refund_warning?.warning && (
        <Card className="p-3 border-amber-500/50 bg-amber-50/50 dark:bg-amber-950/30 text-amber-800 dark:text-amber-200 text-sm inline-flex items-center gap-2">
          <AlertTriangle className="h-4 w-4" /> {d.refund_warning.message}
        </Card>
      )}

      {/* Two columns: order details + summary cards */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2">
          <OrderDetailsCard detail={d} />
        </div>
        <div className="space-y-3">
          <SummaryCard label="Total Products" value={totalProducts.toString()} />
          <SummaryCard label="Units Ordered"  value={totalUnitsOrdered.toString()} />
          <SummaryCard label="Units Received" value={totalUnitsReceived.toString()} sub={`of ${totalUnitsOrdered}`} />
          <SummaryCard label="Total Refund"   value={fmt(po.refund ?? 0)} sub={`Line sum: ${fmt(totalRefund)}${po.refund_manual_override ? " · manual override" : ""}`} />
          <SummaryCard label="Weighted GC Discount" value={`${gcWeightedPct.toFixed(2)}%`} />
        </div>
      </div>

      {/* Gift cards used */}
      <Card className="p-4">
        <h3 className="text-sm font-semibold mb-2">Gift cards on this PO</h3>
        {d.gift_cards.length === 0
          ? <p className="text-sm text-muted-foreground">None.</p>
          : (
            <div className="space-y-1">
              {d.gift_cards.map(g => (
                <div key={g.link_id} className="flex items-center justify-between text-sm border rounded px-3 py-2">
                  <div>
                    <span className="font-mono">{g.card_number}</span>
                    <span className="text-muted-foreground ml-2">@ {n(g.discount_percentage).toFixed(2)}% off</span>
                  </div>
                  <div className="font-mono">{fmt(g.amount_used)} used</div>
                </div>
              ))}
            </div>
          )
        }
        <p className="text-xs text-muted-foreground mt-2">Edit gift cards via the order details panel (Edit → submit) — to be exposed inline in a later iteration.</p>
      </Card>

      {/* Line items */}
      <Card className="p-4 space-y-2">
        <h3 className="text-sm font-semibold">Line items</h3>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8"></TableHead>
                <TableHead>Product</TableHead>
                <TableHead className="font-mono">ASIN</TableHead>
                <TableHead className="text-right">Price</TableHead>
                <TableHead className="text-right">Ord.</TableHead>
                <TableHead className="text-right">Rec.</TableHead>
                <TableHead className="text-right">Canc.</TableHead>
                <TableHead className="text-right">Ret./Ref.</TableHead>
                <TableHead className="text-right">Refund $</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">COGS / unit</TableHead>
                <TableHead className="w-10"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {d.line_items.map(li => (
                <LineItemRow key={li.id} poId={id} li={li} />
              ))}
              {d.line_items.length === 0 && (
                <TableRow><TableCell colSpan={12} className="text-center text-muted-foreground py-6">No line items.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </Card>
    </div>
  );
}

function SummaryCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card className="p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-2xl font-semibold mt-0.5">{value}</div>
      {sub && <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>}
    </Card>
  );
}

function OrderDetailsCard({ detail }: { detail: PoDetail }) {
  const qc = useQueryClient();
  const po = detail.po;
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Partial<PoOrderFields>>({});

  const save = useMutation({
    mutationFn: (patch: Partial<PoOrderFields>) => updatePo(po.id, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["po-detail", po.id] });
      qc.invalidateQueries({ queryKey: ["pos"] });
      setEditing(false);
      setForm({});
    },
  });

  const get = <K extends keyof PoOrderFields>(k: K): any => (form[k] !== undefined ? form[k] : (po as any)[k]);
  const set = <K extends keyof PoOrderFields>(k: K, v: any) => setForm(f => ({ ...f, [k]: v }));

  if (!editing) {
    return (
      <Card className="p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Order details</h2>
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}><Pencil className="h-4 w-4 mr-1" /> Edit</Button>
        </div>
        <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
          <Row label="Order ID"     value={<span className="font-mono">{po.order_id}</span>} />
          <Row label="Date"         value={fmtDate(po.order_date)} />
          <Row label="Supplier"     value={po.supplier} />
          <Row label="Subtotal"     value={fmt(po.order_subtotal)} />
          <Row label="Shipping"     value={fmt(po.shipping_cost ?? 0)} />
          <Row label="Tax"          value={fmt(po.tax ?? 0)} />
          <Row label="Order disc."  value={po.order_discount ? `${n(po.order_discount).toFixed(2)} ${po.order_discount_type ?? ""}` : "—"} />
          <Row label="Order total"  value={fmt(po.order_total)} />
          <Row label="Refund"       value={`${fmt(po.refund ?? 0)}${po.refund_manual_override ? " (manual)" : ""}`} />
          <Row label="Tracking"     value={po.tracking_number ?? "—"} />
          <Row label="Payment"      value={po.payment_method ?? "—"} />
          <Row label="Purchased by" value={po.purchased_by ?? "—"} />
          <Row label="Cashback"     value={po.cashback_website ? `${po.cashback_website} · ${n(po.cashback_percentage).toFixed(2)}%` : "—"} />
          <Row label="Subscription" value={po.is_subscription ? `${po.subscription_frequency ?? "?"} · next ${fmtDate(po.subscription_next_order_date)}` : "No"} />
          <Row label="Disc. notes"  value={po.discount_description ?? "—"} className="col-span-2" />
          <Row label="General notes" value={po.general_notes ?? "—"} className="col-span-2" />
        </div>
      </Card>
    );
  }

  return (
    <Card className="p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Edit order details</h2>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => { setEditing(false); setForm({}); }}><X className="h-4 w-4 mr-1" /> Cancel</Button>
          <Button size="sm" disabled={save.isPending || Object.keys(form).length === 0} onClick={() => save.mutate(form)}>
            <Save className="h-4 w-4 mr-1" /> {save.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
      {save.isError && <p className="text-sm text-red-500">{(save.error as Error).message}</p>}
      <div className="grid grid-cols-2 gap-3 text-sm">
        <Field label="Order ID">      <Input value={get("order_id") ?? ""} onChange={e => set("order_id", e.target.value)} /></Field>
        <Field label="Order Date">    <Input type="date" value={(get("order_date") ?? "").slice(0,10)} onChange={e => set("order_date", e.target.value)} /></Field>
        <Field label="Supplier">      <Input value={get("supplier") ?? ""} onChange={e => set("supplier", e.target.value)} /></Field>
        <Field label="Subtotal">      <Input type="number" step="0.01" value={get("order_subtotal") ?? ""} onChange={e => set("order_subtotal", parseFloat(e.target.value) || 0)} /></Field>
        <Field label="Shipping">      <Input type="number" step="0.01" value={get("shipping_cost") ?? ""} onChange={e => set("shipping_cost", parseFloat(e.target.value) || 0)} /></Field>
        <Field label="Tax">           <Input type="number" step="0.01" value={get("tax") ?? ""} onChange={e => set("tax", parseFloat(e.target.value) || 0)} /></Field>
        <Field label="Order Discount $/%"><Input value={get("order_discount") ?? 0} type="number" step="0.01" onChange={e => set("order_discount", parseFloat(e.target.value) || 0)} /></Field>
        <Field label="Discount Type">
          <Select value={get("order_discount_type") ?? "_none"} onValueChange={v => set("order_discount_type", v === "_none" ? null : v)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="_none">none</SelectItem>
              <SelectItem value="percentage">percentage</SelectItem>
              <SelectItem value="dollar">dollar</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label="Order Total">   <Input type="number" step="0.01" value={get("order_total") ?? ""} onChange={e => set("order_total", parseFloat(e.target.value) || 0)} /></Field>
        <Field label="Refund">        <Input type="number" step="0.01" value={get("refund") ?? ""} onChange={e => set("refund", parseFloat(e.target.value) || 0)} /></Field>
        <Field label="Refund manual override?">
          <label className="flex items-center gap-2 text-sm pt-2 cursor-pointer">
            <Checkbox checked={!!get("refund_manual_override")} onCheckedChange={v => set("refund_manual_override", !!v)} />
            Override line-item sum
          </label>
        </Field>
        <Field label="Tracking">      <Input value={get("tracking_number") ?? ""} onChange={e => set("tracking_number", e.target.value)} /></Field>
        <Field label="Payment Method"><Input value={get("payment_method") ?? ""} onChange={e => set("payment_method", e.target.value)} /></Field>
        <Field label="Purchased by">  <Input value={get("purchased_by") ?? ""} onChange={e => set("purchased_by", e.target.value)} /></Field>
        <Field label="Cashback site">
          <Select value={get("cashback_website") ?? "_none"} onValueChange={v => set("cashback_website", v === "_none" ? null : v)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="_none">None</SelectItem>
              <SelectItem value="BeFrugal">BeFrugal</SelectItem>
              <SelectItem value="TopCashback">TopCashback</SelectItem>
              <SelectItem value="Rakuten">Rakuten</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label="Cashback %">    <Input type="number" step="0.01" value={get("cashback_percentage") ?? ""} onChange={e => set("cashback_percentage", parseFloat(e.target.value) || 0)} /></Field>
        <Field label="Internal Email"><Input value={get("internal_email") ?? ""} onChange={e => set("internal_email", e.target.value)} /></Field>
        <div className="col-span-2"><Field label="Discount Description"><Input value={get("discount_description") ?? ""} onChange={e => set("discount_description", e.target.value)} /></Field></div>
        <div className="col-span-2"><Field label="General notes"><Textarea rows={2} value={get("general_notes") ?? ""} onChange={e => set("general_notes", e.target.value)} /></Field></div>
      </div>
    </Card>
  );
}

function LineItemRow({ poId, li }: { poId: string; li: PoDetailLineItem }) {
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState(false);

  const patch = useMutation({
    mutationFn: (p: any) => updateLineItem(poId, li.id, p),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["po-detail", poId] });
      qc.invalidateQueries({ queryKey: ["pos"] });
    },
  });

  const remove = useMutation({
    mutationFn: () => deleteLineItem(poId, li.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["po-detail", poId] });
      qc.invalidateQueries({ queryKey: ["pos"] });
    },
  });

  const numericBlur = (field: keyof PoDetailLineItem, val: string, current: any) => {
    const parsed = val === "" ? 0 : parseFloat(val);
    if (!Number.isFinite(parsed)) return;
    if (parsed === Number(current)) return;
    patch.mutate({ [field]: parsed });
  };

  // Derive prep cost from result: cogs = adjusted/aqpp + prep → prep = cogs - adjusted/aqpp.
  const aqpp = n(li.asin_qty_per_product) || 1;
  const adjustedPerUnit = n(li.adjusted_product_cost) / aqpp;
  const prepPerUnit = n(li.cogs_per_asin_unit) - adjustedPerUnit;

  return (
    <>
      <TableRow className={patch.isPending ? "opacity-60" : ""}>
        <TableCell className="w-8">
          <button onClick={() => setExpanded(v => !v)} className="text-muted-foreground hover:text-foreground" title="COGS breakdown">
            {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </button>
        </TableCell>
        <TableCell className="max-w-[260px]">
          <div className="truncate">{li.product_name}</div>
          {li.sku && <div className="text-xs text-muted-foreground font-mono">{li.sku}</div>}
        </TableCell>
        <TableCell className="font-mono text-xs">{li.asin}</TableCell>
        <TableCell className="text-right font-mono text-sm">{fmt(li.product_price)}</TableCell>
        <TableCell className="text-right font-mono text-sm">{n(li.qty_ordered)}</TableCell>
        <TableCell className="text-right">
          <Input className="text-right h-7 w-16 ml-auto" type="number" min="0" defaultValue={n(li.qty_received)}
                 onBlur={e => numericBlur("qty_received", e.target.value, li.qty_received)} />
        </TableCell>
        <TableCell className="text-right">
          <Input className="text-right h-7 w-16 ml-auto" type="number" min="0" defaultValue={n(li.qty_canceled)}
                 onBlur={e => numericBlur("qty_canceled", e.target.value, li.qty_canceled)} />
        </TableCell>
        <TableCell className="text-right">
          <Input className="text-right h-7 w-16 ml-auto" type="number" min="0" defaultValue={n(li.qty_returned_refunded)}
                 onBlur={e => numericBlur("qty_returned_refunded", e.target.value, li.qty_returned_refunded)} />
        </TableCell>
        <TableCell className="text-right">
          <Input className="text-right h-7 w-20 ml-auto" type="number" step="0.01" min="0" defaultValue={n(li.refund_amount)}
                 onBlur={e => numericBlur("refund_amount", e.target.value, li.refund_amount)} />
        </TableCell>
        <TableCell>
          <Select value={li.status} onValueChange={(v) => patch.mutate({ status: v })}>
            <SelectTrigger className="h-7 w-36"><SelectValue /></SelectTrigger>
            <SelectContent>
              {LI_STATUSES.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
            </SelectContent>
          </Select>
        </TableCell>
        <TableCell className="text-right font-mono text-sm">
          {li.cogs_per_asin_unit != null ? fmt(li.cogs_per_asin_unit) : "—"}
        </TableCell>
        <TableCell>
          <Button variant="ghost" size="icon" onClick={() => { if (confirm("Delete this line item?")) remove.mutate(); }} title="Delete">
            <Trash2 className="h-4 w-4" />
          </Button>
        </TableCell>
      </TableRow>

      {expanded && (
        <TableRow className="bg-muted/30 hover:bg-muted/30">
          <TableCell colSpan={12} className="py-3">
            <div className="pl-10 max-w-2xl">
              <h4 className="text-xs font-semibold text-muted-foreground mb-2">COGS breakdown · per ASIN unit</h4>
              <table className="text-sm w-full">
                <tbody>
                  <Row2 k="Product Price"               v={fmt(li.product_price)} />
                  <Row2 k={`Product Discount (${li.product_discount_type ?? "—"})`} v={li.product_discount ? `−${n(li.product_discount).toFixed(2)}` : "—"} />
                  <Row2 k="Adjusted Product Cost (post weighted order disc + tax + shipping − GC)" v={fmt(li.adjusted_product_cost ?? 0)} />
                  <Row2 k="÷ ASIN units per product"    v={aqpp.toFixed(3)} />
                  <Row2 k="Per-unit before prep"        v={fmt(adjustedPerUnit)} />
                  <Row2 k="+ Prep cost / unit"          v={fmt(prepPerUnit)} />
                  <Row2 k="= COGS / ASIN unit"          v={fmt(li.cogs_per_asin_unit ?? 0)} bold />
                  <Row2 k="Sourcing / ASIN unit (no prep, GC added back for Amazon submission)" v={fmt(li.sourcing_cost_per_asin_unit ?? 0)} bold />
                </tbody>
              </table>
              <p className="text-xs text-muted-foreground mt-2">
                Order-level allocations (weighted discount/tax/shipping/GC) are absorbed into Adjusted Product Cost.
                Live recompute happens server-side on every PO/LI mutation.
              </p>
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

function Row({ label, value, className }: { label: string; value: React.ReactNode; className?: string }) {
  return (
    <div className={className}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-sm">{value}</div>
    </div>
  );
}

function Row2({ k, v, bold }: { k: string; v: React.ReactNode; bold?: boolean }) {
  return (
    <tr className={`border-b border-border/30 ${bold ? "font-semibold" : ""}`}>
      <td className="py-1 pr-3 text-muted-foreground">{k}</td>
      <td className="py-1 text-right font-mono">{v}</td>
    </tr>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}
