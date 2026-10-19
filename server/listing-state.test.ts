// Listing hygiene, component 16 (SPEC §11/§14/§18): listing state per SKU.
import { describe, it, expect } from "vitest";
import { parseListingState } from "./sku-listing-fetch";
import { runFullScopePass } from "./full-scope-pass";

const US = "ATVPDKIKX0DER";
const body = (endAt: string | null, extra: any = {}) => ({
  summaries: [{ marketplaceId: US, asin: "B092RLQ6P4", productType: "FOOD_STORAGE_CONTAINER", status: ["DISCOVERABLE"], createdDate: "2026-09-18T20:29:43.610Z" }],
  attributes: { purchasable_offer: [{ currency: "USD", end_at: { value: endAt }, audience: "ALL", our_price: [{ schedule: [{ value_with_tax: 26 }] }], marketplace_id: US }], ...extra },
});

describe("parseListingState — the spike shapes", () => {
  it("a closed offer: end_at.value is a past timestamp (PRK-HOM-6P4-PIC-001, closed in SC 2026-10-19)", () => {
    expect(parseListingState(body("2026-10-19T09:31:29.082Z"))).toEqual({
      createdAt: "2026-09-18T20:29:43.610Z", offerEndAt: "2026-10-19T09:31:29.082Z", hasOffer: true, productType: "FOOD_STORAGE_CONTAINER",
    });
  });
  it("an open offer: end_at.value is null", () => {
    expect(parseListingState(body(null)).offerEndAt).toBeNull();
  });
  it("the consumer (audience ALL) entry decides when a B2B entry rides alongside", () => {
    const b = body(null);
    b.attributes.purchasable_offer.unshift({ currency: "USD", end_at: { value: "2026-01-01T00:00:00Z" }, audience: "B2B", our_price: [], marketplace_id: US } as any);
    expect(parseListingState(b).offerEndAt).toBeNull();
  });
  it("no purchasable_offer: hasOffer false, no end date", () => {
    expect(parseListingState({ summaries: body(null).summaries, attributes: {} })).toMatchObject({ hasOffer: false, offerEndAt: null });
  });
});

function harness(skuState: Record<string, "closed" | "open" | "404" | "transient">) {
  const writes: Array<{ sql: string; params: any[] }> = [];
  const gets: any[] = [];
  const query = async (sql: string, params?: any[]) => {
    if (/json_agg/.test(sql)) {
      return { rows: [{ asin: "B0A", id: "id-B0A", primary_sku: "S1", has_live_offer: true, skus: Object.keys(skuState).map((sku) => ({ sku, created_at: "2026-01-01" })) }], rowCount: null };
    }
    if (/NOT EXISTS \(SELECT 1 FROM asin_skus/.test(sql)) return { rows: [], rowCount: null };
    writes.push({ sql, params: params ?? [] });
    return { rows: [], rowCount: 1 };
  };
  const httpGet = async (endpoint: string, params?: any) => {
    gets.push(params);
    if (params?.identifiersType === "ASIN") return { items: [] };
    const st = skuState[decodeURIComponent(endpoint.split("/").pop()!)];
    if (st === "transient") { const e: any = new Error("429"); e.response = { status: 429 }; throw e; }
    if (st === "404") { const e: any = new Error("404"); e.response = { status: 404 }; throw e; }
    return body(st === "closed" ? "2026-10-15T01:55:12.212Z" : null);
  };
  return { writes, gets, query, httpGet };
}
const base = { sellerId: "SELLER", pacingMs: 0, nowMs: () => 0, dryRun: false };
const stateWrites = (w: Array<{ sql: string; params: any[] }>) => w.filter((x) => /listing_checked_at = NOW\(\)/.test(x.sql));

describe("runFullScopePass recordListingState (component 16 only)", () => {
  it("writes every SKU's state: open, closed, and absent (404 → dates cleared, stamp moved)", async () => {
    const h = harness({ OPEN1: "open", SHUT1: "closed", GONE1: "404" });
    await runFullScopePass({ ...base, query: h.query as any, httpGet: h.httpGet as any, recordListingState: true });
    const w = stateWrites(h.writes);
    expect(w).toHaveLength(1);
    const [asin, skus, created, ends] = w[0].params;
    expect(asin).toBe("B0A");
    const by = Object.fromEntries(skus.map((s: string, i: number) => [s, [created[i], ends[i]]]));
    expect(by).toEqual({ OPEN1: ["2026-09-18T20:29:43.610Z", null], SHUT1: ["2026-09-18T20:29:43.610Z", "2026-10-15T01:55:12.212Z"], GONE1: [null, null] });
    expect(h.gets.find((p) => p?.includedData)?.includedData).toBe("summaries,issues,attributes");
  });

  it("a transient SKU probe writes NO state for the ASIN (stamps stay old → read as not checked this pass)", async () => {
    const h = harness({ OPEN1: "open", FLAKY: "transient" });
    await runFullScopePass({ ...base, query: h.query as any, httpGet: h.httpGet as any, recordListingState: true });
    expect(stateWrites(h.writes)).toHaveLength(0);
  });

  it("other callers neither ask for attributes nor write state; a dry run never writes", async () => {
    const h = harness({ OPEN1: "open" });
    await runFullScopePass({ ...base, query: h.query as any, httpGet: h.httpGet as any });
    expect(stateWrites(h.writes)).toHaveLength(0);
    expect(h.gets.find((p) => p?.includedData)?.includedData).toBe("summaries,issues");
    const d = harness({ OPEN1: "open" });
    await runFullScopePass({ ...base, dryRun: true, query: d.query as any, httpGet: d.httpGet as any, recordListingState: true });
    expect(stateWrites(d.writes)).toHaveLength(0);
  });
});
