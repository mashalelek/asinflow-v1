/**
 * Update COGS in SC — the 3-step dialog's state and words (Maria 2026-11-12; the mockups
 * docs/mockups/update-cogs-in-sc-dialog-before-2026-11-12.html and …-after-step-2-2026-11-12.html are the spec for
 * layout, wording and look). The three steps are usable at any time, in any order; nothing is gated.
 *   1. Download Amazon's template — Open Seller Central ↗ (new tab, rel=noopener) marks the step done.
 *   2. Upload Amazon's template to AsinFlow — choosing a file fills it with today's logic (POST /api/export/sourcing-cost,
 *      the selected date range) and downloads the result; done shows "<filename> has been updated and downloaded" and
 *      the closed Report dropdown.
 *   3. Upload COGS to Seller Central — the same link; clicking it marks the step done.
 * The state lives in the ASINs page for the session: closing and reopening keeps it; a new file chosen resets step 2 only.
 */

export const SC_BULK_UPDATE_URL = "https://sellercentral.amazon.com/inventory-reimbursement/sourcing-cost-bulk-update";

// The fill's summary (the /api/export/sourcing-cost response, unchanged).
export type ScSummary = {
  from: string; to: string; rowsWritten: number; asinsWritten: number; purchasedAsins: number; asinsWithPoCogs: number;
  sheetsScanned: number; workbookRowsRead: number; workbookAsins: number; rawRowsRead: number; blankAsinRows: number; includedRows: number;
  skips: { excludedByStatus: number; badDate: number; outOfRange: number; noCogsRow: number; notPoSourced: number; badCost: number; notInWorkbook: number; alreadyApproved: number; wouldLowerApproved: number };
  noCogsRowAsins: string[];
  notPoSourcedAsins: { asin: string; source: string | null }[];
  badCostAsins: { asin: string; cogs: string }[];
  notInWorkbookAsins: string[];
  alreadyApprovedAsins: string[];
  wouldLowerAsins: { asin: string; approved: number; cost: number; source: string | null }[];
  written: { asin: string; fnskus: string[]; cost: number; wasApproved: number | null; source: string | null }[];
};

export interface ScFill { filename: string; summary: ScSummary }
export interface ScDialogState { templateOpened: boolean; fill: ScFill | null; uploaded: boolean }
export type ScDialogAction = { type: "opened_template" } | { type: "filled"; fill: ScFill } | { type: "opened_upload" } | { type: "new_file" };

export const SC_DIALOG_INITIAL: ScDialogState = { templateOpened: false, fill: null, uploaded: false };

/** Each step completes on its own, in any order; a new file chosen resets step 2 only (steps 1 and 3 keep their ✓, Maria 2026-11-12) and step 2 completes again when its fill lands. */
export function scDialogReduce(s: ScDialogState, a: ScDialogAction): ScDialogState {
  switch (a.type) {
    case "opened_template": return { ...s, templateOpened: true };
    case "filled": return { ...s, fill: a.fill };
    case "opened_upload": return { ...s, uploaded: true };
    case "new_file": return { ...s, fill: null };
  }
}

export const stepDone = (s: ScDialogState, step: 1 | 2 | 3): boolean => (step === 1 ? s.templateOpened : step === 2 ? s.fill != null : s.uploaded);

/** Step 3's line: the filled file's name once there is one. */
export function step3Text(s: ScDialogState): { before: string; filename: string | null; after: string } {
  return s.fill ? { before: "Upload ", filename: s.fill.filename, after: " under Sourcing Cost Bulk Update." } : { before: "Upload the filled template under Sourcing Cost Bulk Update.", filename: null, after: "" };
}

/** Step 2's line once done. */
export const filledText = (fill: ScFill) => ({ filename: fill.filename, after: " has been updated and downloaded" });

/** The Report dropdown: its summary and the three lines + the expandable ASIN lists (the old amber paragraph about rows below the approved cost is gone; the count stays in the skipped line and the Would lower list). */
export function reportOf(summary: ScSummary): { title: { costs: number; asins: number }; purchased: string; poRows: string; skipped: string; lists: Array<{ key: string; title: string; items: string[] }> } {
  const s = summary.skips;
  const lists = [
    { key: "written", title: `Costs written — ${summary.written.length} ASINs`, items: summary.written.map((w) => `${w.asin} → ${w.cost.toFixed(2)}${w.wasApproved != null ? ` (was ${w.wasApproved.toFixed(2)}${w.source ? ` / ${w.source}` : ""})` : ""}${w.fnskus.length > 1 ? ` ×${w.fnskus.length} FNSKU` : ""}`) },
    { key: "would-lower", title: `Would lower approval — ${summary.wouldLowerAsins.length} ASINs`, items: summary.wouldLowerAsins.map((x) => `${x.asin} · approved ${x.approved.toFixed(2)} → PO ${x.cost.toFixed(2)}${x.source ? ` (${x.source})` : ""}`) },
    { key: "not-in-workbook", title: `Not in Amazon's workbook — ${summary.notInWorkbookAsins.length} ASINs`, items: summary.notInWorkbookAsins },
    { key: "already-approved", title: `Already approved at this cost — ${summary.alreadyApprovedAsins.length} ASINs`, items: summary.alreadyApprovedAsins },
    { key: "not-po-sourced", title: `Not PO-sourced — ${summary.notPoSourcedAsins.length} ASINs`, items: summary.notPoSourcedAsins.map((x) => `${x.asin} · source=${x.source ?? "null"}`) },
    { key: "no-estimates", title: `No estimates row — ${summary.noCogsRowAsins.length} ASINs`, items: summary.noCogsRowAsins },
    { key: "bad-cost", title: `Bad cost — ${summary.badCostAsins.length} ASINs`, items: summary.badCostAsins.map((x) => `${x.asin} · cogs=${x.cogs}`) },
  ].filter((l) => l.items.length > 0);
  return {
    title: { costs: summary.rowsWritten, asins: summary.asinsWritten },
    purchased: `Purchased ${summary.from}..${summary.to}: ${summary.purchasedAsins} ASINs, ${summary.asinsWithPoCogs} with a PO cost. Workbook: ${summary.workbookRowsRead} rows / ${summary.workbookAsins} ASINs over ${summary.sheetsScanned} sheet${summary.sheetsScanned === 1 ? "" : "s"}.`,
    poRows: `PO rows — read ${summary.rawRowsRead} · blank ASIN ${summary.blankAsinRows} · canceled ${s.excludedByStatus} · bad date ${s.badDate} · out of range ${s.outOfRange} · included ${summary.includedRows}`,
    skipped: `Skipped — no estimates row ${s.noCogsRow} · not PO-sourced ${s.notPoSourced} · bad cost ${s.badCost} · not in workbook ${s.notInWorkbook} · already approved ${s.alreadyApproved} · would lower approval ${s.wouldLowerApproved}`,
    lists,
  };
}
