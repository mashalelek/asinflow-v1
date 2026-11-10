import { describe, it, expect } from "vitest";
import { computePipeline, loadAsinPipeline, envReconStart, PIPELINE_ROWS_SQL, type PipelineRow } from "./asin-po-pipeline";

// Patch docs/claude_spec-patch-asins-on-order-from-pos.md §2 — the on-order
// picture derived from po_asins. Fixture (§4 commit 2): one closed pre-May
// PO with no shipment rows, one open PO partly shipped, one over-received
// row — plus the Equal Exchange and Twilight rows from the reconciliation.

// Since migration 101 the rows come from po_asin_expected: `qty_expected_asin` = ordered − Σ claims that count (D14); the tests'
// `qty` is that figure (no claims), ASIN units throughout.
const row = (o: Partial<Omit<PipelineRow, "qty_expected_asin">> & { asin: string; qty?: number | string | null; qty_expected_asin?: number | string | null }): PipelineRow => {
  const { qty, ...rest } = o;
  return { closed: false, reconciled: true, qty_expected_asin: qty ?? 0, qty_lost_damaged_us: null, qty_at_prep: null, qty_at_warehouse: null, qty_shipped_fba: null, qty_received_amazon: null, ...rest };
};

describe("computePipeline", () => {
  it("PO dated before the reconciliation start (no shipment data): contributes 0 to On Order, open or closed (§2.4)", () => {
    const p = computePipeline([row({ asin: "B0091CZ7WO", closed: true, reconciled: false, qty: 12 }), row({ asin: "B0091CZ7WO", reconciled: false, qty: 5 })]).get("B0091CZ7WO")!;
    expect(p).toEqual({ on_order: 0, at_prep: 0, at_warehouse: 0, open_po_count: 1 });
  });
  it("a CLOSED PO contributes 0 to On Order, always (Maria 2026-11-02, reverting §2.4): walmart 200014971489745 B071G486Q7, ships_to home, 2 ordered, shipped FBA NULL, closed by the sheet → On Order 0; target.com 912003733645362 (2 ordered, 0 shipped, 2 at Velocity) → On Order 0 / At Prep 2 — a wrong Closed is fixed by reopening", () => {
    expect(computePipeline([row({ asin: "B071G486Q7", closed: true, qty: "2.00", qty_shipped_fba: null })]).get("B071G486Q7")).toEqual({ on_order: 0, at_prep: 0, at_warehouse: 0, open_po_count: 0 });
    const p = computePipeline([row({ asin: "B0HGP5P91F", closed: true, qty: 2, qty_shipped_fba: null, qty_at_prep: "2.00" })]).get("B0HGP5P91F")!;
    expect(p).toEqual({ on_order: 0, at_prep: 2, at_warehouse: 0, open_po_count: 0 });
    // the same row reopened counts again — but its 2 units are At Prep, so On Order stays 0 (exclusive stages, 2026-11-02)
    expect(computePipeline([row({ asin: "B0HGP5P91F", closed: false, qty: 2, qty_shipped_fba: null, qty_at_prep: "2.00" })]).get("B0HGP5P91F")).toEqual({ on_order: 0, at_prep: 2, at_warehouse: 0, open_po_count: 1 });
    expect(computePipeline([row({ asin: "B0HGP5P91F", closed: false, qty: 2, qty_shipped_fba: null, qty_at_prep: null })]).get("B0HGP5P91F")).toEqual({ on_order: 2, at_prep: 0, at_warehouse: 0, open_po_count: 1 });
    // mixed: only the open row's remainder (5 − 2 shipped − 3 at prep = 0) is On Order; At Prep sums both rows
    expect(computePipeline([
      row({ asin: "B0F9LRJ9BT", closed: true, qty: 3, qty_shipped_fba: null, qty_at_prep: "1.00" }),
      row({ asin: "B0F9LRJ9BT", closed: false, qty: 5, qty_shipped_fba: "2.00", qty_at_prep: "3.00" }),
    ]).get("B0F9LRJ9BT")).toEqual({ on_order: 0, at_prep: 4, at_warehouse: 0, open_po_count: 1 });
  });
  it("open PO partly shipped: On Order = expected − shipped − at prep − at warehouse (exclusive stages, Maria 2026-11-02), floored at 0; At Prep and At CQG Warehouse sum every row", () => {
    const p = computePipeline([
      row({ asin: "0349125937", qty: 9, qty_shipped_fba: "9.00", qty_received_amazon: "0.00", qty_at_prep: "0.00" }),
      row({ asin: "0349125937", qty: 3, qty_shipped_fba: "1.00", qty_received_amazon: "0.00", qty_at_prep: "2.00" }),
    ]).get("0349125937")!;
    expect(p).toEqual({ on_order: 0, at_prep: 2, at_warehouse: 0, open_po_count: 2 }); // 3 − 1 shipped − 2 at prep
    expect(computePipeline([row({ asin: "B0EXCL0001", qty: 10, qty_shipped_fba: "2.00", qty_at_prep: "3.00", qty_at_warehouse: "1.00" })]).get("B0EXCL0001")).toEqual({ on_order: 4, at_prep: 3, at_warehouse: 1, open_po_count: 1 });
    expect(computePipeline([row({ asin: "B0EXCL0002", qty: 5, qty_at_prep: "6.00" })]).get("B0EXCL0002")).toEqual({ on_order: 0, at_prep: 6, at_warehouse: 0, open_po_count: 1 }); // floored
    // a closed row's At Prep / At CQG Warehouse still count in those columns (they are in Stock), just never in On Order
    expect(computePipeline([row({ asin: "B0EXCL0003", closed: true, qty: 5, qty_at_prep: "1.00", qty_at_warehouse: "2.50" })]).get("B0EXCL0003")).toEqual({ on_order: 0, at_prep: 1, at_warehouse: 2.5, open_po_count: 0 });
  });
  it("fully shipped, closed PO: nothing on order (shipped-not-received shows as Amazon's Sent to FBA, not here)", () => {
    const p = computePipeline([row({ asin: "B004WZ4CLW", closed: true, qty: 10, qty_shipped_fba: "10.00", qty_received_amazon: "0.00" })]).get("B004WZ4CLW")!;
    expect(p).toEqual({ on_order: 0, at_prep: 0, at_warehouse: 0, open_po_count: 0 });
  });
  it("over-received row: nothing on order; the claims (in Expected, D14) and lost reduce it; NULLs read 0", () => {
    const p = computePipeline([
      row({ asin: "B01AWK114G", qty: 16, qty_shipped_fba: "16.00", qty_received_amazon: "17.00" }),
      // 20 ordered, 5 canceled + 1 returned as claims → the view's Expected is 14; lost 2 comes off here
      row({ asin: "B01AWK114G", qty_expected_asin: "14", qty_lost_damaged_us: "2", qty_shipped_fba: "4.00", qty_received_amazon: null }),
    ]).get("B01AWK114G")!;
    // second row: expected 14 − 2 = 12; on order 12 − 4 = 8
    expect(p).toEqual({ on_order: 8, at_prep: 0, at_warehouse: 0, open_po_count: 2 });
  });
  it("an unreconciled OPEN row (shipped NULL) counts its expected less what is at prep as On Order; fractions survive to 2 dp; ASINs normalise", () => {
    const p = computePipeline([row({ asin: " b0test0001 ", qty: 7, qty_shipped_fba: null, qty_at_prep: "1.17" })]).get("B0TEST0001")!;
    expect(p).toEqual({ on_order: 5.83, at_prep: 1.17, at_warehouse: 0, open_po_count: 1 });
    expect(computePipeline([]).size).toBe(0);
  });
});

