import { describe, it, expect, vi } from "vitest";
import { unionKnownOrders, shipmentOrdersFrom, listInboundOrders, type VelocityInboundOrder } from "./velocity-api";

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

// ── Child-derived union keys + pagination tripwires (2026-09-02) ─────────────
// The flat ("" , ASIN) key silently dropped every same-ASIN bundle after the
// first (parent order_number is null) — the 8/30 B0GNHTYGPF phantom-CREATE
// incident. And pagination metadata must be present + fully consumed: silent
// partial coverage is worse than no dedup.
const bundleOrd = (id: string, asin: string, childOrders: string[], quantity: number): VelocityInboundOrder => ({
  order_id: id, order_number: null as any, asin, date: "08/30/2026",
  sold_as: "bundle", status: "inbound", quantity,
  bundle_children: childOrders.map((n) => ({ order_number: n, quantity: 1 })),
});

describe("unionKnownOrders — child-derived keys (2026-09-02)", () => {
  it("two parent-null bundles of the SAME ASIN both survive (the collision incident)", () => {
    const u = unionKnownOrders(
      [bundleOrd("new", "B0GNHTYGPF", ["200015523189765"], 20), bundleOrd("old", "B0GNHTYGPF", ["200015210238647"], 14)],
      [], [],
    );
    expect(u).toHaveLength(2);
    expect(u.map((o) => o.order_id).sort()).toEqual(["new", "old"]);
  });

  it("the same bundle appearing in two legs still dedups (child keys match)", () => {
    const u = unionKnownOrders(
      [bundleOrd("a", "B0GNHTYGPF", ["200015210238647"], 14)],
      [bundleOrd("a2", "B0GNHTYGPF", ["200015210238647"], 14)],
      [],
    );
    expect(u).toHaveLength(1);
    expect(u[0].lifecycleSource).toBe("inbound");
  });
});

describe("pagination tripwires (2026-09-02)", () => {
  const stubFetch = (bodies: any[]) => {
    let i = 0;
    return vi.fn(async () => ({
      status: 200, ok: true,
      headers: { get: () => null },
      json: async () => bodies[Math.min(i++, bodies.length - 1)],
    })) as any;
  };

  it("missing data.results.total_results throws — no silent fallback", async () => {
    process.env.VELOCITY_API_KEY = "k"; process.env.VELOCITY_WAREHOUSE_ID = "1";
    const orig = globalThis.fetch;
    globalThis.fetch = stubFetch([{ status: "success", data: { orders: [], total: 57 } }]);
    try {
      await expect(listInboundOrders()).rejects.toThrow(/missing data\.results\.total_results/);
    } finally { globalThis.fetch = orig; }
  });

  it("fetched ≠ reported total throws — no plan on partial coverage", async () => {
    process.env.VELOCITY_API_KEY = "k"; process.env.VELOCITY_WAREHOUSE_ID = "1";
    const orig = globalThis.fetch;
    // page reports 57 total but serves 1 order then empty pages
    globalThis.fetch = stubFetch([
      { status: "success", data: { orders: [{ order_id: "x", order_number: "1", asin: "B0A" }], results: { total_results: 57 } } },
      { status: "success", data: { orders: [], results: { total_results: 57 } } },
    ]);
    try {
      const { fetchAllInboundOrders } = await import("./velocity-api");
      await expect(fetchAllInboundOrders()).rejects.toThrow(/coverage incomplete: fetched 1 of 57/);
    } finally { globalThis.fetch = orig; }
  });
});
