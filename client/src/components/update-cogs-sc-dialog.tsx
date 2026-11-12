/**
 * Update COGS in SC — the 3-step dialog (Maria 2026-11-12). The mockups docs/mockups/update-cogs-in-sc-dialog-before-2026-11-12.html
 * (fresh open) and …-after-step-2-2026-11-12.html (after the fill) are the spec for layout, wording and look; the look
 * is the scoped stylesheet shared with Claims (client/src/pages/claims.css, `.cl`). State and words: client/src/lib/update-cogs-sc.ts.
 * Esc closes and focus is trapped (Radix Dialog). All Open Seller Central / Choose file buttons are the outline `.btn`;
 * nothing is filled primary; the footer is one Done button.
 */
import React, { useRef } from "react";
import "@/pages/claims.css";
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogClose } from "@/components/ui/dialog";
import { SC_BULK_UPDATE_URL, filledText, reportOf, step3Text, stepDone, type ScDialogAction, type ScDialogState } from "@/lib/update-cogs-sc";

export function UpdateCogsScDialog({ open, onOpenChange, state, dispatch, onFile, busy, range }: {
  open: boolean; onOpenChange: (o: boolean) => void; state: ScDialogState; dispatch: (a: ScDialogAction) => void;
  /** Step 2: the chosen file is filled at once with today's logic (the ASINs page's handler) and downloaded. */
  onFile: (file: File) => void; busy: boolean; range: { from: string; to: string };
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const t3 = step3Text(state);
  const Marker = ({ n, done }: { n: number; done: boolean }) => <span className={`n${done ? " ok" : ""}`} data-testid={`sc-step-${n}-marker`} data-done={done}>{done ? "✓" : n}</span>;
  const DoneTitle = ({ text }: { text: string }) => <div style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 24 }}><span style={{ fontWeight: 500 }}>{text}</span><span className="mut">· done</span></div>;
  const rep = state.fill ? reportOf(state.fill.summary) : null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent dialogId="update-cogs-sc" className="cl cl-dialog" style={{ width: 520, maxWidth: 520, padding: 0 }} data-testid="dialog-update-cogs-sc">
        <div style={{ display: "flex", flexDirection: "column", gap: 18, padding: 20 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <DialogTitle style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Update COGS in Seller Central</DialogTitle>
            <DialogClose className="btn" aria-label="Close" style={{ width: 30, padding: 0, justifyContent: "center" }} data-testid="button-sc-close">×</DialogClose>
          </div>
          <DialogDescription className="sr-only">Download Amazon's template, let AsinFlow fill it, upload it to Seller Central.</DialogDescription>

          <div className="stp" data-testid="sc-step-1" data-done={stepDone(state, 1)}>
            <Marker n={1} done={stepDone(state, 1)} />
            {stepDone(state, 1) ? <DoneTitle text="Download Amazon's template" /> : (
              <div>
                <div style={{ fontWeight: 500 }}>Download Amazon's template</div>
                <div className="mut" style={{ margin: "4px 0 8px" }}>Opens Seller Central's sourcing-cost bulk update page in a new tab. Download the template there, then come back.</div>
                <a className="btn" href={SC_BULK_UPDATE_URL} target="_blank" rel="noopener" onClick={() => dispatch({ type: "opened_template" })} data-testid="link-sc-open-template">Open Seller Central ↗</a>
              </div>)}
          </div>

          <div className="stp" data-testid="sc-step-2" data-done={stepDone(state, 2)}>
            <Marker n={2} done={stepDone(state, 2)} />
            <div>
              {state.fill ? (
                <>
                  <DoneTitle text="Upload Amazon's template to AsinFlow" />
                  <div className="mut" style={{ marginTop: 2 }} data-testid="sc-filled-line"><span className="num" style={{ color: "#e6e3dc" }}>{filledText(state.fill).filename}</span>{filledText(state.fill).after}</div>
                  {rep && (
                    <details style={{ marginTop: 6 }} data-testid="sc-report">
                      <summary>Report · <span className="num">{rep.title.costs}</span> costs written · <span className="num">{rep.title.asins}</span> ASINs</summary>
                      <div className="rep">
                        <div className="mut">{rep.purchased}</div>
                        <div className="mut">{rep.poRows}</div>
                        <div className="mut">{rep.skipped}</div>
                        {rep.lists.map((l) => (
                          <details key={l.key} data-testid={`sc-report-${l.key}`}><summary>{l.title}</summary>
                            <div className="num" style={{ marginTop: 4, maxHeight: 160, overflow: "auto", overflowWrap: "anywhere" }}>{l.items.map((x, i) => <div key={i}>{x}</div>)}</div>
                          </details>))}
                      </div>
                    </details>)}
                  <div style={{ marginTop: 8 }}><label className="btn" htmlFor="sc-file" data-testid="button-sc-choose-file">{busy ? "Filling…" : "Choose another file"}</label></div>
                </>
              ) : (
                <>
                  <div style={{ fontWeight: 500 }}>Upload Amazon's template to AsinFlow</div>
                  <div className="mut" style={{ margin: "4px 0 8px" }}>Choose the template file. AF fills in the Sourcing cost for the ASINs purchased <span className="num" style={{ color: "#e6e3dc" }}>{range.from}..{range.to}</span> and gives you the file to upload back to Amazon.</div>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <label className="btn" htmlFor="sc-file" data-testid="button-sc-choose-file">{busy ? "Filling…" : "Choose file"}</label>
                    <span className="mut">{busy ? "filling and downloading…" : "no file chosen"}</span>
                  </div>
                </>)}
              <input ref={fileRef} id="sc-file" type="file" accept=".xlsx" disabled={busy} style={{ position: "absolute", width: 1, height: 1, opacity: 0 }}
                onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) onFile(f); }} data-testid="input-sc-workbook" />
            </div>
          </div>

          <div className="stp" data-testid="sc-step-3" data-done={stepDone(state, 3)}>
            <Marker n={3} done={stepDone(state, 3)} />
            {stepDone(state, 3) ? <DoneTitle text="Upload COGS to Seller Central" /> : (
              <div>
                <div style={{ fontWeight: 500 }}>Upload COGS to Seller Central</div>
                <div className="mut" style={{ margin: "4px 0 8px" }} data-testid="sc-step-3-text">{t3.before}{t3.filename && <span className="num" style={{ color: "#e6e3dc" }}>{t3.filename}</span>}{t3.after}</div>
                <a className="btn" href={SC_BULK_UPDATE_URL} target="_blank" rel="noopener" onClick={() => dispatch({ type: "opened_upload" })} data-testid="link-sc-open-upload">Open Seller Central ↗</a>
              </div>)}
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, paddingTop: 6, borderTop: "1px solid #2a2824" }}>
            <DialogClose className="btn" data-testid="button-sc-done">Done</DialogClose>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
