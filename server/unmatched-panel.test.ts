import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// PO matching patch §6 (amended 2026-10-29): the Unmatched shipments panel shows
// only what no rule placed — ranked candidates on the row, the nearest miss,
// "Map → supplier", bulk dismiss (hidden, never deleted), visible-only count.
const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8");
const routes = read("server/routes.ts");
const page = read("client/src/pages/purchase-orders.tsx");

describe("server", () => {
  it("visible = unresolved and not dismissed; the POs badge counts the same set; dismissed come back separately", () => {
    expect(routes).toMatch(/FROM shipment_unmatched WHERE resolved_at IS NULL AND dismissed_at IS NULL\) \+ \(SELECT COUNT\(\*\)::int FROM velocity_shipments WHERE sc_match = 'ambiguous'\)/);
    expect(routes).toMatch(/u\.candidates, u\.nearest_miss, u\.dismissed_at/);
    expect(routes).toMatch(/res\.json\(\{ lines, dismissed, ambiguous, count: lines\.length \+ ambiguous\.length \}\)/);
    expect(routes).toMatch(/l\.retailer_unmapped = resolveRetailer\(l\.retailer, aliases, suppliers\)\.kind === "unresolved"/);
  });
  it("dismiss stamps dismissed_at, never deletes; aliases from the panel are 'manual' and only to a real supplier; the picker records match_reason", () => {
    expect(routes).toMatch(/UPDATE shipment_unmatched SET dismissed_at = now\(\) WHERE id = ANY\(\$1::uuid\[\]\) AND resolved_at IS NULL AND dismissed_at IS NULL/);
    expect(routes).not.toMatch(/DELETE FROM shipment_unmatched/);
    expect(routes).toMatch(/SELECT 1 FROM purchase_orders WHERE supplier = \$1 LIMIT 1[\s\S]{0,200}setAlias\(poQuery, alias, supplier, "manual"\)/);
    expect(read("server/shipment-link.ts")).toMatch(/resolved_po_asin_id = \$2, match_reason = 'picker' WHERE id = \$1/);
  });
});

describe("client", () => {
  it("candidate buttons on the row, best first, through the picker's link route; free-text picker kept", () => {
    expect(page).toMatch(/cands\.map\(\(c\) => \([\s\S]{0,400}linkUnmatched\(l\.id, c\.po_asin_id\)[\s\S]{0,200}Link to \{candidateLabel\(c\)\}/);
    expect(page).toMatch(/<LinkPicker line=\{l\} onLinked=\{onLinked\} \/>/);
    expect(page).toMatch(/fetch\(`\/api\/pos\/unmatched\/\$\{lineId\}\/link`/);
  });
  it("nearest miss in Why, Map → supplier for an unmapped retailer, Dismiss selected, Dismissed (N)", () => {
    expect(page).toMatch(/if \(l\.nearest_miss\) return l\.nearest_miss;/);
    expect(page).toMatch(/l\.retailer_unmapped && l\.retailer && \(/);
    expect(page).toMatch(/fetch\("\/api\/supplier-aliases"/);
    expect(page).toMatch(/Dismiss selected \(\{picked\.size\}\)/);
    expect(page).toMatch(/fetch\("\/api\/pos\/unmatched\/dismiss"/);
    expect(page).toMatch(/Dismissed \(\{data\.dismissed\.length\}\)/);
  });
  it("candidateLabel: §4 candidates show Δdays and units left; Col P rows say so", async () => {
    const { candidateLabel } = await import("../client/src/pages/purchase-orders");
    expect(candidateLabel({ po_asin_id: "x", order_id: "39836159", supplier: "s", asin: "a", source: "col_p" })).toBe("39836159 · Col P");
    expect(candidateLabel({ po_asin_id: "x", order_id: "A1", supplier: "s", asin: "a", source: "candidate", days: -9, remaining_units: 2 })).toBe("A1 · -9d · 2 left");
    expect(candidateLabel({ po_asin_id: "x", order_id: "A1", supplier: "s", asin: "a", source: "candidate", days: 0, remaining_units: 5 })).toBe("A1 · same day · 5 left");
    expect(candidateLabel({ po_asin_id: "x", order_id: "A1", supplier: "s", asin: "a", source: "candidate", days: 3, remaining_units: 5 })).toBe("A1 · +3d · 5 left");
  });
});
