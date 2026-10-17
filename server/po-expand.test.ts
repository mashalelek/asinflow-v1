import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { poAsinRowsSql } from "./po-queries";
import { fmtQty, qtyNumber, individualUnits, productQtyFromAsin, PO_ASIN_COLUMNS } from "../client/src/lib/po-qty";

// PO expand-by-ASIN patch (docs/claude_spec-patch-po-expand-by-asin.md).
// Commit 3: the §4 column model is ONE component for the detail tab and the
// nested rows; Canceled/Returned are derived from the lines (decision 1);
// Unreimb. Loss is gone from the table (column stays in the DB).

const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8");

describe("§4 column model", () => {
  it("has the 19 columns in the patch's order and names", () => {
    expect(PO_ASIN_COLUMNS.map((c) => c.label)).toEqual([
      "ASIN", "Title", "Amazon SKU", "Ordered", "Cost/Unit", "Total Cost", "Prep", "Sold As", "Units/Pack",
      "Individual Units Ordered", "Canceled", "Returned", "Shipped by Supplier", "At Prep Center", "At CQG Warehouse",
      "Lost/damaged by us", "Shipped FBA", "Received by Amazon", "Shipment IDs", "Action Items", // row-level Status 2026-10-17
    ]);
  });
  it("the detail page renders the shared table and no longer carries Qty (units) or Unreimb. Loss", () => {
    const page = read("client/src/pages/purchase-orders.tsx");
    expect(page).toMatch(/<PoAsinTable asins=\{asins\}/);
    expect(page).not.toMatch(/Qty \(units\)|Unreimb/);
    const comp = read("client/src/components/po-asin-rows.tsx");
    expect(comp).not.toMatch(/unreimbursed/i);
    // Individual Units Ordered = Ordered × Units/Pack (P1)
    expect(comp).toMatch(/individualUnits\(a\.qty, a\.units_per_pack\)/);
    // fixed widths so separate instances align under one header
    expect(comp).toMatch(/table-fixed/);
    expect(comp).toMatch(/<colgroup>/);
  });
});

describe("quantity semantics (§4.1)", () => {
  it("NULL = not tracked → em-dash; integers plain; fractions 2 dp", () => {
    expect(fmtQty(null)).toBe("—");
    expect(fmtQty(undefined)).toBe("—");
    expect(fmtQty("")).toBe("—");
    expect(fmtQty(0)).toBe("0");
    expect(fmtQty("12.00")).toBe("12");
    expect(fmtQty("1.17")).toBe("1.17");
    expect(fmtQty(7 / 6)).toBe("1.17");
    expect(qtyNumber("abc")).toBeNull();
  });
  it("Individual Units Ordered: 5 three-packs = 15 skeins", () => {
    expect(individualUnits(5, 3)).toBe(15);
    expect(individualUnits(6, 2)).toBe(12);
  });
});

