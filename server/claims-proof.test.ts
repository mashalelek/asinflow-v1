import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { comparePipelines, compareVerdicts, comparePlans, compareRows, planByKey } from "./claims-proof";
import { OLD_PIPELINE_ROWS_SQL, OLD_CLOSE_ROWS_SQL, OLD_PO_CLOSE_ACTION_ITEMS_SQL, oldComputePipeline, oldAllUnitsAccounted } from "./__fixtures__/claims-before-readers";
import { PIPELINE_ROWS_SQL } from "./asin-po-pipeline";
import { poAsinRowsSql } from "./po-queries";

// Claims commit 1 (migration 101): the before / after proof the dry run runs on production — the frozen old readers vs the
// new ones, compared per ASIN (On Order), per PO (auto-close) and per Velocity plan key.
describe("the frozen pre-migration readers", () => {
  it("still read the columns migration 101 drops; the live readers never do", () => {
    for (const sql of [OLD_PIPELINE_ROWS_SQL, OLD_CLOSE_ROWS_SQL, OLD_PO_CLOSE_ACTION_ITEMS_SQL]) expect(sql).toMatch(/qty_canceled|final_qty|po_line_defects/);
    for (const sql of [PIPELINE_ROWS_SQL, poAsinRowsSql("TRUE")]) expect(sql).not.toMatch(/\bqty_canceled\b|\bqty_returned\b|final_qty|po_line_defects/); // (qty_canceled_asin is the view's Σ claims)
    expect(readFileSync("server/__fixtures__/claims-before-readers.ts", "utf8")).toMatch(/frozen from commit[\s/]+a1e946b/);
  });
  it("the old arithmetic: expected = ordered − canceled − returned − lost; a bundle's Canceled ÷ unique products", () => {
    const p = oldComputePipeline([{ asin: "B0X", closed: false, reconciled: true, qty: 20, qty_canceled_asin: "5", qty_returned_asin: "1", qty_lost_damaged_us: "2", qty_at_prep: null, qty_at_warehouse: null, qty_shipped_fba: "4" }]).get("B0X")!;
    expect(p.on_order).toBe(8);
    expect(oldAllUnitsAccounted([{ qty: 10, qty_canceled_asin: "2", qty_returned_asin: "1", qty_lost_damaged_us: null, qty_shipped_fba: "7" }])).toBe(true);
    expect(OLD_PIPELINE_ROWS_SQL).toContain("ln.canceled_sum / (CASE WHEN pa.sold_as = 'bundle' AND COALESCE(pa.unique_products, 0) > 1 THEN pa.unique_products ELSE 1 END)");
  });
});

describe("the comparisons (pure)", () => {
  const pipe = (o = 0) => ({ on_order: o, at_prep: 1, at_warehouse: 0, open_po_count: 1 });
  it("pipelines: identical to 2 dp → nothing; a moved figure or a missing ASIN → listed", () => {
    expect(comparePipelines(new Map([["B0A", pipe(5.833)]]), new Map([["B0A", pipe(5.83)]]))).toEqual([]);
    expect(comparePipelines(new Map([["B0A", pipe(5)]]), new Map([["B0A", pipe(6)]]))).toEqual([{ key: "B0A", field: "on_order", before: "5", after: "6" }]);
    expect(comparePipelines(new Map([["B0A", pipe(5)]]), new Map())).toHaveLength(4);
  });
  it("verdicts: per PO; plans: per (order, ASIN) key plus the counts; rows: the plan's inputs per line", () => {
    expect(compareVerdicts(new Map([["p1", { verdict: true }]]), new Map([["p1", { verdict: true }]]))).toEqual([]);
    expect(compareVerdicts(new Map([["p1", { verdict: true }]]), new Map([["p1", { verdict: false }]]))).toEqual([{ key: "p1", field: "verdict", before: "true", after: "false" }]);
    const plan = (q: string, unchanged = 3) => ({ creates: [{ order_number: "A1", asin: "B0A", quantity: q }], bundleCreates: [{ orderNumbers: ["A2"], asin: "B0B", quantity: 24, units_per_pack: 2 }],
      updates: [{ order_number: "A3", asin: "B0C", actionable: true, diffs: [{ field: "quantity", sheet: 10, velocity: 8 }] }], skips: [{ orderNumber: "A4", asin: "B0D", reason: "no_live_sku" }], deleteCandidates: [], unchanged, closedInVelocity: 2, unmatchedVelocity: 0, homeCreates: [], homeBundleCreates: [] });
    expect(planByKey(plan("12")).get("A1|B0A")).toBe("create 12");
    expect(planByKey(plan("12")).get("A2|B0B")).toBe("create bundle 24 (×2)");
    expect(planByKey(plan("12")).get("A3|B0C")).toBe("update quantity: 10 vs 8");
    expect(comparePlans(plan("12"), plan("12"))).toEqual([]);
    expect(comparePlans(plan("12"), plan("6", 4))).toEqual([{ key: "A1|B0A", field: "plan", before: "create 12", after: "create 6" }, { key: "*", field: "unchanged", before: "3", after: "4" }]);
    const row = (qty: number, quantity: string) => ({ poAsinId: "pa1", lineNumber: 1, orderNumber: "A1", asin: "B0A", status: "Ordered", qty, quantity, setsN: "5", yieldT: "1", unitsPerPack: "2", soldAs: "multi-pack", prepCost: 1, shipsTo: "velocity" });
    expect(compareRows([row(5, "10")], [row(5, "10")])).toEqual([]);
    expect(compareRows([row(5, "10")], [row(5.5, "11")])).toEqual([{ key: "A1 B0A #1", field: "quantity", before: "10", after: "11" }, { key: "A1 B0A #1", field: "qty", before: "5", after: "5.5" }]);
  });
});
