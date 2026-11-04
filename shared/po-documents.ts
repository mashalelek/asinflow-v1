// PO documents — naming and linking rules (patch docs/claude_spec-patch-po-documents.md
// §2, D1–D3; Maria 2026-11-04). Pure: the Drive client, the link script, the
// ingest and the UI all name and match files through this file.
//
// Name (Orders sheet col AU): `YYYY-MM-DD_supplier_POID.pdf` — the PO's order
// date and AF's supplier name, verbatim. Shipped / delivered emails append
// `_shipped` / `_delivered`, a manual upload `_invoice` (D3); a second
// document of the same type gets `-2`, `-3`.

export type PoDocumentType = "order_confirmation" | "shipped" | "delivered" | "invoice_manual";
export type PoDocumentSource = "email" | "upload" | "linked_existing";

export const DOCUMENT_TYPES: readonly PoDocumentType[] = ["order_confirmation", "shipped", "delivered", "invoice_manual"];

export const DOCUMENT_TYPE_LABEL: Record<PoDocumentType, string> = {
  order_confirmation: "Order confirmation", shipped: "Shipped", delivered: "Delivered", invoice_manual: "Invoice",
};

const TYPE_SUFFIX: Record<PoDocumentType, string> = { order_confirmation: "", shipped: "_shipped", delivered: "_delivered", invoice_manual: "_invoice" };

