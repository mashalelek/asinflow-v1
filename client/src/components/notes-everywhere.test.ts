// Notes everywhere (Maria 2026-11-05): every notes field in AF uses the shared inline editor (inline-note.tsx) —
// click to edit in place, Enter saves, Shift+Enter new line, Esc cancels, blur saves. The old popup with
// Cancel / Save buttons (note-editor.tsx) is gone, and no notes field goes back to a generic InlineEdit.
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const root = path.resolve(__dirname, "..");
const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => d.isDirectory() ? files(path.join(dir, d.name)) : d.name.endsWith(".tsx") ? [path.join(dir, d.name)] : []);
const src = Object.fromEntries(files(root).map((f) => [path.relative(root, f), fs.readFileSync(f, "utf8")]));

describe("notes everywhere use the shared inline editor", () => {
  it("the old notes popup is gone", () => {
    expect(fs.existsSync(path.join(root, "components/note-editor.tsx"))).toBe(false);
    for (const [f, s] of Object.entries(src)) expect({ f, uses: /\bNoteEditor\b|note-editor/.test(s) }).toEqual({ f, uses: false });
  });
  it("no InlineEdit edits a note / notes / promo field", () => {
    for (const [f, s] of Object.entries(src)) {
      const bad = Array.from(s.matchAll(/<InlineEdit\b[^>]*value=\{[^}]*\b(notes?|promoNotes|promo_notes)\b[^}]*\}/g)).map((m) => m[0].slice(0, 80));
      expect({ f, bad }).toEqual({ f, bad: [] });
    }
  });
  it("each converted field renders InlineNoteCell", () => {
    expect(src["components/results-table.tsx"]).toMatch(/InlineNoteCell value=\{result\.notes \?\? null\}/);
    expect(src["components/results-table.tsx"]).toMatch(/InlineNoteCell value=\{result\.promoNotes \?\? null\}/);
    expect(src["pages/subscriptions.tsx"]).toMatch(/InlineNoteCell value=\{r\.notes\}/);
    expect(src["components/po-money.tsx"]).toMatch(/InlineNoteCell value=\{r\.note\}/);
    expect(src["pages/purchase-orders.tsx"]).toMatch(/InlineNoteCell value=\{po\.notes\}/);
    expect(src["components/po-asin-rows.tsx"]).toMatch(/InlineNoteCell value=\{a\.notes\}/);
  });
});
