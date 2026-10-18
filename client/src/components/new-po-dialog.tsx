/**
 * New PO form (patch docs/claude_spec-patch-po-af-owned.md §4). State is the
 * plain JSON PoFormState from shared/po-form.ts — the AI-prefill patch fills
 * that object and the form renders it. checkPoForm runs live here and again
 * on the server before anything is written.
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Plus, Trash2, AlertTriangle } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { MoneyCalcInput, calcMoney } from "@/components/money-calc-input";
import { checkPoForm, emptyPoForm, emptyProduct, SOLD_AS_OPTIONS, type PoFormState, type PoFormProduct } from "@shared/po-form";

const todayYmd = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const money = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

type Lookup = { asin: string; title: string | null; primary_sku: string | null; image_url: string | null };

/** ASIN input with a typeahead against AF's catalog (GET /api/pos/asin-lookup). */
function AsinTypeahead({ value, onChange, rowIndex, known }: { value: string; onChange: (v: string) => void; rowIndex: number; known: Map<string, Lookup> }) {
  const [opts, setOpts] = useState<Lookup[]>([]);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => {
    const q = value.trim();
    window.clearTimeout(timer.current);
    if (q.length < 2 || known.has(q.toUpperCase())) { setOpts([]); return; }
    timer.current = window.setTimeout(() => {
      fetch(`/api/pos/asin-lookup?q=${encodeURIComponent(q)}`).then((r) => r.json()).then((d) => {
        const rows: Lookup[] = d.rows ?? [];
        for (const r of rows) known.set(r.asin, r);
        setOpts(rows);
      }).catch(() => setOpts([]));
    }, 200);
    return () => window.clearTimeout(timer.current);
  }, [value, known]);
  const hit = known.get(value.trim().toUpperCase());
  return (
    <div className="min-w-[8rem]">
      <Input value={value} onChange={(e) => onChange(e.target.value.toUpperCase())} list={`asin-options-${rowIndex}`} placeholder="ASIN or title" className="h-8 font-mono text-xs" data-testid={`input-new-po-asin-${rowIndex}`} />
      <datalist id={`asin-options-${rowIndex}`}>
        {opts.map((o) => <option key={o.asin} value={o.asin}>{(o.title ?? "").slice(0, 80)}</option>)}
      </datalist>
      <div className="mt-0.5 truncate text-[10px] text-muted-foreground max-w-[14rem]" title={hit?.title ?? ""}>
        {hit ? (hit.title ?? "in catalog") : value.trim().length === 10 ? <span className="text-amber-600">not in AF's catalog</span> : ""}
      </div>
    </div>
  );
}

/** Every money field of the form with its expression calculated (shared/money-expr.ts). */
export function settleMoney(f: PoFormState): { ok: true; form: PoFormState } | { ok: false; error: string } {
  const one = (v: string): string => { const c = calcMoney(v); if (!c.ok) throw new Error(`"${v}": ${c.error}`); return c.text; };
  try {
    const out: PoFormState = { ...f, products: f.products.map((p) => ({ ...p, price: one(p.price), prep_cost: one(p.prep_cost) })), cost_overrides: Object.fromEntries(Object.entries(f.cost_overrides).map(([k, v]) => [k, one(v)])) };
    for (const k of ["subtotal", "tax", "sh_donations", "discount", "refund_amount", "order_total"] as const) out[k] = one(f[k]);
    return { ok: true, form: out };
  } catch (e: any) { return { ok: false, error: e.message }; }
}

