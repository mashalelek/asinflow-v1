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

describe("shared auth: the LWA token is read inside the rate-limited send", () => {
  it("a fresh module (empty token cache) fetches the token only AFTER the limiter releases the request", async () => {
    // Regression for ledger backfill job 13 (2026-10-19): the token used to be
    // fetched before the limiter wait, so a request queued across an expiry
    // left with a dead token → 403 "The access token you provided has expired".
    vi.resetModules();
    const order: string[] = [];
    const limiter: any = await import("./spapi-rate-limit");
    limiter.withRateLimit.mockImplementationOnce(async (_endpoint: string, fn: () => Promise<any>) => { order.push("released"); return fn(); });
    const ax: any = (await import("axios")).default;
    ax.post.mockImplementationOnce(async () => { order.push("token"); return { data: { access_token: "fresh", expires_in: 3600 } }; });
    ax.delete.mockImplementationOnce(async (_url: string, cfg: any) => { order.push(`sent:${cfg.headers["x-amz-access-token"]}`); return { data: { status: "ACCEPTED" }, headers: {} }; });
    const fresh = await import("./spapi-auth");
    await fresh.spApiDelete(PATH, { marketplaceIds: "ATVPDKIKX0DER" });
    expect(order).toEqual(["released", "token", "sent:fresh"]);
  });
});
