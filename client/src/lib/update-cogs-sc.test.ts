import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { SC_BULK_UPDATE_URL, SC_DIALOG_INITIAL, scDialogReduce, stepDone, step3Text, filledText, reportOf, type ScSummary, type ScDialogState } from "./update-cogs-sc";

// Update COGS in SC, the 3-step dialog (Maria 2026-11-12): every step completes on its own and in any order, the words
// are the mockups', the report is today's minus the "Held back" paragraph, the state survives a close / reopen.
const summary: ScSummary = {
  from: "2026-10-13", to: "2026-11-11", rowsWritten: 99, asinsWritten: 88, purchasedAsins: 124, asinsWithPoCogs: 124, sheetsScanned: 1, workbookRowsRead: 1669, workbookAsins: 1551,
  rawRowsRead: 4041, blankAsinRows: 0, includedRows: 149,
  skips: { excludedByStatus: 112, badDate: 0, outOfRange: 3780, noCogsRow: 0, notPoSourced: 0, badCost: 0, notInWorkbook: 27, alreadyApproved: 5, wouldLowerApproved: 8 },
  noCogsRowAsins: [], notPoSourcedAsins: [], badCostAsins: [], notInWorkbookAsins: Array.from({ length: 27 }, (_, i) => `B0NIW${String(i).padStart(5, "0")}`), alreadyApprovedAsins: ["B0A1", "B0A2", "B0A3", "B0A4"],
  wouldLowerAsins: Array.from({ length: 8 }, (_, i) => ({ asin: `B0WL${i}`, approved: 10 + i, cost: 9 + i, source: "SELLER" })),
  written: Array.from({ length: 88 }, (_, i) => ({ asin: `B0W${String(i).padStart(4, "0")}`, fnskus: i < 11 ? ["X1", "X2"] : ["X1"], cost: 4.5 + i, wasApproved: i % 2 ? 4 + i : null, source: i % 2 ? "SELLER" : null })),
};
const fill = { filename: "amzn-sourcing-cost-2026-10-13_2026-11-11.xlsx", summary };

describe("the three steps complete independently, in any order", () => {
  it("each action marks only its own step; every order ends in the same state; nothing is gated on an earlier step", () => {
    const s1 = scDialogReduce(SC_DIALOG_INITIAL, { type: "opened_template" });
    expect([stepDone(s1, 1), stepDone(s1, 2), stepDone(s1, 3)]).toEqual([true, false, false]);
    const s3 = scDialogReduce(SC_DIALOG_INITIAL, { type: "opened_upload" });
    expect([stepDone(s3, 1), stepDone(s3, 2), stepDone(s3, 3)]).toEqual([false, false, true]);
    const s2 = scDialogReduce(SC_DIALOG_INITIAL, { type: "filled", fill });
    expect([stepDone(s2, 1), stepDone(s2, 2), stepDone(s2, 3)]).toEqual([false, true, false]);
    const orders: Array<Array<Parameters<typeof scDialogReduce>[1]>> = [
      [{ type: "opened_template" }, { type: "filled", fill }, { type: "opened_upload" }],
      [{ type: "opened_upload" }, { type: "opened_template" }, { type: "filled", fill }],
      [{ type: "filled", fill }, { type: "opened_upload" }, { type: "opened_template" }],
    ];
    for (const o of orders) { const end = o.reduce(scDialogReduce, SC_DIALOG_INITIAL); expect(end).toEqual({ templateOpened: true, fill, uploaded: true }); }
  });
  it("a new file chosen resets step 2 only — steps 1 and 3 keep their ✓ (Maria 2026-11-12); the state is a plain value the page keeps across close / reopen", () => {
    const done: ScDialogState = { templateOpened: true, fill, uploaded: true };
    expect(scDialogReduce(done, { type: "new_file" })).toEqual({ templateOpened: true, fill: null, uploaded: true });
    expect(scDialogReduce(scDialogReduce(done, { type: "new_file" }), { type: "filled", fill })).toEqual(done);
    expect(scDialogReduce(SC_DIALOG_INITIAL, { type: "new_file" })).toEqual(SC_DIALOG_INITIAL);
    // reopen = the same state object rendered again: nothing in the reducer depends on the dialog being open
    expect(JSON.parse(JSON.stringify(done))).toEqual(done);
  });
});

