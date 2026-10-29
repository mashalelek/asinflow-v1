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
    expect(routes).toMatch(/UPDATE shipment_unmatched SET dismissed_at = now\(\), dismiss_note = \$2 WHERE id = ANY\(\$1::uuid\[\]\) AND resolved_at IS NULL AND dismissed_at IS NULL`, \[ids, note\]/);
    expect(routes).not.toMatch(/DELETE FROM shipment_unmatched/);
    expect(routes).toMatch(/SELECT 1 FROM purchase_orders WHERE supplier = \$1 LIMIT 1[\s\S]{0,200}setAlias\(poQuery, alias, supplier, "manual"\)/);
    expect(read("server/shipment-link.ts")).toMatch(/resolved_po_asin_id = \$2, match_reason = 'picker' WHERE id = \$1/);
  });
});

describe("client", () => {
  it("candidate buttons on the row, best first, through the picker's link route; free-text picker kept", () => {
    expect(page).toMatch(/cands\.map\(\(c\) => \([\s\S]{0,400}tryLink\(c\.po_asin_id, c\.order_id\)[\s\S]{0,200}Link to \{candidateLabel\(c\)\}/);
    expect(page).toMatch(/<LinkPicker line=\{l\} onPick=\{\(r\) => tryLink\(r\.id, r\.order_id\)\} \/>/);
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

describe("picker suggestions and Velocity eligibility (Maria 2026-10-29)", () => {
  it("search lists eligible POs first; a Home or pre-start PO stays listed with the reason as a warning", () => {
    expect(routes).toMatch(/ORDER BY \(p\.ships_to = 'home' OR \(\$2::date IS NOT NULL AND p\.order_date < \$2::date\)\), p\.order_date DESC/);
    expect(routes).toMatch(/r\.velocity_warning = why \? ineligibleText\(why, start\) : null/);
    expect(page).toMatch(/r\.velocity_warning && <span className="text-amber-500"/);
  });
});

describe("Extra units shipped and the dismiss note (Maria 2026-10-29)", () => {
  const rows = read("client/src/components/po-asin-rows.tsx");
  it("an overshoot comes back as a confirm that needs a note; candidate buttons and the picker both go through it", () => {
    expect(page).toMatch(/if \(res\.status === 409 && data\.code === "overshoot"\) return \{ overshoot:/);
    expect(page).toMatch(/if \(r\.overshoot\) \{ setPending\(/);
    expect(page).toMatch(/disabled=\{!note\.trim\(\) \|\| busy\}[\s\S]{0,120}linkUnmatched\(l\.id, pending\.poAsinId, note\.trim\(\)\)/);
  });
  it("dismiss sends the optional note; the Dismissed list shows it", () => {
    expect(page).toMatch(/JSON\.stringify\(\{ ids: Array\.from\(picked\), note: dismissNote \}\)/);
    expect(page).toMatch(/l\.dismiss_note \? ` — \$\{l\.dismiss_note\}` : ""/);
  });
  it("the chip is red, its hover carries the note, and clearing by hand needs one", () => {
    expect(rows).toMatch(/if \(item === EXTRA_UNITS_SHIPPED\) return "bg-red-500\/15 text-red-600/);
    expect(rows).toMatch(/titles=\{extraTitles\(a\)\}/);
    expect(rows).toMatch(/disabled=\{!note\.trim\(\)\} onClick=\{\(\) => void save\(\)\}/);
    expect(routes).toMatch(/app\.post\("\/api\/pos\/asin-rows\/:id\/extra-units\/clear"/);
    expect(routes).toMatch(/if \(wanted\.includes\(EXTRA_UNITS_SHIPPED\)\) any\.push\(EXTRA_UNITS_EXISTS_SQL\)/);
  });
});
