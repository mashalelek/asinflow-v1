/**
 * New PO form (patch docs/claude_spec-patch-po-af-owned.md §4; Capture PO
 * patch docs/claude_spec-patch-po-ai-prefill.md §6, 2026-10-31). State is the
 * plain JSON PoFormState from shared/po-form.ts — the extension's prefill
 * fills that object and the form renders it. checkPoForm runs live here and
 * again on the server before anything is written.
 *
 * §6.1 markers: every field shows where its value came from — amber ring =
 * the model (captured pages), stone ring = AF's database (set once an ASIN is
 * chosen), none = typed. Editing a field clears its marker.
 * §6.3 lines: the retailer line as bought (name, SKU, qty, retailer
 * units / pack, unit price) with its ASIN row beneath; a bundle = several
 * lines → one ASIN; a split = "+ Add ASIN to this line" (a second line with
 * the same product, its own qty / ASIN).
 * §6.4 ASIN picker: history from the same supplier, then AF title matches,
 * then the model's guess (amber); "Not in AF — Add to AF" onboards it.
 * §6.5: ASIN qty = qty × retailer units ÷ ASIN units (editable); the three
 * costs with the allocation; a COGS adjustment with a reason; changing a
 * known ASIN's pack asks "This PO only" (default) or "Update ASIN in AF".
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Plus, Trash2, AlertTriangle, Split, Sparkles, Database, FileText } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { MoneyCalcInput, calcMoney } from "@/components/money-calc-input";
import { useAuth } from "@/contexts/auth-context";
import {
  checkPoForm, emptyPoForm, emptyProduct, emptyPromo, emptyPayment, shipsToFromForm, yieldFromPacks, promoCountsByDefault,
  SOLD_AS_OPTIONS, PROMO_TYPES, PAYMENT_METHODS, CASHBACK_STATUSES,
  type PoFormState, type PoFormProduct, type PoFormPromo, type PoFormPayment, type PoFormPrefill, type PrefillSource,
} from "@shared/po-form";

const todayYmd = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const money = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const r2 = (x: number) => Math.round(x * 100) / 100;

/** What GET /api/pos/prefill/:id returns (commit 4): the form values and where they came from. */
export interface PrefillResponse { form: Partial<PoFormState>; prefill: PoFormPrefill }

export interface AsinInfo {
  asin: string; title: string | null; primary_sku: string | null; image_url: string | null; brand: string | null;
  sold_as: string | null; units_per_pack: number | null; in_af: boolean;
  via?: "history_exact" | "history_tokens" | "title" | "search" | "model"; matched_name?: string | null; last_ordered?: string | null;
}

/** §6.1: the ring class for a field's source. */
export function markClass(src: PrefillSource | undefined): string {
  return src === "model" ? "ring-1 ring-amber-400/80" : src === "af" ? "ring-1 ring-stone-400/70" : "";
}

/** Every money field of the form with its expression calculated (shared/money-expr.ts). */
export function settleMoney(f: PoFormState): { ok: true; form: PoFormState } | { ok: false; error: string } {
  const one = (v: string): string => { const c = calcMoney(v); if (!c.ok) throw new Error(`"${v}": ${c.error}`); return c.text; };
  try {
    const out: PoFormState = {
      ...f,
      products: f.products.map((p) => ({ ...p, price: one(p.price), prep_cost: one(p.prep_cost) })),
      cost_overrides: Object.fromEntries(Object.entries(f.cost_overrides).map(([k, v]) => [k, one(v)])),
      cogs_adjustments: Object.fromEntries(Object.entries(f.cogs_adjustments ?? {}).map(([k, v]) => [k, { ...v, amount: one(v.amount) }])),
      promos: (f.promos ?? []).map((p) => ({ ...p, amount: one(p.amount) })),
      payments: (f.payments ?? []).map((p) => ({ ...p, amount: one(p.amount) })),
    };
    for (const k of ["subtotal", "tax", "sh_donations", "discount", "refund_amount", "order_total"] as const) out[k] = one(f[k]);
    return { ok: true, form: out };
  } catch (e: any) { return { ok: false, error: e.message }; }
}

