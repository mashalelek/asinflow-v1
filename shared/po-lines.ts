// New PO form — the line layout (Maria's whiteboard, 2026-11-01; SPEC §22
// "New PO form"). The form's state stays the flat PoFormProduct list that
// checkPoForm and the server read (one row per product × ASIN); this module
// is the pure layer that groups those rows for the screen and edits them in
// step:
//   - a LINE is a retailer product as bought (SKU / UPC · name · price · qty ·
//     units / pack); its rows share `line_id`. One row = one ASIN beneath it;
//     several rows = a split (one product → several ASINs), each row holding
//     that ASIN's share of the qty.
//   - a BUNDLE is several lines in one box sharing `bundle_id`, with one ASIN
//     row beneath the group (slot k = the k-th row of every member line).
// Three shapes on the whiteboard: one product → two ASINs (a split), two
// products → one ASIN (a bundle), one product → one ASIN (the plain line).
import { yieldFromPacks, type PoFormProduct } from "./po-form";

export interface LineBox {
  /** bundle_id for a bundle, else the line_id. */
  key: string;
  bundle: boolean;
  /** The product lines in the box, each with its rows' indexes (slot order). */
  lines: Array<{ line_id: string; copies: number[] }>;
  /** The ASIN rows beneath: slot k = the k-th copy of every line that has one. */
  slots: number[][];
}

