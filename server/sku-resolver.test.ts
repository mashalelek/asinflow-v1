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

  it("no_brand → legend_pending 'missing' (§18 2026-08-29 reclassification), no legend lookup", async () => {
    const lq = vi.fn(async () => ({ rows: [] }));
    const r = await resolveAndGenerateSku(
      "B00MW6OAK6",
      1,
      { queryFn: lq as any, httpGet: fakeHttpGet({ ...HAPPY_PAYLOAD, summaries: [{ itemName: "X" }] }) },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("legend_pending");
      expect(r.pending?.brand?.status).toBe("missing");
    }
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

// §18 missing-brand manual entry (2026-08-29): brand absent from the catalog
// is legend_pending (status "missing"), never an error; a manually-entered
// 3-char code (A-Z/0-9) builds the SKU after validation + legend-collision
// check, and the one-off path writes NO legend row.
describe("resolveAndGenerateSku — missing brand (§18, 2026-08-29)", () => {
  const NO_BRAND_PAYLOAD = {
    ...HAPPY_PAYLOAD,
    summaries: [{ itemName: "Mystery Widget Deluxe" }], // no brand key at all
  };

  // Query router: legend resolve lookups (params [type, rawValue]) + the
  // collision probe (SQL contains "code = $1"); captures every write.
  function makeQuery(opts: { collidingBrand?: string } = {}) {
    const writes: Array<{ sql: string; params: any[] }> = [];
    const queryFn = async (sql: string, params?: any[]) => {
      if (/INSERT|UPDATE|DELETE/i.test(sql)) { writes.push({ sql, params: params ?? [] }); return { rows: [] }; }
      if (/code = \$1/.test(sql)) {
        return { rows: opts.collidingBrand ? [{ raw_value: opts.collidingBrand }] : [] };
      }
      const [type, rawValue] = params ?? [];
      if (type === "dept" && String(rawValue).toLowerCase() === "beauty & personal care") {
        return { rows: [{ code: "BPC", status: "approved" }] };
      }
      return { rows: [] };
    };
    return { queryFn, writes };
  }

  it("no brand, no override → legend_pending with pending.brand.status 'missing' (reclassified, not error)", async () => {
    const { queryFn } = makeQuery();
    const r = await resolveAndGenerateSku("B00MW6OAK6", 1, { queryFn, httpGet: fakeHttpGet(NO_BRAND_PAYLOAD) });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("legend_pending");
    expect(r.pending?.brand?.status).toBe("missing");
    expect(r.pending?.brand?.proposedCode).toBe(""); // nothing to derive — empty, no prefill
  });

  it("override must be exactly 3 chars A-Z/0-9 — bad shapes stay legend_pending with the reason in details", async () => {
    for (const bad of ["AB", "ABCD", "a?c", ""]) {
      const { queryFn } = makeQuery();
      const r = await resolveAndGenerateSku("B00MW6OAK6", 1, { queryFn, httpGet: fakeHttpGet(NO_BRAND_PAYLOAD), brandCodeOverride: bad });
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.reason).toBe("legend_pending");
      expect(r.pending?.brand?.status).toBe("missing");
    }
  });

  it("override colliding with an existing legend code → legend_pending naming the owning brand", async () => {
    const { queryFn } = makeQuery({ collidingBrand: "AminoGenesis" });
    const r = await resolveAndGenerateSku("B00MW6OAK6", 1, { queryFn, httpGet: fakeHttpGet(NO_BRAND_PAYLOAD), brandCodeOverride: "AMG" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("legend_pending");
    expect(r.details).toContain("AminoGenesis");
    expect(r.pending?.brand?.status).toBe("missing");
  });

  it("valid one-off override builds the SKU with the entered BRD and writes NO legend row", async () => {
    const { queryFn, writes } = makeQuery();
    const r = await resolveAndGenerateSku("B00MW6OAK6", 7, { queryFn, httpGet: fakeHttpGet(NO_BRAND_PAYLOAD), brandCodeOverride: "cq1" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sku.startsWith("CQ1-BPC-")).toBe(true); // normalized uppercase; digits allowed
    expect(r.trail.brd).toBe("CQ1");
    expect(r.trail.brand).toBe(""); // never the code — there is no brand name
    expect(writes).toEqual([]); // one-off: NO legend (or any other) write from the resolver
  });

  it("missing brand never self-heals asins (no catalog brand to write)", async () => {
    const { queryFn } = makeQuery();
    const selfHealWrite = vi.fn();
    await resolveAndGenerateSku("B00MW6OAK6", 1, { queryFn, httpGet: fakeHttpGet(NO_BRAND_PAYLOAD), selfHealWrite, brandCodeOverride: "CQ1" });
    expect(selfHealWrite).not.toHaveBeenCalled();
  });
});
