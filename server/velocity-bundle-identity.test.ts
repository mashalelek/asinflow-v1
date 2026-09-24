import { describe, it, expect } from "vitest";
import { shipmentOrdersFrom, collapseBundleShipmentRows, matchKeysForOrder, unionKnownOrders } from "./velocity-api";

// §11 Part C.1 (2026-09-21): bundle shipment rows group by parent order_id
// with quantity = the parent total. Before this, all shipped bundles of one
// ASIN collapsed onto ("", ASIN) and the survivor reported quantity_shipped.
const C0835 = "c0835a42-62bf-4926-91dc-97ba664bf4fa";
const O3BB = "03bb63ec-20d7-40a9-9794-28cfdd98ee62";

const bundleRow = (order_id: string, quantity: number, quantity_shipped: number) => ({
  order_id, order_number: null, asin: "B0GNHTYGPF", date: "09/01/2026",
  sold_as: "bundle", quantity, quantity_shipped, units_per_pack: 2,
  amazon_sku: "DRT-BPC-GPF-GGL-001", item_name: "Dr Teal's Gardenia Grace…",
});

describe("Part C.1 — shipment-leg bundle grouping", () => {
  it("a bundle's shipment row reports the parent quantity, not quantity_shipped", () => {
    const rows = shipmentOrdersFrom({ orders: [bundleRow(C0835, 20, 2)] }, "ship-1");
    expect(rows[0].quantity).toBe(20);          // bundle TOTAL
    expect((rows[0] as any).units_per_pack).toBe(2);
  });

  it("a FLAT order still reports quantity_shipped (unchanged)", () => {
    const rows = shipmentOrdersFrom({ orders: [{ order_id: "x", order_number: "123", asin: "B0FLAT00001", sold_as: "individual", quantity: 50, quantity_shipped: 7 }] }, "ship-1");
    expect(rows[0].quantity).toBe(7);
  });

  it("c0835a42's four shipment rows collapse to ONE known order, quantity 20", () => {
    const raw = [
      ...shipmentOrdersFrom({ orders: [bundleRow(C0835, 20, 2)] }, "ship-1"),
      ...shipmentOrdersFrom({ orders: [bundleRow(C0835, 20, 6)] }, "ship-2"),
      ...shipmentOrdersFrom({ orders: [bundleRow(C0835, 20, 2)] }, "ship-3"),
      ...shipmentOrdersFrom({ orders: [bundleRow(C0835, 20, 10)] }, "ship-4"),
    ];
    const collapsed = collapseBundleShipmentRows(raw);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0].quantity).toBe(20);
    expect((collapsed[0] as any).__shipment_ids).toEqual(["ship-1", "ship-2", "ship-3", "ship-4"]);
  });

  it("TWO parents of the SAME ASIN stay distinct through collapse AND union", () => {
    const raw = [
      ...shipmentOrdersFrom({ orders: [bundleRow(C0835, 20, 10)] }, "ship-a"),
      ...shipmentOrdersFrom({ orders: [{ ...bundleRow(O3BB, 14, 14), date: "08/30/2026" }] }, "ship-a"),
    ];
    const collapsed = collapseBundleShipmentRows(raw);
    expect(collapsed).toHaveLength(2);
    const union = unionKnownOrders([], [], collapsed);
    expect(union).toHaveLength(2);                       // the old code produced 1
    expect(union.map((o) => o.quantity).sort((a, b) => (a! - b!))).toEqual([14, 20]);
  });

  it("an unidentified bundle parent keys by order_id and matches no sheet key", () => {
    const keys = matchKeysForOrder({ order_number: null, asin: "B0GNHTYGPF", sold_as: "bundle", order_id: C0835 } as any);
    expect(keys).toEqual([{ orderNumber: `__velocity_order_id:${C0835}`, asin: "B0GNHTYGPF" }]);
    expect(keys[0].orderNumber).not.toBe("");            // the collapsing key
  });

  it("a HYDRATED bundle still keys by its child order numbers", () => {
    const keys = matchKeysForOrder({
      order_number: null, asin: "B0G6R55GNQ", sold_as: "bundle", order_id: "d86eb6ef",
      bundle_children: [{ order_number: "200015497641702" }, { order_number: "200015497641702" }],
    } as any);
    expect(keys).toEqual([{ orderNumber: "200015497641702", asin: "B0G6R55GNQ" }]);
  });
});

import { recordableBundles, childIdentityOf, recordBundleIdentities, mapBundleIdentity } from "./velocity-bundle-identity";

