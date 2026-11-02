// Jobs dialog layout (2026-10-21): job rows must not widen the dialog — a long
// outcome line once pushed Release off-screen (1,737 px rows in a 766 px
// dialog). jsdom has no layout, so the classes that prevent it are pinned.
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const src = (f: string) => readFileSync(join(__dirname, f), "utf8");

describe("jobs dialog never scrolls sideways", () => {
  it("the dialog renders through the shared frame (dialogId), whose body lets its items shrink, wraps long tokens, and hides x-overflow", () => {
    const s = src("jobs-dialog.tsx");
    expect(s).toMatch(/<DialogContent dialogId="jobs" className="sm:max-w-3xl" data-testid="dialog-jobs">/);
    const frame = src("ui/dialog.tsx");
    const m = /DIALOG_BODY_CLASS = "([^"]+)"/.exec(frame)!;
    expect(m).not.toBeNull();
    for (const c of ["overflow-y-auto", "overflow-x-hidden", "[overflow-wrap:anywhere]", "[&>*]:min-w-0"]) expect(m[1].split(" ")).toContain(c);
  });
  it("job rows and the expanded body can shrink; the error is truncated inside the row", () => {
    const s = src("jobs-dialog.tsx");
    expect(s).toMatch(/className="w-full min-w-0 text-left flex items-center gap-3"/);
    expect(s).toMatch(/text-destructive truncate min-w-0 flex-1/);
    expect(s).toMatch(/mt-2 pl-3 space-y-3 min-w-0/);
  });
  it("the hygiene panel header wraps, so Release never sits past the edge; evidence <pre> wraps", () => {
    const s = src("listing-hygiene-panel.tsx");
    expect(s).toMatch(/flex flex-wrap items-center gap-2 min-w-0/);
    expect(s).toMatch(/max-w-full overflow-auto whitespace-pre-wrap/);
  });
});
