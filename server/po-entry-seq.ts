// Same-day tie-break for "newest PO" (patch docs/claude_spec-patch-po-af-owned.md,
// decision 2026-10-18). Newest = order_date DESC, entry_seq DESC NULLS LAST.
// Sheet POs: total sheet data rows − the PO's FIRST row index (newest-first
// sheet ⇒ higher row = newer = larger). AF-created POs: creation epoch ms.
import { COL, t } from "./po-import-classify";

export const NEWEST_PO_ORDER = "p.order_date DESC, p.entry_seq DESC NULLS LAST, p.created_at DESC";

/** (supplier, order_id) → entry_seq, from the raw A2:AZ cells (row 0 = sheet row 2). */
export function sheetEntrySeqByKey(dataCells: string[][]): Map<string, number> {
  const out = new Map<string, number>();
  const total = dataCells.length;
  for (let i = 0; i < dataCells.length; i++) {
    const c = dataCells[i];
    let supplier = t(c[COL.supplier]);
    if (supplier === "shop.tetleyusa.com / WorldPantry.com") supplier = "shop.tetleyusa.com";
    const orderId = t(c[COL.orderId]);
    if (!orderId) continue;
    const k = `${supplier}\u0000${orderId}`; // = poKey (po-sheet-sync) — inlined to avoid an import cycle
    if (!out.has(k)) out.set(k, total - i);
  }
  return out;
}

/** entry_seq for a PO created in AF. */
export const afEntrySeq = (now: Date = new Date()): number => now.getTime();
