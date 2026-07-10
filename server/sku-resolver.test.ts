import { describe, it, expect, vi } from "vitest";
import { resolveAndGenerateSku, type ResolveSkuDeps } from "./sku-resolver";

function fakeHttpGet(payload: any) {
  return async () => payload;
}
function failingHttpGet(status: number) {
  return async () => {
    const err: any = new Error("simulated");
    err.response = { status, data: { errors: [{ message: "simulated" }] } };
    throw err;
  };
}

function fakeLegendQuery(rows: Record<string, { code: string; status: string } | null>) {
  // rows keyed by `${type}:${rawValue}` (case-insensitive lookup like the DB does)
  return async (_sql: string, params?: any[]) => {
    const [type, rawValue] = params ?? [];
    const key = `${type}:${String(rawValue ?? "").trim().toLowerCase().replace(/\s+/g, " ")}`;
    const row = rows[key];
    return { rows: row ? [row] : [] };
  };
}

const HAPPY_PAYLOAD = {
  summaries: [{ brand: "AminoGenesis", itemName: "AminoGenesis Triple Firming Renewal" }],
  classifications: [
    {
      classifications: [
        {
          displayName: "Moisturizers",
          parent: {
            displayName: "Face",
            parent: {
              displayName: "Skin Care",
              parent: { displayName: "Beauty & Personal Care" },
            },
          },
        },
      ],
    },
  ],
  images: [],
};

const HAPPY_LEGEND = fakeLegendQuery({
  "brand:aminogenesis": { code: "AMG", status: "approved" },
  "dept:beauty & personal care": { code: "BPC", status: "approved" },
});

describe("resolveAndGenerateSku", () => {
  it("happy path: builds a 5-segment SKU end-to-end", async () => {
    const r = await resolveAndGenerateSku(
      "B0FCM6CX8M",
      4,
      { httpGet: fakeHttpGet(HAPPY_PAYLOAD), queryFn: HAPPY_LEGEND },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.sku).toBe("AMG-BPC-X8M-TFR-004");
      expect(r.trail.category).toBe("Beauty & Personal Care");
      expect(r.trail.brand).toBe("AminoGenesis");
      expect(r.trail.brd).toBe("AMG");
      expect(r.trail.dep).toBe("BPC");
      expect(r.trail.ttl).toBe("TFR");
    }
  });

  it("variantSuffix produces 6-segment SKU", async () => {
    const r = await resolveAndGenerateSku(
      "B0FCM6CX8M",
      4,
      { httpGet: fakeHttpGet(HAPPY_PAYLOAD), queryFn: HAPPY_LEGEND },
      "B",
    );
    if (r.ok) expect(r.sku).toBe("AMG-BPC-X8M-TFR-004-B");
  });

  it("calls selfHealWrite with the catalog-derived fields", async () => {
    const heal = vi.fn().mockResolvedValue(undefined);
    await resolveAndGenerateSku(
      "B0FCM6CX8M",
      1,
      { httpGet: fakeHttpGet(HAPPY_PAYLOAD), queryFn: HAPPY_LEGEND, selfHealWrite: heal },
    );
    expect(heal).toHaveBeenCalledOnce();
    expect(heal).toHaveBeenCalledWith({
      asin: "B0FCM6CX8M",
      category: "Beauty & Personal Care",
      brand: "AminoGenesis",
      itemName: "AminoGenesis Triple Firming Renewal",
      imageUrl: null,
    });
  });

  it("dead_asin: returns 404 outcome, no legend lookup, no self-heal", async () => {
    const heal = vi.fn();
    const lq = vi.fn().mockResolvedValue({ rows: [] });
    const r = await resolveAndGenerateSku(
      "B0DEAD",
      1,
      { httpGet: failingHttpGet(404), queryFn: lq, selfHealWrite: heal },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("dead_asin");
    expect(heal).not.toHaveBeenCalled();
    expect(lq).not.toHaveBeenCalled();
  });

  it("no_brand: returns outcome, no legend lookup", async () => {
    const lq = vi.fn().mockResolvedValue({ rows: [] });
    const r = await resolveAndGenerateSku(
      "B0X",
      1,
      {
        httpGet: fakeHttpGet({ summaries: [{ brand: "" }], classifications: HAPPY_PAYLOAD.classifications }),
        queryFn: lq,
      },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no_brand");
    expect(lq).not.toHaveBeenCalled();
  });

  it("no_category: returns outcome", async () => {
    const r = await resolveAndGenerateSku(
      "B0X",
      1,
      {
        httpGet: fakeHttpGet({ summaries: [{ brand: "X" }], classifications: [] }),
        queryFn: async () => ({ rows: [] }),
      },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no_category");
  });

  it("legend_pending: surfaces brand and dept that need approval", async () => {
    const lq = fakeLegendQuery({
      // brand not in legend at all; dept proposed but unapproved
      "dept:beauty & personal care": { code: "BPC", status: "proposed" },
    });
    const r = await resolveAndGenerateSku(
      "B0FCM6CX8M",
      1,
      { httpGet: fakeHttpGet(HAPPY_PAYLOAD), queryFn: lq },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("legend_pending");
      expect(r.pending?.brand?.rawValue).toBe("AminoGenesis");
      expect(r.pending?.brand?.status).toBe("not_in_legend");
      expect(r.pending?.brand?.proposedCode).toBe("AMI"); // derived
      expect(r.pending?.dept?.rawValue).toBe("Beauty & Personal Care");
      expect(r.pending?.dept?.status).toBe("proposed");
      expect(r.pending?.dept?.proposedCode).toBe("BPC");
    }
  });

  // 20s timeout: fetchCatalogForSku retries 429s 5× with 1s initial backoff
  // doubling (1+2+4+8 = 15s max) before surfacing transient_error.
  it("transient_error: returns retryable outcome after retry exhaustion", { timeout: 20000 }, async () => {
    const r = await resolveAndGenerateSku(
      "B0X",
      1,
      { httpGet: failingHttpGet(429), queryFn: async () => ({ rows: [] }) },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("transient_error");
  });
});
