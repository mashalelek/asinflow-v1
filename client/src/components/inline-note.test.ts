// Inline notes (Maria 2026-11-04): keys, the value sent, the icon, and where the editor is wired.
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { noteKeyAction, nextNoteValue } from "./inline-note";

const src = (...p: string[]) => readFileSync(join(__dirname, ...p), "utf8");
const note = src("inline-note.tsx");
const page = src("..", "pages", "purchase-orders.tsx");
const rows = src("po-asin-rows.tsx");
const edit = src("po-edit.tsx");

describe("keys", () => {
  it("Enter saves, Shift+Enter is a newline, Esc cancels, IME composition is left alone", () => {
    expect(noteKeyAction({ key: "Enter" })).toBe("save");
    expect(noteKeyAction({ key: "Enter", shiftKey: true })).toBeNull();
    expect(noteKeyAction({ key: "Escape" })).toBe("cancel");
    expect(noteKeyAction({ key: "Enter", nativeEvent: { isComposing: true } })).toBeNull();
    expect(noteKeyAction({ key: "a" })).toBeNull();
  });
  it("blur saves; one edit finishes once (blur, Esc and the popover close can all arrive)", () => {
    expect(note).toMatch(/onBlur: \(\) => finish\(true\)/);
    expect(note).toMatch(/if \(done\.current\) return;/);
    expect(note).toMatch(/onEscapeKeyDown=\{\(\) => ed\.finish\(false\)\}/);
  });
});

describe("the value sent", () => {
  it("unchanged → nothing sent; blank → null; ends trimmed, inner newlines kept", () => {
    expect(nextNoteValue("same", "same")).toBeUndefined();
    expect(nextNoteValue("  same \n", "same")).toBeUndefined();
    expect(nextNoteValue("", null)).toBeUndefined();
    expect(nextNoteValue("   ", "old")).toBeNull();
    expect(nextNoteValue(" a\nb ", null)).toBe("a\nb");
  });
  it("a toast only on error; the shown note reverts", () => {
    expect(note).toMatch(/catch\(\(e: any\) => \{ setShown\(before\); toast\(\{ title: "Note not saved"/);
    expect(note.match(/toast\(/g)?.length).toBe(1);
  });
});

describe("icon", () => {
  it("filled when a note exists, outline when empty, the same muted colour (no new colours)", () => {
    expect(note).toMatch(/fill=\{has \? "currentColor" : "none"\}/);
    expect(note).toMatch(/has \? "text-muted-foreground" : "text-muted-foreground\/40"/);
  });
  it("hover shows the full note", () => {
    expect(note).toMatch(/<TooltipContent[^>]*><p className="whitespace-pre-wrap text-xs"[^>]*>\{ed\.shown\}<\/p>/);
  });
});

describe("wiring", () => {
  it("POs table: the Notes cell PATCHes the PO note; the click never opens the PO", () => {
    expect(page).toMatch(/<td style=\{poColStyle\(colWidths, "notes"\)\} className="p-0" onClick=\{\(e\) => e\.stopPropagation\(\)\}>\s*<InlineNoteCell value=\{po\.notes\}/);
    expect(page).toMatch(/poApi\(`\/api\/pos\/\$\{po\.id\}`, "PATCH", \{ notes: v \}\)/);
  });
  it("PO Details: the NOTES box is click-to-edit, no Edit PO round trip", () => {
    expect(page).toMatch(/<InlineNoteBox value=\{po\.notes\}/);
    expect(page).not.toMatch(/<DetailCard title="Notes"/);
  });
  it("expanded ASIN rows edit the ASIN-row note; product lines the line note; the Products tab too", () => {
    expect(rows).toMatch(/<InlineNoteCell value=\{a\.notes\} label="ASIN note"[^>]*onSave=\{saveAsin\("notes"\)\}/);
    expect(rows).toMatch(/<InlineNoteCell value=\{l\.notes\} label="line note"[^\n]*poApi\(`\/api\/pos\/lines\/\$\{l\.id\}`, "PATCH", \{ notes: v \}\)/);
    expect(edit).toMatch(/<InlineNoteCell value=\{l\.notes\} label="line note"/);
  });
});