describe("loadAsinPipeline", () => {
  it("one query, optional ASIN subset, rows folded per ASIN", async () => {
    const calls: Array<{ sql: string; params?: any[] }> = [];
    const query = async (sql: string, params?: any[]) => { calls.push({ sql, params }); return { rows: [row({ asin: "B004WZ4CLW", closed: true, qty: 10, qty_shipped_fba: "10.00", qty_received_amazon: "0.00" })], rowCount: 1 }; };
    const m = await loadAsinPipeline(query, ["b004wz4clw"]);
    expect(m.get("B004WZ4CLW")?.on_order).toBe(0);
    expect(calls[0].sql).toContain(PIPELINE_ROWS_SQL);
    expect(calls[0].sql).toMatch(/WHERE e\.asin = ANY\(\$2::text\[\]\)$/);
    expect(calls[0].params?.[1]).toEqual(["B004WZ4CLW"]);
    await loadAsinPipeline(query);
    expect(calls[1].params).toHaveLength(1);
    expect(PIPELINE_ROWS_SQL).toMatch(/\(p\.closed_at IS NOT NULL\) AS closed/);
    expect(PIPELINE_ROWS_SQL).toMatch(/e\.at_prep_asin AS qty_at_prep, e\.at_warehouse_asin AS qty_at_warehouse/);
    expect(PIPELINE_ROWS_SQL).toMatch(/p\.order_date >= COALESCE\(\(SELECT MIN\(shipped_at\) FROM velocity_shipments\), \$1::date, DATE '9999-12-31'\)\) AS reconciled/);
    expect(envReconStart("7/30/2026")).toBe("2026-07-30");
    expect(envReconStart("")).toBeNull();
    expect(PIPELINE_ROWS_SQL).toMatch(/e\.expected_asin AS qty_expected_asin/);
  });
});

describe("pipeline query shape (performance, 2026-10-18; the view since migration 101)", () => {
  it("every quantity comes from po_asin_expected (one grouped pass inside the view) — no per-row subquery over po_line_items, no pack arithmetic here", () => {
    expect(PIPELINE_ROWS_SQL).toMatch(/FROM po_asin_expected e JOIN purchase_orders p ON p\.id = e\.po_id/);
    expect(PIPELINE_ROWS_SQL).not.toMatch(/po_line_items/);
    expect(PIPELINE_ROWS_SQL).not.toMatch(/units_per_pack|unique_products|qty_canceled|qty_returned/);
    for (const c of ["e.lost_damaged_us_asin AS qty_lost_damaged_us", "e.at_prep_asin AS qty_at_prep", "e.at_warehouse_asin AS qty_at_warehouse", "e.shipped_fba_asin AS qty_shipped_fba", "e.received_amazon_asin AS qty_received_amazon"]) expect(PIPELINE_ROWS_SQL).toContain(c);
  });
  it("migration 063 indexes po_line_items(po_asin_id)", async () => {
    const { readFileSync } = await import("fs");
    const sql = readFileSync(new URL("../database/migrations/063_po_line_items_po_asin_idx.sql", import.meta.url), "utf8");
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS po_line_items_po_asin_idx ON po_line_items \(po_asin_id\);/);
  });
});