describe("derived Canceled / Returned (pre-flight decision 1)", () => {
  it("the ASIN row sums line qty × yield and is NULL when any line is untracked", () => {
    const sql = poAsinRowsSql("pa.po_id = $1").replace(/\s+/g, " ");
    for (const col of ["qty_canceled", "qty_returned"]) {
      expect(sql).toContain(`COUNT(*) FILTER (WHERE l.${col} IS NULL) > 0 THEN NULL`);
      expect(sql).toContain(`SUM(l.${col} * COALESCE(l.asin_qty_per_product, 1))`);
    }
    expect(sql).toMatch(/AS qty_canceled_asin/);
    expect(sql).toMatch(/AS qty_returned_asin/);
    // no stored copies on po_asins are read for these
    expect(sql).not.toMatch(/pa\.qty_canceled|pa\.qty_returned/);
  });
  it("the detail route uses the shared loader (one query shape for both surfaces)", () => {
    const routes = read("server/routes.ts");
    const detail = routes.slice(routes.indexOf('app.get("/api/pos/:id"'), routes.indexOf("// === Bulk Profit Calculator"));
    expect(detail).toMatch(/await loadPoAsinRows\(/);
    expect(detail).not.toMatch(/SELECT pa\.\*/);
  });
});

// ── Commit 4: Expand by ASIN on the POs page (§3) ──────────────────────────
import { DEFAULT_PO_EXPANDED, isPoExpanded, togglePoExpanded, toggleExpandAll, PO_EXPANDED_KEY } from "../client/src/lib/po-expanded";

describe("Expand by ASIN — persisted state helpers (§3.4)", () => {
  it("default is all collapsed; chevron toggles one; Expand All toggles the flag", () => {
    expect(DEFAULT_PO_EXPANDED).toEqual({ all: false, ids: [] });
    expect(PO_EXPANDED_KEY).toBe("fba-po-expanded");
    const one = togglePoExpanded(DEFAULT_PO_EXPANDED, "p1", ["p1", "p2", "p3"]);
    expect(one).toEqual({ all: false, ids: ["p1"] });
    expect(isPoExpanded(one, "p1")).toBe(true);
    expect(isPoExpanded(one, "p2")).toBe(false);
    expect(togglePoExpanded(one, "p1", ["p1", "p2", "p3"])).toEqual({ all: false, ids: [] });
    const all = toggleExpandAll(one);
    expect(all).toEqual({ all: true, ids: [] });
    expect(isPoExpanded(all, "p9")).toBe(true);
    expect(toggleExpandAll(all)).toEqual({ all: false, ids: [] });
  });
  it("collapsing one PO under Expand All turns the flag off and keeps the other visible POs open", () => {
    const s = togglePoExpanded({ all: true, ids: [] }, "p2", ["p1", "p2", "p3"]);
    expect(s).toEqual({ all: false, ids: ["p1", "p3"] });
  });
});

describe("Expand by ASIN — list payload and page (§3.1–3.3)", () => {
  it("the list route attaches the page's ASIN rows through the shared loader (P3: 25/page, eager)", () => {
    const routes = read("server/routes.ts");
    const list = routes.slice(routes.indexOf('app.get("/api/pos"'), routes.indexOf('app.get("/api/pos/:id"'));
    expect(list).toMatch(/loadPoAsinRows\(\(sql, params\) => query\(sql, params\), rows\.map/);
    expect(list).toMatch(/r\.asins = asinsByPo\.get/);
  });
  it("the page has the Expand All toggle, a chevron-only expand target, nested rows via the shared row, header once", () => {
    const page = read("client/src/pages/purchase-orders.tsx");
    expect(page).toMatch(/button-po-expand-all/);
    expect(page).toMatch(/toggleExpandAll\(expandedState\)/);
    expect(page).toMatch(/onClick=\{\(e\) => e\.stopPropagation\(\)\}>\s*<button type="button"/); // chevron cell swallows the row click
    expect(page).toMatch(/togglePoExpanded\(expandedState, po\.id, visibleIds\)/);
    expect(page).toMatch(/<PoAsinRow key=\{a\.id\} a=\{a\} indent/);
    expect(page).toMatch(/firstExpandedId === po\.id && <thead><PoAsinHeaderRow sub \/><\/thead>/);
    expect(page).toMatch(/savePoExpanded\(next\)/);
  });
});

// ── Commit 7: Products table status columns (§4.3) ─────────────────────────
describe("Products tab status columns (§4.3)", () => {
  it("converts an ASIN quantity to product units through the yield", () => {
    expect(productQtyFromAsin("5", "0.33")).toBe(15.15);   // 5 three-packs ≈ 15 skeins (sheet yield is rounded)
    expect(productQtyFromAsin("6", "6")).toBe(1);          // 6 two-packs = 1 case
    expect(productQtyFromAsin("4", "1")).toBe(4);
    expect(productQtyFromAsin("4", null)).toBe(4);
    expect(productQtyFromAsin(null, "1")).toBeNull();      // not tracked stays not tracked
  });
  it("the Products tab adds At Prep Center / At CQG Warehouse / Lost-damaged, through the yield for 1:1 lines, dash for bundle components", () => {
    const page = read("client/src/pages/purchase-orders.tsx");
    const tab = page.slice(page.indexOf('{tab === "products" && ('));
    for (const h of ["At Prep Center", "At CQG Warehouse", "Lost/damaged by us"]) expect(tab).toContain(`<th className={thNum}>${h}</th>`);
    expect(tab).toMatch(/l\.soleLine \? productQtyFromAsin\(l\.parent\.qty_at_prep, l\.asin_qty_per_product\) : null/);
    expect(tab).toMatch(/l\.soleLine \? productQtyFromAsin\(l\.parent\.qty_at_warehouse, l\.asin_qty_per_product\) : null/);
    expect(tab).toMatch(/l\.soleLine \? productQtyFromAsin\(l\.parent\.qty_lost_damaged_us, l\.asin_qty_per_product\) : null/);
    expect(page).toMatch(/soleLine: a\.lines\.length === 1/);
    // shipment columns stay ASIN-level only
    expect(tab).not.toMatch(/Shipped FBA|Received by Amazon|Shipment IDs/);
  });
});
