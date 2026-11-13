// Same-day tie-break for "newest PO" (patch docs/claude_spec-patch-po-af-owned.md,
// decision 2026-10-18). Newest = order_date DESC, entry_seq DESC NULLS LAST.
// Sheet-imported POs (history): total sheet data rows − the PO's FIRST row index
// (newest-first sheet ⇒ higher row = newer = larger), stored at import; the
// sheet reader that computed it left with Sync POs (2026-11-13). AF-created
// POs: creation epoch ms.

export const NEWEST_PO_ORDER = "p.order_date DESC, p.entry_seq DESC NULLS LAST, p.created_at DESC";

/** entry_seq for a PO created in AF. */
export const afEntrySeq = (now: Date = new Date()): number => now.getTime();
