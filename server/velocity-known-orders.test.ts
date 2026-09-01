import { describe, it, expect } from "vitest";
import { unionKnownOrders, shipmentOrdersFrom, type VelocityInboundOrder } from "./velocity-api";

// Complete-coverage dedup fix (2026-08-11; near-miss diagnosed 2026-08-07:
// checked-in order 129059664 and shipped order 100878 vanished from
// GET /inbound and classified as CREATE — a duplicate if sent). These pin
// the union precedence, the shipped pseudo-order mapping, and the
// fail-closed shipment-detail parse.

const ord = (order_number: string, asin: string, status: string, quantity?: number): VelocityInboundOrder =>
  ({ order_id: `id-${order_number}-${asin}`, order_number, asin, date: "08/02/2026", sold_as: "individual", status, quantity });

describe("unionKnownOrders", () => {
  it("precedence inbound > inventory > shipment for the same (order_number, asin)", () => {
    const u = unionKnownOrders(
      [ord("111", "B000000001", "inbound", 10)],
      [ord("111", "B000000001", "inventory", 10), ord("222", "B000000002", "inventory", 5)],
      [ord("111", "B000000001", "shipped", 9), ord("333", "B000000003", "shipped", 30)],
    );
    const byNum = new Map(u.map((o) => [o.order_number, o]));
    expect(u).toHaveLength(3);
    expect(byNum.get("111")!.lifecycleSource).toBe("inbound");
    expect(byNum.get("111")!.status).toBe("inbound");
    expect(byNum.get("222")!.lifecycleSource).toBe("inventory");
    expect(byNum.get("333")!.lifecycleSource).toBe("shipment");
  });

  it("same order number with different ASINs stays two entries (multi-ASIN orders)", () => {
    const u = unionKnownOrders([ord("444", "B00000000A", "inbound")], [ord("444", "B00000000B", "inventory")], []);
    expect(u).toHaveLength(2);
  });

  it("the 2026-08-07 repro shape: completed orders present in the union", () => {
    // 129059664 lived only in /inventory, 100878 only in a shipment detail.
    const u = unionKnownOrders(
      [ord("555", "B0000INBND", "inbound")],
      [ord("129059664", "B01AWK114G", "inventory", 16)],
      [ord("100878", "B00O1Y7K68", "shipped", 30)],
    );
    const nums = u.map((o) => o.order_number).sort();
    expect(nums).toEqual(["100878", "129059664", "555"]);
  });
});

describe("shipmentOrdersFrom (fail-closed)", () => {
  it("maps detail orders to shipped pseudo-orders (quantity = quantity_shipped)", () => {
    const rows = shipmentOrdersFrom(
      { orders: [{ order_id: "x", order_number: "100878", asin: "b00o1y7k68", quantity_shipped: 30, sold_as: "individual" }] },
      "ship-1",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("shipped");
    expect(rows[0].asin).toBe("B00O1Y7K68");
    expect(rows[0].quantity).toBe(30);
  });

  it("missing/malformed orders array THROWS — ambiguous coverage refuses to classify", () => {
    expect(() => shipmentOrdersFrom({}, "ship-2")).toThrow(/coverage ambiguous/);
    expect(() => shipmentOrdersFrom({ orders: "nope" }, "ship-3")).toThrow(/coverage ambiguous/);
  });
});