// §11 Part B (2026-09-21) — recording.
describe("Part B — recording", () => {
  const listBundle = (over: any = {}) => ({
    order_id: "d86eb6ef", asin: "b0g6r55gnq", sold_as: "bundle", lifecycleSource: "inbound",
    bundle_children: [
      { order_id: "27e74815", order_number: "200015497641702" },
      { order_id: "179e2b04", order_number: "200015497641702" },
    ],
    ...over,
  });

  it("collects list-leg bundle parents with children, uppercasing the ASIN and de-duping numbers", () => {
    const rows = recordableBundles([listBundle()]);
    expect(rows).toEqual([{
      velocity_order_id: "d86eb6ef", asin: "B0G6R55GNQ",
      child_order_numbers: ["200015497641702"],           // de-duped
      child_order_ids: ["27e74815", "179e2b04"],
      source: "observed",
    }]);
  });

  it("ignores shipment-leg rows (their children are never serialized)", () => {
    expect(recordableBundles([listBundle({ lifecycleSource: "shipment", bundle_children: [] })])).toEqual([]);
  });

  it("ignores non-bundles and children-less parents — nothing to record", () => {
    expect(recordableBundles([listBundle({ sold_as: "individual" })])).toEqual([]);
    expect(recordableBundles([listBundle({ bundle_children: [] })])).toEqual([]);
    expect(recordableBundles([listBundle({ bundle_children: [{ order_number: "  " }] })])).toEqual([]);
  });

  it("childIdentityOf returns ids only when present (manual rows have none)", () => {
    expect(childIdentityOf({ bundle_children: [{ order_number: "A" }] })).toEqual({ numbers: ["A"], ids: [] });
  });

  it("observed children OVERWRITE a stale row and the change is reported", async () => {
    const calls: any[] = [];
    const fakeQuery = async (sql: string, params?: any[]) => {
      calls.push({ sql, params });
      if (/SELECT child_order_numbers/.test(sql)) return { rows: [{ child_order_numbers: ["OLD-1"] }] };
      return { rows: [], rowCount: 1 };
    };
    const r = await recordBundleIdentities(recordableBundles([listBundle()]), { query: fakeQuery as any });
    expect(r.written).toBe(1);
    expect(r.changed).toEqual([{ velocity_order_id: "d86eb6ef", from: ["OLD-1"], to: ["200015497641702"] }]);
    expect(calls.some((c) => /INSERT INTO velocity_bundle_identity/.test(c.sql) && /ON CONFLICT/.test(c.sql))).toBe(true);
    expect(calls.every((c) => !/DELETE/i.test(c.sql))).toBe(true); // insert/upsert only
  });

  it("a write failure is surfaced, not thrown — the plan still completes (B.4)", async () => {
    const fakeQuery = async (sql: string) => {
      if (/SELECT child_order_numbers/.test(sql)) return { rows: [] };
      throw new Error("db on fire");
    };
    const r = await recordBundleIdentities(recordableBundles([listBundle()]), { query: fakeQuery as any });
    expect(r.written).toBe(0);
    expect(r.errors[0]).toMatch(/d86eb6ef: db on fire/);
  });

  it("mapBundleIdentity writes a manual_map row and refuses a blank order number", async () => {
    const calls: any[] = [];
    const fakeQuery = async (sql: string, params?: any[]) => { calls.push({ sql, params }); return { rows: [] }; };
    await mapBundleIdentity({ velocityOrderId: "c0835a42", asin: "b0gnhtygpf", orderNumber: " 200015523189765 " }, { query: fakeQuery as any });
    expect(calls[0].sql).toMatch(/'manual_map'/);
    expect(calls[0].params).toEqual(["c0835a42", "B0GNHTYGPF", "200015523189765"]);
    await expect(mapBundleIdentity({ velocityOrderId: "x", asin: "y", orderNumber: "  " }, { query: fakeQuery as any }))
      .rejects.toThrow(/orderNumber is required/);
  });
});

import { withinOneDay } from "./velocity-reconcile";

// §11 Part D (2026-09-21) — the ±1-day / same-units candidate window.
describe("Part D — unplaced candidate window", () => {
  it("−1 / 0 / +1 calendar day are candidates; ±2 is not", () => {
    // Velocity 09/01/2026 (zero-padded) vs sheet M/D/YYYY.
    expect(withinOneDay("8/31/2026", "09/01/2026")).toBe(true);   // the c0835a42 case
    expect(withinOneDay("9/1/2026", "09/01/2026")).toBe(true);
    expect(withinOneDay("9/2/2026", "09/01/2026")).toBe(true);
    expect(withinOneDay("8/30/2026", "09/01/2026")).toBe(false);  // −2
    expect(withinOneDay("9/3/2026", "09/01/2026")).toBe(false);   // +2
  });

  it("crosses month and year boundaries correctly", () => {
    expect(withinOneDay("8/31/2026", "09/01/2026")).toBe(true);
    expect(withinOneDay("12/31/2025", "01/01/2026")).toBe(true);
    expect(withinOneDay("1/1/2026", "12/31/2025")).toBe(true);
  });

  it("an unparseable date on either side is NOT a candidate (fail-closed)", () => {
    expect(withinOneDay("", "09/01/2026")).toBe(false);
    expect(withinOneDay("9/1/2026", "")).toBe(false);
    expect(withinOneDay("2026-09-01", "09/01/2026")).toBe(false); // wrong format
  });
});

