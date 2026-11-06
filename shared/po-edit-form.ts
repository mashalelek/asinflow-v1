// Edit PO as a page (Maria 2026-11-04; SPEC §22 "Edit PO"). /pos/:id/edit
// renders the New PO form prefilled from the stored PO; Save sends the whole
// form back and the server turns the difference into the existing per-field
// editors (server/po-edit.ts, server/po-money-edit.ts), so every changed
// field writes its own History row exactly as the old editor did.
//
// This module is pure and runs on both sides:
//   - poToForm: the stored PO (header, ASIN rows with their lines, promos,
//     payments) → PoFormState. Every row keeps its id (line_item_id, id) so
//     the diff can tell an edit from an add or a removal. A line whose stored
//     yield the pack math cannot reproduce keeps that yield as a typed one,
//     so opening and saving an untouched PO writes nothing.
//   - editBlockingErrors: the form check's errors that the STORED PO does not
//     already have — an imported PO with a NULL price or a lopsided bundle
//     still saves a change elsewhere; a new problem blocks.
//   - planPoEdit: stored form vs edited form → the editor calls to make.
// No stored COGS / Sourcing / Paid value is recomputed here (CLAUDE.md,
// Maria 2026-10-31): a cost is written only when its field was changed; a
// v2 PO's costs follow the server's recomputePoCosts as with every edit.
import { checkPoForm, emptyPoForm, productRatio, productLineMoney, priceText, yieldFromPacks, SOLD_AS_OPTIONS, PROMO_IN_PRICES_QUESTION, type PoFormState, type PoFormProduct, type PoFormPromo, type PoFormPayment, type PoFormCheck, type SoldAs } from "./po-form";
import { ratioYield } from "./yield";

type Row = Record<string, any>;
export interface StoredPo { po: Row; asins: Array<Row & { lines: Row[] }>; payments: Row[]; promos: Row[] }

