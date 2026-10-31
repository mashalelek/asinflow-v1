// PO table v2 UI (docs/claude_spec-patch-po-table-v2.md §5): chips per line,
// count badge + hover, apply-to-all confirm, labels in sentence case.
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { lineDetailTitle, ACTION_ITEM_OPTIONS, DISPLAY_ACTION_ITEMS, MAX_CHIPS } from "./po-asin-rows";
import { poLineCount, nextPoSort, PO_LIST_COLUMNS, poColStyle, PO_COL_WIDTHS_KEY, PO_DEFAULT_COL_WIDTHS } from "../pages/purchase-orders";
import { PO_SORT_KEYS } from "../../../server/po-queries";

const rows = readFileSync(join(__dirname, "po-asin-rows.tsx"), "utf8");
const page = readFileSync(join(__dirname, "..", "pages", "purchase-orders.tsx"), "utf8");

describe("labels", () => {
  it("sentence case, Extra units shipped right after the manual items", () => {
    expect(ACTION_ITEM_OPTIONS).toEqual(["Need to return", "Missing / damaged from supplier", "Confirm refund / replacement", "ATTN: Velocity", "See comments", "SHIP", "Received - FBM", "Confirm order details", "Subscription renews", "Review renewal PO"]);
    expect(DISPLAY_ACTION_ITEMS.slice(10, 12)).toEqual(["Extra units shipped", "Review Velocity"]);
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
    expect(rows).toMatch(/list\.length > MAX_CHIPS \? list\.slice\(0, MAX_CHIPS\) : list/);
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

describe("sortable headers (commit 4)", () => {
  it("a click cycles asc → desc → off; another column starts at asc", () => {
    const a = nextPoSort(null, "supplier");
    expect(a).toEqual({ key: "supplier", dir: "asc" });
    const b = nextPoSort(a, "supplier");
    expect(b).toEqual({ key: "supplier", dir: "desc" });
    expect(nextPoSort(b, "supplier")).toBeNull();
    expect(nextPoSort(b, "order_total")).toEqual({ key: "order_total", dir: "asc" });
  });
  it("every sortable column is a server-whitelisted key; Invoice and Notes do not sort", () => {
    const keys = PO_LIST_COLUMNS.filter((c) => c.sortKey).map((c) => c.sortKey!).concat("status");
    expect(keys.sort()).toEqual(Object.keys(PO_SORT_KEYS).sort());
    expect(PO_LIST_COLUMNS.filter((c) => !c.sortKey).map((c) => c.label)).toEqual(["Invoice", "Notes"]);
  });
  it("the list sends sort/dir and a sort change resets to page 1", () => {
    expect(page).toMatch(/if \(sort\) \{ params\.set\("sort", sort\.key\); params\.set\("dir", sort\.dir\); \}/);
    expect(page).toMatch(/useEffect\(\(\) => \{ setPage\(1\); \}, \[[^\]]*sortKey\]\)/);
  });
});

describe("resizable columns (commit 5): one shared mechanism", () => {
  const hook = readFileSync(join(__dirname, "..", "hooks", "use-column-widths.tsx"), "utf8");
  const results = readFileSync(join(__dirname, "results-table.tsx"), "utf8");
  const grouped = readFileSync(join(__dirname, "grouped-table.tsx"), "utf8");
  it("the ASINs tables (flat + grouped) and the POs table all use the hook; nobody keeps a local copy", () => {
    for (const src of [results, grouped, page]) {
      expect(src).toMatch(/import \{ useColumnWidths, ResizeHandle \} from "@\/hooks\/use-column-widths"/);
      expect(src).not.toMatch(/function ResizeHandle\(|const saveWidths = useCallback|localStorage\.(get|set)Item\("fba-col-widths"/);
    }
    expect(results).toMatch(/useColumnWidths\("fba-col-widths"\)/); // the ASINs widths keep their key — nobody loses a layout
    expect(grouped).toMatch(/useColumnWidths\("fba-col-widths"\)/);
    expect(page).toMatch(/useColumnWidths\(PO_COL_WIDTHS_KEY\)/);
    expect(PO_COL_WIDTHS_KEY).not.toBe("fba-col-widths");
  });
  it("the hook saves debounced under the caller's key, has a 50 px floor and a reset that removes the key", () => {
    expect(hook).toMatch(/localStorage\.setItem\(storageKey, JSON\.stringify\(widths\)\)/);
    expect(hook).toMatch(/}, 300\);/);
    expect(hook).toMatch(/minWidth = 50/);
    expect(hook).toMatch(/localStorage\.removeItem\(storageKey\)/);
  });
  it("Action Items defaults to 160 px (≈60% of the old 272 px); a dragged width wins; other columns size to content", () => {
    expect(PO_DEFAULT_COL_WIDTHS.action_items).toBe(160);
    expect(poColStyle({}, "action_items")).toEqual({ width: 160, minWidth: 160, maxWidth: 160, overflow: "hidden" });
    expect(poColStyle({ action_items: 220 }, "action_items")).toEqual({ width: 220, minWidth: 220, maxWidth: 220, overflow: "hidden" });
    expect(poColStyle({}, "supplier")).toBeUndefined();
    expect(page).toMatch(/onClick=\{resetWidths\} data-testid="button-po-reset-widths">Reset widths</);
  });
});
