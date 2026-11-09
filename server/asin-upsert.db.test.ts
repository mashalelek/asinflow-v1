// The Analyze / onboarding row writes against the REAL local schema, rolled back
// (the pattern of payment-rewards.test.ts / po-defects.test.ts). Why this test
// exists (Maria 2026-11-09): commit e16daa0 typed parameter $16 twice in the
// asin_estimates INSERT and Postgres refused the statement at parse time
// (42P08) — every ASIN onboarded between 2026-11-06 and 2026-11-09 got an
// asins row and no estimates row, and no mocked-query test could notice,
// because a mock never parses SQL. Every statement here runs for real.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import type { AsinResult } from "@shared/schema";
import { upsertAsinResult, upsertCsvCogs, appendNotesForAsin } from "./asin-upsert";

const url = process.env.DATABASE_URL || "postgresql://localhost:5432/asinflow";
let client: pg.Client | null = null;
beforeAll(async () => {
  const c = new pg.Client({ connectionString: url });
  try { await c.connect(); await c.query("SELECT fee_fetched_at, fba_fee_promotion FROM asin_estimates LIMIT 0"); client = c; } catch { await c.end().catch(() => {}); }
});
afterAll(async () => { await client?.end(); });

const ASIN = "ZZUPSERT01";
const ASIN2 = "ZZUPSERT02";

/** The onboarding placeholder exactly as insertNewAsinRows builds it: no Amazon data, the user's fields only. */
const blank = (asin: string, over: Partial<AsinResult> = {}): AsinResult => ({
  asin, cogs: 0, estimatedCogs: null, actualCogs: null, buyLink: null, prepOverride: null, storageOverride: null,
  supplierSku: null, uploadPack: null,
  pricingData: { lowestFbaPrice: null, buyBoxPrice: null, buyBoxFulfillment: null, lowestPrice: null, avg30DayPrice: null, avg90DayPrice: null, numberOfSellers: null, sellersFba: null, sellersFbm: null },
  catalogData: { weightLbs: null, title: null, brand: null, imageUrl: null, bsrRank: null, bsrCategory: null, isDangerousGood: null, isCatalogDeleted: null } as AsinResult["catalogData"],
  feesData: { fbaFulfillmentFee: null, referralFee: null, feesEstimatePrice: null },
  eligibilityData: { status: "check" } as AsinResult["eligibilityData"],
  error: null,
  ...over,
});

/** A fully populated Analyze result: every column of both statements carries a value. */
const full = (asin: string): AsinResult => ({
  ...blank(asin),
  cogs: 12.5, buyLink: "https://www.walmart.com/ip/x/1?irgwc=1", supplierSku: "SKU-1",
  pricingData: { lowestFbaPrice: 10.1, buyBoxPrice: 10.2, buyBoxFulfillment: "FBA", lowestPrice: 9.9, avg30DayPrice: null, avg90DayPrice: null, numberOfSellers: 5, sellersFba: 2, sellersFbm: 3 },
  catalogData: { weightLbs: 1.25, title: "zz probe", brand: "ZZ", imageUrl: "https://img/x.jpg", bsrRank: 123, bsrCategory: "Toys & Games", isDangerousGood: false, isCatalogDeleted: false, isMeltable: true, isHazmat: false } as any,
  feesData: { fbaFulfillmentFee: 3.21, referralFee: 1.5, feesEstimatePrice: 10.1, feeSource: "spapi", fbaFeePromotion: 0.5 } as any,
  eligibilityData: { status: "yes" } as AsinResult["eligibilityData"],
});