const str = (v: unknown): string => (v == null ? "" : String(v).trim());
const moneyText = (v: unknown): string => { if (v == null || v === "") return ""; const n = Number(v); return Number.isFinite(n) ? n.toFixed(2) : String(v); };
const isWholeCents = (v: unknown): boolean => { const n = Number(v); return v == null || v === "" || !Number.isFinite(n) || Math.abs(n * 100 - Math.round(n * 100)) < 1e-6; };
const numText = (v: unknown): string => { if (v == null || v === "") return ""; const n = Number(v); return Number.isFinite(n) ? String(n) : String(v); };
/** YYYY-MM-DD for a pg DATE (a local-midnight Date or an ISO string). */
export function ymdOfStored(v: unknown): string {
  if (v instanceof Date) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`;
  const s = String(v ?? "");
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  if (m && !s.includes("T")) return m[1];
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? "" : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const soldAsOf = (v: unknown): SoldAs => ((SOLD_AS_OPTIONS as readonly string[]).includes(String(v)) ? (String(v) as SoldAs) : "individual");

/** A sheet-imported PO (cost_formula_version NULL): its stored costs are shown as stored and never recomputed. */
export const isImportedPo = (po: Row): boolean => po.cost_formula_version == null;

/** The stored PO as the New PO form's state. */
export function poToForm(d: StoredPo): PoFormState {
  const po = d.po;
  const base = emptyPoForm(ymdOfStored(po.order_date));
  const products: PoFormProduct[] = [];
  for (const a of d.asins) {
    const soldAs = soldAsOf(a.sold_as);
    const upp = soldAs === "individual" ? "1" : str(a.units_per_pack);
    const pk = soldAs === "individual" ? 1 : Number(upp) || 1;
    for (const l of a.lines ?? []) {
      const R = Number(l.retailer_units_per_product), U = Number(l.asin_units_per_pack);
      let retailer = "1", yieldManual = false, y: string;
      if (Number.isInteger(R) && R > 0 && Number.isInteger(U) && U > 0) {
        if ((R * pk) % U === 0) { retailer = String((R * pk) / U); y = yieldFromPacks(retailer, upp, soldAs); }
        else { retailer = String(R); yieldManual = true; y = ratioYield({ retailer: R, asinUnits: U }); }
      } else { yieldManual = true; y = numText(l.asin_qty_per_product) || "1"; }
      products.push({
        line_item_id: String(l.id), line_id: `l-${l.id}`, ...(soldAs === "bundle" ? { bundle_id: `b-${a.id}` } : {}),
        // A stored line total (migration 087) shows its price to the cent; a price typed past the cent shows as typed.
        product_name: str(l.product_name), supplier_sku: str(l.supplier_sku), price: l.line_total != null || isWholeCents(l.price) ? moneyText(l.price) : numText(l.price), qty_ordered: numText(l.qty_ordered),
        ...(l.line_total != null ? { line_total: moneyText(l.line_total) } : {}),
        ...(l.regular_price != null ? { regular_price: isWholeCents(l.regular_price) ? moneyText(l.regular_price) : numText(l.regular_price) } : {}),
        retailer_units_per_pack: retailer, asin: str(a.asin).toUpperCase(), asin_qty_per_product: y, yield_manual: yieldManual,
        sold_as: soldAs, units_per_pack: upp, prep_cost: moneyText(a.prep_cost), notes: str(l.notes),
      });
    }
  }
  const form: PoFormState = {
    ...base,
    supplier: str(po.supplier), order_id: str(po.order_id), order_date: ymdOfStored(po.order_date),
    subtotal: moneyText(po.subtotal), tax: moneyText(po.tax), sh_donations: moneyText(po.sh_donations), discount: moneyText(po.discount),
    refund_amount: moneyText(po.refund_amount), order_total: moneyText(po.order_total),
    payment_method: str(po.payment_method), weighted_gc_discount_pct: numText(po.weighted_gc_discount_pct),
    cashback_site: str(po.cashback_site), cashback_pct: numText(po.cashback_pct), purchased_by: str(po.purchased_by), notes: str(po.notes),
    ships_to: po.ships_to === "home" ? "home" : "velocity",
    email_used: str(po.email_used), alt_order_ids: str(po.alt_order_ids), purchased_by_user_id: po.purchased_by_user_id == null ? "" : String(po.purchased_by_user_id), cashback_status: str(po.cashback_status),
    subscription: { present: po.subscription === true, frequency_weeks: "" },
    products, cost_overrides: {}, cogs_adjustments: {}, pack_updates: {},
    promos: d.promos.map((p): PoFormPromo => ({ id: Number(p.id), type: (["sale", "coupon", "rewards"].includes(String(p.type)) ? p.type : "") as PoFormPromo["type"], description: str(p.description), amount: moneyText(p.amount), percent: numText(p.percent), counts_toward_cogs: p.counts_toward_cogs !== false, in_line_prices: typeof p.in_line_prices === "boolean" ? p.in_line_prices : null, ...(p.position != null ? { position: Number(p.position) } : {}) })),
    payments: d.payments.map((p): PoFormPayment => ({ id: Number(p.id), method: str(p.method) as PoFormPayment["method"], nickname: str(p.nickname), last4: str(p.last4), amount: moneyText(p.amount), gift_card_discount_pct: numText(p.gift_card_discount_pct), reward_pct: numText(p.reward_pct) })),
  };
  for (const a of d.asins) {
    const asin = str(a.asin).toUpperCase();
    if (a.cogs_adjustment != null) form.cogs_adjustments![asin] = { amount: moneyText(a.cogs_adjustment), reason: str(a.cogs_adjustment_reason) };
  }
  // COGS: an imported PO shows its stored cost / unit as the field's value (never the formula's); a v2 PO only where it differs from the formula (a typed one).
  const computed = isImportedPo(po) ? null : checkPoForm(form);
  for (const a of d.asins) {
    const asin = str(a.asin).toUpperCase();
    if (a.cost_per_unit == null) continue;
    const stored = moneyText(a.cost_per_unit);
    const formula = computed?.asins.find((x) => x.asin === asin)?.computed_cost_per_unit ?? null;
    if (computed == null || formula !== stored) form.cost_overrides[asin] = stored;
  }
  return form;
}

/** The stored Sourcing / COGS / Paid per ASIN, shown on an imported PO's rows instead of the formula's. */
export function storedAsinCosts(d: StoredPo): Record<string, { sourcing_cost: string | null; cost_per_unit: string | null; paid_cost: string | null }> {
  const out: Record<string, { sourcing_cost: string | null; cost_per_unit: string | null; paid_cost: string | null }> = {};
  for (const a of d.asins) out[str(a.asin).toUpperCase()] = { sourcing_cost: moneyText(a.sourcing_cost) || null, cost_per_unit: moneyText(a.cost_per_unit) || null, paid_cost: moneyText(a.paid_cost) || null };
  return out;
}

const rowLabel = (p: PoFormProduct | undefined, i: number) => (p?.asin || p?.product_name || `row ${i + 1}`);
/** The check's errors the stored PO does not already carry (by message; a product's by its line id). Pure. */
export function editBlockingErrors(stored: PoFormState, next: PoFormState, sc: PoFormCheck = checkPoForm(stored), nc: PoFormCheck = checkPoForm(next), opts: { imported?: boolean } = {}): { errors: string[]; productErrors: Record<number, string[]> } {
  // "Which promos are already in the prices?" always blocks (2026-11-06) — except on a sheet-imported PO, whose costs are never recomputed.
  const errors = nc.errors.filter((e) => (e.startsWith(PROMO_IN_PRICES_QUESTION) ? !opts.imported : !sc.errors.includes(e)));
  const idx = new Map(stored.products.map((p, i) => [p.line_item_id, i] as const));
  const productErrors: Record<number, string[]> = {};
  for (const [k, msgs] of Object.entries(nc.productErrors)) {
    const i = Number(k), id = next.products[i]?.line_item_id;
    const base = id != null && idx.has(id) ? sc.productErrors[idx.get(id)!] ?? [] : [];
    const fresh = msgs.filter((m) => !base.includes(m));
    if (fresh.length) productErrors[i] = fresh;
  }
  return { errors: [...errors, ...Object.entries(productErrors).map(([i, m]) => `${rowLabel(next.products[Number(i)], Number(i))}: ${m.join("; ")}`)], productErrors };
}

export interface PoEditPlan {
  errors: string[];
  header: Record<string, string>;
  lineEdits: Array<{ id: string; body: Record<string, unknown> }>;
  lineAdds: Array<Record<string, unknown>>;
  lineRemoves: string[];
  asinEdits: Array<{ asin: string; body: Record<string, unknown>; isNew: boolean }>;
  promoAdds: Array<Record<string, unknown>>; promoEdits: Array<{ id: number; body: Record<string, unknown> }>; promoRemoves: number[];
  paymentAdds: Array<Record<string, unknown>>; paymentEdits: Array<{ id: number; body: Record<string, unknown> }>; paymentRemoves: number[];
  packUpdates: Array<{ asin: string; sold_as: string; units_per_pack: number }>;
  /** Nothing to write. */
  empty: boolean;
}

/** Header fields the form edits, in HEADER_FIELDS order (server/po-edit.ts). */
export const EDIT_HEADER_KEYS = ["supplier", "order_id", "order_date", "subtotal", "tax", "sh_donations", "discount", "refund_amount", "order_total", "weighted_gc_discount_pct", "cashback_site", "cashback_pct", "purchased_by", "purchased_by_user_id", "notes", "email_used", "cashback_status", "ships_to", "alt_order_ids"] as const;
const NUMERIC = new Set(["subtotal", "tax", "sh_donations", "discount", "refund_amount", "order_total", "weighted_gc_discount_pct", "cashback_pct", "price", "line_total", "qty_ordered", "amount", "percent", "gift_card_discount_pct", "prep_cost", "cogs_adjustment", "cost_per_unit", "units_per_pack"]);
/** The comparable text of a form value: trimmed; a number without $ , % and trailing zeros. */
export function canonField(key: string, v: unknown): string {
  const s = str(v);
  if (!NUMERIC.has(key)) return s;
  const n = s.replace(/[$,%\s]/g, "");
  return /^-?\d+(\.\d+)?$/.test(n) ? String(Number(n)) : s;
}

/** The header values the form saves: a blank subtotal / order total is the computed one, Weighted GC % follows the gift-card payments when they carry one. */
function headerValues(f: PoFormState, c: PoFormCheck): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of EDIT_HEADER_KEYS) out[k] = str((f as any)[k]);
  if (out.subtotal === "") out.subtotal = c.computedSubtotal.toFixed(2);
  if (out.order_total === "") out.order_total = c.effectiveOrderTotal.toFixed(2);
  if (c.weightedGcPct != null) out.weighted_gc_discount_pct = c.weightedGcPct.toFixed(2);
  return out;
}

const LINE_TEXT = ["product_name", "supplier_sku", "notes"] as const;
const RATIO_INPUTS = ["qty_ordered", "retailer_units_per_pack", "units_per_pack", "sold_as", "asin_qty_per_product"] as const;

/** Stored form vs edited form → the editor calls. `imported`: the PO's costs are the sheet's (a cleared COGS goes blank, never to the formula). */
export function planPoEdit(stored: PoFormState, next: PoFormState, opts: { imported: boolean }): PoEditPlan {
  const sc = checkPoForm(stored), nc = checkPoForm(next);
  const plan: PoEditPlan = { errors: editBlockingErrors(stored, next, sc, nc, opts).errors, header: {}, lineEdits: [], lineAdds: [], lineRemoves: [], asinEdits: [], promoAdds: [], promoEdits: [], promoRemoves: [], paymentAdds: [], paymentEdits: [], paymentRemoves: [], packUpdates: [], empty: true };

  const hs = headerValues(stored, sc), hn = headerValues(next, nc);
  for (const k of EDIT_HEADER_KEYS) if (canonField(k, hs[k]) !== canonField(k, hn[k])) plan.header[k] = hn[k];

  // Lines, by their stored id; a row without one (or a second row claiming the same id) is new.
  const storedById = new Map(stored.products.filter((p) => p.line_item_id).map((p) => [p.line_item_id!, p] as const));
  const seen = new Set<string>();
  for (const p of next.products) {
    const id = p.line_item_id;
    const r = productRatio(p);
    if (id && storedById.has(id) && !seen.has(id)) {
      seen.add(id);
      const s = storedById.get(id)!;
      const body: Record<string, unknown> = {};
      for (const k of LINE_TEXT) if (str(p[k]) !== str(s[k])) body[k] = str(p[k]);
      if (canonField("price", p.price) !== canonField("price", s.price)) body.price = str(p.price);
      if (canonField("qty_ordered", p.qty_ordered) !== canonField("qty_ordered", s.qty_ordered)) body.qty_ordered = str(p.qty_ordered);
      if (canonField("line_total", p.line_total) !== canonField("line_total", s.line_total)) {
        body.line_total = str(p.line_total);
        // A dropped line total takes the price as shown (the stored one may carry more decimals than the field).
        if (str(p.line_total) === "" && !("price" in body)) body.price = str(p.price);
      }
      if (canonField("price", p.regular_price) !== canonField("price", s.regular_price)) body.regular_price = str(p.regular_price);
      if (str(p.asin).toUpperCase() !== str(s.asin).toUpperCase()) body.asin = str(p.asin).toUpperCase();
      const ratioTouched = RATIO_INPUTS.some((k) => canonField(k, p[k]) !== canonField(k, s[k])) || (p.yield_manual === true) !== (s.yield_manual === true);
      if (ratioTouched) { const sr = productRatio(s); if (r.retailer * sr.asinUnits !== sr.retailer * r.asinUnits || r.asinUnits !== sr.asinUnits) { body.retailer_units_per_product = r.retailer; body.asin_units_per_pack = r.asinUnits; } }
      if (Object.keys(body).length) plan.lineEdits.push({ id, body });
    } else {
      const lm = productLineMoney(p);
      plan.lineAdds.push({ asin: str(p.asin).toUpperCase(), qty_ordered: str(p.qty_ordered), product_name: str(p.product_name), supplier_sku: str(p.supplier_sku), price: lm?.lineTotal != null ? priceText(lm.unit) : str(p.price), ...(lm?.lineTotal != null ? { line_total: lm.lineTotal.toFixed(2) } : {}), ...(str(p.regular_price) ? { regular_price: str(p.regular_price) } : {}), notes: str(p.notes), retailer_units_per_product: r.retailer, asin_units_per_pack: r.asinUnits });
    }
  }
  for (const id of Array.from(storedById.keys())) if (!seen.has(id)) plan.lineRemoves.push(id);

  // ASIN rows: sold as, units / pack, prep, COGS (only when its field changed), the adjustment.
  for (const a of nc.asins) {
    const s = sc.asins.find((x) => x.asin === a.asin);
    const body: Record<string, unknown> = {};
    const want = { sold_as: a.sold_as, units_per_pack: String(a.units_per_pack), prep_cost: a.prep_cost };
    if (!s) Object.assign(body, want);
    else for (const k of ["sold_as", "units_per_pack", "prep_cost"] as const) if (canonField(k, want[k]) !== canonField(k, k === "units_per_pack" ? String(s.units_per_pack) : s[k])) body[k] = want[k];
    const ovN = canonField("cost_per_unit", next.cost_overrides?.[a.asin]), ovS = canonField("cost_per_unit", stored.cost_overrides?.[a.asin]);
    if (!s) { if (ovN !== "") body.cost_per_unit = str(next.cost_overrides[a.asin]); else if (opts.imported && a.computed_cost_per_unit) body.cost_per_unit = a.computed_cost_per_unit; }
    else if (ovN !== ovS) body.cost_per_unit = ovN !== "" ? str(next.cost_overrides[a.asin]) : opts.imported ? "" : a.computed_cost_per_unit ?? "";
    const adjN = next.cogs_adjustments?.[a.asin], adjS = stored.cogs_adjustments?.[a.asin];
    if (canonField("cogs_adjustment", adjN?.amount) !== canonField("cogs_adjustment", adjS?.amount)) body.cogs_adjustment = str(adjN?.amount);
    if (str(adjN?.reason) !== str(adjS?.reason)) body.cogs_adjustment_reason = str(adjN?.reason);
    if (Object.keys(body).length) plan.asinEdits.push({ asin: a.asin, body, isNew: !s });
    if (next.pack_updates?.[a.asin] === true) plan.packUpdates.push({ asin: a.asin, sold_as: a.sold_as, units_per_pack: a.units_per_pack });
  }

  // Promos and payments, by id.
  const moneyRows = <T extends { id?: number }>(sRows: T[], nRows: T[], keys: readonly (keyof T & string)[], adds: Array<Record<string, unknown>>, edits: Array<{ id: number; body: Record<string, unknown> }>, removes: number[]) => {
    const byId = new Map(sRows.filter((r) => r.id != null).map((r) => [r.id!, r] as const));
    const kept = new Set<number>();
    for (const r of nRows) {
      const vals = Object.fromEntries(keys.map((k) => [k, typeof r[k] === "boolean" ? r[k] : str(r[k])]));
      const s = r.id != null ? byId.get(r.id) : undefined;
      if (!s || kept.has(r.id!)) { adds.push(vals); continue; }
      kept.add(r.id!);
      const body: Record<string, unknown> = {};
      for (const k of keys) { const a = r[k], b = s[k]; if (typeof a === "boolean" ? a !== b : canonField(k, a) !== canonField(k, b)) body[k] = vals[k]; }
      if (Object.keys(body).length) edits.push({ id: r.id!, body });
    }
    for (const id of Array.from(byId.keys())) if (!kept.has(id)) removes.push(id);
  };
  // Promo sequence (2026-11-06): reordered in the form → every promo takes its form position; otherwise positions are left alone.
  const sPromos = stored.promos ?? [], nPromos = next.promos ?? [];
  const sIds = new Set(sPromos.map((p) => p.id)), nIds = new Set(nPromos.map((p) => p.id));
  const reordered = sPromos.filter((p) => p.id != null && nIds.has(p.id)).map((p) => p.id).join() !== nPromos.filter((p) => p.id != null && sIds.has(p.id)).map((p) => p.id).join();
  moneyRows(sPromos, reordered ? nPromos.map((p, i) => ({ ...p, position: i })) : nPromos, ["type", "description", "amount", "percent", "counts_toward_cogs", "in_line_prices", ...(reordered ? ["position" as const] : [])], plan.promoAdds, plan.promoEdits, plan.promoRemoves);
  moneyRows(stored.payments ?? [], next.payments ?? [], ["method", "nickname", "last4", "amount", "gift_card_discount_pct", "reward_pct"], plan.paymentAdds, plan.paymentEdits, plan.paymentRemoves);

  plan.empty = Object.keys(plan.header).length + plan.lineEdits.length + plan.lineAdds.length + plan.lineRemoves.length + plan.asinEdits.length
    + plan.promoAdds.length + plan.promoEdits.length + plan.promoRemoves.length + plan.paymentAdds.length + plan.paymentEdits.length + plan.paymentRemoves.length + plan.packUpdates.length === 0;
  return plan;
}