/** YYYY-MM-DD of a PO order date. A pg DATE arrives as a JS Date at local midnight: local components, never toISOString (TZ shift). */
export function orderYmd(d: Date | string): string {
  if (typeof d === "string") { const m = /^(\d{4}-\d{2}-\d{2})/.exec(d); if (m) return m[1]; d = new Date(d); }
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** `YYYY-MM-DD_supplier_POID` — no type suffix, no extension (the PO Details "Invoice File Name" line). */
export function documentBaseName(po: { order_date: Date | string; supplier: string; order_id: string }): string {
  return `${orderYmd(po.order_date)}_${po.supplier}_${po.order_id}`;
}

/** The file name for the n-th (1-based) document of a type. */
export function documentFileName(base: string, type: PoDocumentType, n = 1): string {
  return `${base}${TYPE_SUFFIX[type]}${n > 1 ? `-${n}` : ""}.pdf`;
}

/** The first free file name for a type, given the names already taken (in the target folder and on the PO) — compared case-insensitively. */
export function nextDocumentFileName(base: string, type: PoDocumentType, taken: Iterable<string>): string {
  const t = new Set(Array.from(taken, (s) => s.toLowerCase()));
  for (let n = 1; ; n++) { const name = documentFileName(base, type, n); if (!t.has(name.toLowerCase())) return name; }
}

/** Drive folders (D1 / D2; Maria 2026-11-04 decision 4): the year folder, and the month folder under either spelling. */
export const yearFolderName = (ymd: string) => `Invoices - ${ymd.slice(0, 4)}`;
export const monthFolderName = (ymd: string) => `Invoices ${ymd.slice(0, 7)}`;
/** Existing month folders may be named `Receipts_YYYY-MM` (2025) — written to as they are; `Invoices YYYY-MM` is created only when neither exists. */
export const monthFolderNames = (ymd: string): string[] => [monthFolderName(ymd), `Receipts_${ymd.slice(0, 7)}`];

// ---- Linking existing PDFs (D1; Maria 2026-11-04 decisions 2, 3) ----

/** Lower case, every whitespace character removed, a trailing ".pdf" dropped. */
export const normName = (s: string): string => s.toLowerCase().replace(/\s+/g, "").replace(/\.pdf$/, "");

/** A linked file is an order confirmation unless its name ends `_shipped` / `_delivered` (before any `-N`). */
export function typeFromFileName(name: string): PoDocumentType {
  const n = normName(name).replace(/-\d+$/, "");
  if (n.endsWith("_shipped")) return "shipped";
  if (n.endsWith("_delivered")) return "delivered";
  return "order_confirmation";
}

export interface DriveFileLite { id: string; name: string; mimeType?: string | null; size?: number | null; path?: string }
export interface PoLite { id: string; order_date: Date | string; supplier: string; order_id: string }

export const isPdf = (f: DriveFileLite): boolean => f.mimeType === "application/pdf" || /\.pdf\s*$/i.test(f.name);

/** Rule 1: the §2 name, case- and space-insensitive, with an optional type suffix and `-N`. */
export function matchesExactName(file: string, base: string): boolean {
  const f = normName(file), b = normName(base);
  if (!f.startsWith(b)) return false;
  return /^(?:_(?:shipped|delivered|invoice))?(?:-\d+)?$/.test(f.slice(b.length));
}

const ORDER_CHARS = /[a-z0-9]/;
/** Rule 2: same order date as the name's prefix and the order # anywhere after it as a whole token (any supplier spelling). */
export function matchesLooseName(file: string, po: PoLite): boolean {
  const f = normName(file), ymd = orderYmd(po.order_date);
  if (!f.startsWith(ymd)) return false;
  const oid = po.order_id.toLowerCase().replace(/\s+/g, "");
  if (oid.length < 4) return false;
  for (let i = f.indexOf(oid, ymd.length); i >= 0; i = f.indexOf(oid, i + 1)) {
    const before = f[i - 1] ?? "", after = f[i + oid.length] ?? "";
    if (!ORDER_CHARS.test(before) && !ORDER_CHARS.test(after)) return true;
  }
  return false;
}

export interface LinkPlanEntry { po_id: string; file: DriveFileLite; type: PoDocumentType; rule: "name" | "loose" }
export interface LinkReviewEntry { po: PoLite; candidates: DriveFileLite[]; reason: "several_files" | "file_fits_several_pos" }
export interface LinkPlan { links: LinkPlanEntry[]; review: LinkReviewEntry[] }

/**
 * Which existing PDFs link to which POs. Rule 1 (the §2 name) links every
 * file it finds — a name in Drive twice links both. Otherwise rule 2, only
 * when exactly one file fits and that file fits no other PO; anything else
 * goes on the review list. Re-runs are no-ops: a file already linked
 * (`linked` ids) is never planned again, and a PO whose rule-2 file is
 * already linked is settled.
 */
export function planLinks(pos: readonly PoLite[], files: readonly DriveFileLite[], linked: ReadonlySet<string> = new Set()): LinkPlan {
  const byPrefix = new Map<string, DriveFileLite[]>();
  for (const f of files) { if (!isPdf(f)) continue; const k = normName(f.name).slice(0, 10); (byPrefix.get(k) ?? byPrefix.set(k, []).get(k)!).push(f); }
  const sameDay = (po: PoLite) => byPrefix.get(orderYmd(po.order_date)) ?? [];
  const exact = new Map<string, DriveFileLite[]>(), loose = new Map<string, DriveFileLite[]>();
  const taken = new Set<string>();
  for (const po of pos) {
    const base = documentBaseName(po);
    const hits = sameDay(po).filter((f) => matchesExactName(f.name, base));
    if (hits.length) { exact.set(po.id, hits); hits.forEach((f) => taken.add(f.id)); }
  }
  const fitsPos = new Map<string, number>();
  for (const po of pos) {
    if (exact.has(po.id)) continue;
    const c = sameDay(po).filter((f) => !taken.has(f.id) && matchesLooseName(f.name, po));
    if (c.length) { loose.set(po.id, c); c.forEach((f) => fitsPos.set(f.id, (fitsPos.get(f.id) ?? 0) + 1)); }
  }
  const plan: LinkPlan = { links: [], review: [] };
  for (const po of pos) {
    for (const f of exact.get(po.id) ?? []) if (!linked.has(f.id)) plan.links.push({ po_id: po.id, file: f, type: typeFromFileName(f.name), rule: "name" });
    const c = loose.get(po.id);
    if (!c || c.some((f) => linked.has(f.id))) continue;
    if (c.length > 1) plan.review.push({ po, candidates: c, reason: "several_files" });
    else if ((fitsPos.get(c[0].id) ?? 0) > 1) plan.review.push({ po, candidates: c, reason: "file_fits_several_pos" });
    else plan.links.push({ po_id: po.id, file: c[0], type: typeFromFileName(c[0].name), rule: "loose" });
  }
  return plan;
}
