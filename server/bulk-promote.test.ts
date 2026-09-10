import { describe, it, expect, vi, beforeEach } from "vitest";

// §21 Promote to database (2026-09-09): the ONE user-initiated bulk→main
// write. These tests pin the doc's field table, the skip-existing rule,
// per-ASIN transaction independence, the tag-failure-is-error rule, and
// (below) that promote stays the ONLY bulk module touching asins.
vi.mock("./index", () => ({ log: () => {} }));

const clientQueries: Array<{ text: string; values?: any[] }> = [];
let existsResult: { rows: any[] } = { rows: [] };
const mockClient = {
  query: vi.fn(async (text: string, values?: any[]) => {
    clientQueries.push({ text, values });
    if (/SELECT 1 FROM asins/.test(text)) return existsResult;
    return { rows: [], rowCount: 1 };
  }),
  release: vi.fn(),
};
const poolQueries: Array<{ text: string; values?: any[] }> = [];
let bulkRowsResult: any[] = [];
let cacheRowsResult: any[] = [];
vi.mock("./db", () => ({
  query: vi.fn(async (text: string, values?: any[]) => {
    poolQueries.push({ text, values });
    if (/FROM bulk_list_asins/.test(text)) return { rows: bulkRowsResult };
    if (/FROM bulk_gating_hazmat_cache/.test(text)) return { rows: cacheRowsResult };
    if (/FROM tags WHERE LOWER/.test(text)) {
      const name = String(values?.[0] ?? "");
      // "Spark Lead" exists (case-insensitive); anything else is missing.
      return name.toLowerCase() === "spark lead" ? { rows: [{ id: "tag-spark" }] } : { rows: [] };
    }
    if (/INSERT INTO tags/.test(text)) return { rows: [{ id: "tag-new" }] };
    if (/SELECT id FROM asins/.test(text)) return { rows: [{ id: "asin-id-1" }] };
    return { rows: [], rowCount: 1 };
  }),
  isDbAvailable: () => true,
  default: { connect: async () => mockClient },
}));

import { buildPromoteRows, promoteBulkAsins } from "./bulk-promote";
import { upsertTagsForAsin } from "./tags-repo";

const BULK_ROW = {
  asin: "B0PROMO001", title: "T", brand: "Br", image_url: "img", category: "Cat",
  weight_lb: "1.5", length_in: "2", width_in: "3", height_in: "4",
  is_meltable: true, is_hazmat: null, is_dangerous_good: false,
  buy_link: "https://s.example/x", supplier: "s.example", supplier_sku: "SKU-1",
  notes: "Lead date 09/02/2026 | stuff", promo_notes: "WELCOME",
  added_at: new Date("2026-08-02T04:00:00Z"),
  sale_price: "23.62", sale_price_buy_box: "24.51", sale_price_lowest: "22.99",
  fba_fee: "3.10", referral_fee: "3.54", variable_closing_fee: null, fees_estimate_price: "23.62",
  bsr: 1234, sellers_fba: 3, sellers_fbm: 1,
  eligibility_status: null, estimated_cogs: "11.17", estimated_cogs_source: "csv",
  fetched_at: new Date("2026-09-09T15:00:00Z"),
  last_reviewed_at: new Date("2026-09-08T12:00:00Z"),
  tags: ["Spark Lead"],
};
const CACHE_ROW = {
  asin: "B0PROMO001", eligibility_status: "yes", is_hazmat: false,
  gating_checked_at: new Date("2026-09-09T16:00:00Z"),
  hazmat_checked_at: new Date("2026-09-09T16:30:00Z"),
};

beforeEach(() => { clientQueries.length = 0; poolQueries.length = 0; existsResult = { rows: [] }; bulkRowsResult = [BULK_ROW]; cacheRowsResult = [CACHE_ROW]; mockClient.query.mockClear(); });

