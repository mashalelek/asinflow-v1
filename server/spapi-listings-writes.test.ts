// Listing hygiene (SPEC §11, components 22 / 24): PATCH and DELETE on the
// listings items path go through the single choke point and land in the
// Listings bucket — the same one getListingsItem and the PUT spend.
import { describe, it, expect, vi, beforeEach } from "vitest";

const seen: string[] = [];
vi.mock("./spapi-rate-limit", async (orig) => {
  const real: any = await orig();
  return { ...real, withRateLimit: vi.fn(async (endpoint: string, fn: () => Promise<any>) => { seen.push(endpoint); return fn(); }) };
});
vi.mock("axios", () => {
  const ok = { data: { status: "ACCEPTED" }, headers: {} };
  return { default: { post: vi.fn(async () => ({ data: { access_token: "t", expires_in: 3600 } })), patch: vi.fn(async () => ok), delete: vi.fn(async () => ok) } };
});

import axios from "axios";
import { spApiPatch, spApiDelete } from "./spapi-auth";
import { operationKeyFor } from "./spapi-rate-limit";

const PATH = "/listings/2021-08-01/items/A1SELLER/ABC-DEF-001";

describe("listings writes: limiter mapping", () => {
  it("PATCH and DELETE item paths map to the Listings bucket (incl. an encoded SKU and a query string)", () => {
    expect(operationKeyFor(PATH)).toBe("listings.items");
    expect(operationKeyFor(`/listings/2021-08-01/items/A1SELLER/${encodeURIComponent("AB/CD 1")}?marketplaceIds=ATVPDKIKX0DER`)).toBe("listings.items");
  });
});

describe("spApiPatch / spApiDelete go through withRateLimit", () => {
  beforeEach(() => { seen.length = 0; process.env.SP_API_CLIENT_ID = "x"; process.env.SP_API_CLIENT_SECRET = "y"; process.env.SP_API_REFRESH_TOKEN = "z"; });

  it("spApiPatch sends a PATCH through the limiter with the endpoint", async () => {
    const r = await spApiPatch(PATH, { productType: "PRODUCT", patches: [] }, { marketplaceIds: "ATVPDKIKX0DER" });
    expect(r).toEqual({ status: "ACCEPTED" });
    expect(seen).toEqual([PATH]);
    expect((axios as any).patch).toHaveBeenCalledWith(expect.stringContaining(PATH), { productType: "PRODUCT", patches: [] }, expect.objectContaining({ params: { marketplaceIds: "ATVPDKIKX0DER" }, timeout: 30_000 }));
  });

  it("spApiDelete sends a DELETE through the limiter with the endpoint", async () => {
    await spApiDelete(PATH, { marketplaceIds: "ATVPDKIKX0DER" });
    expect(seen).toEqual([PATH]);
    expect((axios as any).delete).toHaveBeenCalledWith(expect.stringContaining(PATH), expect.objectContaining({ params: { marketplaceIds: "ATVPDKIKX0DER" }, timeout: 30_000 }));
  });
});
