import { describe, it, expect, vi, beforeEach } from "vitest";

// §21 one-implementation guarantee (2026-09-09): the shared price/fees
// passes are pure fetch/parse/outcome loops — ALL persistence goes through
// the injected writer. Invoked with the bulk writer they physically cannot
// write to asins/asin_estimates, because they never touch the DB at all.
// This is the test Maria asked for instead of a comment.
vi.mock("./index", () => ({ log: () => {} }));
const querySpy = vi.fn(async () => ({ rows: [], rowCount: 0 }));
vi.mock("./db", () => ({ query: (...a: any[]) => querySpy(...a), pool: {} }));
const postSpy = vi.fn();
vi.mock("./spapi-auth", () => ({
  spApiPost: (...a: any[]) => postSpy(...a),
  spApiGet: vi.fn(),
}));

import { runPricePass } from "./price-sync";
import { runFeesPass } from "./refresh-job";

beforeEach(() => { querySpy.mockClear(); postSpy.mockClear(); });

describe("runPricePass — pluggable writer, zero DB access", () => {
  it("writes conclusive outcomes ONLY through the injected writer; query() never called", async () => {
    postSpy.mockResolvedValueOnce({
      responses: [
        { status: { statusCode: 200 }, body: { payload: { Summary: { LowestPrices: [{ condition: "new", fulfillmentChannel: "Amazon", LandedPrice: { Amount: 12.5 } }], NumberOfOffers: [{ condition: "new", OfferCount: 1 }] }, Offers: [{ IsFulfilledByAmazon: true, ListingPrice: { Amount: 12.5 } }] } } },
        { status: { statusCode: 404 } },
      ],
    });
    const writes: Array<[string, any]> = [];
    const res = await runPricePass(["B0TESTAAAA", "B0TESTBBBB"], async (asin, p) => { writes.push([asin, p]); });
    expect(res.counts.updated).toBe(1);
    expect(res.counts.not_found).toBe(1);
    expect(writes.map(([a]) => a)).toEqual(["B0TESTAAAA"]);
    expect(querySpy).not.toHaveBeenCalled(); // the pass owns NO persistence
  });

  it("write: null fetches and tallies without persisting anywhere", async () => {
    postSpy.mockResolvedValueOnce({ responses: [{ status: { statusCode: 200 }, body: { payload: { Summary: {}, Offers: [] } } }] });
    const res = await runPricePass(["B0TESTAAAA"], null);
    expect(res.counts.no_offers).toBe(1);
    expect(res.parsed.has("B0TESTAAAA")).toBe(true); // parsed still returned
    expect(querySpy).not.toHaveBeenCalled();
  });
});

describe("runFeesPass — pluggable writer, zero DB access", () => {
  it("parsed fees flow through the writer; query() never called", async () => {
    postSpy.mockResolvedValueOnce([
      {
        Status: "Success",
        FeesEstimateIdentifier: { IdValue: "B0TESTAAAA" },
        FeesEstimate: {
          TotalFeesEstimate: { Amount: 5.5 },
          FeeDetailList: [
            { FeeType: "ReferralFee", FeeAmount: { Amount: 2.0 }, FinalFee: { Amount: 2.0 } },
            { FeeType: "FBAFees", FeeAmount: { Amount: 3.5 }, FinalFee: { Amount: 3.5 } },
          ],
        },
      },
    ]);
    const writes: Array<[string, any]> = [];
    const res = await runFeesPass([{ asin: "B0TESTAAAA", price: 12.5 }], async (asin, fees) => { writes.push([asin, fees]); });
    expect(res.counts.updated).toBe(1);
    expect(writes).toHaveLength(1);
    expect(writes[0][1].fbaFulfillmentFee).toBeGreaterThan(0);
    expect(querySpy).not.toHaveBeenCalled();
  });
});