// §11 Part D UI (2026-09-21): a mapping identifies ONE parent, so it releases
// exactly that parent's other candidates — never another parent's.
describe("Part D — mapping releases only the mapping parent's candidates", () => {
  const skip = (orderNumber: string, asin: string, holders: string[]) => ({
    reason: "bundle_unplaced_candidate", orderNumber, asin, itemName: null,
    unplaced: holders.map((h) => ({ velocity_order_id: h, date: "09/01/2026", quantity: 20, units_per_pack: 2, amazon_sku: null, item_name: null, created_at: null })),
  });
  // Mirrors the dialog's release rule (same predicate, asserted here so the
  // scoping can't silently widen).
  const released = (skips: any[], mappedKey: string, parentId: string) =>
    skips.filter((o) => o.reason === "bundle_unplaced_candidate")
      .filter((o) => `${o.orderNumber}|${o.asin}` !== mappedKey)
      .filter((o) => (o.unplaced ?? []).some((u: any) => u.velocity_order_id === parentId))
      .map((o) => `${o.orderNumber}|${o.asin}`);

  it("releases the other groups held by the SAME parent", () => {
    const skips = [skip("A1", "B0GNHTYGPF", ["parent-1"]), skip("A2", "B0GNHTYGPF", ["parent-1"])];
    expect(released(skips, "A1|B0GNHTYGPF", "parent-1")).toEqual(["A2|B0GNHTYGPF"]);
  });

  it("leaves groups held by a DIFFERENT parent still held", () => {
    const skips = [skip("A1", "B0GNHTYGPF", ["parent-1"]), skip("A2", "B0GNHTYGPF", ["parent-2"])];
    expect(released(skips, "A1|B0GNHTYGPF", "parent-1")).toEqual([]);
  });

  it("a group held by BOTH parents is released when either is mapped", () => {
    const skips = [skip("A1", "B0GNHTYGPF", ["parent-1"]), skip("A2", "B0GNHTYGPF", ["parent-1", "parent-2"])];
    expect(released(skips, "A1|B0GNHTYGPF", "parent-1")).toEqual(["A2|B0GNHTYGPF"]);
  });
});

import { hydrateChildlessBundles } from "./velocity-bundle-identity";
import { matchKeysForOrder as mkKeys } from "./velocity-api";

// §11 Part C.2 (2026-09-24) — the shared hydration, and the exact case that
// would have duplicated: 134524 / B0DKT4NDFZ, approved 9/21, created 9/23,
// parent SHIPPED before the send, so its shipment row is child-less.
describe("shared hydration — execute must drop an approved create whose parent shipped", () => {
  const PARENT = "6766a9d2-1f85-4765-af1e-fa6655eeebe6";
  const shippedChildless = () => ({
    order_id: PARENT, order_number: null, asin: "B0DKT4NDFZ", sold_as: "bundle",
    status: "shipped", lifecycleSource: "shipment", date: "09/13/2026", quantity: 10,
  });
  const recordQuery = async (sql: string, params?: any[]) => {
    if (/FROM velocity_bundle_identity/.test(sql)) {
      return { rows: (params?.[0] ?? []).includes(PARENT)
        ? [{ velocity_order_id: PARENT, asin: "B0DKT4NDFZ", child_order_numbers: ["134524"], child_order_ids: null, source: "observed" }]
        : [] };
    }
    return { rows: [] };
  };

  it("WITHOUT hydration the shipped parent keys on the synthetic form — the duplicate bug", () => {
    const keys = mkKeys(shippedChildless() as any);
    expect(keys[0].orderNumber).toBe(`__velocity_order_id:${PARENT}`);
    const liveKeys = new Set(keys.map((k) => `${k.orderNumber} ${k.asin}`));
    expect(liveKeys.has("134524 B0DKT4NDFZ")).toBe(false);   // execute would re-send
  });

  it("WITH hydration it keys on 134524 — the approved create is dropped", async () => {
    const live = [shippedChildless()];
    const r = await hydrateChildlessBundles(live, { query: recordQuery as any });
    expect(r.hydrated).toBe(1);
    expect(r.unplaced).toEqual([]);
    const liveKeys = new Set<string>();
    for (const o of live) for (const k of mkKeys(o as any)) liveKeys.add(`${k.orderNumber} ${k.asin}`);
    expect(liveKeys.has("134524 B0DKT4NDFZ")).toBe(true);    // execute now skips it
  });

  it("a parent with NO record stays unplaced and is not invented", async () => {
    const live = [{ ...shippedChildless(), order_id: "unknown-parent" }];
    const r = await hydrateChildlessBundles(live, { query: recordQuery as any });
    expect(r.hydrated).toBe(0);
    expect(r.unplaced).toHaveLength(1);
    expect(live[0].bundle_children).toBeUndefined();
  });

  it("a list-visible bundle with real children is left alone", async () => {
    const live = [{ order_id: "d86eb6ef", asin: "B0G6R55GNQ", sold_as: "bundle", lifecycleSource: "inbound",
      bundle_children: [{ order_number: "200015497641702" }] }];
    const r = await hydrateChildlessBundles(live, { query: recordQuery as any });
    expect(r.hydrated).toBe(0);
    expect(live[0].bundle_children).toEqual([{ order_number: "200015497641702" }]);
  });
});