describe("the words (the mockups)", () => {
  it("step 3 names the filled file once there is one; step 2's done line; the link target", () => {
    expect(step3Text(SC_DIALOG_INITIAL)).toEqual({ before: "Upload the filled template under Sourcing Cost Bulk Update.", filename: null, after: "" });
    expect(step3Text({ ...SC_DIALOG_INITIAL, fill })).toEqual({ before: "Upload ", filename: fill.filename, after: " under Sourcing Cost Bulk Update." });
    expect(filledText(fill)).toEqual({ filename: fill.filename, after: " has been updated and downloaded" });
    expect(SC_BULK_UPDATE_URL).toBe("https://sellercentral.amazon.com/inventory-reimbursement/sourcing-cost-bulk-update");
  });
  it("the report: title counts, the three lines as the mockup words them, the expandable lists; no 'Held back' paragraph anywhere — the count stays in the skipped line and the Would lower list", () => {
    const r = reportOf(summary);
    expect(r.title).toEqual({ costs: 99, asins: 88 });
    expect(r.purchased).toBe("Purchased 2026-10-13..2026-11-11: 124 ASINs, 124 with a PO cost. Workbook: 1669 rows / 1551 ASINs over 1 sheet.");
    expect(r.poRows).toBe("PO rows — read 4041 · blank ASIN 0 · canceled 112 · bad date 0 · out of range 3780 · included 149");
    expect(r.skipped).toBe("Skipped — no estimates row 0 · not PO-sourced 0 · bad cost 0 · not in workbook 27 · already approved 5 · would lower approval 8");
    expect(r.lists.map((l) => l.title)).toEqual(["Costs written — 88 ASINs", "Would lower approval — 8 ASINs", "Not in Amazon's workbook — 27 ASINs", "Already approved at this cost — 4 ASINs"]);
    expect(r.lists[0].items[1]).toBe("B0W0001 → 5.50 (was 5.00 / SELLER) ×2 FNSKU");
    expect(r.lists[1].items[0]).toBe("B0WL0 · approved 10.00 → PO 9.00 (SELLER)");
    expect(JSON.stringify(r)).not.toMatch(/Held back/i);
    for (const f of ["client/src/lib/update-cogs-sc.ts", "client/src/components/update-cogs-sc-dialog.tsx", "client/src/pages/home.tsx"]) expect(readFileSync(f, "utf8")).not.toMatch(/Held back/);
  });
});

describe("the dialog's markup (source-level)", () => {
  const src = readFileSync("client/src/components/update-cogs-sc-dialog.tsx", "utf8");
  const home = readFileSync("client/src/pages/home.tsx", "utf8");
  it("both Open Seller Central links go to the bulk-update page in a new tab with rel=noopener and mark their step done", () => {
    expect(src.match(/href=\{SC_BULK_UPDATE_URL\} target="_blank" rel="noopener"/g)).toHaveLength(2);
    expect(src).toContain('rel="noopener" onClick={() => dispatch({ type: "opened_template" })}');
    expect(src).toContain('rel="noopener" onClick={() => dispatch({ type: "opened_upload" })}');
  });
  it("Open Seller Central and Choose file are the outline .btn, nothing is .btn.p, the footer is one Done; choosing a file fills at once (no fill button); the scoped stylesheet", () => {
    expect(src).not.toMatch(/btn p/);
    expect(src).not.toMatch(/Fill template/);
    expect(src.match(/data-testid="button-sc-done"/g)).toHaveLength(1);
    expect(src).toContain('<label className="btn" htmlFor="sc-file"');
    expect(src).toContain('onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) onFile(f); }}');
    expect(src).toContain('import "@/pages/claims.css"');
    expect(src).toContain('className="cl cl-dialog"');
    const css = readFileSync("client/src/pages/claims.css", "utf8");
    for (const f of ["docs/mockups/update-cogs-in-sc-dialog-before-2026-11-12.html", "docs/mockups/update-cogs-in-sc-dialog-after-step-2-2026-11-12.html"]) {
      const style = /<style>([\s\S]*?)<\/style>/.exec(readFileSync(f, "utf8"))![1];
      for (const rule of style.split("\n").map((l) => l.trim()).filter(Boolean)) {
        if (rule.startsWith("body{")) continue;
        for (const one of rule.split("}").filter(Boolean)) { const [sel, body] = one.split("{"); expect(css, one).toContain(`.cl ${sel.trim().split(",").join(",.cl ")}{${body}`); }
      }
    }
  });
  it("the ASINs page keeps the dialog state for the session and the toolbar button opens the dialog; the fill request is unchanged (file + from + to to /api/export/sourcing-cost)", () => {
    expect(home).toContain("const [scDialog, scDispatch] = useReducer(scDialogReduce, SC_DIALOG_INITIAL);");
    expect(home).toContain("const handleExportSourcingCost = useCallback(() => { setScDialogOpen(true); }, []);");
    expect(home).toContain('fd.append("file", file);\n      fd.append("from", startDate);\n      fd.append("to", endDate);\n      const res = await fetch("/api/export/sourcing-cost", { method: "POST", body: fd });');
    expect(home).toContain('scDispatch({ type: "filled", fill: { filename: data.filename, summary: data.summary } });');
    expect(home).toContain('<UpdateCogsScDialog open={scDialogOpen} onOpenChange={setScDialogOpen} state={scDialog} dispatch={scDispatch}');
  });
});
