// Listing hygiene, component 15 (SPEC §11/§14): every FBA bucket per SKU.
import { describe, it, expect, vi, beforeEach } from "vitest";

const pages: Array<() => any> = [];
const queries: { sql: string; params?: any[] }[] = [];
vi.mock("./log", () => ({ log: () => {} }));
vi.mock("./spapi", () => ({ spApiGet: vi.fn(async () => { const next = pages.shift(); if (!next) throw new Error("no page"); return next(); }) }));
vi.mock("./db", () => ({ query: vi.fn(async (sql: string, params?: any[]) => { queries.push({ sql, params }); return { rows: [], rowCount: 0 }; }) }));
vi.mock("./asin-po-pipeline", () => ({ loadAsinPipeline: vi.fn(async () => new Map()) }));

import { parseSkuBuckets, planSkuInventoryRows, anyBucketNonzero } from "./sku-fba-inventory";
import { syncInventory } from "./inventory-sync";

// The details=true shape, verbatim from the 2026-10-18 spike (1K-6A2Y-J883).
const SPIKE_ROW = {
  asin: "B06Y66P49Z", fnSku: "X00522Y00X", sellerSku: "1K-6A2Y-J883", condition: "NewItem",
  inventoryDetails: {
    fulfillableQuantity: 3, inboundWorkingQuantity: 4, inboundShippedQuantity: 5, inboundReceivingQuantity: 6,
    reservedQuantity: { totalReservedQuantity: 15, pendingCustomerOrderQuantity: 7, pendingTransshipmentQuantity: 8, fcProcessingQuantity: 0 },
    researchingQuantity: { totalResearchingQuantity: 2, researchingQuantityBreakdown: [] },
    unfulfillableQuantity: { totalUnfulfillableQuantity: 1, customerDamagedQuantity: 0, warehouseDamagedQuantity: 0, distributorDamagedQuantity: 0, carrierDamagedQuantity: 0, defectiveQuantity: 1, expiredQuantity: 0 },
    futureSupplyQuantity: { reservedFutureSupplyQuantity: 0, futureSupplyBuyableQuantity: 9 },
  },
  lastUpdatedTime: "2026-10-16T02:54:28Z", productName: "x", totalQuantity: 1, stores: [],
};

describe("parseSkuBuckets", () => {
  it("maps every details=true bucket by its spike field name", () => {
    expect(parseSkuBuckets(SPIKE_ROW)).toEqual({
      sku: "1K-6A2Y-J883", asin: "B06Y66P49Z", fnsku: "X00522Y00X",
      fulfillable: 3, inbound_working: 4, inbound_shipped: 5, inbound_receiving: 6,
      reserved_customer: 7, reserved_fc_transfer: 8, reserved_fc_processing: 0,
      unfulfillable: 1, researching: 2, future_supply: 9,
    });
  });
  it("missing detail objects read 0, and a row without sellerSku is skipped", () => {
    const b = parseSkuBuckets({ asin: "B0X", sellerSku: "S1" })!;
    expect(anyBucketNonzero(b)).toBe(false);
    expect(parseSkuBuckets({ asin: "B0X" })).toBeNull();
  });
});

describe("planSkuInventoryRows", () => {
  it("zero-fills a known SKU absent from the complete pull, and sums a duplicated SKU", () => {
    const a = parseSkuBuckets(SPIKE_ROW)!;
    const { rows, zeroFilled } = planSkuInventoryRows([a, { ...a }], [{ sku: "1K-6A2Y-J883", asin: "B06Y66P49Z" }, { sku: "GONE-001", asin: "B000000001" }]);
    expect(zeroFilled).toBe(1);
    expect(rows.find((r) => r.sku === "1K-6A2Y-J883")!.fulfillable).toBe(6);
    const gone = rows.find((r) => r.sku === "GONE-001")!;
    expect(gone.asin).toBe("B000000001");
    expect(anyBucketNonzero(gone)).toBe(false);
  });
});

describe("syncInventory → sku_fba_inventory", () => {
  beforeEach(() => { pages.length = 0; queries.length = 0; });
  const writes = () => queries.filter((q) => q.sql.includes("INSERT INTO sku_fba_inventory"));

  it("an incomplete pull (a page fails) writes nothing to sku_fba_inventory", async () => {
    pages.push(() => ({ payload: { inventorySummaries: [SPIKE_ROW] }, pagination: { nextToken: "p2" } }));
    pages.push(() => { throw new Error("HTTP 500"); });
    await expect(syncInventory(undefined, { recordSkuBuckets: true, jobId: 7 })).rejects.toThrow("HTTP 500");
    expect(writes()).toHaveLength(0);
  });

  it("a complete pull writes every SKU account-wide, with the job id", async () => {
    pages.push(() => ({ payload: { inventorySummaries: [SPIKE_ROW] }, pagination: {} }));
    const r = await syncInventory(new Set(["B0SOMETHINGELSE"]), { recordSkuBuckets: true, jobId: 7 });
    expect(writes()).toHaveLength(1);
    expect(writes()[0].params![0]).toEqual(["1K-6A2Y-J883"]); // outside asinFilter, still written
    expect(writes()[0].params![13]).toBe(7);
    expect(r.skuRows).toBe(1);
  });

  it("callers other than component 15 never write it", async () => {
    pages.push(() => ({ payload: { inventorySummaries: [SPIKE_ROW] }, pagination: {} }));
    await syncInventory(undefined);
    expect(writes()).toHaveLength(0);
  });
});