// ── ASIN picker (§6.4) ───────────────────────────────────────────────────────
function viaLabel(v: AsinInfo["via"]): string {
  return v === "history_exact" ? "bought before (same name)" : v === "history_tokens" ? "bought before (similar name)" : v === "title" ? "title match" : v === "model" ? "model's guess" : "";
}
function AsinPicker({ value, product, supplier, guess, known, onPick, onChange, rowIndex, mark }: {
  value: string; product: string; supplier: string; guess: string | null; known: Map<string, AsinInfo>;
  onPick: (info: AsinInfo | null, asin: string) => void; onChange: (v: string) => void; rowIndex: number; mark: string;
}) {
  const [opts, setOpts] = useState<AsinInfo[]>([]);
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const q = value.trim();
  useEffect(() => {
    window.clearTimeout(timer.current);
    if (!open) return;
    timer.current = window.setTimeout(() => {
      const u = new URLSearchParams({ supplier, product, q: q.length >= 2 && !known.has(q.toUpperCase()) ? q : "" });
      fetch(`/api/pos/asin-suggest?${u}`).then((r) => r.json()).then((d) => {
        const rows: AsinInfo[] = d.rows ?? [];
        for (const r of rows) known.set(r.asin, r);
        if (guess && /^[A-Z0-9]{10}$/.test(guess) && !rows.some((r) => r.asin === guess)) rows.push({ asin: guess, title: null, primary_sku: null, image_url: null, brand: null, sold_as: null, units_per_pack: null, in_af: known.get(guess)?.in_af ?? false, via: "model" });
        setOpts(rows);
      }).catch(() => setOpts([]));
    }, 180);
    return () => window.clearTimeout(timer.current);
  }, [q, product, supplier, open, guess, known]);
  // A full ASIN typed or pasted: fetch its AF facts once.
  useEffect(() => {
    const a = q.toUpperCase();
    if (!/^[A-Z0-9]{10}$/.test(a) || known.has(a)) return;
    fetch(`/api/pos/asin-info/${a}`).then((r) => r.json()).then((d) => { known.set(a, d.info ?? { asin: a, title: null, primary_sku: null, image_url: null, brand: null, sold_as: null, units_per_pack: null, in_af: false }); onPick(d.info ?? null, a); }).catch(() => {});
  }, [q, known, onPick]);
  const hit = known.get(q.toUpperCase());
  const addToAf = async () => {
    setAdding(true);
    try {
      const r = await fetch("/api/pos/add-asin", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ asin: q.toUpperCase() }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.message || `HTTP ${r.status}`);
      if (d.info) { known.set(q.toUpperCase(), d.info); onPick(d.info, q.toUpperCase()); }
    } catch { /* the status line keeps "not in AF" */ } finally { setAdding(false); }
  };
  return (
    <div className="min-w-[11rem]">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Input value={value} onChange={(e) => { onChange(e.target.value.toUpperCase()); setOpen(true); }} onFocus={() => setOpen(true)} placeholder="ASIN, title, SKU…" className={`h-8 font-mono text-xs ${mark}`} data-testid={`input-new-po-asin-${rowIndex}`} autoComplete="off" />
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[28rem] p-1" onOpenAutoFocus={(e) => e.preventDefault()} data-testid={`asin-suggestions-${rowIndex}`}>
          {opts.length === 0 ? <div className="px-2 py-1.5 text-xs text-muted-foreground">{product.trim() ? "No suggestions yet — type an ASIN, title or SKU" : "Type an ASIN, title or SKU"}</div> : opts.map((o) => (
            <button key={o.asin} type="button" className="flex w-full items-start gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-muted" onClick={() => { onChange(o.asin); onPick(o, o.asin); setOpen(false); }} data-testid={`asin-suggestion-${o.asin}`}>
              {o.image_url ? <img src={o.image_url} alt="" className="h-8 w-8 rounded object-contain bg-white" /> : <div className="h-8 w-8 rounded bg-muted" />}
              <span className="min-w-0 flex-1">
                <span className="font-mono">{o.asin}</span>
                {o.via === "model" && <span className="ml-1.5 inline-flex items-center gap-0.5 rounded-sm bg-amber-500/15 px-1 text-[10px] text-amber-700 dark:text-amber-400"><Sparkles className="h-2.5 w-2.5" /> model's guess</span>}
                {o.via && o.via !== "model" && <span className="ml-1.5 text-[10px] text-muted-foreground">{viaLabel(o.via)}{o.last_ordered ? ` · ${o.last_ordered}` : ""}</span>}
                {!o.in_af && <span className="ml-1.5 text-[10px] text-amber-700 dark:text-amber-400">not in AF</span>}
                <span className="block truncate text-muted-foreground" title={o.title ?? o.matched_name ?? ""}>{o.title ?? o.matched_name ?? "—"}</span>
                {(o.sold_as || o.primary_sku) && <span className="block truncate text-[10px] text-muted-foreground">{[o.primary_sku, o.sold_as ? `${o.sold_as}${o.units_per_pack && o.units_per_pack > 1 ? ` × ${o.units_per_pack}` : ""}` : null].filter(Boolean).join(" · ")}</span>}
              </span>
            </button>
          ))}
        </PopoverContent>
      </Popover>
      <div className="mt-0.5 flex items-center gap-1 truncate text-[10px] text-muted-foreground max-w-[18rem]" title={hit?.title ?? ""}>
        {hit?.in_af ? <><Database className="h-2.5 w-2.5 shrink-0" />{hit.title ?? "in AF"}{hit.primary_sku ? ` · ${hit.primary_sku}` : ""}</>
          : q.length === 10 ? <><span className="text-amber-600">Not in AF</span><button type="button" onClick={addToAf} disabled={adding} className="underline" data-testid={`button-add-to-af-${rowIndex}`}>{adding ? "Adding…" : "— Add to AF"}</button></> : null}
      </div>
    </div>
  );
}