export function NewPoDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (v: boolean) => void; onCreated: (poId: string) => void }) {
  const [form, setForm] = useState<PoFormState>(() => emptyPoForm(todayYmd()));
  const [busy, setBusy] = useState(false);
  const [serverErr, setServerErr] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const known = useMemo(() => new Map<string, Lookup>(), []);
  useEffect(() => { if (open) { setForm(emptyPoForm(todayYmd())); setServerErr(null); setTouched(false); } }, [open]);
  const check = useMemo(() => checkPoForm(form), [form]);

  const set = (k: keyof PoFormState, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const setP = (i: number, k: keyof PoFormProduct, v: string) => setForm((f) => {
    const products = f.products.map((p, j) => {
      if (j !== i) return p;
      const next = { ...p, [k]: v } as PoFormProduct;
      if (k === "sold_as" && v === "individual") next.units_per_pack = "1";
      if (k === "sold_as" && v === "multi-pack" && (next.units_per_pack === "1" || next.units_per_pack === "")) next.units_per_pack = "2";
      return next;
    });
    return { ...f, products };
  });
  const addP = () => setForm((f) => ({ ...f, products: [...f.products, emptyProduct()] }));
  const delP = (i: number) => setForm((f) => ({ ...f, products: f.products.filter((_, j) => j !== i) }));
  const setOverride = (asin: string, v: string) => setForm((f) => ({ ...f, cost_overrides: { ...f.cost_overrides, [asin]: v } }));

  const save = async () => {
    setTouched(true); setServerErr(null);
    // A money field still holding an expression (typed, not yet blurred) is calculated first.
    const settled = settleMoney(form);
    if (!settled.ok) { setServerErr(`A money field can't be calculated: ${settled.error}`); return; }
    setForm(settled.form);
    if (!checkPoForm(settled.form).ok) return;
    setBusy(true);
    try {
      const res = await fetch("/api/pos", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(settled.form) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
      onOpenChange(false); onCreated(String(data.poId));
    } catch (e: any) { setServerErr(e.message); } finally { setBusy(false); }
  };

  const field = (k: keyof PoFormState, label: string, opts: { w?: string; type?: string; ph?: string; money?: boolean } = {}) => (
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground" htmlFor={`new-po-${k}`}>{label}</Label>
      {opts.money
        ? <MoneyCalcInput id={`new-po-${k}`} value={form[k] as string} onChange={(v) => set(k, v)} placeholder={opts.ph} className={`h-8 text-sm ${opts.w ?? ""}`} data-testid={`input-new-po-${k}`} />
        : <Input id={`new-po-${k}`} type={opts.type ?? "text"} value={form[k] as string} onChange={(e) => set(k, e.target.value)} placeholder={opts.ph} className={`h-8 text-sm ${opts.w ?? ""}`} data-testid={`input-new-po-${k}`} />}
    </div>
  );
  const th = "px-2 py-1.5 text-[11px] font-medium text-left whitespace-nowrap text-muted-foreground";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[min(96vw,80rem)] max-h-[92vh] overflow-y-auto" data-testid="new-po-dialog">
        <DialogHeader>
          <DialogTitle>New PO</DialogTitle>
          <DialogDescription>Creates the PO, its products and ASIN rows in AF. Sync POs never overwrites it.</DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {field("supplier", "Supplier", { ph: "walmart.com" })}
          {field("order_id", "Order #")}
          {field("order_date", "Order date", { type: "date" })}
          {field("purchased_by", "Purchased by")}
          {field("subtotal", "Subtotal", { ph: check.computedSubtotal.toFixed(2), money: true })}
          {field("tax", "Tax", { ph: "0.00", money: true })}
          {field("sh_donations", "S&H + Donations", { ph: "0.00", money: true })}
          {field("discount", "Discount", { ph: "0.00", money: true })}
          {field("refund_amount", "Refund amount", { ph: "0.00", money: true })}
          {field("order_total", "Order total", { ph: check.effectiveOrderTotal.toFixed(2), money: true })}
          {field("payment_method", "Payment method")}
          {field("weighted_gc_discount_pct", "Weighted GC %")}
          {field("cashback_site", "Cashback site")}
          {field("cashback_pct", "Cashback %")}
          <div className="space-y-1 col-span-2">
            <Label className="text-xs text-muted-foreground" htmlFor="new-po-notes">Notes</Label>
            <Textarea id="new-po-notes" value={form.notes} onChange={(e) => set("notes", e.target.value)} rows={1} data-testid="input-new-po-notes" />
          </div>
        </div>

        <div className="mt-4 space-y-2">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Products</div>
          <div className="overflow-x-auto rounded-md" style={{ border: "0.5px solid hsl(var(--border))" }}>
            <table className="w-full border-collapse text-sm" data-testid="new-po-products">
              <thead><tr className="bg-muted/40">
                <th className={th}>Product name</th><th className={th}>Supplier SKU</th><th className={th}>Price</th><th className={th}>Qty</th>
                <th className={th}>ASIN</th><th className={th}>Yield</th><th className={th}>Sold as</th><th className={th}>Units / pack</th><th className={th}>Prep</th><th className={th}></th>
              </tr></thead>
              <tbody>
                {form.products.map((p, i) => (
                  <React.Fragment key={i}>
                    <tr style={{ borderTop: "0.5px solid hsl(var(--border))" }} data-testid={`row-new-po-product-${i}`}>
                      <td className="px-2 py-1.5"><Input value={p.product_name} onChange={(e) => setP(i, "product_name", e.target.value)} className="h-8 text-xs min-w-[14rem]" data-testid={`input-new-po-product_name-${i}`} /></td>
                      <td className="px-2 py-1.5"><Input value={p.supplier_sku} onChange={(e) => setP(i, "supplier_sku", e.target.value)} className="h-8 text-xs w-28" data-testid={`input-new-po-supplier_sku-${i}`} /></td>
                      <td className="px-2 py-1.5"><MoneyCalcInput value={p.price} onChange={(v) => setP(i, "price", v)} className="h-8 text-xs w-20 text-right" data-testid={`input-new-po-price-${i}`} /></td>
                      <td className="px-2 py-1.5"><Input value={p.qty_ordered} onChange={(e) => setP(i, "qty_ordered", e.target.value)} inputMode="decimal" className="h-8 text-xs w-16 text-right" data-testid={`input-new-po-qty_ordered-${i}`} /></td>
                      <td className="px-2 py-1.5 align-top"><AsinTypeahead value={p.asin} onChange={(v) => setP(i, "asin", v)} rowIndex={i} known={known} /></td>
                      <td className="px-2 py-1.5"><Input value={p.asin_qty_per_product} onChange={(e) => setP(i, "asin_qty_per_product", e.target.value)} inputMode="decimal" className="h-8 text-xs w-16 text-right" data-testid={`input-new-po-yield-${i}`} /></td>
                      <td className="px-2 py-1.5">
                        <select value={p.sold_as} onChange={(e) => setP(i, "sold_as", e.target.value)} className="h-8 rounded border border-input bg-background px-1 text-xs" data-testid={`select-new-po-sold_as-${i}`}>
                          {SOLD_AS_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
                        </select>
                      </td>
                      <td className="px-2 py-1.5"><Input value={p.units_per_pack} disabled={p.sold_as === "individual"} onChange={(e) => setP(i, "units_per_pack", e.target.value)} inputMode="numeric" className="h-8 text-xs w-16 text-right" data-testid={`input-new-po-units_per_pack-${i}`} /></td>
                      <td className="px-2 py-1.5"><MoneyCalcInput value={p.prep_cost} onChange={(v) => setP(i, "prep_cost", v)} className="h-8 text-xs w-16 text-right" data-testid={`input-new-po-prep_cost-${i}`} /></td>
                      <td className="px-2 py-1.5"><button onClick={() => delP(i)} disabled={form.products.length === 1} className="text-muted-foreground/60 hover:text-destructive disabled:opacity-30" title="Remove product" data-testid={`button-new-po-remove-${i}`}><Trash2 className="h-3.5 w-3.5" /></button></td>
                    </tr>
                    {touched && check.productErrors[i] && (
                      <tr><td colSpan={10} className="px-2 pb-1.5 text-xs text-destructive" data-testid={`new-po-product-error-${i}`}>{check.productErrors[i].join(" · ")}</td></tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
          <Button size="sm" variant="outline" onClick={addP} data-testid="button-new-po-add-product"><Plus className="h-3.5 w-3.5 mr-1" /> Add product</Button>
        </div>

        {check.asins.length > 0 && (
          <div className="mt-4 space-y-2">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">ASIN rows this PO will create</div>
            <table className="text-sm" data-testid="new-po-asin-summary">
              <thead><tr>
                <th className={th}>ASIN</th><th className={th}>Sold as</th><th className={`${th} text-right`}>Ordered</th><th className={`${th} text-right`}>Products</th>
                <th className={`${th} text-right`}>Cost / unit</th><th className={th}></th>
              </tr></thead>
              <tbody>
                {check.asins.map((a) => (
                  <tr key={a.asin} data-testid={`row-new-po-asin-${a.asin}`}>
                    <td className="px-2 py-1 font-mono text-xs">{a.asin}</td>
                    <td className="px-2 py-1 text-xs">{a.sold_as}{a.sold_as !== "individual" ? ` × ${a.units_per_pack}` : ""}</td>
                    <td className="px-2 py-1 text-right">{a.qty}</td>
                    <td className="px-2 py-1 text-right">{a.lines.length}</td>
                    <td className="px-2 py-1 text-right">
                      <MoneyCalcInput value={form.cost_overrides[a.asin] ?? ""} onChange={(v) => setOverride(a.asin, v)} placeholder={a.computed_cost_per_unit ?? "—"} className="h-7 w-24 text-right text-xs" data-testid={`input-new-po-cost-${a.asin}`} />
                    </td>
                    <td className="px-2 py-1 text-[10px] text-muted-foreground">{form.cost_overrides[a.asin] ? "typed" : "from price × total ÷ subtotal × (1 − GC %)"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-6 rounded-md px-3 py-2 text-sm" style={{ border: "0.5px solid hsl(var(--border))" }} data-testid="new-po-totals">
          <div><span className="text-muted-foreground mr-1.5">Subtotal (Σ price × qty)</span><span className="font-mono">{money(check.computedSubtotal)}</span></div>
          <div><span className="text-muted-foreground mr-1.5">Order total</span><span className="font-mono">{money(check.effectiveOrderTotal)}</span></div>
          <div><span className="text-muted-foreground mr-1.5">ASIN units</span><span>{check.asins.reduce((t, a) => t + a.qty, 0)}</span></div>
        </div>
        {check.warnings.map((w) => <p key={w} className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400"><AlertTriangle className="h-3.5 w-3.5" />{w}</p>)}
        {touched && check.errors.length > 0 && (
          <ul className="list-disc pl-5 text-xs text-destructive" data-testid="new-po-errors">{check.errors.map((e) => <li key={e}>{e}</li>)}</ul>
        )}
        {serverErr && <p className="text-sm text-destructive" data-testid="new-po-server-error">{serverErr}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button onClick={save} disabled={busy || (touched && !check.ok)} data-testid="button-new-po-save">{busy ? "Creating…" : "Create PO"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
