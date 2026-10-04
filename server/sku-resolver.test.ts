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
      marketplaceId: "ATVPDKIKX0DER",
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

  it("no brand → BRD = NUL, and the legend is never consulted for the brand", async () => {
    // dept resolves; the brand leg must not reach the legend at all.
    const lq = vi.fn(fakeLegendQuery({ "dept:beauty & personal care": { code: "BPC", status: "approved" } }));
    const r = await resolveAndGenerateSku(
      "B00MW6OAK6",
      1,
      { queryFn: lq as any, httpGet: fakeHttpGet({ ...HAPPY_PAYLOAD, summaries: [{ itemName: "X" }] }) },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.trail.brd).toBe("NUL");
    expect(r.sku.startsWith("NUL-BPC-")).toBe(true);
    // Every legend call was for dept — none for brand.
    for (const call of lq.mock.calls) expect((call as any[])[1][0]).toBe("dept");
  });

  // RETIRED 2026-10-04: an empty classifications block was the no_category
  // hard fail. It is now DEP = NUL (§18). Brand "X" is unknown to this stub
  // legend, so the outcome is pending on BRAND only — never on dept.
  it("empty classifications → DEP NUL, pending on brand only (was no_category)", async () => {
    const r = await resolveAndGenerateSku(
      "B0X",
      1,
      {
        httpGet: fakeHttpGet({ summaries: [{ brand: "X" }], classifications: [] }),
        queryFn: async () => ({ rows: [] }),
      },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("legend_pending");
      expect(r.pending?.dept).toBeUndefined();
      expect(r.pending?.brand?.rawValue).toBe("X");
    }
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
describe("resolveAndGenerateSku — brandless ASIN → NUL (§18, 2026-09-24)", () => {
  // Replaces the 2026-08-29 manual-code flow. A brandless ASIN is decided
  // automatically: BRD = NUL, no approval step, no legend row keyed on "".
  // Origin: B08WX3XDLQ ("Winter Garden Paperback") — a book, so the catalog
  // omits `brand` entirely.
  const NO_BRAND_SUMMARY = { itemName: "Mystery Widget Deluxe" }; // no brand key at all

  function makeQuery() {
    const writes: Array<{ sql: string; params: any[] }> = [];
    const brandLookups: any[] = [];
    const queryFn = async (sql: string, params?: any[]) => {
      if (/INSERT|UPDATE|DELETE/i.test(sql)) { writes.push({ sql, params: params ?? [] }); return { rows: [] }; }
      const [type, rawValue] = params ?? [];
      if (type === "brand") brandLookups.push(rawValue);
      if (type === "dept" && String(rawValue).toLowerCase() === "beauty & personal care") {
        return { rows: [{ code: "BPC", status: "approved" }] };
      }
      return { rows: [] };
    };
    return { queryFn, writes, brandLookups };
  }

  function payloadWithBrand(brand: any) {
    // `undefined` means the key is absent entirely, matching a real book.
    const summary: any = brand === undefined ? { ...NO_BRAND_SUMMARY } : { ...NO_BRAND_SUMMARY, brand };
    return { ...HAPPY_PAYLOAD, summaries: [summary] };
  }

  // The four shapes the catalog can hand us for "no brand".
  const BLANK_SHAPES: Array<[string, any]> = [
    ["absent", undefined],
    ["null", null],
    ["empty string", ""],
    ["whitespace only", "   "],
  ];

  for (const [label, value] of BLANK_SHAPES) {
    it(`brand ${label} → BRD = NUL, ok, and NO pending.brand`, async () => {
      const { queryFn, brandLookups } = makeQuery();
      const r = await resolveAndGenerateSku("B08WX3XDLQ", 1, { queryFn, httpGet: fakeHttpGet(payloadWithBrand(value)) });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.trail.brd).toBe("NUL");
      expect(r.sku.startsWith("NUL-BPC-")).toBe(true);
      expect(r.trail.brand).toBe(""); // the NAME is empty — never "NUL"
      // Nothing was looked up in the legend under a blank value — that lookup
      // is exactly what resolved through the "" → HAU row.
      expect(brandLookups).toEqual([]);
    });
  }

  it("a brandless ASIN is never legend_pending on the brand — there is nothing to approve", async () => {
    // dept is ALSO unknown here, so the result IS pending — but only for dept.
    const queryFn = async (_sql: string, params?: any[]) => {
      const [type] = params ?? [];
      if (type === "brand") throw new Error("brand must never reach the legend for a brandless ASIN");
      return { rows: [] };
    };
    const r = await resolveAndGenerateSku("B08WX3XDLQ", 1, { queryFn, httpGet: fakeHttpGet(payloadWithBrand(undefined)) });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("legend_pending");
    expect(r.pending?.brand).toBeUndefined();   // DEP can still gate on its own
    expect(r.pending?.dept?.status).toBe("not_in_legend");
  });

  it("a real brand still resolves through the legend normally", async () => {
    const { queryFn, brandLookups } = makeQuery();
    const r = await resolveAndGenerateSku("B00MW6OAK6", 1, { queryFn, httpGet: fakeHttpGet(payloadWithBrand("AminoGenesis")) });
    expect(brandLookups).toEqual(["AminoGenesis"]);  // NOT short-circuited to NUL
    expect(r.ok).toBe(false);                        // not in this legend stub
    if (r.ok) return;
    expect(r.pending?.brand?.rawValue).toBe("AminoGenesis");
  });

  it("a brandless ASIN never self-heals asins.brand — NUL is a code, not a brand name", async () => {
    const { queryFn } = makeQuery();
    const selfHealWrite = vi.fn();
    await resolveAndGenerateSku("B08WX3XDLQ", 1, { queryFn, httpGet: fakeHttpGet(payloadWithBrand("  ")), selfHealWrite });
    expect(selfHealWrite).not.toHaveBeenCalled();
  });

  it("the resolver writes nothing — no legend row is created for a brandless ASIN", async () => {
    const { queryFn, writes } = makeQuery();
    const r = await resolveAndGenerateSku("B08WX3XDLQ", 7, { queryFn, httpGet: fakeHttpGet(payloadWithBrand("")) });
    expect(r.ok).toBe(true);
    expect(writes).toEqual([]);
  });
});

// ============================================================================
// B08WX3XDLQ — the ASIN that could not be added (§18, 2026-09-24)
// ============================================================================
// "Winter Garden Paperback", walmart.com, a book. Books carry contributors /
// manufacturer and the catalog omits `brand` ENTIRELY (verified live against
// getCatalogItem on 2026-09-24 — `"brand" in summaries[0] === false`).
//
// Before the fix this surfaced a legend approval row with an EMPTY raw value;
// Approve and Merge both failed with `"" already in legend with code "HAU"`,
// and the ASIN could not be added at all.
describe("B08WX3XDLQ — brandless book adds with a NUL- SKU", () => {
  // Recorded from the live catalog response (2026-09-24), trimmed to the
  // fields the resolver reads. Note: no `brand` key anywhere.
  const WINTER_GARDEN = {
    summaries: [{
      marketplaceId: "ATVPDKIKX0DER",
      itemName: "Winter Garden Paperback 20 Nov 2014",
      manufacturer: "Pan Macmillan",
      websiteDisplayGroupName: "Books",
    }],
    classifications: [{ marketplaceId: "ATVPDKIKX0DER", classifications: [{ displayName: "Books" }] }],
    attributes: {},
  };

  const legendWithBooks = fakeLegendQuery({ "dept:books": { code: "BOO", status: "approved" } });

  it("resolves to NUL-BOO-DLQ-WGP-001 — the exact SKU the live catalog produces", async () => {
    const r = await resolveAndGenerateSku("B08WX3XDLQ", 1, {
      queryFn: legendWithBooks,
      httpGet: fakeHttpGet(WINTER_GARDEN),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sku).toBe("NUL-BOO-DLQ-WGP-001");
    expect(r.trail.brd).toBe("NUL");
    expect(r.trail.dep).toBe("BOO");
    expect(r.trail.brand).toBe("");
  });

  it("is not legend_pending and not an error — no approval step at all", async () => {
    const r = await resolveAndGenerateSku("B08WX3XDLQ", 1, {
      queryFn: legendWithBooks,
      httpGet: fakeHttpGet(WINTER_GARDEN),
    });
    expect(r.ok).toBe(true);
    if (r.ok) return;
    expect(r.reason).not.toBe("legend_pending");
  });

  it("never asks the legend for a blank brand — the lookup that hit the \"\" → HAU row", async () => {
    const seen: any[] = [];
    const spy = async (sql: string, params?: any[]) => {
      seen.push(params?.[0]);
      return legendWithBooks(sql, params);
    };
    await resolveAndGenerateSku("B08WX3XDLQ", 1, { queryFn: spy, httpGet: fakeHttpGet(WINTER_GARDEN) });
    expect(seen).not.toContain("brand");
  });
});

// ============================================================================
// §18 categoryless ASIN → DEP = NUL (2026-10-04)
// ============================================================================
// Mirror of the brandless → BRD = NUL rule. NUL is ONE reserved code meaning
// "the catalog has no value here", used in either position.
describe("resolveAndGenerateSku — categoryless ASIN → DEP = NUL", () => {
  const payload = (over: any = {}) => ({
    summaries: [{ brand: "Infusion Pool Products", itemName: "Infusion V-fitting Venturi" }],
    classifications: [{ marketplaceId: "ATVPDKIKX0DER", classifications: [] }],
    attributes: {},
    ...over,
  });

  function makeQuery() {
    const writes: Array<{ sql: string }> = [];
    const deptLookups: any[] = [];
    const queryFn = async (sql: string, params?: any[]) => {
      if (/INSERT|UPDATE|DELETE/i.test(sql)) { writes.push({ sql }); return { rows: [] }; }
      const [type, rawValue] = params ?? [];
      if (type === "dept") deptLookups.push(rawValue);
      if (type === "brand" && String(rawValue) === "Infusion Pool Products") {
        return { rows: [{ code: "INF", status: "approved" }] };
      }
      return { rows: [] };
    };
    return { queryFn, writes, deptLookups };
  }

  it("resolves DEP to NUL and never asks the legend for a blank category", async () => {
    const { queryFn, deptLookups } = makeQuery();
    const r = await resolveAndGenerateSku("B008DG32FI", 1, { queryFn, httpGet: fakeHttpGet(payload()) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.trail.dep).toBe("NUL");
    expect(r.trail.brd).toBe("INF");
    expect(r.sku.startsWith("INF-NUL-")).toBe(true);
    expect(r.trail.category).toBeNull();     // the NAME stays null, never "NUL"
    expect(deptLookups).toEqual([]);         // the lookup that would key on ""
  });

  it("is never legend_pending on department — there is nothing to approve", async () => {
    // Brand ALSO unknown here, so the result IS pending — but only on brand.
    const queryFn = async (_sql: string, params?: any[]) => {
      const [type] = params ?? [];
      if (type === "dept") throw new Error("dept must never reach the legend for a categoryless ASIN");
      return { rows: [] };
    };
    const r = await resolveAndGenerateSku("B008DG32FI", 1, { queryFn, httpGet: fakeHttpGet(payload()) });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("legend_pending");
    expect(r.pending?.dept).toBeUndefined();
    expect(r.pending?.brand?.rawValue).toBe("Infusion Pool Products");
  });

  it("brandless AND categoryless → NUL-NUL-…", async () => {
    const { queryFn } = makeQuery();
    const r = await resolveAndGenerateSku("B000BOTH01", 1, {
      queryFn,
      httpGet: fakeHttpGet(payload({ summaries: [{ itemName: "Mystery Thing" }] })),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.trail.brd).toBe("NUL");
    expect(r.trail.dep).toBe("NUL");
    expect(r.sku.startsWith("NUL-NUL-")).toBe(true);
  });

  it("self-heal never runs for a categoryless ASIN — NUL is not a category name", async () => {
    const { queryFn } = makeQuery();
    const selfHealWrite = vi.fn();
    await resolveAndGenerateSku("B008DG32FI", 1, { queryFn, httpGet: fakeHttpGet(payload()), selfHealWrite });
    expect(selfHealWrite).not.toHaveBeenCalled();
  });

  it("the resolver writes nothing — no sku_legend row keyed on an empty category", async () => {
    const { queryFn, writes } = makeQuery();
    await resolveAndGenerateSku("B008DG32FI", 7, { queryFn, httpGet: fakeHttpGet(payload()) });
    expect(writes).toEqual([]);
  });

  it("a real category still resolves through the legend normally", async () => {
    const { queryFn, deptLookups } = makeQuery();
    await resolveAndGenerateSku("B000REAL01", 1, { queryFn, httpGet: fakeHttpGet(payload({
      classifications: [{ marketplaceId: "ATVPDKIKX0DER", classifications: [{ displayName: "Patio, Lawn & Garden" }] }],
    })) });
    expect(deptLookups).toEqual(["Patio, Lawn & Garden"]); // NOT short-circuited
  });

  it("a 404 is still a hard fail, not NUL-NUL", async () => {
    const { queryFn } = makeQuery();
    const r = await resolveAndGenerateSku("B000DEAD01", 1, {
      queryFn,
      httpGet: async () => { const e: any = new Error("gone"); e.response = { status: 404 }; throw e; },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("dead_asin");
  });
});

// ============================================================================
// B008DG32FI — the ASIN that triggered the rule (§18, 2026-10-04)
// ============================================================================
// "Infusion V-fitting for Inlet and Return Line, Venturi, White". Verified
// live: HTTP 200 whose classifications entry for ATVPDKIKX0DER is an EMPTY
// array, stable across four consecutive fetches, salesRanks empty,
// relationships [] (no variation parent to inherit from). Genuinely absent at
// Amazon — not a fetch or parse fault.
//
// Before the rule it failed offer-add preview with "classifications block
// empty for B008DG32FI".
describe("B008DG32FI — categoryless fitting resolves with a NUL department", () => {
  // Trimmed to the fields the resolver reads, from the live response.
  const INFUSION = {
    summaries: [{
      marketplaceId: "ATVPDKIKX0DER",
      brand: "Infusion Pool Products",
      manufacturer: "Infusion Pool Products",
      itemName: "Infusion V-fitting for Inlet and Return Line, Venturi, White",
      websiteDisplayGroupName: "Home Improvement", // deliberately NOT used for DEP
      itemClassification: "BASE_PRODUCT",
    }],
    classifications: [{ marketplaceId: "ATVPDKIKX0DER", classifications: [] }],
    salesRanks: [{ marketplaceId: "ATVPDKIKX0DER" }], // no ranks at all
    attributes: {},
  };

  // INF was approved for "Infusion Pool Products" on 2026-10-04, so the
  // brand resolves and the ASIN is fully ready.
  const legendWithInf = fakeLegendQuery({ "brand:infusion pool products": { code: "INF", status: "approved" } });

  it("resolves to INF-NUL-2FI-FIR-001 — the exact SKU the live catalog produces", async () => {
    const r = await resolveAndGenerateSku("B008DG32FI", 1, { queryFn: legendWithInf, httpGet: fakeHttpGet(INFUSION) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sku).toBe("INF-NUL-2FI-FIR-001");
    expect(r.trail.dep).toBe("NUL");
    expect(r.trail.category).toBeNull();
  });

  it("never falls back to websiteDisplayGroupName or salesRanks for DEP", async () => {
    const r = await resolveAndGenerateSku("B008DG32FI", 1, { queryFn: legendWithInf, httpGet: fakeHttpGet(INFUSION) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // "Home Improvement" is right there in the payload and must be ignored.
    expect(r.trail.dep).not.toMatch(/HOM|HOME/);
    expect(r.trail.dep).toBe("NUL");
  });

  it("with the brand NOT yet approved: pending.brand present, pending.dept ABSENT", async () => {
    // The state this ASIN was in before INF was approved — the acceptance
    // shape originally specified. Dept is never pending either way.
    const r = await resolveAndGenerateSku("B008DG32FI", 1, {
      queryFn: fakeLegendQuery({}), httpGet: fakeHttpGet(INFUSION),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("legend_pending");
    expect(r.pending?.brand?.rawValue).toBe("Infusion Pool Products");
    expect(r.pending?.dept).toBeUndefined();
  });
});