describe("buildPromoteRows — the doc's field table, verbatim", () => {
  it("every field lands with original timestamps, lead date, active status", () => {
    const { asins, estimates } = buildPromoteRows(BULK_ROW, CACHE_ROW);
    expect(asins).toMatchObject({
      asin: "B0PROMO001", title: "T", brand: "Br", buy_link: "https://s.example/x",
      supplier: "s.example", supplier_sku: "SKU-1", notes: BULK_ROW.notes,
      promo_notes: "WELCOME", status: "active",
      added_at: BULK_ROW.added_at,                       // lead date, not NOW()
      is_hazmat: false,                                  // cache wins
      gating_checked_at: CACHE_ROW.gating_checked_at,    // stamps carried
      hazmat_checked_at: CACHE_ROW.hazmat_checked_at,
      last_reviewed_at: BULK_ROW.last_reviewed_at,       // review stamp carries (2026-09-10)
    });
    expect(asins).not.toHaveProperty("is_wholesale");    // §16: user-set only
    expect(estimates).toMatchObject({
      lowest_fba_price: "23.62", buy_box_price: "24.51", lowest_price: "22.99",
      estimated_cogs: "11.17", estimated_cogs_source: "csv",
      eligibility_status: "yes",
      fetched_at: BULK_ROW.fetched_at,                   // bulk snapshot age, never NOW()
    });
  });
});

describe("promoteBulkAsins", () => {
  it("new ASIN → added; INSERTs run in a transaction with explicit timestamps", async () => {
    const results = await promoteBulkAsins("list-1", ["B0PROMO001"]);
    expect(results).toEqual([{ asin: "B0PROMO001", outcome: "added" }]);
    const seq = clientQueries.map((q) => q.text.split(" ")[0] + (q.text.includes("asin_estimates") ? ":est" : q.text.includes("INSERT INTO asins") ? ":asins" : ""));
    expect(seq[0]).toBe("BEGIN");
    expect(seq[seq.length - 1]).toBe("COMMIT");
    const estIns = clientQueries.find((q) => q.text.includes("INSERT INTO asin_estimates"))!;
    expect(estIns.text).toContain("fetched_at");         // explicit — default never fires
    expect(estIns.values).toContain(BULK_ROW.fetched_at);
  });

  it("existing ASIN (any status) → already_in_database, nothing written", async () => {
    existsResult = { rows: [{ "?column?": 1 }] };
    const results = await promoteBulkAsins("list-1", ["B0PROMO001"]);
    expect(results).toEqual([{ asin: "B0PROMO001", outcome: "already_in_database" }]);
    expect(clientQueries.some((q) => q.text.startsWith("INSERT"))).toBe(false);
    expect(clientQueries.some((q) => q.text === "ROLLBACK")).toBe(true);
  });

  it("tag failure after commit → outcome error with message, not silent success", async () => {
    bulkRowsResult = [{ ...BULK_ROW, tags: ["Spark Lead"] }];
    const db = await import("./db");
    (db.query as any).mockImplementationOnce(async (text: string, values?: any[]) => {
      poolQueries.push({ text, values });
      return { rows: bulkRowsResult };
    }).mockImplementationOnce(async () => ({ rows: cacheRowsResult }))
      .mockImplementationOnce(async () => { throw new Error("tags table on fire"); });
    const results = await promoteBulkAsins("list-1", ["B0PROMO001"]);
    expect(results[0].outcome).toBe("error");
    expect(results[0].message).toMatch(/row inserted; tag creation failed/);
  });
});

describe("upsertTagsForAsin — create missing, reuse case-insensitively", () => {
  it("case-variant reuses; unknown name creates; existing tags never modified", async () => {
    poolQueries.length = 0;
    await upsertTagsForAsin("B0PROMO001", ["spark lead", "Brand New Tag"]);
    const texts = poolQueries.map((q) => q.text);
    expect(texts.filter((x) => x.includes("INSERT INTO tags"))).toHaveLength(1); // only the missing one
    expect(texts.some((x) => x.includes("UPDATE tags"))).toBe(false);            // never modifies existing
    expect(texts.filter((x) => x.includes("INSERT INTO asin_tags"))).toHaveLength(2);
  });
});