let seq = 0;
export const newLineId = (): string => `L${(seq++).toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const r2 = (x: number) => Math.round(x * 100) / 100;
const r4 = (x: number) => Math.round(x * 10000) / 10000;

/** Every row carries a line_id (a prefill or an older form has none): row i without one gets `l<i>`. */
export function ensureLineIds(products: PoFormProduct[]): PoFormProduct[] {
  if (products.every((p) => p.line_id)) return products;
  const used = new Set(products.map((p) => p.line_id).filter(Boolean));
  return products.map((p, i) => { if (p.line_id) return p; let id = `l${i}`; while (used.has(id)) id = `${id}x`; used.add(id); return { ...p, line_id: id }; });
}

/** Group the flat rows into boxes (first-appearance order), lines and ASIN slots. */
export function groupLines(products: readonly PoFormProduct[]): LineBox[] {
  const boxes = new Map<string, LineBox>();
  products.forEach((p, i) => {
    const lineId = p.line_id ?? `l${i}`;
    const key = p.bundle_id || lineId;
    let box = boxes.get(key);
    if (!box) { box = { key, bundle: !!p.bundle_id, lines: [], slots: [] }; boxes.set(key, box); }
    let line = box.lines.find((l) => l.line_id === lineId);
    if (!line) { line = { line_id: lineId, copies: [] }; box.lines.push(line); }
    line.copies.push(i);
  });
  for (const box of Array.from(boxes.values())) {
    const n = Math.max(0, ...box.lines.map((l) => l.copies.length));
    for (let k = 0; k < n; k++) box.slots.push(box.lines.flatMap((l) => (l.copies[k] == null ? [] : [l.copies[k]])));
  }
  return Array.from(boxes.values());
}

/** The line's qty: one row = its qty; a split = Σ its rows' shares. */
export function lineQty(products: readonly PoFormProduct[], copies: readonly number[]): number {
  return r2(copies.reduce((t, i) => t + (Number(products[i]?.qty_ordered) || 0), 0));
}
/** ASIN units of one row: qty × yield. */
export const copyUnits = (p: PoFormProduct): number => r2((Number(p.qty_ordered) || 0) * (Number(p.asin_qty_per_product) || 0));
/** What an ASIN row shows: a plain line's row = its units; a bundle slot = the sets (the smallest member's units). */
export function slotUnits(products: readonly PoFormProduct[], slot: readonly number[], bundle: boolean): number {
  const u = slot.map((i) => copyUnits(products[i]));
  if (u.length === 0) return 0;
  return bundle ? Math.min(...u) : u[0];
}
/** A fractional ASIN qty must not pass silently (red text + "check qty or pack size"); saving is still allowed. */
export const FRACTIONAL_UNITS_NOTE = "check qty or pack size";
export const isFractional = (units: number): boolean => units > 0 && Math.abs(units - Math.round(units)) > 1e-9;

/**
 * Typing an ASIN row's qty. A line with ONE ASIN row keeps the qty as bought
 * and pins the yield (units ÷ qty); a split sets that row's share of the qty
 * (units ÷ yield); a bundle does the same per member (sets ÷ member's yield,
 * or the member's yield = sets ÷ its qty when it has one slot).
 */
export function setSlotUnits(products: PoFormProduct[], box: LineBox, k: number, units: string): PoFormProduct[] {
  const u = Number(units);
  const slot = box.slots[k] ?? [];
  return products.map((p, i) => {
    if (!slot.includes(i)) return p;
    const line = box.lines.find((l) => l.copies.includes(i));
    const single = (line?.copies.length ?? 1) === 1;
    if (single) {
      const qty = Number(p.qty_ordered) || 0;
      return qty > 0 && u > 0 ? { ...p, yield_manual: true, asin_qty_per_product: String(r4(u / qty)) } : { ...p, yield_manual: true };
    }
    const y = Number(p.asin_qty_per_product) || 1;
    return { ...p, qty_ordered: u > 0 ? String(r2(u / y)) : "" };
  });
}
/** Back to the pack math for the rows of a slot. */
export function resetSlotYield(products: PoFormProduct[], slot: readonly number[]): PoFormProduct[] {
  return products.map((p, i) => (slot.includes(i) ? { ...p, yield_manual: false, asin_qty_per_product: yieldFromPacks(p.retailer_units_per_pack, p.units_per_pack, p.sold_as) } : p));
}

const lastIndex = (box: LineBox): number => Math.max(...box.lines.flatMap((l) => l.copies));
const insertAfter = (products: PoFormProduct[], at: number, rows: PoFormProduct[]): PoFormProduct[] => [...products.slice(0, at + 1), ...rows, ...products.slice(at + 1)];
/** A fresh ASIN row from a line's first row: no ASIN, no share yet, the pack math's yield. */
function blankCopy(src: PoFormProduct, bundle: boolean): PoFormProduct {
  const sold_as = bundle ? "bundle" : "individual";
  const units_per_pack = bundle ? (Number(src.units_per_pack) >= 2 ? src.units_per_pack : "2") : "1";
  return { ...src, asin: "", qty_ordered: "", yield_manual: false, sold_as, units_per_pack, asin_qty_per_product: yieldFromPacks(src.retailer_units_per_pack, units_per_pack, sold_as), notes: "" };
}

/** "+ Add ASIN": one more ASIN row beneath the line (a split) — for a bundle, one more slot (a row per member). */
export function addAsinRow(products: PoFormProduct[], box: LineBox): PoFormProduct[] {
  const rows = box.lines.map((l) => blankCopy(products[l.copies[0]], box.bundle));
  return insertAfter(products, lastIndex(box), rows);
}
/** "+ Add product to bundle": a plain line becomes a bundle box (its rows sold as bundle, units / pack ≥ 2) and gains a member; a bundle gains a member (a row per slot, same ASIN). */
export function addProductToBundle(products: PoFormProduct[], box: LineBox): PoFormProduct[] {
  const bundleId = box.key;
  const slots = box.slots.length || 1;
  let out = products.map((p, i) => {
    if (!box.lines.some((l) => l.copies.includes(i))) return p;
    const units_per_pack = Number(p.units_per_pack) >= 2 ? p.units_per_pack : "2";
    const next: PoFormProduct = { ...p, bundle_id: bundleId, sold_as: "bundle", units_per_pack };
    if (!next.yield_manual) next.asin_qty_per_product = yieldFromPacks(next.retailer_units_per_pack, units_per_pack, "bundle");
    return next;
  });
  const lineId = newLineId();
  const rows: PoFormProduct[] = [];
  for (let k = 0; k < slots; k++) {
    const src = out[box.slots[k]?.[0] ?? box.lines[0].copies[0]];
    rows.push({ ...blankCopy({ ...src, product_name: "", supplier_sku: "", price: "", retailer_units_per_pack: "1" }, true), asin: src.asin, units_per_pack: src.units_per_pack, asin_qty_per_product: yieldFromPacks("1", src.units_per_pack, "bundle"), line_id: lineId, bundle_id: bundleId });
  }
  out = insertAfter(out, lastIndex(box), rows);
  return out;
}
/** Remove one ASIN row (slot k) — every member's k-th row. A line left with no row is gone with it. */
export function removeAsinRow(products: PoFormProduct[], box: LineBox, k: number): PoFormProduct[] {
  const gone = new Set(box.slots[k] ?? []);
  return degrade(products.filter((_, i) => !gone.has(i)), box.key);
}
/** Remove a product line with all its rows. */
export function removeLine(products: PoFormProduct[], box: LineBox, lineId: string): PoFormProduct[] {
  const gone = new Set(box.lines.find((l) => l.line_id === lineId)?.copies ?? []);
  return degrade(products.filter((_, i) => !gone.has(i)), box.key);
}
/** A bundle left with one member is a plain line again (sold as individual, units / pack 1). */
function degrade(products: PoFormProduct[], bundleKey: string): PoFormProduct[] {
  const members = new Set(products.filter((p) => p.bundle_id === bundleKey).map((p) => p.line_id));
  if (members.size !== 1) return products;
  return products.map((p) => {
    if (p.bundle_id !== bundleKey) return p;
    const next: PoFormProduct = { ...p, sold_as: "individual", units_per_pack: "1" };
    delete next.bundle_id;
    if (!next.yield_manual) next.asin_qty_per_product = yieldFromPacks(next.retailer_units_per_pack, "1", "individual");
    return next;
  });
}
