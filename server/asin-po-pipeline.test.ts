import { describe, it, expect } from "vitest";
import { computePipeline, loadAsinPipeline, PIPELINE_ROWS_SQL, type PipelineRow } from "./asin-po-pipeline";

// Patch docs/claude_spec-patch-asins-on-order-from-pos.md §2 — the on-order
// picture derived from po_asins. Fixture (§4 commit 2): one closed pre-May
// PO with no shipment rows, one open PO partly shipped, one over-received
// row — plus the Equal Exchange and Twilight rows from the reconciliation.

const row = (o: Partial<PipelineRow> & { asin: string }): PipelineRow => ({
  closed: false, qty: 0, qty_canceled_asin: null, qty_returned_asin: null, qty_lost_damaged_us: null, qty_at_prep: null, qty_shipped_fba: null, qty_received_amazon: null, ...o,
});

describe("computePipeline", () => {
  it("closed pre-May PO with no shipment rows: nothing on order, nothing inbound (D1)", () => {
    const p = computePipeline([row({ asin: "B0091CZ7WO", closed: true, qty: 12 })]).get("B0091CZ7WO")!;
    expect(p).toEqual({ on_order: 0, at_prep: 0, inbound_fba: 0, pipeline: 0, open_po_count: 0 });
  });
  it("open PO partly shipped: On Order = expected − shipped; Inbound FBA = shipped − received; At Prep from Velocity", () => {
    const p = computePipeline([
      row({ asin: "0349125937", qty: 9, qty_shipped_fba: "9.00", qty_received_amazon: "0.00", qty_at_prep: "0.00" }),
      row({ asin: "0349125937", qty: 3, qty_shipped_fba: "1.00", qty_received_amazon: "0.00", qty_at_prep: "2.00" }),
    ]).get("0349125937")!;
    expect(p).toEqual({ on_order: 2, at_prep: 2, inbound_fba: 10, pipeline: 12, open_po_count: 2 });
  });
  it("fully shipped, auto-closed PO: On Order 0 but its shipped-not-received units stay Inbound FBA", () => {
    const p = computePipeline([row({ asin: "B004WZ4CLW", closed: true, qty: 10, qty_shipped_fba: "10.00", qty_received_amazon: "0.00" })]).get("B004WZ4CLW")!;
    expect(p).toEqual({ on_order: 0, at_prep: 0, inbound_fba: 10, pipeline: 10, open_po_count: 0 });
  });
  it("over-received row contributes 0 to Inbound FBA; canceled / returned / lost reduce Expected; NULLs read 0", () => {
    const p = computePipeline([
      row({ asin: "B01AWK114G", qty: 16, qty_shipped_fba: "16.00", qty_received_amazon: "17.00" }),
      row({ asin: "B01AWK114G", qty: 20, qty_canceled_asin: "5", qty_returned_asin: "1", qty_lost_damaged_us: "2", qty_shipped_fba: "4.00", qty_received_amazon: null }),
    ]).get("B01AWK114G")!;
    // second row: expected 20 − 5 − 1 − 2 = 12; on order 12 − 4 = 8; inbound 4 − 0 = 4
    expect(p).toEqual({ on_order: 8, at_prep: 0, inbound_fba: 4, pipeline: 12, open_po_count: 2 });
  });
  it("an unreconciled OPEN row (shipped NULL) counts its full expected as On Order; fractions survive to 2 dp; ASINs normalise", () => {
    const p = computePipeline([row({ asin: " b0test0001 ", qty: 7, qty_shipped_fba: null, qty_at_prep: "1.17" })]).get("B0TEST0001")!;
    expect(p).toEqual({ on_order: 7, at_prep: 1.17, inbound_fba: 0, pipeline: 7, open_po_count: 1 });
    expect(computePipeline([]).size).toBe(0);
  });
});

describe("loadAsinPipeline", () => {
  it("one query, optional ASIN subset, rows folded per ASIN", async () => {
    const calls: Array<{ sql: string; params?: any[] }> = [];
    const query = async (sql: string, params?: any[]) => { calls.push({ sql, params }); return { rows: [row({ asin: "B004WZ4CLW", closed: true, qty: 10, qty_shipped_fba: "10.00", qty_received_amazon: "0.00" })], rowCount: 1 }; };
    const m = await loadAsinPipeline(query, ["b004wz4clw"]);
    expect(m.get("B004WZ4CLW")?.pipeline).toBe(10);
    expect(calls[0].sql).toContain(PIPELINE_ROWS_SQL);
    expect(calls[0].sql).toMatch(/WHERE pa\.asin = ANY\(\$1::text\[\]\)$/);
    expect(calls[0].params).toEqual([["B004WZ4CLW"]]);
    await loadAsinPipeline(query);
    expect(calls[1].params).toBeUndefined();
    expect(PIPELINE_ROWS_SQL).toMatch(/\(p\.closed_at IS NOT NULL\) AS closed/);
    expect(PIPELINE_ROWS_SQL).toMatch(/FILTER \(WHERE l\.qty_canceled IS NULL\)/);
  });
});
