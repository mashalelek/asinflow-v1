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
// (File name kept for history — since 2026-11-01 this is the New PO PAGE, no Dialog.)
import { Plus, Trash2, AlertTriangle, Sparkles, Database, FileText } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"; // the pack-override question only
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MoneyCalcInput, calcMoney } from "@/components/money-calc-input";
import { useAuth } from "@/contexts/auth-context";
import {
  checkPoForm, emptyPoForm, emptyProduct, emptyPromo, emptyPayment, shipsToFromForm, yieldFromPacks, promoCountsByDefault,
  SOLD_AS_OPTIONS, PROMO_TYPES, PAYMENT_METHODS, CASHBACK_STATUSES,
  type PoFormState, type PoFormProduct, type PoFormPromo, type PoFormPayment, type PoFormPrefill, type PrefillSource,
} from "@shared/po-form";
import { groupLines, newLineId, lineQty, slotUnits, setSlotUnits, resetSlotYield, addAsinRow, addProductToBundle, removeAsinRow, removeLine, ensureLineIds, isFractional, FRACTIONAL_UNITS_NOTE, type LineBox } from "@shared/po-lines";

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

// ── ASIN picker (§6.4) — a type-ahead combobox (Maria 2026-11-01: never a bare dropdown) ──
function viaLabel(v: AsinInfo["via"]): string {
  return v === "history_exact" ? "bought before (same name)" : v === "history_tokens" ? "bought before (similar name)" : v === "title" ? "title match" : v === "model" ? "model's guess" : "";
}
const ASIN_RE = /^[A-Z0-9]{10}$/;
/** Pure: the suggestions that match what is typed (ASIN / title / SKU / brand), so the list narrows while the server search is in flight. */
export function filterSuggestions(opts: readonly AsinInfo[], q: string): AsinInfo[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [...opts];
  return opts.filter((o) => [o.asin, o.title, o.primary_sku, o.brand, o.matched_name].some((s) => String(s ?? "").toLowerCase().includes(needle)));
}
function AsinPicker({ value, product, supplier, guess, known, onPick, onChange, rowIndex, mark, compact = false }: {
  value: string; product: string; supplier: string; guess: string | null; known: Map<string, AsinInfo>;
  onPick: (info: AsinInfo | null, asin: string) => void; onChange: (v: string) => void; rowIndex: number; mark: string;
  /** The ASIN row shows the title in its own column: the status line only says "Not in AF — Add to AF". */
  compact?: boolean;
}) {
  const [opts, setOpts] = useState<AsinInfo[]>([]);
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const [adding, setAdding] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const q = value.trim();
  const qUp = q.toUpperCase();
  // Suggestions: history → title → the typed search (server), the model's guess appended; 180 ms after the last keystroke.
  useEffect(() => {
    window.clearTimeout(timer.current);
    if (!open) return;
    timer.current = window.setTimeout(() => {
      const u = new URLSearchParams({ supplier, product, q: q.length >= 2 && !known.has(qUp) ? q : "" });
      fetch(`/api/pos/asin-suggest?${u}`).then((r) => r.json()).then((d) => {
        const rows: AsinInfo[] = d.rows ?? [];
        for (const r of rows) known.set(r.asin, r);
        if (guess && ASIN_RE.test(guess) && !rows.some((r) => r.asin === guess)) rows.push({ asin: guess, title: null, primary_sku: null, image_url: null, brand: null, sold_as: null, units_per_pack: null, in_af: known.get(guess)?.in_af ?? false, via: "model" });
        setOpts(rows); setHi(0);
      }).catch(() => setOpts([]));
    }, 180);
    return () => window.clearTimeout(timer.current);
  }, [q, qUp, product, supplier, open, guess, known]);
  // A full ASIN typed or pasted: fetch its AF facts once.
  useEffect(() => {
    if (!ASIN_RE.test(qUp) || known.has(qUp)) return;
    fetch(`/api/pos/asin-info/${qUp}`).then((r) => r.json()).then((d) => { known.set(qUp, d.info ?? { asin: qUp, title: null, primary_sku: null, image_url: null, brand: null, sold_as: null, units_per_pack: null, in_af: false }); onPick(d.info ?? null, qUp); if (d.info?.in_af) setOpen(false); }).catch(() => {});
  }, [qUp, known, onPick]);
  const hit = known.get(qUp);
  const shown = useMemo(() => filterSuggestions(opts, q.length >= 2 && !known.has(qUp) ? q : ""), [opts, q, qUp, known]);
  const notInAf = ASIN_RE.test(qUp) && hit != null && !hit.in_af;
  const pick = (o: AsinInfo) => { onChange(o.asin); onPick(o, o.asin); setOpen(false); };
  const addToAf = async () => {
    setAdding(true);
    try {
      const r = await fetch("/api/pos/add-asin", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ asin: qUp }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.message || `HTTP ${r.status}`);
      if (d.info) { known.set(qUp, d.info); onPick(d.info, qUp); }
    } catch { /* the status line keeps "not in AF" */ } finally { setAdding(false); }
  };
  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setHi((h) => Math.min(h + 1, Math.max(shown.length - 1, 0))); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
    else if (e.key === "Enter") { if (open && shown[hi]) { e.preventDefault(); pick(shown[hi]); } else if (open && shown.length === 0 && notInAf) { e.preventDefault(); void addToAf(); } }
    else if (e.key === "Escape" || e.key === "Tab") setOpen(false);
  };
  return (
    <div className="relative min-w-[11rem]" data-testid={`asin-picker-${rowIndex}`}>
      <Input value={value} role="combobox" aria-expanded={open} aria-autocomplete="list" onChange={(e) => { onChange(e.target.value.toUpperCase()); setOpen(true); setHi(0); }} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)} onKeyDown={onKey} placeholder="ASIN / title / SKU" className={`h-8 font-mono text-xs ${mark}`} data-testid={`input-new-po-asin-${rowIndex}`} autoComplete="off" />
      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 w-[28rem] rounded-md border bg-popover p-1 text-popover-foreground shadow-md" role="listbox" onMouseDown={(e) => e.preventDefault()} data-testid={`asin-suggestions-${rowIndex}`}>
          {shown.length === 0 && !notInAf && <div className="px-2 py-1.5 text-xs text-muted-foreground">{q.length >= 2 ? "No match — keep typing an ASIN, title, SKU or brand" : product.trim() ? "No suggestions yet — type an ASIN, title or SKU" : "Type an ASIN, title or SKU"}</div>}
          {shown.map((o, i) => (
            <button key={o.asin} type="button" role="option" aria-selected={i === hi} className={`flex w-full items-start gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-muted ${i === hi ? "bg-muted" : ""}`} onMouseEnter={() => setHi(i)} onClick={() => pick(o)} data-testid={`asin-suggestion-${o.asin}`}>
              {o.image_url ? <img src={o.image_url} alt="" className="h-8 w-8 rounded object-contain bg-white" /> : <div className="h-8 w-8 rounded bg-muted" />}
              <span className="min-w-0 flex-1">
                <span className="font-mono">{o.asin}</span>
                {o.via === "model" && <span className="ml-1.5 inline-flex items-center gap-0.5 rounded-sm bg-amber-500/15 px-1 text-[10px] text-amber-700 dark:text-amber-400"><Sparkles className="h-2.5 w-2.5" /> model's guess</span>}
                {o.via && o.via !== "model" && <span className="ml-1.5 text-[10px] text-muted-foreground">{viaLabel(o.via)}{o.last_ordered ? ` · ${o.last_ordered}` : ""}</span>}
                {!o.in_af && <span className="ml-1.5 text-[10px] text-amber-700 dark:text-amber-400">not in AF</span>}
                <span className="block truncate text-muted-foreground" title={o.title ?? o.matched_name ?? ""}>{o.title ?? o.matched_name ?? "—"}</span>
                {(o.sold_as || o.primary_sku || o.brand) && <span className="block truncate text-[10px] text-muted-foreground">{[o.brand, o.primary_sku, o.sold_as ? `${o.sold_as}${o.units_per_pack && o.units_per_pack > 1 ? ` × ${o.units_per_pack}` : ""}` : null].filter(Boolean).join(" · ")}</span>}
              </span>
            </button>
          ))}
          {notInAf && <button type="button" className="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left text-xs text-amber-700 hover:bg-muted dark:text-amber-400" onClick={addToAf} disabled={adding} data-testid={`button-add-to-af-${rowIndex}`}><Plus className="h-3 w-3" /> {adding ? "Adding…" : `${qUp} is not in AF — Add to AF`}</button>}
        </div>
      )}
      <div className="mt-0.5 flex items-center gap-1 truncate text-[10px] text-muted-foreground max-w-[18rem]" title={hit?.title ?? ""}>
        {hit?.in_af && !compact ? <><Database className="h-2.5 w-2.5 shrink-0" />{hit.title ?? "in AF"}{hit.primary_sku ? ` · ${hit.primary_sku}` : ""}</>
          : notInAf ? <><span className="text-amber-600">Not in AF</span><button type="button" onClick={addToAf} disabled={adding} className="underline" data-testid={`button-add-to-af-status-${rowIndex}`}>{adding ? "Adding…" : "— Add to AF"}</button></> : null}
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
/** The New PO form — a full page (/pos/new), not a modal (Maria 2026-11-01). `onOpenChange(false)` = Cancel (the page navigates away). */
export function NewPoForm({ open, onOpenChange, onCreated, prefill }: { open: boolean; onOpenChange: (v: boolean) => void; onCreated: (poId: string) => void; prefill?: PrefillResponse | null }) {
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
    seeded.products = ensureLineIds(seeded.products);
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
  /** One product field on several rows at once — a line's copies (a split) or a bundle slot's members; each row's marker is cleared. */
  const setMany = (idx: readonly number[], k: keyof PoFormProduct, v: string | boolean) => setForm((f0) => {
    let f = f0;
    for (const i of idx) f = clearMark(f, `products.${i}.${String(k)}`);
    const products = f.products.map((p, j) => {
      if (!idx.includes(j)) return p;
      const next = { ...p, [k]: v } as PoFormProduct;
      if (k === "sold_as" && v === "individual") next.units_per_pack = "1";
      if (k === "sold_as" && v !== "individual" && (next.units_per_pack === "1" || next.units_per_pack === "")) next.units_per_pack = "2";
      // §6.5 pack math keeps the yield in step until it is typed by hand.
      if (!next.yield_manual && ["retailer_units_per_pack", "units_per_pack", "sold_as"].includes(String(k))) next.asin_qty_per_product = yieldFromPacks(next.retailer_units_per_pack, next.units_per_pack, next.sold_as);
      return next;
    });
    return { ...f, products };
  });
  const setP = (i: number, k: keyof PoFormProduct, v: string | boolean) => setMany([i], k, v);
  // The line layout (shared/po-lines.ts): boxes of product lines with their ASIN rows (slots) beneath.
  const boxes = useMemo(() => groupLines(form.products), [form.products]);
  const withBox = (key: string, fn: (products: PoFormProduct[], box: LineBox) => PoFormProduct[]) => setForm((f) => { const b = groupLines(f.products).find((x) => x.key === key); return b ? { ...f, products: fn(f.products, b) } : f; });
  const onSlotUnits = (key: string, k: number, units: string) => withBox(key, (ps, b) => setSlotUnits(ps, b, k, units));
  const onResetSlot = (key: string, k: number) => withBox(key, (ps, b) => resetSlotYield(ps, b.slots[k] ?? []));
  const addLine = () => setForm((f) => ({ ...f, products: [...f.products, { ...emptyProduct(), line_id: newLineId() }] }));
  const onAddAsin = (key: string) => withBox(key, addAsinRow);
  const onAddToBundle = (key: string) => withBox(key, addProductToBundle);
  const onRemoveAsin = (key: string, k: number) => withBox(key, (ps, b) => removeAsinRow(ps, b, k));
  const onRemoveLine = (key: string, lineId: string) => withBox(key, (ps, b) => removeLine(ps, b, lineId));
  const setOverride = (asin: string, v: string) => setForm((f) => ({ ...f, cost_overrides: { ...f.cost_overrides, [asin]: v } }));
  const setAdj = (asin: string, k: "amount" | "reason", v: string) => setForm((f) => ({ ...f, cogs_adjustments: { ...(f.cogs_adjustments ?? {}), [asin]: { amount: "", reason: "", ...(f.cogs_adjustments?.[asin] ?? {}), [k]: v } } }));

  /** An ASIN chosen for a slot's rows: AF's title / pack fields win (stone); the pack override question comes later, on a change. */
  const onPick = (idx: readonly number[]) => (info: AsinInfo | null, asin: string) => setForm((f0) => {
    let f = f0;
    const products = f.products.map((p, j) => {
      if (!idx.includes(j)) return p;
      const next = { ...p, asin };
      if (info?.in_af && info.sold_as && !p.bundle_id) { next.sold_as = info.sold_as as PoFormProduct["sold_as"]; next.units_per_pack = String(info.units_per_pack ?? 1); f = setMark(f, `asin.${asin}`, "af"); }
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
    <div className="min-w-0 space-y-0.5">
      <Label className="text-[11px] text-muted-foreground" htmlFor={`new-po-${String(k)}`}>{label}</Label>
      {opts.money
        ? <MoneyCalcInput id={`new-po-${String(k)}`} value={(form[k] as string) ?? ""} onChange={(v) => set(k, v)} placeholder={opts.ph} className={`h-8 text-sm ${opts.w ?? ""} ${mark(String(k))}`} data-testid={`input-new-po-${String(k)}`} />
        : <Input id={`new-po-${String(k)}`} type={opts.type ?? "text"} list={opts.list} value={(form[k] as string) ?? ""} onChange={(e) => set(k, e.target.value)} placeholder={opts.ph} className={`h-8 text-sm ${opts.w ?? ""} ${mark(String(k))}`} data-testid={`input-new-po-${String(k)}`} />}
    </div>
  );
  const th = "px-2 py-1 text-[11px] font-medium text-left whitespace-nowrap text-muted-foreground";
  const sel = "h-8 rounded border border-input bg-background px-1 text-xs";
  const hairline = { border: "0.5px solid hsl(var(--border))" } as const;
  const pf = form.prefill;
  const totalPayments = r2((form.payments ?? []).reduce((t, p) => t + (Number(String(p.amount).replace(/[$,\s]/g, "")) || 0), 0));
  // The line grid (Maria's whiteboard): product row · ↳ ASIN rows beneath. Column templates shared by the header and the rows.
  const G_LINE = "grid grid-cols-[7.5rem_minmax(12rem,1fr)_5.5rem_4rem_4.5rem_1.75rem] items-start gap-x-2";
  const G_ASIN = "grid grid-cols-[1rem_11rem_minmax(8rem,1fr)_5rem_6.5rem_4rem_4rem_8rem_1.75rem_auto] items-start gap-x-2";
  if (!open) return null;

  return (
    <div className="relative flex min-h-[calc(100vh-64px)] flex-col" data-testid="new-po-page">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h1 className="text-xl font-semibold">New PO</h1>
        <p className="text-xs text-muted-foreground">Creates the PO, its products and ASIN rows in AF. Sync POs never overwrites it.</p>
      </div>

      {pf && (
        <div className="mt-1.5 rounded-md px-3 py-1.5 text-xs" style={{ ...hairline, background: "hsl(var(--muted) / 0.4)" }} data-testid="new-po-prefill-banner">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="inline-flex items-center gap-1"><Sparkles className="h-3.5 w-3.5 text-amber-600" /> Prefilled from <b>{pf.supplier ?? form.supplier ?? "the capture"}</b>{pf.pages != null ? ` · ${pf.pages} page${pf.pages === 1 ? "" : "s"} captured` : ""}{pf.captured_at ? ` ${new Date(pf.captured_at).toLocaleTimeString()}` : ""}</span>
            <span className="text-muted-foreground"><span className="inline-block h-2.5 w-2.5 rounded-sm ring-1 ring-amber-400/80 align-middle" /> model · <span className="inline-block h-2.5 w-2.5 rounded-sm ring-1 ring-stone-400/70 align-middle" /> AF database · plain = typed</span>
            {pf.raw_text && <button type="button" className="inline-flex items-center gap-1 underline" onClick={() => setRawOpen((v) => !v)} data-testid="button-new-po-raw-text"><FileText className="h-3 w-3" /> {rawOpen ? "Hide" : "Show"} captured text</button>}
          </div>
          {(pf.warnings ?? []).length > 0 && <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">{(pf.warnings ?? []).map((w) => <span key={w} className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400" data-testid="new-po-prefill-warning"><AlertTriangle className="h-3 w-3 shrink-0" />{w}</span>)}</div>}
          {rawOpen && pf.raw_text && <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-background p-2 text-[11px]" data-testid="new-po-raw-text">{pf.raw_text}</pre>}
        </div>
      )}

      {/* §6.2 order fields — two rows at 1440: identity, then money. */}
      <div className="mt-2 grid grid-cols-3 gap-x-3 gap-y-1.5 md:grid-cols-5 xl:grid-cols-9" data-testid="new-po-order-fields">
        {field("supplier", "Supplier", { ph: "walmart.com" })}
        {field("order_id", "Order #")}
        {field("order_date", "Order date", { type: "date" })}
        <div className="min-w-0 space-y-0.5">
          <Label className="text-[11px] text-muted-foreground" htmlFor="new-po-purchased_by">Purchased by</Label>
          {people.users.length > 0
            ? <select id="new-po-purchased_by" value={form.purchased_by_user_id ?? ""} onChange={(e) => { const u = people.users.find((x) => String(x.id) === e.target.value); setForm((f) => ({ ...f, purchased_by_user_id: e.target.value, purchased_by: u?.display_name ?? f.purchased_by })); }} className={`${sel} h-8 w-full text-sm`} data-testid="input-new-po-purchased_by">
                <option value="">—</option>{people.users.map((u) => <option key={u.id} value={u.id}>{u.display_name}</option>)}
              </select>
            : <Input id="new-po-purchased_by" value={form.purchased_by} onChange={(e) => set("purchased_by", e.target.value)} className="h-8 text-sm" data-testid="input-new-po-purchased_by" />}
        </div>
        <div className="min-w-0 space-y-0.5">
          <Label className="text-[11px] text-muted-foreground" htmlFor="new-po-ships_to">Ships to</Label>
          <select id="new-po-ships_to" value={shipsTo} onChange={(e) => { set("ships_to", e.target.value); setShipsToEdited(true); }} className={`${sel} h-8 w-full text-sm ${mark("ships_to")}`} data-testid="input-new-po-ships_to" title={shipsToEdited ? "Set by hand" : "From prep cost: any product with prep > 0 → Velocity"}>
            <option value="velocity">Velocity</option>
            <option value="home">Home</option>
          </select>
        </div>
        {field("email_used", "Email used", { list: "new-po-emails", ph: people.emails[0] ?? "" })}
        <datalist id="new-po-emails">{people.emails.map((e) => <option key={e} value={e} />)}</datalist>
        <div className="min-w-0 space-y-0.5">
          <Label className="text-[11px] text-muted-foreground">Subscription</Label>
          <div className={`flex h-8 items-center gap-2 text-sm ${mark("subscription")}`}>
            <input type="checkbox" checked={form.subscription?.present ?? false} onChange={(e) => setForm((f) => clearMark({ ...f, subscription: { present: e.target.checked, frequency_weeks: f.subscription?.frequency_weeks ?? "" } }, "subscription"))} data-testid="input-new-po-subscription" />
            {form.subscription?.present && <span className="flex items-center gap-1 text-xs">every <Input value={form.subscription.frequency_weeks} onChange={(e) => setForm((f) => ({ ...f, subscription: { present: true, frequency_weeks: e.target.value } }))} inputMode="numeric" className="h-7 w-12 text-xs text-right" data-testid="input-new-po-subscription-weeks" /> wks</span>}
            {!form.subscription?.present && <span className="text-xs text-muted-foreground">No</span>}
          </div>
        </div>
        <div className="col-span-2 min-w-0 space-y-0.5">
          <Label className="text-[11px] text-muted-foreground" htmlFor="new-po-notes">PO notes</Label>
          <Input id="new-po-notes" value={form.notes} onChange={(e) => set("notes", e.target.value)} className={`h-8 text-sm ${mark("notes")}`} data-testid="input-new-po-notes" />
        </div>
        {field("subtotal", "Subtotal", { ph: check.computedSubtotal.toFixed(2), money: true })}
        {field("discount", "Discount", { ph: "0.00", money: true })}
        {field("tax", "Tax", { ph: "0.00", money: true })}
        {field("sh_donations", "Shipping (S&H + donations)", { ph: "0.00", money: true })}
        {field("order_total", "Order total", { ph: check.effectiveOrderTotal.toFixed(2), money: true })}
        {field("weighted_gc_discount_pct", "Weighted GC %")}
        {field("cashback_site", "Cashback site")}
        {field("cashback_pct", "Cashback %")}
        <div className="min-w-0 space-y-0.5">
          <Label className="text-[11px] text-muted-foreground" htmlFor="new-po-cashback_status">Cashback status</Label>
          <select id="new-po-cashback_status" value={form.cashback_status ?? ""} onChange={(e) => set("cashback_status", e.target.value)} className={`${sel} h-8 w-full text-sm`} data-testid="input-new-po-cashback_status">
            <option value="">—</option>{CASHBACK_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
      </div>

      {/* §6.3 lines — Maria's whiteboard (2026-11-01): the product row, ↳ one ASIN row per ASIN beneath it; a bundle = several product rows in one outlined box with one ↳ ASIN row. */}
      <div className="mt-2 space-y-1" data-testid="new-po-lines">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Lines as bought · ASIN rows beneath</span>
          <Button size="sm" variant="outline" className="h-7" onClick={addLine} data-testid="button-new-po-add-product"><Plus className="h-3.5 w-3.5 mr-1" /> Add line</Button>
        </div>
        <div className="rounded-md" style={hairline} data-testid="new-po-products">
          <div className={`${G_LINE} rounded-t-md bg-muted/40 px-2 py-1 text-[11px] font-medium text-muted-foreground`}>
            <span>SKU / UPC</span><span>Product name</span><span>Price</span><span className="text-right">Qty</span><span className="text-right" title="The retailer's pack — a 12-count is 12">Units / pack</span><span />
          </div>
          {boxes.map((box, bi) => {
            const errRows = box.lines.flatMap((l) => l.copies).filter((i) => touched && check.productErrors[i]);
            return (
              <div key={box.key} className="px-2 py-1.5" style={bi > 0 ? { borderTop: "0.5px solid hsl(var(--border))" } : undefined} data-testid={`new-po-box-${bi}`}>
                <div className={box.bundle ? "rounded-md px-2 py-1.5 ring-1 ring-stone-400/70 dark:ring-stone-500/60" : ""} data-testid={box.bundle ? `new-po-bundle-${bi}` : undefined}>
                  {box.bundle && <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Bundle — {box.lines.length} products → one ASIN</div>}
                  {box.lines.map((line) => {
                    const i = line.copies[0]; const p = form.products[i]; const split = line.copies.length > 1;
                    return (
                      <div key={line.line_id} className={`${G_LINE} py-0.5`} data-testid={`row-new-po-product-${i}`}>
                        <Input value={p.supplier_sku} onChange={(e) => setMany(line.copies, "supplier_sku", e.target.value)} placeholder="SKU / UPC" className={`h-8 text-xs ${mark(`products.${i}.supplier_sku`)}`} data-testid={`input-new-po-supplier_sku-${i}`} />
                        <Input value={p.product_name} onChange={(e) => setMany(line.copies, "product_name", e.target.value)} placeholder="Product name" className={`h-8 text-xs ${mark(`products.${i}.product_name`)}`} data-testid={`input-new-po-product_name-${i}`} />
                        <MoneyCalcInput value={p.price} onChange={(v) => setMany(line.copies, "price", v)} placeholder="price" className={`h-8 text-xs text-right ${mark(`products.${i}.price`)}`} data-testid={`input-new-po-price-${i}`} />
                        {split
                          ? <div className="flex h-8 items-center justify-end pr-1 text-xs" title={`Split across ${line.copies.length} ASIN rows — edit each row's ASIN qty`} data-testid={`new-po-qty-sum-${i}`}>{lineQty(form.products, line.copies)}</div>
                          : <Input value={p.qty_ordered} onChange={(e) => setP(i, "qty_ordered", e.target.value)} inputMode="decimal" placeholder="qty" title={hint(`products.${i}.qty_ordered`)} className={`h-8 text-xs text-right ${mark(`products.${i}.qty_ordered`)}`} data-testid={`input-new-po-qty_ordered-${i}`} />}
                        <Input value={p.retailer_units_per_pack ?? "1"} onChange={(e) => setMany(line.copies, "retailer_units_per_pack", e.target.value)} inputMode="numeric" className={`h-8 text-xs text-right ${mark(`products.${i}.retailer_units_per_pack`)}`} data-testid={`input-new-po-retailer_upp-${i}`} />
                        <button type="button" onClick={() => onRemoveLine(box.key, line.line_id)} disabled={form.products.length === line.copies.length} className="mt-2 text-muted-foreground/60 hover:text-destructive disabled:opacity-30" title="Remove line" data-testid={`button-new-po-remove-${i}`}><Trash2 className="h-3.5 w-3.5" /></button>
                      </div>
                    );
                  })}
                  {box.slots.map((slot, k) => {
                    const i = slot[0]; const p = form.products[i];
                    const units = slotUnits(form.products, slot, box.bundle); const frac = isFractional(units);
                    const anyQty = slot.some((j) => Number(form.products[j].qty_ordered) > 0);
                    const qty = Number(p.qty_ordered) || 0, r = Number(p.retailer_units_per_pack ?? "1") || 1, u = p.sold_as === "individual" ? 1 : Number(p.units_per_pack) || 1; // the math, shown on hover
                    const info = known.get(p.asin.toUpperCase());
                    const guess = p.asin.length === 10 && sources[`products.${i}.asin`] === "model" ? p.asin : null;
                    const manual = slot.some((j) => form.products[j].yield_manual);
                    return (
                      <div key={`${box.key}-${k}`} className={`${G_ASIN} py-0.5`} data-testid={`row-new-po-asin-${i}`}>
                        <span className="pt-1.5 text-center text-sm leading-none text-muted-foreground" aria-hidden>↳</span>
                        <AsinPicker value={p.asin} product={p.product_name} supplier={form.supplier} guess={guess} known={known} onPick={onPick(slot)} onChange={(v) => setMany(slot, "asin", v)} rowIndex={i} mark={mark(`products.${i}.asin`)} compact />
                        <div className="flex h-8 min-w-0 items-center truncate text-xs text-muted-foreground" title={info?.title ?? ""} data-testid={`new-po-asin-title-${i}`}>
                          {info?.in_af ? <><Database className="mr-1 h-2.5 w-2.5 shrink-0" /><span className="truncate">{info.title ?? "in AF"}</span></> : p.asin.length === 10 ? <span className="text-amber-600">Not in AF</span> : <span className="opacity-60">title from AF</span>}
                        </div>
                        <div>
                          <Input value={anyQty ? String(units) : ""} onChange={(e) => onSlotUnits(box.key, k, e.target.value)} inputMode="decimal" placeholder="ASIN qty" className={`h-8 text-xs text-right ${frac ? "font-semibold text-destructive" : ""}`} title={box.bundle ? `sets: the smallest member's qty × yield = ${units}` : `${qty} × ${r} ÷ ${u} = ${units}`} data-testid={`input-new-po-asin-qty-${i}`} />
                          {(frac || manual) && <div className={`mt-0.5 whitespace-nowrap text-[10px] ${frac ? "text-destructive" : "text-muted-foreground"}`} data-testid={frac ? `new-po-fractional-${i}` : undefined}>
                            {frac ? FRACTIONAL_UNITS_NOTE : "typed"}
                            {manual && <button type="button" className="ml-1 underline" onClick={() => onResetSlot(box.key, k)} title="Back to the pack math">reset</button>}
                          </div>}
                        </div>
                        {box.bundle
                          ? <div className="flex h-8 items-center text-xs" data-testid={`select-new-po-sold_as-${i}`}>bundle</div>
                          : <select value={p.sold_as} onChange={(e) => setMany(slot, "sold_as", e.target.value)} onBlur={() => onPackBlur(i)} className={`${sel} ${mark(`asin.${p.asin.toUpperCase()}`)}`} data-testid={`select-new-po-sold_as-${i}`}>
                              {SOLD_AS_OPTIONS.filter((o) => o !== "bundle" || p.sold_as === "bundle").map((o) => <option key={o} value={o}>{o}</option>)}
                            </select>}
                        <Input value={p.units_per_pack} disabled={p.sold_as === "individual"} onChange={(e) => setMany(slot, "units_per_pack", e.target.value)} onBlur={() => onPackBlur(i)} inputMode="numeric" title="ASIN units / pack" className={`h-8 text-xs text-right ${mark(`asin.${p.asin.toUpperCase()}`)}`} data-testid={`input-new-po-units_per_pack-${i}`} />
                        <MoneyCalcInput value={p.prep_cost} onChange={(v) => setMany(slot, "prep_cost", v)} placeholder="prep" className={`h-8 text-xs text-right ${mark("prep_cost")}`} data-testid={`input-new-po-prep_cost-${i}`} />
                        <Input value={p.notes ?? ""} onChange={(e) => setMany(slot, "notes", e.target.value)} placeholder="notes" className="h-8 text-xs" data-testid={`input-new-po-line-notes-${i}`} />
                        <button type="button" onClick={() => onRemoveAsin(box.key, k)} disabled={box.slots.length === 1} className="mt-2 text-muted-foreground/60 hover:text-destructive disabled:opacity-30" title="Remove this ASIN row" data-testid={`button-new-po-remove-asin-${i}`}><Trash2 className="h-3.5 w-3.5" /></button>
                        {k === box.slots.length - 1
                          ? <div className="flex h-8 items-center gap-3 whitespace-nowrap pl-1 text-[11px]">
                              <button type="button" className="text-primary hover:underline" onClick={() => onAddAsin(box.key)} data-testid={`button-new-po-add-asin-${bi}`}>+ Add ASIN</button>
                              <button type="button" className="text-primary hover:underline" onClick={() => onAddToBundle(box.key)} data-testid={`button-new-po-add-to-bundle-${bi}`}>+ Add product to bundle</button>
                            </div>
                          : <span />}
                      </div>
                    );
                  })}
                  {errRows.map((i) => <p key={i} className="ml-6 text-xs text-destructive" data-testid={`new-po-product-error-${i}`}>{form.products[i].asin || form.products[i].product_name || `row ${i + 1}`}: {check.productErrors[i].join(" · ")}</p>)}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* §6.5 / §7 ASIN rows with the three costs */}
      {check.asins.length > 0 && (
        <div className="mt-2 space-y-1">
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
                    <td className="px-2 py-0.5 font-mono text-xs">{a.asin}</td>
                    <td className="px-2 py-0.5 text-xs">{a.sold_as}{a.sold_as !== "individual" ? ` × ${a.units_per_pack}` : ""}</td>
                    <td className={`px-2 py-0.5 text-right ${isFractional(a.qty) ? "font-semibold text-destructive" : ""}`}>{a.qty}</td>
                    <td className="px-2 py-0.5 text-right">{a.lines.length}</td>
                    <td className="px-2 py-0.5 text-right font-mono text-xs" data-testid={`new-po-sourcing-${a.asin}`}>{a.sourcing_cost ?? "—"}</td>
                    <td className="px-2 py-0.5 text-right">
                      <MoneyCalcInput value={form.cost_overrides[a.asin] ?? ""} onChange={(v) => setOverride(a.asin, v)} placeholder={a.computed_cost_per_unit ?? "—"} className="h-7 w-24 text-right text-xs" data-testid={`input-new-po-cost-${a.asin}`} title={form.cost_overrides[a.asin] ? "typed" : `${a.sourcing_cost ?? "?"} × (1 − GC %)${a.cogs_adjustment ? ` + ${a.cogs_adjustment}` : ""}`} />
                    </td>
                    <td className="px-2 py-0.5 text-right font-mono text-xs">{a.paid_cost ?? "—"}</td>
                    <td className="px-2 py-0.5">
                      <span className="inline-flex items-center gap-1">
                        <MoneyCalcInput value={adj?.amount ?? ""} onChange={(v) => setAdj(a.asin, "amount", v)} placeholder="0.00" className="h-7 w-16 text-right text-xs" data-testid={`input-new-po-adj-${a.asin}`} />
                        <Input value={adj?.reason ?? ""} onChange={(e) => setAdj(a.asin, "reason", e.target.value)} placeholder="reason" className="h-7 w-32 text-xs" data-testid={`input-new-po-adj-reason-${a.asin}`} />
                      </span>
                    </td>
                    <td className="px-2 py-0.5 text-[10px] text-muted-foreground">{pu === true ? "updates ASIN in AF" : pu === false ? "this PO only" : ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* §7.2 promos and §8.2 payments — side by side */}
      <div className="mt-2 grid gap-4 md:grid-cols-2">
        <div className="space-y-1" data-testid="new-po-promos">
          <div className="flex items-center justify-between"><span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Promos</span><Button size="sm" variant="ghost" className="h-7" onClick={() => setForm((f) => ({ ...f, promos: [...(f.promos ?? []), emptyPromo()] }))} data-testid="button-new-po-add-promo"><Plus className="h-3.5 w-3.5 mr-1" /> Promo</Button></div>
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
        <div className="space-y-1" data-testid="new-po-payments">
          <div className="flex items-center justify-between"><span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Payments</span><Button size="sm" variant="ghost" className="h-7" onClick={() => setForm((f) => ({ ...f, payments: [...(f.payments ?? []), emptyPayment()] }))} data-testid="button-new-po-add-payment"><Plus className="h-3.5 w-3.5 mr-1" /> Payment</Button></div>
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

      {/* Warnings + errors */}
      <div className="mt-2 space-y-0.5 pb-2">
        {check.warnings.map((w) => <p key={w} data-testid="new-po-warning" className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400"><AlertTriangle className="h-3.5 w-3.5" />{w}</p>)}
        {touched && check.errors.length > 0 && (
          <ul className="list-disc pl-5 text-xs text-destructive" data-testid="new-po-errors">{check.errors.map((e) => <li key={e}>{e}</li>)}</ul>
        )}
        {serverErr && <p className="text-sm text-destructive" data-testid="new-po-server-error">{serverErr}</p>}
      </div>

      {/* Totals, then Cancel / Create PO — stay in view at the bottom of the page. */}
      <div className="sticky bottom-0 z-20 -mx-6 mt-auto flex items-center gap-2 border-t bg-background/95 px-6 py-2 pt-2 backdrop-blur" style={{ marginTop: "auto" }} data-testid="new-po-footer">
        <div className="flex flex-1 flex-wrap items-center gap-x-6 gap-y-1 text-sm" data-testid="new-po-totals">
          <div><span className="text-muted-foreground mr-1.5">Subtotal (Σ price × qty)</span><span className="font-mono">{money(check.computedSubtotal)}</span></div>
          <div><span className="text-muted-foreground mr-1.5">Order total</span><span className="font-mono">{money(check.effectiveOrderTotal)}</span></div>
          <div><span className="text-muted-foreground mr-1.5">ASIN units</span><span>{check.asins.reduce((t, a) => t + a.qty, 0)}</span></div>
          {check.nonCountingPromoAmount > 0 && <div><span className="text-muted-foreground mr-1.5">Added back (rewards)</span><span className="font-mono">{money(check.nonCountingPromoAmount)}</span></div>}
        </div>
        <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy} data-testid="button-new-po-cancel">Cancel</Button>
        <Button onClick={save} disabled={busy || (touched && !check.ok)} data-testid="button-new-po-save">{busy ? "Creating…" : "Create PO"}</Button>
      </div>
      <PackOverrideDialog ask={packAsk} onChoose={answerPack} />
    </div>
  );
}
