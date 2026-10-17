import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { asinWriteThrough, unionActionItems } from "./po-action-items";

// Row-level Status §2.1 (2026-10-17): action items live on product lines.
const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8");

describe("unionActionItems / asinWriteThrough", () => {
  it("union is deduped and in display order", () => {
    expect(unionActionItems([["SHIP", "See Comments"], ["Need to Return", "SHIP"], null])).toEqual(["Need to Return", "See Comments", "SHIP"]);
  });
  it("setting an item on the ASIN writes it to every line; untouched items stay on their own line", () => {
    const out = asinWriteThrough([{ id: "l1", action_items: ["SHIP"] }, { id: "l2", action_items: [] }], ["SHIP", "ATTN: Velocity"]);
    expect(Object.fromEntries(out)).toEqual({ l1: ["ATTN: Velocity", "SHIP"], l2: ["ATTN: Velocity"] });
  });
  it("removing an item from the ASIN removes it from every line", () => {
    const out = asinWriteThrough([{ id: "l1", action_items: ["SHIP", "See Comments"] }, { id: "l2", action_items: ["SHIP"] }], ["See Comments"]);
    expect(Object.fromEntries(out)).toEqual({ l1: ["See Comments"], l2: [] });
  });
  it("no change → no writes", () => {
    expect(asinWriteThrough([{ id: "l1", action_items: ["SHIP"] }], ["SHIP"]).size).toBe(0);
  });
});

describe("wiring", () => {
  const routes = read("server/routes.ts");
  it("ASIN and product routes write po_line_items only; the PO-level PATCH is gone; the cancel action sets every line", () => {
    expect(routes).toMatch(/app\.patch\("\/api\/pos\/asin-rows\/:id\/action-items"[\s\S]*?asinWriteThrough\(lines, v\.value\)/);
    expect(routes).toMatch(/app\.patch\("\/api\/pos\/lines\/:id\/action-items"[\s\S]*?UPDATE po_line_items SET action_items = \$2::text\[\] WHERE id = \$1/);
    expect(routes).not.toMatch(/app\.patch\("\/api\/pos\/:id\/action-items"/);
    expect(routes).not.toMatch(/UPDATE purchase_orders SET action_items/);
    expect(routes).toMatch(/app\.post\("\/api\/pos\/asin-rows\/:id\/cancel"[\s\S]*?UPDATE po_line_items SET qty_canceled = qty_ordered WHERE po_asin_id = \$1/);
  });
  it("the list filter and the PO column read the union over lines; auto-close (b) reads lines", () => {
    expect(routes).toMatch(/EXISTS \(SELECT 1 FROM po_line_items l WHERE l\.po_id = p\.id AND l\.action_items && \$\$\{params\.length\}::text\[\]\)/);
    expect(routes).toMatch(/r\.action_items = unionActionItems\(\[r\.line_action_items\]\)/);
    expect(read("server/po-close.ts")).toMatch(/\$\{PO_ACTION_ITEMS_SQL\} AS action_items FROM purchase_orders p/);
  });
  it("UI: ASIN rows edit with write-through, product rows edit their own line, the POs page shows read-only chips", () => {
    const c = read("client/src/components/po-asin-rows.tsx");
    expect(c).toMatch(/url=\{`\/api\/pos\/asin-rows\/\$\{a\.id\}\/action-items`\}/);
    expect(c).toMatch(/url=\{`\/api\/pos\/lines\/\$\{l\.id\}\/action-items`\}/);
    expect(c).toMatch(/\/api\/pos\/asin-rows\/\$\{a\.id\}\/cancel/);
    const page = read("client/src/pages/purchase-orders.tsx");
    expect(page).toMatch(/<ActionItemChips items=\{po\.action_items\}/);
    expect(page).not.toMatch(/\/api\/pos\/\$\{po\.id\}\/action-items/);
  });
});
