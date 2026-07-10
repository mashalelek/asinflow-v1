/**
 * PO Entry Form (/purchase-orders/new).
 *
 * Single-page form. Order-level fields up top, line items below. POSTs to
 * /api/pos in one shot (server wraps in a transaction + computes COGS per LI
 * via the shared engine). On success redirects to the new PO's detail page.
 *
 * MVP simplifications (deliberate, flagged in Phase 3 close-out):
 *   - ASIN entry is a free-text input (validated as 10-char). No autocomplete
 *     across the 1.7k-item catalog yet; invalid ASINs are surfaced as FK errors.
 *   - Tags entered as comma-separated string.
 *   - Invoice upload field is disabled with a note (R2 creds not configured).
 *   - Gift card picker selects from existing Active gift_cards only; creating
 *     new gift cards from the PO form is deferred to a future GC module.
 */
import { useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter, DialogClose,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { createPo, listGiftCards, n, type LineItemFields, type DiscType, type GiftCard, type PoCreateBody } from "@/lib/po-api";
import { parseDiscount, formatDiscount } from "@/lib/parse-discount";

interface LineItemDraft {
  _key: string; // local client key only
  sku: string;
  product_name: string;
  product_price: string;
  discount_input: string; // raw smart-input string
  qty_ordered: string;
  asin: string;
  asin_qty_per_product: string;
  tax_exempt: boolean;
  expiration_date: string;
  tags: string; // comma-separated
  notes: string;
}

const blankLI = (): LineItemDraft => ({
  _key: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  sku: "", product_name: "", product_price: "", discount_input: "",
  qty_ordered: "1", asin: "", asin_qty_per_product: "1", tax_exempt: false,
  expiration_date: "", tags: "", notes: "",
});

const ASIN_RE = /^[A-Z0-9]{10}$/;
const today = () => new Date().toISOString().slice(0, 10);

export default function PoNew() {
  const [, setLoc] = useLocation();
  const qc = useQueryClient();

  // ─── Order-level state ─────────────────────────────────────────────────────
  const [orderId, setOrderId] = useState("");
  const [orderDate, setOrderDate] = useState(today());
  const [supplier, setSupplier] = useState("");
  const [orderSubtotal, setOrderSubtotal] = useState("");
  const [shipping, setShipping] = useState("0");
  const [tax, setTax] = useState("0");
  const [discountInput, setDiscountInput] = useState("");
  const [discountDesc, setDiscountDesc] = useState("");
  const [orderTotal, setOrderTotal] = useState("");
  const [cashbackSite, setCashbackSite] = useState<"BeFrugal" | "TopCashback" | "Rakuten" | "None" | "">("");
  const [cashbackPct, setCashbackPct] = useState("");
  const [tracking, setTracking] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("");
  const [purchasedBy, setPurchasedBy] = useState("");
  const [isSubscription, setIsSubscription] = useState(false);
  const [subFreq, setSubFreq] = useState("");
  const [subNextDate, setSubNextDate] = useState("");
  const [internalEmail, setInternalEmail] = useState("");
  const [generalNotes, setGeneralNotes] = useState("");

  // ─── Line items + gift cards ───────────────────────────────────────────────
  const [items, setItems] = useState<LineItemDraft[]>([blankLI()]);
  const [selectedGcs, setSelectedGcs] = useState<{ gift_card_id: string; amount_used: number; card_number: string; discount_percentage: number }[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Auto-compute order_total whenever the user hasn't manually overridden.
  const expectedTotal = useMemo(() => {
    const sub = parseFloat(orderSubtotal) || 0;
    const sh = parseFloat(shipping) || 0;
    const tx = parseFloat(tax) || 0;
    const d = parseDiscount(discountInput);
    const disc = d.type === "percentage" ? sub * d.amount / 100 : d.amount;
    return Math.max(0, sub + sh + tx - disc);
  }, [orderSubtotal, shipping, tax, discountInput]);

  const totalMismatch = orderTotal && Math.abs(parseFloat(orderTotal) - expectedTotal) > 0.01;

  const create = useMutation({
    mutationFn: (body: PoCreateBody) => createPo(body),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["pos"] });
      setLoc(`/purchase-orders/${data.po.id}`);
    },
    onError: (e: Error) => setError(e.message),
  });

  // ─── Submit ────────────────────────────────────────────────────────────────
  function buildBody(): PoCreateBody | string {
    if (!orderId.trim()) return "Order ID is required";
    if (!orderDate)      return "Order date is required";
    if (!supplier.trim()) return "Supplier is required";
    const sub = parseFloat(orderSubtotal);
    if (!Number.isFinite(sub) || sub <= 0) return "Order subtotal must be > 0";
    const tot = orderTotal ? parseFloat(orderTotal) : expectedTotal;
    if (!Number.isFinite(tot) || tot < 0) return "Order total must be ≥ 0";

    const cleaned: LineItemFields[] = [];
    for (let i = 0; i < items.length; i++) {
      const li = items[i];
      const name = li.product_name.trim();
      const price = parseFloat(li.product_price);
      const qty = parseInt(li.qty_ordered, 10);
      const asin = li.asin.trim().toUpperCase();
      const aqpp = parseFloat(li.asin_qty_per_product);
      if (!name) return `Line ${i + 1}: product name required`;
      if (!Number.isFinite(price) || price < 0) return `Line ${i + 1}: invalid product price`;
      if (!Number.isFinite(qty) || qty < 1) return `Line ${i + 1}: qty must be ≥ 1`;
      if (!ASIN_RE.test(asin)) return `Line ${i + 1}: ASIN must be 10 uppercase alphanumeric characters`;
      if (!Number.isFinite(aqpp) || aqpp <= 0) return `Line ${i + 1}: ASIN qty per product must be > 0`;

      const liDisc = parseDiscount(li.discount_input);
      cleaned.push({
        sku: li.sku.trim() || null,
        product_name: name,
        product_price: price,
        product_discount: liDisc.amount,
        product_discount_type: liDisc.amount ? liDisc.type : null,
        qty_ordered: qty,
        asin,
        asin_qty_per_product: aqpp,
        tax_exempt: li.tax_exempt,
        expiration_date: li.expiration_date || null,
        tags: li.tags.trim() ? li.tags.split(",").map(t => t.trim()).filter(Boolean) : null,
        notes: li.notes.trim() || null,
      });
    }

    const orderDisc = parseDiscount(discountInput);
    const body: PoCreateBody = {
      order_id: orderId.trim(),
      order_date: orderDate,
      supplier: supplier.trim(),
      order_subtotal: sub,
      shipping_cost: parseFloat(shipping) || 0,
      tax: parseFloat(tax) || 0,
      order_discount: orderDisc.amount,
      order_discount_type: orderDisc.amount ? orderDisc.type : null,
      discount_description: discountDesc.trim() || null,
      order_total: tot,
      cashback_website: cashbackSite || null,
      cashback_percentage: parseFloat(cashbackPct) || 0,
      tracking_number: tracking.trim() || null,
      payment_method: paymentMethod.trim() || null,
      purchased_by: purchasedBy.trim() || null,
      is_subscription: isSubscription,
      subscription_frequency: isSubscription ? (subFreq.trim() || null) : null,
      subscription_next_order_date: isSubscription ? (subNextDate || null) : null,
      internal_email: internalEmail.trim() || null,
      general_notes: generalNotes.trim() || null,
      line_items: cleaned,
      gift_cards: selectedGcs.map(g => ({ gift_card_id: g.gift_card_id, amount_used: g.amount_used })),
    };
    return body;
  }

  function onSubmit() {
    setError(null);
    const built = buildBody();
    if (typeof built === "string") { setError(built); return; }
    create.mutate(built);
  }

  // ─── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="px-6 py-4 space-y-4 max-w-7xl mx-auto">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Link href="/purchase-orders"><Button variant="ghost" size="sm"><ArrowLeft className="h-4 w-4 mr-1" /> Back</Button></Link>
          <h1 className="text-2xl font-semibold">New Purchase Order</h1>
        </div>
        <div className="flex gap-2">
          <Link href="/purchase-orders"><Button variant="outline">Cancel</Button></Link>
          <Button onClick={onSubmit} disabled={create.isPending} className="bg-stone-700 hover:bg-stone-800 text-white">
            {create.isPending ? "Saving…" : "Save PO"}
          </Button>
        </div>
      </div>

      {error && (
        <Card className="p-3 border-red-500/50 bg-red-50/50 dark:bg-red-950/30 text-red-700 dark:text-red-300 text-sm">
          {error}
        </Card>
      )}

      {/* ─── Order-level fields ───────────────────────────────────── */}
      <Card className="p-4 space-y-4">
        <h2 className="text-lg font-semibold">Order details</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <Field label="Order ID *"><Input value={orderId} onChange={e => setOrderId(e.target.value)} placeholder="e.g., 112-1234567-1234567" /></Field>
          <Field label="Order Date *"><Input type="date" value={orderDate} onChange={e => setOrderDate(e.target.value)} /></Field>
          <Field label="Supplier *"><Input value={supplier} onChange={e => setSupplier(e.target.value)} placeholder="Walmart, Target, …" /></Field>

          <Field label="Order Subtotal *"><Input type="number" step="0.01" value={orderSubtotal} onChange={e => setOrderSubtotal(e.target.value)} placeholder="0.00" /></Field>
          <Field label="Shipping"><Input type="number" step="0.01" value={shipping} onChange={e => setShipping(e.target.value)} /></Field>
          <Field label="Tax"><Input type="number" step="0.01" value={tax} onChange={e => setTax(e.target.value)} /></Field>

          <Field label="Order Discount" hint='Type "15%" or "$25"'>
            <Input value={discountInput}
              onChange={e => setDiscountInput(e.target.value)}
              onBlur={() => {
                const p = parseDiscount(discountInput);
                setDiscountInput(formatDiscount(p.amount, p.type));
              }}
              placeholder="e.g., 15% or $25" />
          </Field>
          <Field label="Discount Description"><Input value={discountDesc} onChange={e => setDiscountDesc(e.target.value)} placeholder="optional" /></Field>
          <Field label="Order Total *" hint={`Expected: $${expectedTotal.toFixed(2)}`}>
            <Input type="number" step="0.01" value={orderTotal}
              onChange={e => setOrderTotal(e.target.value)}
              onBlur={() => { if (!orderTotal) setOrderTotal(expectedTotal.toFixed(2)); }}
              placeholder={expectedTotal.toFixed(2)} />
            {totalMismatch && (
              <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">⚠ doesn't match subtotal + shipping + tax − discount</p>
            )}
          </Field>

          <Field label="Tracking #"><Input value={tracking} onChange={e => setTracking(e.target.value)} /></Field>
          <Field label="Payment Method"><Input value={paymentMethod} onChange={e => setPaymentMethod(e.target.value)} placeholder="Credit Card" /></Field>
          <Field label="Purchased By"><Input value={purchasedBy} onChange={e => setPurchasedBy(e.target.value)} /></Field>

          <Field label="Cashback Site">
            <Select value={cashbackSite || "_none"} onValueChange={v => setCashbackSite(v === "_none" ? "" : v as any)}>
              <SelectTrigger><SelectValue placeholder="None" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="_none">None</SelectItem>
                <SelectItem value="BeFrugal">BeFrugal</SelectItem>
                <SelectItem value="TopCashback">TopCashback</SelectItem>
                <SelectItem value="Rakuten">Rakuten</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Cashback %"><Input type="number" step="0.01" value={cashbackPct} onChange={e => setCashbackPct(e.target.value)} /></Field>
          <Field label="Internal Email"><Input value={internalEmail} onChange={e => setInternalEmail(e.target.value)} /></Field>
        </div>

        <div className="flex flex-wrap items-center gap-4 pt-2 border-t">
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <Checkbox checked={isSubscription} onCheckedChange={v => setIsSubscription(!!v)} />
            Subscription
          </label>
          {isSubscription && (
            <>
              <Input className="w-44" placeholder="Frequency (e.g., Monthly)" value={subFreq} onChange={e => setSubFreq(e.target.value)} />
              <Input className="w-44" type="date" value={subNextDate} onChange={e => setSubNextDate(e.target.value)} />
            </>
          )}
          <div className="flex-1" />
          <div className="text-xs text-muted-foreground italic">Invoice upload: R2 not yet configured (deferred)</div>
        </div>

        <Field label="General notes">
          <Textarea value={generalNotes} onChange={e => setGeneralNotes(e.target.value)} rows={2} placeholder="optional" />
        </Field>
      </Card>

      {/* ─── Gift cards ────────────────────────────────────────────────── */}
      <Card className="p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Gift cards used</h2>
          <GiftCardPicker
            already={selectedGcs.map(g => g.gift_card_id)}
            onAdd={(g, amt) => setSelectedGcs(curr => [
              ...curr,
              { gift_card_id: g.id, amount_used: amt, card_number: g.card_number, discount_percentage: Number(g.discount_percentage) },
            ])}
          />
        </div>
        {selectedGcs.length === 0
          ? <p className="text-sm text-muted-foreground">None added.</p>
          : (
            <div className="space-y-1">
              {selectedGcs.map((g, i) => (
                <div key={g.gift_card_id} className="flex items-center justify-between text-sm border rounded px-3 py-2">
                  <div>
                    <span className="font-mono">{g.card_number}</span>
                    <span className="text-muted-foreground ml-2">@ {g.discount_percentage.toFixed(2)}% off</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="font-mono">${g.amount_used.toFixed(2)} used</span>
                    <Button variant="ghost" size="icon" onClick={() => setSelectedGcs(curr => curr.filter((_, j) => j !== i))} title="Remove">
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )
        }
      </Card>

      {/* ─── Line items ────────────────────────────────────────────────── */}
      <Card className="p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Line items</h2>
          <Button variant="outline" size="sm" onClick={() => setItems(curr => [...curr, blankLI()])}>
            <Plus className="h-4 w-4 mr-1" /> Add Product
          </Button>
        </div>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-32">SKU</TableHead>
                <TableHead className="min-w-[200px]">Product Name *</TableHead>
                <TableHead className="w-24 text-right">Price *</TableHead>
                <TableHead className="w-32">Discount</TableHead>
                <TableHead className="w-20 text-right">Qty *</TableHead>
                <TableHead className="w-32">ASIN *</TableHead>
                <TableHead className="w-24 text-right">ASINs / unit *</TableHead>
                <TableHead className="w-16 text-center">Tax-exempt</TableHead>
                <TableHead className="w-36">Expires</TableHead>
                <TableHead className="w-40">Tags (comma-sep)</TableHead>
                <TableHead className="w-10"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((li, idx) => (
                <TableRow key={li._key}>
                  <TableCell><Input value={li.sku} onChange={e => updateItem(setItems, idx, "sku", e.target.value)} /></TableCell>
                  <TableCell><Input value={li.product_name} onChange={e => updateItem(setItems, idx, "product_name", e.target.value)} /></TableCell>
                  <TableCell><Input type="number" step="0.01" className="text-right" value={li.product_price} onChange={e => updateItem(setItems, idx, "product_price", e.target.value)} /></TableCell>
                  <TableCell>
                    <Input value={li.discount_input}
                      onChange={e => updateItem(setItems, idx, "discount_input", e.target.value)}
                      onBlur={() => {
                        const p = parseDiscount(li.discount_input);
                        updateItem(setItems, idx, "discount_input", formatDiscount(p.amount, p.type));
                      }}
                      placeholder='e.g., 5% or $2' />
                  </TableCell>
                  <TableCell><Input type="number" min="1" className="text-right" value={li.qty_ordered} onChange={e => updateItem(setItems, idx, "qty_ordered", e.target.value)} /></TableCell>
                  <TableCell><Input value={li.asin} className="font-mono" onChange={e => updateItem(setItems, idx, "asin", e.target.value.toUpperCase())} placeholder="B0XXXXXXXX" maxLength={10} /></TableCell>
                  <TableCell><Input type="number" step="0.001" min="0.001" className="text-right" value={li.asin_qty_per_product} onChange={e => updateItem(setItems, idx, "asin_qty_per_product", e.target.value)} /></TableCell>
                  <TableCell className="text-center"><Checkbox checked={li.tax_exempt} onCheckedChange={v => updateItem(setItems, idx, "tax_exempt", !!v)} /></TableCell>
                  <TableCell><Input type="date" value={li.expiration_date} onChange={e => updateItem(setItems, idx, "expiration_date", e.target.value)} /></TableCell>
                  <TableCell><Input value={li.tags} onChange={e => updateItem(setItems, idx, "tags", e.target.value)} placeholder="organic, hot" /></TableCell>
                  <TableCell>
                    <Button variant="ghost" size="icon" disabled={items.length === 1} onClick={() => setItems(curr => curr.filter((_, j) => j !== idx))} title="Remove">
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </Card>
    </div>
  );
}

function updateItem(setItems: React.Dispatch<React.SetStateAction<LineItemDraft[]>>, idx: number, key: keyof LineItemDraft, val: any) {
  setItems(curr => curr.map((li, i) => i === idx ? { ...li, [key]: val } : li));
}

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div>
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground mt-0.5">{hint}</p>}
    </div>
  );
}

function GiftCardPicker({ already, onAdd }: {
  already: string[];
  onAdd: (gc: GiftCard, amount: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string>("");
  const [amount, setAmount] = useState("");

  const q = useQuery({
    queryKey: ["gift-cards", "Active"],
    queryFn: () => listGiftCards("Active"),
    enabled: open,
  });

  const selected = q.data?.rows.find(g => g.id === selectedId);

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (v) { setSelectedId(""); setAmount(""); } }}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm"><Plus className="h-4 w-4 mr-1" /> Add Gift Card</Button>
      </DialogTrigger>
      <DialogContent className="max-w-xl">
        <DialogHeader><DialogTitle>Add gift card to PO</DialogTitle></DialogHeader>
        <div className="space-y-3">
          {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
          {q.data && q.data.rows.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No Active gift cards. Add gift cards via the Gift Cards module first (not yet built — uses the gift_cards table directly).
            </p>
          )}
          {q.data && q.data.rows.length > 0 && (
            <>
              <div className="max-h-72 overflow-y-auto border rounded">
                <table className="text-sm w-full">
                  <thead className="bg-muted text-muted-foreground sticky top-0">
                    <tr>
                      <th className="text-left p-2"></th>
                      <th className="text-left p-2">Card #</th>
                      <th className="text-right p-2">Face</th>
                      <th className="text-right p-2">Paid</th>
                      <th className="text-right p-2">% off</th>
                      <th className="text-right p-2">Balance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {q.data.rows.map(gc => {
                      const used = already.includes(gc.id);
                      return (
                        <tr key={gc.id} className={`border-t hover:bg-muted/40 cursor-pointer ${used ? "opacity-40" : ""}`}
                            onClick={() => !used && setSelectedId(gc.id)}>
                          <td className="p-2">
                            <input type="radio" disabled={used} checked={selectedId === gc.id} onChange={() => setSelectedId(gc.id)} />
                          </td>
                          <td className="p-2 font-mono">{gc.card_number}</td>
                          <td className="p-2 text-right font-mono">${n(gc.face_value).toFixed(2)}</td>
                          <td className="p-2 text-right font-mono">${n(gc.amount_paid).toFixed(2)}</td>
                          <td className="p-2 text-right font-mono">{n(gc.discount_percentage).toFixed(2)}%</td>
                          <td className="p-2 text-right font-mono">${n(gc.current_balance).toFixed(2)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {selected && (
                <div className="flex items-end gap-2">
                  <div className="flex-1">
                    <Label className="text-xs text-muted-foreground">Amount used (≤ balance ${n(selected.current_balance).toFixed(2)})</Label>
                    <Input type="number" step="0.01" min="0.01" max={n(selected.current_balance)} value={amount}
                           onChange={e => setAmount(e.target.value)} placeholder="0.00" />
                  </div>
                </div>
              )}
            </>
          )}
        </div>
        <DialogFooter>
          <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
          <Button
            disabled={!selected || !(parseFloat(amount) > 0) || parseFloat(amount) > n(selected?.current_balance)}
            onClick={() => {
              if (selected) {
                onAdd(selected, parseFloat(amount));
                setOpen(false);
              }
            }}
          >
            Add
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