// ── Pack override (§6.5) ─────────────────────────────────────────────────────
function PackOverrideDialog({ ask, onChoose }: { ask: { asin: string; from: string; to: string } | null; onChoose: (updateAf: boolean) => void }) {
  const [choice, setChoice] = useState<"po" | "af">("po");
  useEffect(() => { if (ask) setChoice("po"); }, [ask]);
  return (
    <Dialog open={!!ask} onOpenChange={(v) => { if (!v) onChoose(false); }}>
      <DialogContent className="max-w-md" data-testid="pack-override-dialog">
        <DialogHeader>
          <DialogTitle>Pack size changed</DialogTitle>
          <DialogDescription>{ask ? `${ask.asin}: units / pack changed from AF's ${ask.from} to ${ask.to}. Apply to:` : ""}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2 text-sm">
          <label className="flex items-start gap-2"><input type="radio" name="pack-scope" checked={choice === "po"} onChange={() => setChoice("po")} data-testid="pack-override-po-only" /><span><b>This PO only</b> (default) — AF's ASIN keeps {ask?.from}.</span></label>
          <label className="flex items-start gap-2"><input type="radio" name="pack-scope" checked={choice === "af"} onChange={() => setChoice("af")} data-testid="pack-override-update-af" /><span><b>Update ASIN in AF</b> — writes the ASIN's pack fields (History row), brings every open PO's row to the new size and recomputes its ASIN qty / COGS; a Velocity order created with the old size shows "Pack size mismatch". Closed POs are untouched.</span></label>
        </div>
        <DialogFooter><Button onClick={() => onChoose(choice === "af")} data-testid="pack-override-ok">OK</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── The form ─────────────────────────────────────────────────────────────────
export function NewPoDialog({ open, onOpenChange, onCreated, prefill }: { open: boolean; onOpenChange: (v: boolean) => void; onCreated: (poId: string) => void; prefill?: PrefillResponse | null }) {
  const { user } = useAuth();
  const [form, setForm] = useState<PoFormState>(() => emptyPoForm(todayYmd()));
  const [busy, setBusy] = useState(false);
  const [serverErr, setServerErr] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const [shipsToEdited, setShipsToEdited] = useState(false);
  const [people, setPeople] = useState<{ users: Array<{ id: number; display_name: string }>; emails: string[] }>({ users: [], emails: [] });
  const [packAsk, setPackAsk] = useState<{ asin: string; from: string; to: string } | null>(null);
  const [rawOpen, setRawOpen] = useState(false);
  const known = useMemo(() => new Map<string, AsinInfo>(), []);

  useEffect(() => {
    if (!open) return;
    const base = emptyPoForm(todayYmd());
    const seeded: PoFormState = prefill ? { ...base, ...prefill.form, products: (prefill.form.products?.length ? prefill.form.products : base.products).map((p) => ({ ...emptyProduct(), ...p })), prefill: prefill.prefill } : base;
    if (!seeded.purchased_by_user_id && user) { seeded.purchased_by_user_id = String(user.id); seeded.purchased_by = user.displayName; }
    if (prefill?.prefill.sources && Object.keys(prefill.prefill.sources).some((k) => k === "ships_to")) setShipsToEdited(true); else setShipsToEdited(false);
    emailDefaultRef.current = seeded.prefill?.sources?.email_used === "af" ? (seeded.email_used ?? "") : "";
    setForm(seeded); setServerErr(null); setTouched(false); setRawOpen(false);
    fetch("/api/pos/purchasers").then((r) => r.json()).then((d) => setPeople({ users: d.users ?? [], emails: d.emails ?? [] })).catch(() => {});
  }, [open, prefill, user]);
  // Email used default per supplier (Maria 2026-11-01; GET /api/pos/email-default): fills an empty field, or one still holding
  // the previous supplier's default, with a stone marker; a typed or model-read email is left alone.
  const emailDefaultRef = useRef<string>("");
  useEffect(() => {
    if (!open) return;
    const s = form.supplier.trim();
    const t = window.setTimeout(() => {
      fetch(`/api/pos/email-default?supplier=${encodeURIComponent(s)}`).then((r) => r.json()).then((d) => {
        const email = typeof d?.email === "string" ? d.email : "";
        setForm((f) => {
          const cur = (f.email_used ?? "").trim();
          if (cur !== "" && cur !== emailDefaultRef.current) return f;
          emailDefaultRef.current = email;
          if (cur === email) return f;
          return setMark({ ...f, email_used: email }, "email_used", "af");
        });
      }).catch(() => {});
    }, 250);
    return () => window.clearTimeout(t);
  }, [open, form.supplier]);

  const shipsTo = shipsToEdited && (form.ships_to === "home" || form.ships_to === "velocity") ? form.ships_to : shipsToFromForm(form);
  const check = useMemo(() => checkPoForm(form), [form]);
  const sources = form.prefill?.sources ?? {};
  const mark = (key: string) => markClass(sources[key]);
  /** A server-side correction's tooltip on an amber field ("qty inferred from subtotal"); gone once the field is edited. */
  const hint = (key: string): string | undefined => form.prefill?.hints?.[key];
  const clearMark = (f: PoFormState, key: string): PoFormState => {
    if (!f.prefill?.sources?.[key] && !f.prefill?.hints?.[key]) return f;
    const next = { ...f.prefill!.sources }; delete next[key];
    const hints = { ...(f.prefill!.hints ?? {}) }; delete hints[key];
    return { ...f, prefill: { ...f.prefill!, sources: next, hints } };
  };
  const setMark = (f: PoFormState, key: string, src: PrefillSource): PoFormState => ({ ...f, prefill: { ...(f.prefill ?? { sources: {} }), sources: { ...(f.prefill?.sources ?? {}), [key]: src } } });

  const set = (k: keyof PoFormState, v: string) => setForm((f) => clearMark({ ...f, [k]: v }, String(k)));
  const setP = (i: number, k: keyof PoFormProduct, v: string | boolean) => setForm((f0) => {
    const f = clearMark(f0, `products.${i}.${String(k)}`);
    const products = f.products.map((p, j) => {
      if (j !== i) return p;
      const next = { ...p, [k]: v } as PoFormProduct;
      if (k === "sold_as" && v === "individual") next.units_per_pack = "1";
      if (k === "sold_as" && v === "multi-pack" && (next.units_per_pack === "1" || next.units_per_pack === "")) next.units_per_pack = "2";
      // §6.5 pack math keeps the yield in step until it is typed by hand.
      if (!next.yield_manual && ["retailer_units_per_pack", "units_per_pack", "sold_as"].includes(String(k))) next.asin_qty_per_product = yieldFromPacks(next.retailer_units_per_pack, next.units_per_pack, next.sold_as);
      return next;
    });
    return { ...f, products };
  });
  /** The ASIN qty of one line typed directly → yield = units ÷ qty, pinned. */
  const setLineAsinQty = (i: number, units: string) => setForm((f) => ({ ...f, products: f.products.map((p, j) => {
    if (j !== i) return p;
    const qty = Number(p.qty_ordered) || 0, u = Number(units);
    if (!(qty > 0) || !(u > 0)) return { ...p, yield_manual: true };
    return { ...p, yield_manual: true, asin_qty_per_product: String(Math.round((u / qty) * 10000) / 10000) };
  }) }));
  const resetYield = (i: number) => setForm((f) => ({ ...f, products: f.products.map((p, j) => j === i ? { ...p, yield_manual: false, asin_qty_per_product: yieldFromPacks(p.retailer_units_per_pack, p.units_per_pack, p.sold_as) } : p) }));
  const addP = () => setForm((f) => ({ ...f, products: [...f.products, emptyProduct()] }));
  /** §6.3 split: the same retailer line again, for another ASIN. */
  const splitP = (i: number) => setForm((f) => { const p = f.products[i]; const copy: PoFormProduct = { ...p, asin: "", qty_ordered: "", yield_manual: false, asin_qty_per_product: yieldFromPacks(p.retailer_units_per_pack, "1", "individual"), sold_as: "individual", units_per_pack: "1" }; const products = [...f.products]; products.splice(i + 1, 0, copy); return { ...f, products }; });
  const delP = (i: number) => setForm((f) => ({ ...f, products: f.products.filter((_, j) => j !== i) }));
  const setOverride = (asin: string, v: string) => setForm((f) => ({ ...f, cost_overrides: { ...f.cost_overrides, [asin]: v } }));
  const setAdj = (asin: string, k: "amount" | "reason", v: string) => setForm((f) => ({ ...f, cogs_adjustments: { ...(f.cogs_adjustments ?? {}), [asin]: { amount: "", reason: "", ...(f.cogs_adjustments?.[asin] ?? {}), [k]: v } } }));

  /** An ASIN chosen for line i: AF's title / pack fields win (stone); the pack override question comes later, on a change. */
  const onPick = (i: number) => (info: AsinInfo | null, asin: string) => setForm((f0) => {
    let f = f0;
    const products = f.products.map((p, j) => {
      if (j !== i) return p;
      const next = { ...p, asin };
      if (info?.in_af && info.sold_as) { next.sold_as = info.sold_as as PoFormProduct["sold_as"]; next.units_per_pack = String(info.units_per_pack ?? 1); f = setMark(f, `asin.${asin}`, "af"); }
      if (!next.yield_manual) next.asin_qty_per_product = yieldFromPacks(next.retailer_units_per_pack, next.units_per_pack, next.sold_as);
      return next;
    });
    return { ...f, products };
  });
  /** §6.5: a pack change on an ASIN AF knows → ask once per ASIN. */
  const onPackBlur = (i: number) => {
    const p = form.products[i]; const info = known.get(p.asin.toUpperCase());
    if (!info?.in_af || !info.sold_as) return;
    const afUpp = info.sold_as === "individual" ? 1 : Number(info.units_per_pack ?? 1);
    const upp = p.sold_as === "individual" ? 1 : Number(p.units_per_pack) || 1;
    if (upp === afUpp && p.sold_as === info.sold_as) { setForm((f) => ({ ...f, pack_updates: { ...(f.pack_updates ?? {}), [p.asin]: false } })); return; }
    if (form.pack_updates?.[p.asin] !== undefined) return; // already answered for this ASIN
    setPackAsk({ asin: p.asin.toUpperCase(), from: `${info.sold_as} × ${afUpp}`, to: `${p.sold_as} × ${upp}` });
  };
  const answerPack = (updateAf: boolean) => { if (packAsk) setForm((f) => ({ ...f, pack_updates: { ...(f.pack_updates ?? {}), [packAsk.asin]: updateAf } })); setPackAsk(null); };

  const setPromo = (i: number, patch: Partial<PoFormPromo>) => setForm((f0) => { const f = clearMark(f0, `promos.${i}`); return { ...f, promos: (f.promos ?? []).map((p, j) => (j === i ? { ...p, ...patch, ...(patch.type !== undefined && patch.type !== p.type ? { counts_toward_cogs: promoCountsByDefault(String(patch.type)) } : {}) } : p)) }; });
  const setPay = (i: number, patch: Partial<PoFormPayment>) => setForm((f0) => { const f = clearMark(f0, `payments.${i}`); return { ...f, payments: (f.payments ?? []).map((p, j) => (j === i ? { ...p, ...patch } : p)) }; });

  const save = async () => {
    setTouched(true); setServerErr(null);
    const settled = settleMoney(form);
    if (!settled.ok) { setServerErr(`A money field can't be calculated: ${settled.error}`); return; }
    setForm(settled.form);
    if (!checkPoForm(settled.form).ok) return;
    setBusy(true);
    try {
      const res = await fetch("/api/pos", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...settled.form, ships_to: shipsTo }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
      onOpenChange(false); onCreated(String(data.poId));
    } catch (e: any) { setServerErr(e.message); } finally { setBusy(false); }
  };

  const field = (k: keyof PoFormState, label: string, opts: { w?: string; type?: string; ph?: string; money?: boolean; list?: string } = {}) => (
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground" htmlFor={`new-po-${String(k)}`}>{label}</Label>
      {opts.money
        ? <MoneyCalcInput id={`new-po-${String(k)}`} value={(form[k] as string) ?? ""} onChange={(v) => set(k, v)} placeholder={opts.ph} className={`h-8 text-sm ${opts.w ?? ""} ${mark(String(k))}`} data-testid={`input-new-po-${String(k)}`} />
        : <Input id={`new-po-${String(k)}`} type={opts.type ?? "text"} list={opts.list} value={(form[k] as string) ?? ""} onChange={(e) => set(k, e.target.value)} placeholder={opts.ph} className={`h-8 text-sm ${opts.w ?? ""} ${mark(String(k))}`} data-testid={`input-new-po-${String(k)}`} />}
    </div>
  );
  const th = "px-2 py-1.5 text-[11px] font-medium text-left whitespace-nowrap text-muted-foreground";
  const sel = "h-8 rounded border border-input bg-background px-1 text-xs";
  const pf = form.prefill;
  const totalPayments = r2((form.payments ?? []).reduce((t, p) => t + (Number(String(p.amount).replace(/[$,\s]/g, "")) || 0), 0));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[min(96vw,84rem)] max-h-[92vh] overflow-y-auto" data-testid="new-po-dialog">
        <DialogHeader>
          <DialogTitle>New PO</DialogTitle>
          <DialogDescription>Creates the PO, its products and ASIN rows in AF. Sync POs never overwrites it.</DialogDescription>
        </DialogHeader>

        {pf && (
          <div className="rounded-md px-3 py-2 text-xs" style={{ border: "0.5px solid hsl(var(--border))", background: "hsl(var(--muted) / 0.4)" }} data-testid="new-po-prefill-banner">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="inline-flex items-center gap-1"><Sparkles className="h-3.5 w-3.5 text-amber-600" /> Prefilled from <b>{pf.supplier ?? form.supplier ?? "the capture"}</b>{pf.pages != null ? ` · ${pf.pages} page${pf.pages === 1 ? "" : "s"} captured` : ""}{pf.captured_at ? ` ${new Date(pf.captured_at).toLocaleTimeString()}` : ""}</span>
              <span className="text-muted-foreground"><span className="inline-block h-2.5 w-2.5 rounded-sm ring-1 ring-amber-400/80 align-middle" /> model · <span className="inline-block h-2.5 w-2.5 rounded-sm ring-1 ring-stone-400/70 align-middle" /> AF database · plain = typed</span>
              {pf.raw_text && <button type="button" className="inline-flex items-center gap-1 underline" onClick={() => setRawOpen((v) => !v)} data-testid="button-new-po-raw-text"><FileText className="h-3 w-3" /> {rawOpen ? "Hide" : "Show"} captured text</button>}
            </div>
            {(pf.warnings ?? []).map((w) => <p key={w} className="mt-1 flex items-center gap-1.5 text-amber-700 dark:text-amber-400" data-testid="new-po-prefill-warning"><AlertTriangle className="h-3 w-3" />{w}</p>)}
            {rawOpen && pf.raw_text && <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-background p-2 text-[11px]" data-testid="new-po-raw-text">{pf.raw_text}</pre>}
          </div>
        )}

        <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-3">
          {field("supplier", "Supplier", { ph: "walmart.com" })}
          {field("order_id", "Order #")}
          {field("order_date", "Order date", { type: "date" })}
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground" htmlFor="new-po-purchased_by">Purchased by</Label>
            {people.users.length > 0
              ? <select id="new-po-purchased_by" value={form.purchased_by_user_id ?? ""} onChange={(e) => { const u = people.users.find((x) => String(x.id) === e.target.value); setForm((f) => ({ ...f, purchased_by_user_id: e.target.value, purchased_by: u?.display_name ?? f.purchased_by })); }} className={`${sel} h-8 w-full text-sm`} data-testid="input-new-po-purchased_by">
                  <option value="">—</option>{people.users.map((u) => <option key={u.id} value={u.id}>{u.display_name}</option>)}
                </select>
              : <Input id="new-po-purchased_by" value={form.purchased_by} onChange={(e) => set("purchased_by", e.target.value)} className="h-8 text-sm" data-testid="input-new-po-purchased_by" />}
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground" htmlFor="new-po-ships_to">Ships to</Label>
            <select id="new-po-ships_to" value={shipsTo} onChange={(e) => { set("ships_to", e.target.value); setShipsToEdited(true); }} className={`${sel} h-8 w-full text-sm ${mark("ships_to")}`} data-testid="input-new-po-ships_to" title={shipsToEdited ? "Set by hand" : "From prep cost: any product with prep > 0 → Velocity"}>
              <option value="velocity">Velocity</option>
              <option value="home">Home</option>
            </select>
          </div>
          {field("email_used", "Email used", { list: "new-po-emails", ph: people.emails[0] ?? "" })}
          <datalist id="new-po-emails">{people.emails.map((e) => <option key={e} value={e} />)}</datalist>
          {field("subtotal", "Subtotal", { ph: check.computedSubtotal.toFixed(2), money: true })}
          {field("discount", "Discount", { ph: "0.00", money: true })}
          {field("tax", "Tax", { ph: "0.00", money: true })}
          {field("sh_donations", "Shipping (S&H + donations)", { ph: "0.00", money: true })}
          {field("order_total", "Order total", { ph: check.effectiveOrderTotal.toFixed(2), money: true })}
          {field("weighted_gc_discount_pct", "Weighted GC %")}
          {field("cashback_site", "Cashback site")}
          {field("cashback_pct", "Cashback %")}
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground" htmlFor="new-po-cashback_status">Cashback status</Label>
            <select id="new-po-cashback_status" value={form.cashback_status ?? ""} onChange={(e) => set("cashback_status", e.target.value)} className={`${sel} h-8 w-full text-sm`} data-testid="input-new-po-cashback_status">
              <option value="">—</option>{CASHBACK_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Subscription</Label>
            <div className={`flex h-8 items-center gap-2 text-sm ${mark("subscription")}`}>
              <input type="checkbox" checked={form.subscription?.present ?? false} onChange={(e) => setForm((f) => clearMark({ ...f, subscription: { present: e.target.checked, frequency_weeks: f.subscription?.frequency_weeks ?? "" } }, "subscription"))} data-testid="input-new-po-subscription" />
              {form.subscription?.present && <span className="flex items-center gap-1 text-xs">every <Input value={form.subscription.frequency_weeks} onChange={(e) => setForm((f) => ({ ...f, subscription: { present: true, frequency_weeks: e.target.value } }))} inputMode="numeric" className="h-7 w-12 text-xs text-right" data-testid="input-new-po-subscription-weeks" /> weeks</span>}
              {!form.subscription?.present && <span className="text-xs text-muted-foreground">No</span>}
            </div>
          </div>
          <div className="space-y-1 col-span-2">
            <Label className="text-xs text-muted-foreground" htmlFor="new-po-notes">PO notes</Label>
            <Textarea id="new-po-notes" value={form.notes} onChange={(e) => set("notes", e.target.value)} rows={1} className={mark("notes")} data-testid="input-new-po-notes" />
          </div>
        </div>

        {/* §6.3 lines */}
        <div className="mt-4 space-y-2">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Lines as bought · ASIN rows beneath</div>
          <div className="overflow-x-auto rounded-md" style={{ border: "0.5px solid hsl(var(--border))" }}>
            <table className="w-full border-collapse text-sm" data-testid="new-po-products">
              <thead><tr className="bg-muted/40">
                <th className={th}>Product name</th><th className={th}>SKU / UPC</th><th className={th}>Price</th><th className={th}>Qty</th><th className={th} title="The retailer's pack — a 12-count is 12">Units / pack</th>
                <th className={th}>ASIN</th><th className={th} title="ASIN qty = qty × retailer units ÷ ASIN units per pack">ASIN qty</th><th className={th}>Sold as</th><th className={th}>ASIN units / pack</th><th className={th}>Prep</th><th className={th}>Notes</th><th className={th}></th>
              </tr></thead>
              <tbody>
                {form.products.map((p, i) => {
                  const qty = Number(p.qty_ordered) || 0, r = Number(p.retailer_units_per_pack ?? "1") || 1;
                  const u = p.sold_as === "individual" ? 1 : Number(p.units_per_pack) || 1;
                  const y = Number(p.asin_qty_per_product) || 0;
                  const units = qty > 0 ? Math.round(qty * y * 100) / 100 : 0;
                  const guess = p.asin.length === 10 && sources[`products.${i}.asin`] === "model" ? p.asin : null;
                  return (
                    <React.Fragment key={i}>
                      <tr style={{ borderTop: "0.5px solid hsl(var(--border))" }} data-testid={`row-new-po-product-${i}`}>
                        <td className="px-2 py-1.5 align-top"><Input value={p.product_name} onChange={(e) => setP(i, "product_name", e.target.value)} className={`h-8 text-xs min-w-[14rem] ${mark(`products.${i}.product_name`)}`} data-testid={`input-new-po-product_name-${i}`} /></td>
                        <td className="px-2 py-1.5 align-top"><Input value={p.supplier_sku} onChange={(e) => setP(i, "supplier_sku", e.target.value)} className={`h-8 text-xs w-24 ${mark(`products.${i}.supplier_sku`)}`} data-testid={`input-new-po-supplier_sku-${i}`} /></td>
                        <td className="px-2 py-1.5 align-top"><MoneyCalcInput value={p.price} onChange={(v) => setP(i, "price", v)} className={`h-8 text-xs w-20 text-right ${mark(`products.${i}.price`)}`} data-testid={`input-new-po-price-${i}`} /></td>
                        <td className="px-2 py-1.5 align-top"><Input value={p.qty_ordered} onChange={(e) => setP(i, "qty_ordered", e.target.value)} inputMode="decimal" title={hint(`products.${i}.qty_ordered`)} className={`h-8 text-xs w-14 text-right ${mark(`products.${i}.qty_ordered`)}`} data-testid={`input-new-po-qty_ordered-${i}`} /></td>
                        <td className="px-2 py-1.5 align-top"><Input value={p.retailer_units_per_pack ?? "1"} onChange={(e) => setP(i, "retailer_units_per_pack", e.target.value)} inputMode="numeric" className={`h-8 text-xs w-14 text-right ${mark(`products.${i}.retailer_units_per_pack`)}`} data-testid={`input-new-po-retailer_upp-${i}`} /></td>
                        <td className="px-2 py-1.5 align-top"><AsinPicker value={p.asin} product={p.product_name} supplier={form.supplier} guess={guess} known={known} onPick={onPick(i)} onChange={(v) => setP(i, "asin", v)} rowIndex={i} mark={mark(`products.${i}.asin`)} /></td>
                        <td className="px-2 py-1.5 align-top">
                          <Input value={qty > 0 ? String(units) : ""} onChange={(e) => setLineAsinQty(i, e.target.value)} inputMode="decimal" className="h-8 text-xs w-16 text-right" data-testid={`input-new-po-asin-qty-${i}`} title={`${qty} × ${r} ÷ ${u} = ${units}`} />
                          <div className="mt-0.5 whitespace-nowrap text-[10px] text-muted-foreground">{qty > 0 ? `${qty} × ${r} ÷ ${u}` : "qty × retailer ÷ ASIN units"}{p.yield_manual && <button type="button" className="ml-1 underline" onClick={() => resetYield(i)} title="Back to the pack math">reset</button>}</div>
                        </td>
                        <td className="px-2 py-1.5 align-top">
                          <select value={p.sold_as} onChange={(e) => setP(i, "sold_as", e.target.value)} onBlur={() => onPackBlur(i)} className={`${sel} ${mark(`asin.${p.asin.toUpperCase()}`)}`} data-testid={`select-new-po-sold_as-${i}`}>
                            {SOLD_AS_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
                          </select>
                        </td>
                        <td className="px-2 py-1.5 align-top"><Input value={p.units_per_pack} disabled={p.sold_as === "individual"} onChange={(e) => setP(i, "units_per_pack", e.target.value)} onBlur={() => onPackBlur(i)} inputMode="numeric" className={`h-8 text-xs w-14 text-right ${mark(`asin.${p.asin.toUpperCase()}`)}`} data-testid={`input-new-po-units_per_pack-${i}`} /></td>
                        <td className="px-2 py-1.5 align-top"><MoneyCalcInput value={p.prep_cost} onChange={(v) => setP(i, "prep_cost", v)} className={`h-8 text-xs w-14 text-right ${mark("prep_cost")}`} data-testid={`input-new-po-prep_cost-${i}`} /></td>
                        <td className="px-2 py-1.5 align-top"><Input value={p.notes ?? ""} onChange={(e) => setP(i, "notes", e.target.value)} placeholder="—" className="h-8 text-xs w-24" data-testid={`input-new-po-line-notes-${i}`} /></td>
                        <td className="px-2 py-1.5 align-top whitespace-nowrap">
                          <button type="button" onClick={() => splitP(i)} className="mr-2 text-muted-foreground/60 hover:text-foreground" title="Add ASIN to this line (split)" data-testid={`button-new-po-split-${i}`}><Split className="h-3.5 w-3.5" /></button>
                          <button type="button" onClick={() => delP(i)} disabled={form.products.length === 1} className="text-muted-foreground/60 hover:text-destructive disabled:opacity-30" title="Remove line" data-testid={`button-new-po-remove-${i}`}><Trash2 className="h-3.5 w-3.5" /></button>
                        </td>
                      </tr>
                      {touched && check.productErrors[i] && (
                        <tr><td colSpan={12} className="px-2 pb-1.5 text-xs text-destructive" data-testid={`new-po-product-error-${i}`}>{check.productErrors[i].join(" · ")}</td></tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Button size="sm" variant="outline" onClick={addP} data-testid="button-new-po-add-product"><Plus className="h-3.5 w-3.5 mr-1" /> Add line</Button>
        </div>

        {/* §6.5 / §7 ASIN rows with the three costs */}
        {check.asins.length > 0 && (
          <div className="mt-4 space-y-2">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">ASIN rows this PO will create</div>
            <table className="text-sm" data-testid="new-po-asin-summary">
              <thead><tr>
                <th className={th}>ASIN</th><th className={th}>Sold as</th><th className={`${th} text-right`}>Ordered</th><th className={`${th} text-right`}>Lines</th>
                <th className={`${th} text-right`} title="Col AR: before the gift-card discount, promos applied — what Update COGS in SC sends">Sourcing cost</th>
                <th className={`${th} text-right`} title="Col Y: Sourcing × (1 − GC %) + adjustment — feeds profitability, Aura, repricing">COGS / unit</th>
                <th className={`${th} text-right`} title="Every discount counted (rewards too)">Paid cost</th>
                <th className={th}>Adjustment</th><th className={th}>Pack</th>
              </tr></thead>
              <tbody>
                {check.asins.map((a) => {
                  const adj = form.cogs_adjustments?.[a.asin];
                  const pu = form.pack_updates?.[a.asin];
                  return (
                    <tr key={a.asin} data-testid={`row-new-po-asin-${a.asin}`}>
                      <td className="px-2 py-1 font-mono text-xs">{a.asin}</td>
                      <td className="px-2 py-1 text-xs">{a.sold_as}{a.sold_as !== "individual" ? ` × ${a.units_per_pack}` : ""}</td>
                      <td className="px-2 py-1 text-right">{a.qty}</td>
                      <td className="px-2 py-1 text-right">{a.lines.length}</td>
                      <td className="px-2 py-1 text-right font-mono text-xs" data-testid={`new-po-sourcing-${a.asin}`}>{a.sourcing_cost ?? "—"}</td>
                      <td className="px-2 py-1 text-right">
                        <MoneyCalcInput value={form.cost_overrides[a.asin] ?? ""} onChange={(v) => setOverride(a.asin, v)} placeholder={a.computed_cost_per_unit ?? "—"} className="h-7 w-24 text-right text-xs" data-testid={`input-new-po-cost-${a.asin}`} title={form.cost_overrides[a.asin] ? "typed" : `${a.sourcing_cost ?? "?"} × (1 − GC %)${a.cogs_adjustment ? ` + ${a.cogs_adjustment}` : ""}`} />
                      </td>
                      <td className="px-2 py-1 text-right font-mono text-xs">{a.paid_cost ?? "—"}</td>
                      <td className="px-2 py-1">
                        <span className="inline-flex items-center gap-1">
                          <MoneyCalcInput value={adj?.amount ?? ""} onChange={(v) => setAdj(a.asin, "amount", v)} placeholder="0.00" className="h-7 w-16 text-right text-xs" data-testid={`input-new-po-adj-${a.asin}`} />
                          <Input value={adj?.reason ?? ""} onChange={(e) => setAdj(a.asin, "reason", e.target.value)} placeholder="reason" className="h-7 w-32 text-xs" data-testid={`input-new-po-adj-reason-${a.asin}`} />
                        </span>
                      </td>
                      <td className="px-2 py-1 text-[10px] text-muted-foreground">{pu === true ? "updates ASIN in AF" : pu === false ? "this PO only" : ""}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* §7.2 promos and §8.2 payments */}
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <div className="space-y-2" data-testid="new-po-promos">
            <div className="flex items-center justify-between"><span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Promos</span><Button size="sm" variant="ghost" onClick={() => setForm((f) => ({ ...f, promos: [...(f.promos ?? []), emptyPromo()] }))} data-testid="button-new-po-add-promo"><Plus className="h-3.5 w-3.5 mr-1" /> Promo</Button></div>
            {(form.promos ?? []).length === 0 && <p className="text-xs text-muted-foreground">None. Sale and coupon count toward COGS; rewards do not (toggle each).</p>}
            {(form.promos ?? []).map((p, i) => (
              <div key={i} className={`flex flex-wrap items-center gap-1.5 rounded px-1 py-0.5 ${mark(`promos.${i}`)}`} data-testid={`row-new-po-promo-${i}`}>
                <select value={p.type} onChange={(e) => setPromo(i, { type: e.target.value as PoFormPromo["type"] })} className={sel} data-testid={`select-new-po-promo-type-${i}`}>
                  <option value="">type…</option>{PROMO_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
                <Input value={p.description} onChange={(e) => setPromo(i, { description: e.target.value })} placeholder="15% off with WELCOME15" className="h-8 min-w-[12rem] flex-1 text-xs" data-testid={`input-new-po-promo-desc-${i}`} />
                <MoneyCalcInput value={p.amount} onChange={(v) => setPromo(i, { amount: v })} placeholder="$" className="h-8 w-20 text-right text-xs" data-testid={`input-new-po-promo-amount-${i}`} />
                <Input value={p.percent} onChange={(e) => setPromo(i, { percent: e.target.value })} placeholder="%" inputMode="decimal" className="h-8 w-14 text-right text-xs" data-testid={`input-new-po-promo-pct-${i}`} />
                <label className="flex items-center gap-1 text-xs" title="Counts toward COGS"><input type="checkbox" checked={p.counts_toward_cogs} onChange={(e) => setPromo(i, { counts_toward_cogs: e.target.checked })} data-testid={`input-new-po-promo-counts-${i}`} /> COGS</label>
                <button type="button" onClick={() => setForm((f) => ({ ...f, promos: (f.promos ?? []).filter((_, j) => j !== i) }))} className="text-muted-foreground/60 hover:text-destructive" data-testid={`button-new-po-remove-promo-${i}`}><Trash2 className="h-3.5 w-3.5" /></button>
              </div>
            ))}
          </div>
          <div className="space-y-2" data-testid="new-po-payments">
            <div className="flex items-center justify-between"><span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Payments</span><Button size="sm" variant="ghost" onClick={() => setForm((f) => ({ ...f, payments: [...(f.payments ?? []), emptyPayment()] }))} data-testid="button-new-po-add-payment"><Plus className="h-3.5 w-3.5 mr-1" /> Payment</Button></div>
            {(form.payments ?? []).length === 0 && <p className="text-xs text-muted-foreground">None recorded.</p>}
            {(form.payments ?? []).map((p, i) => (
              <div key={i} className={`flex flex-wrap items-center gap-1.5 rounded px-1 py-0.5 ${mark(`payments.${i}`)}`} data-testid={`row-new-po-payment-${i}`}>
                <select value={p.method} onChange={(e) => setPay(i, { method: e.target.value as PoFormPayment["method"] })} className={sel} data-testid={`select-new-po-payment-method-${i}`}>
                  <option value="">method…</option>{PAYMENT_METHODS.map((m) => <option key={m} value={m}>{m.replace("_", " ")}</option>)}
                </select>
                <Input value={p.nickname} onChange={(e) => setPay(i, { nickname: e.target.value })} placeholder="Amex" className="h-8 w-28 text-xs" data-testid={`input-new-po-payment-nick-${i}`} />
                <Input value={p.last4} onChange={(e) => setPay(i, { last4: e.target.value.replace(/\D/g, "").slice(0, 4) })} placeholder="last 4" inputMode="numeric" className="h-8 w-16 font-mono text-xs" data-testid={`input-new-po-payment-last4-${i}`} />
                <MoneyCalcInput value={p.amount} onChange={(v) => setPay(i, { amount: v })} placeholder="$" className="h-8 w-20 text-right text-xs" data-testid={`input-new-po-payment-amount-${i}`} />
                {p.method === "gift_card" && <Input value={p.gift_card_discount_pct} onChange={(e) => setPay(i, { gift_card_discount_pct: e.target.value })} placeholder="GC %" inputMode="decimal" className="h-8 w-14 text-right text-xs" data-testid={`input-new-po-payment-gc-${i}`} />}
                <button type="button" onClick={() => setForm((f) => ({ ...f, payments: (f.payments ?? []).filter((_, j) => j !== i) }))} className="text-muted-foreground/60 hover:text-destructive" data-testid={`button-new-po-remove-payment-${i}`}><Trash2 className="h-3.5 w-3.5" /></button>
              </div>
            ))}
            {(form.payments ?? []).some((p) => p.amount.trim() !== "") && <p className="text-[11px] text-muted-foreground">Payments {money(totalPayments)} · order total {money(check.effectiveOrderTotal)}</p>}
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-6 rounded-md px-3 py-2 text-sm" style={{ border: "0.5px solid hsl(var(--border))" }} data-testid="new-po-totals">
          <div><span className="text-muted-foreground mr-1.5">Subtotal (Σ price × qty)</span><span className="font-mono">{money(check.computedSubtotal)}</span></div>
          <div><span className="text-muted-foreground mr-1.5">Order total</span><span className="font-mono">{money(check.effectiveOrderTotal)}</span></div>
          <div><span className="text-muted-foreground mr-1.5">ASIN units</span><span>{check.asins.reduce((t, a) => t + a.qty, 0)}</span></div>
          {check.nonCountingPromoAmount > 0 && <div><span className="text-muted-foreground mr-1.5">Added back (rewards)</span><span className="font-mono">{money(check.nonCountingPromoAmount)}</span></div>}
        </div>
        {check.warnings.map((w) => <p key={w} data-testid="new-po-warning" className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400"><AlertTriangle className="h-3.5 w-3.5" />{w}</p>)}
        {touched && check.errors.length > 0 && (
          <ul className="list-disc pl-5 text-xs text-destructive" data-testid="new-po-errors">{check.errors.map((e) => <li key={e}>{e}</li>)}</ul>
        )}
        {serverErr && <p className="text-sm text-destructive" data-testid="new-po-server-error">{serverErr}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button onClick={save} disabled={busy || (touched && !check.ok)} data-testid="button-new-po-save">{busy ? "Creating…" : "Create PO"}</Button>
        </DialogFooter>
        <PackOverrideDialog ask={packAsk} onChoose={answerPack} />
      </DialogContent>
    </Dialog>
  );
}
