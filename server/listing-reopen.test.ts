import { describe, it, expect } from "vitest";
import { reopenListing, buildReopenPatchBody } from "./listing-reopen";

const SELLER = "A2TESTSELLER";

describe("buildReopenPatchBody — §18 rails", () => {
  it("uses op merge (NEVER replace — replace wipes the price)", () => {
    const body = buildReopenPatchBody();
    expect(body.patches).toHaveLength(1);
    expect(body.patches[0].op).toBe("merge");
    expect(body.patches[0].path).toBe("/attributes/purchasable_offer");
  });

  it("sets end_at to null (documented optional-sub-attribute delete)", () => {
    const v = buildReopenPatchBody().patches[0].value[0];
    expect(v.end_at).toBeNull();
    expect(v.marketplace_id).toBe("ATVPDKIKX0DER");
    expect(v.currency).toBe("USD");
    expect(v.audience).toBe("ALL");
  });

  it("is PRICE-FREE — no our_price or price fields anywhere in the patch (18555 silent-ignore rail)", () => {
    const json = JSON.stringify(buildReopenPatchBody());
    expect(json).not.toContain("our_price");
    expect(json).not.toContain("value_with_tax");
    expect(json).not.toContain("price");
  });
});

describe("reopenListing", () => {
  it("PATCHes the SKU endpoint and returns ok on ACCEPTED", async () => {
    let captured: { endpoint?: string; body?: any; params?: any } = {};
    const out = await reopenListing(SELLER, "CAM-HOM-M64-RQR-003", async (endpoint, body, params) => {
      captured = { endpoint, body, params };
      return { status: "ACCEPTED", submissionId: "sub-123" };
    });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.submissionId).toBe("sub-123");
    expect(captured.endpoint).toBe(`/listings/2021-08-01/items/${SELLER}/CAM-HOM-M64-RQR-003`);
    expect(captured.params).toEqual({ marketplaceIds: "ATVPDKIKX0DER" });
    expect(captured.body.patches[0].value[0].end_at).toBeNull();
  });

  it("URL-encodes the SKU", async () => {
    let endpoint = "";
    await reopenListing(SELLER, "SKU WITH/SLASH", async (e) => { endpoint = e; return { status: "ACCEPTED" }; });
    expect(endpoint).toContain("SKU%20WITH%2FSLASH");
  });

  it("non-ACCEPTED status → ok:false with the first issue message", async () => {
    const out = await reopenListing(SELLER, "SKU-X", async () => ({
      status: "INVALID",
      issues: [{ code: "4000001", message: "invalid value" }],
    }));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.message).toBe("invalid value");
  });

  it("HTTP error → ok:false with status + code (never throws)", async () => {
    const out = await reopenListing(SELLER, "SKU-X", async () => {
      const err: any = new Error("Request failed with status code 429");
      err.response = { status: 429, data: { errors: [{ code: "QuotaExceeded", message: "throttled" }] } };
      throw err;
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.status).toBe(429);
      expect(out.code).toBe("QuotaExceeded");
    }
  });
});
