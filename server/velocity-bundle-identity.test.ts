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
