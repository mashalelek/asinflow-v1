// PO table v2 UI (docs/claude_spec-patch-po-table-v2.md §5): chips per line,
// count badge + hover, apply-to-all confirm, labels in sentence case.
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { lineDetailTitle, ACTION_ITEM_OPTIONS, DISPLAY_ACTION_ITEMS, MAX_CHIPS } from "./po-asin-rows";
import { poLineCount } from "../pages/purchase-orders";

const rows = readFileSync(join(__dirname, "po-asin-rows.tsx"), "utf8");
const page = readFileSync(join(__dirname, "..", "pages", "purchase-orders.tsx"), "utf8");

describe("labels", () => {
  it("sentence case, Extra units shipped right after the manual items", () => {
    expect(ACTION_ITEM_OPTIONS).toEqual(["Need to return", "Missing / damaged from supplier", "Confirm refund / replacement", "ATTN: Velocity", "See comments", "SHIP", "Received - FBM"]);
    expect(DISPLAY_ACTION_ITEMS.slice(7, 9)).toEqual(["Extra units shipped", "Review Velocity"]);
  });
});

describe("PO row chips", () => {
  it("hover names the lines and the auto reasons; the badge shows only when not every line has it", () => {
    expect(lineDetailTitle("SHIP", { lines: 3, of: 3, asins: ["B1", "B2"], reasons: [] })).toBe("SHIP: all 3 lines — B1, B2");
    expect(lineDetailTitle("Review Velocity", { lines: 1, of: 3, asins: ["B2"], reasons: ["not in Velocity"] })).toBe("Review Velocity: 1 of 3 lines — B2 · not in Velocity");
    expect(rows).toMatch(/d && d\.lines < d\.of \? <span className="ml-1 opacity-70" data-testid=\{`chip-count-\$\{it\}`\}>·\{d\.lines\}<\/span>/);
  });
  it("two chips at most, then +N", () => {
    expect(MAX_CHIPS).toBe(2);
    expect(rows).toMatch(/list\.length > MAX_CHIPS \+ 1 \? list\.slice\(0, MAX_CHIPS\) : list/);
  });
  it("the PO row edits every line through PATCH /api/pos/:id/action-items, confirming when the PO has more than one line", () => {
    expect(page).toMatch(/<ActionItemsEditor items=\{po\.action_items\}[\s\S]{0,200}url=\{`\/api\/pos\/\$\{po\.id\}\/action-items`\}[\s\S]{0,80}lineCount=\{poLineCount\(po\)\}/);
    expect(poLineCount({ asins: [{ lines: [1, 2] }, { lines: [3] }, {}] })).toBe(3);
  });
});

describe("apply-to-all confirm", () => {
  it("a change on a scope with > 1 line waits for 'Apply to all N lines'; one line saves at once", () => {
    expect(rows).toMatch(/if \(lineCount > 1\) setPending\(\{ next, label:/);
    expect(rows).toMatch(/else void save\(next\);/);
    expect(rows).toMatch(/Apply to all \{lineCount\} lines/);
    expect(rows).toMatch(/url=\{`\/api\/pos\/asin-rows\/\$\{a\.id\}\/action-items`\} onSaved=\{onChanged\} testId=\{`button-action-items-asin-\$\{a\.asin\}`\} lineCount=\{lines\.length\}/);
    expect(rows).toMatch(/url=\{`\/api\/pos\/lines\/\$\{l\.id\}\/action-items`\}/);
  });
});