describe("asin-upsert on the real schema (rolled back)", () => {
  it("insert-only (onboarding): blank placeholder → asins row AND asin_estimates row, user fields on both; a second insert-only call touches neither", async (ctx) => {
    if (!client) return ctx.skip();
    const q = (sql: string, params?: any[]) => client!.query(sql, params);
    await q("BEGIN");
    try {
      const r = await upsertAsinResult(q, blank(ASIN, { cogs: 6.94, buyLink: "https://www.chewy.com/x/dp/958982?utm=1" }), "VA: check BB", "CardDepot 8.5%", "ER", true);
      expect(r.inserted).toBe(true);
      const a = (await q(`SELECT title, buy_link, supplier, notes, promo_notes, lead_source, last_refreshed_at FROM asins WHERE asin = $1`, [ASIN])).rows[0];
      expect(a).toMatchObject({ title: null, buy_link: "https://www.chewy.com/x/dp/958982?utm=1", supplier: "chewy.com", notes: "VA: check BB", promo_notes: "CardDepot 8.5%", lead_source: "ER" });
      const e = (await q(`SELECT estimated_cogs, estimated_cogs_source, lowest_fba_price, fba_fee, fee_source, fee_fetched_at, fba_fee_promotion, eligibility_status, error FROM asin_estimates WHERE asin = $1`, [ASIN])).rows;
      expect(e).toHaveLength(1);
      expect(e[0]).toMatchObject({ estimated_cogs: "6.94", estimated_cogs_source: "csv", lowest_fba_price: null, fba_fee: null, fee_source: null, fee_fetched_at: null, fba_fee_promotion: null, eligibility_status: "check", error: null });
      // no history snapshot on the insert-only path
      expect((await q(`SELECT count(*)::int AS n FROM asin_estimates_history h JOIN asins a ON a.id = h.asin_id WHERE a.asin = $1`, [ASIN])).rows[0].n).toBe(0);
      // the same ASIN again (an upload naming an existing ASIN): nothing on the estimates row changes, last_refreshed_at stays
      const r2 = await upsertAsinResult(q, blank(ASIN, { cogs: 99 }), null, null, "MP", true);
      expect(r2.inserted).toBe(false);
      const e2 = (await q(`SELECT estimated_cogs, estimated_cogs_source FROM asin_estimates WHERE asin = $1`, [ASIN])).rows[0];
      expect(e2).toMatchObject({ estimated_cogs: "6.94", estimated_cogs_source: "csv" });
      const a2 = (await q(`SELECT lead_source, last_refreshed_at FROM asins WHERE asin = $1`, [ASIN])).rows[0];
      expect(a2.lead_source).toBe("ER");
      expect(new Date(a2.last_refreshed_at).getTime()).toBe(new Date(a.last_refreshed_at).getTime());
    } finally { await q("ROLLBACK"); }
    expect((await client.query(`SELECT count(*)::int AS n FROM asins WHERE asin IN ($1, $2)`, [ASIN, ASIN2])).rows[0].n).toBe(0);
  });

  it("insert-only with every field populated, then Analyze (not insert-only) with every field: prices, fees, promotion, fee_fetched_at and a history row land; estimated_cogs is never touched by Analyze", async (ctx) => {
    if (!client) return ctx.skip();
    const q = (sql: string, params?: any[]) => client!.query(sql, params);
    await q("BEGIN");
    try {
      // populated insert-only (the shape an Upload File row carries)
      const r = await upsertAsinResult(q, full(ASIN2), "note", "promo", "MP", true);
      expect(r.inserted).toBe(true);
      const e = (await q(`SELECT estimated_cogs, estimated_cogs_source, lowest_fba_price, buy_box_price, buy_box_fulfillment, lowest_price, sellers_fba, sellers_fbm, fba_fee, referral_fee, fees_estimate_price, fee_source, fba_fee_promotion, fee_fetched_at, bsr, bsr_category, eligibility_status FROM asin_estimates WHERE asin = $1`, [ASIN2])).rows[0];
      expect(e).toMatchObject({ estimated_cogs: "12.50", estimated_cogs_source: "csv", lowest_fba_price: "10.1", buy_box_price: "10.2", buy_box_fulfillment: "FBA", lowest_price: "9.9", sellers_fba: 2, sellers_fbm: 3, fba_fee: "3.21", referral_fee: "1.5", fees_estimate_price: "10.1", fee_source: "spapi", fba_fee_promotion: "0.50", bsr: 123, bsr_category: "Toys & Games", eligibility_status: "yes" });
      expect(e.fee_fetched_at).not.toBeNull();
      const a = (await q(`SELECT title, brand, image_url, weight_lb, supplier, is_meltable, is_hazmat, is_dangerous_good, supplier_sku FROM asins WHERE asin = $1`, [ASIN2])).rows[0];
      expect(a).toMatchObject({ title: "zz probe", brand: "ZZ", image_url: "https://img/x.jpg", weight_lb: "1.2500", supplier: "walmart.com", is_meltable: true, is_hazmat: false, is_dangerous_good: false, supplier_sku: "SKU-1" });

      // Analyze on the existing row: Amazon-side values move, the user's COGS does not, one history row
      const again = full(ASIN2);
      again.cogs = 1; again.pricingData.lowestFbaPrice = 11.11; again.feesData.fbaFulfillmentFee = 4.44; (again.feesData as any).fbaFeePromotion = null;
      const r2 = await upsertAsinResult(q, again, null, null, null, false);
      expect(r2.inserted).toBe(false);
      const e2 = (await q(`SELECT estimated_cogs, lowest_fba_price, fba_fee, fba_fee_promotion, fee_error FROM asin_estimates WHERE asin = $1`, [ASIN2])).rows[0];
      expect(e2).toMatchObject({ estimated_cogs: "12.50", lowest_fba_price: "11.11", fba_fee: "4.44", fba_fee_promotion: null, fee_error: null });
      expect((await q(`SELECT count(*)::int AS n FROM asin_estimates_history h JOIN asins a ON a.id = h.asin_id WHERE a.asin = $1`, [ASIN2])).rows[0].n).toBe(1);

      // Analyze with an all-null result on the existing row: nothing blanked (COALESCE), fee block untouched
      const r3 = await upsertAsinResult(q, blank(ASIN2), null, null, null, false);
      expect(r3.inserted).toBe(false);
      const e3 = (await q(`SELECT lowest_fba_price, fba_fee, fee_source FROM asin_estimates WHERE asin = $1`, [ASIN2])).rows[0];
      expect(e3).toMatchObject({ lowest_fba_price: "11.11", fba_fee: "4.44", fee_source: "spapi" });
    } finally { await q("ROLLBACK"); }
    expect((await client.query(`SELECT count(*)::int AS n FROM asins WHERE asin IN ($1, $2)`, [ASIN, ASIN2])).rows[0].n).toBe(0);
  });

  it("Analyze (not insert-only) on a brand-new ASIN with every field: the INSERT branch of both statements", async (ctx) => {
    if (!client) return ctx.skip();
    const q = (sql: string, params?: any[]) => client!.query(sql, params);
    await q("BEGIN");
    try {
      const r = await upsertAsinResult(q, full(ASIN), null, null, null, false);
      expect(r.inserted).toBe(true);
      const e = (await q(`SELECT estimated_cogs, fee_source, fee_fetched_at, fetched_at FROM asin_estimates WHERE asin = $1`, [ASIN])).rows[0];
      expect(e).toMatchObject({ estimated_cogs: "12.50", fee_source: "spapi" });
      expect(e.fee_fetched_at).not.toBeNull();
      expect(e.fetched_at).not.toBeNull();
      expect((await q(`SELECT count(*)::int AS n FROM asin_estimates_history h JOIN asins a ON a.id = h.asin_id WHERE a.asin = $1`, [ASIN])).rows[0].n).toBe(1);
    } finally { await q("ROLLBACK"); }
  });

  it("upsertCsvCogs updates an existing row's COGS as 'csv' and is a no-op before the row exists; appendNotesForAsin dedups", async (ctx) => {
    if (!client) return ctx.skip();
    const q = (sql: string, params?: any[]) => client!.query(sql, params);
    await q("BEGIN");
    try {
      await upsertCsvCogs(q, ASIN, 3.33); // no row yet: nothing to update, no error
      expect((await q(`SELECT count(*)::int AS n FROM asin_estimates WHERE asin = $1`, [ASIN])).rows[0].n).toBe(0);
      await upsertAsinResult(q, blank(ASIN), "first", null, null, true);
      await upsertCsvCogs(q, ASIN, 3.33);
      expect((await q(`SELECT estimated_cogs, estimated_cogs_source FROM asin_estimates WHERE asin = $1`, [ASIN])).rows[0]).toMatchObject({ estimated_cogs: "3.33", estimated_cogs_source: "csv" });
      await appendNotesForAsin(q, ASIN, "first");   // same text: not appended twice
      await appendNotesForAsin(q, ASIN, "second");
      expect((await q(`SELECT notes FROM asins WHERE asin = $1`, [ASIN])).rows[0].notes).toBe("first\nsecond");
    } finally { await q("ROLLBACK"); }
  });
});
