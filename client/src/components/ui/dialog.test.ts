import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join, resolve } from "path";
import { clampDialogSize, dialogSizeKey, DIALOG_MIN_W, DIALOG_MIN_H, DIALOG_MARGIN } from "./dialog";

// AF-wide dialog rule (Maria 2026-11-01): one shared frame for every modal.
const CLIENT = resolve(__dirname, "../..");
function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) { const p = join(dir, f); if (statSync(p).isDirectory()) walk(p, out); else if (/\.tsx$/.test(f)) out.push(p); }
  return out;
}
const files = walk(CLIENT).filter((p) => !p.includes("/components/ui/"));

describe("dialog frame — the remembered size", () => {
  it("clamps a stored size to min 480×320 and max viewport − 32, and rejects garbage", () => {
    const vp = { w: 1440, h: 900 };
    expect(clampDialogSize({ w: 300, h: 100 }, vp)).toEqual({ w: DIALOG_MIN_W, h: DIALOG_MIN_H });
    expect(clampDialogSize({ w: 5000, h: 5000 }, vp)).toEqual({ w: 1440 - DIALOG_MARGIN, h: 900 - DIALOG_MARGIN });
    expect(clampDialogSize({ w: 800.4, h: 600.6 }, vp)).toEqual({ w: 800, h: 601 });
    expect(clampDialogSize(null, vp)).toBeNull();
    expect(clampDialogSize({ w: "x" as any, h: 1 }, vp)).toBeNull();
    expect(dialogSizeKey("jobs")).toBe("af-dialog-size:jobs");
  });
});

describe("every modal in AF renders through the shared frame", () => {
  const contents = files.flatMap((p) => { const s = readFileSync(p, "utf8"); return Array.from(s.matchAll(/<(?:Alert)?DialogContent\b([^>]*)>/g)).map((m) => ({ file: p.slice(CLIENT.length + 1), attrs: m[1] })); });
  it("finds the dialogs and each carries a dialogId (its remembered-size key)", () => {
    expect(contents.length).toBeGreaterThanOrEqual(28);
    for (const c of contents) expect(c.attrs, c.file).toMatch(/dialogId="[a-z0-9-]+"/);
  });
  it("the ids are unique across AF", () => {
    const ids = contents.map((c) => /dialogId="([^"]+)"/.exec(c.attrs)![1]);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it("no dialog carries its own scroll or height rules any more (the frame owns them), and no Sheet survives", () => {
    for (const c of contents) expect(c.attrs, c.file).not.toMatch(/overflow-y-auto|overflow-x-hidden|max-h-\[|h-\[\d+vh\]/);
    for (const p of files) expect(readFileSync(p, "utf8"), p).not.toMatch(/<SheetContent/);
  });
  it("confirm dialogs ignore the backdrop (confirm / AlertDialog); tables inside dialogs sit in a DialogTable", () => {
    const confirms = contents.filter((c) => /\bconfirm\b/.test(c.attrs) || /AlertDialog/.test(c.attrs)).length;
    expect(confirms).toBeGreaterThanOrEqual(4);
    for (const f of ["components/upload-to-velocity-dialog.tsx", "components/po-tracking.tsx"]) {
      const s = readFileSync(join(CLIENT, f), "utf8");
      expect(s.match(/<table\b/g)?.length ?? 0, f).toBe(s.match(/<DialogTable>/g)?.length ?? 0);
    }
  });
});
