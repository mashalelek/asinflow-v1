// The Analyze / onboarding row writes for ONE ASIN (SPEC §14 "Analyze MAY write",
// §11 onboarding): the asins upsert, the asin_estimates upsert (INSERT … DO
// NOTHING on the insert-only onboarding path, DO UPDATE on Analyze), the
// history snapshot, the CSV COGS write and the notes append. Extracted from
// server/routes.ts on 2026-11-09 so the exact statements run against the real
// schema in server/asin-upsert.db.test.ts (rolled back): the fee-promotion
// commit (e16daa0) typed parameter $16 twice in the estimates INSERT and
// Postgres refused it at parse time, which no mocked-query test could see.
// Every function takes the query to run on (a pool query or a transaction
// client), so the onboarding sink can write one ASIN's rows in one transaction.
import { type AsinResult, extractDomain, type LeadSource } from "@shared/schema";
import { applyCatalogDeletedSignal } from "./catalog-deleted-write";
import { log } from "./log";

export type QueryLike = (sql: string, params?: any[]) => Promise<{ rows: any[]; rowCount: number | null }>;

/**
 * Dedicated write path for CSV-uploaded COGS values. Runs BEFORE the
 * analyze UPSERT so estimated_cogs is populated regardless of whether
 * the ASIN is new or existing. This is separate from the analyze UPSERT
 * which only touches Amazon-side pricing/fees and never user-controlled
 * cost fields.
 */
export async function upsertCsvCogs(q: QueryLike, asin: string, cogs: number): Promise<void> {
  // Try UPDATE first (existing ASIN)
  const updated = await q(
    `UPDATE asin_estimates SET estimated_cogs = $2, estimated_cogs_source = 'csv'
     WHERE asin = $1`,
    [asin, cogs],
  );
  if ((updated.rowCount ?? 0) === 0) {
    // New ASIN — INSERT will be handled by upsertAsinResult below,
    // which includes estimated_cogs in its INSERT branch
  }
}

export async function upsertAsinResult(
  q: QueryLike,
  result: AsinResult,
  notesForNewInsert: string | null = null,
  promoNotesForNewInsert: string | null = null,
  // §6 lead source, INSERT branch only (§14). Absent = NULL, which is what
  // §18 phase c wants: an SC-discovered ASIN has no lead source AF can claim.
  leadSourceForNewInsert: LeadSource | null = null,
  // Scheduler v1 onboarding (2026-10-15): rows only. Existing rows keep
  // their last_refreshed_at; asin_estimates is INSERT ... DO NOTHING; no
  // history row, no catalog-deleted signal. The queued job does the rest.
  // Since 2026-11-09 the insert-only row's fetched_at is NULL (not NOW()):
  // nothing was fetched, so Price Age shows "—" and the Sale Price cell
  // never reads "No offers" on a row no component has priced yet; every
  // reader of fetched_at handles NULL (the list, Price Age, the last-
  // refreshed MAX, the extension's history).
  insertOnly = false,
): Promise<{ inserted: boolean }> {
  const supplier = extractDomain(result.buyLink);

  // Asymmetric UPSERT for notes + promo_notes (same pattern as estimated_cogs
  // below):
  //   INSERT branch    — writes both from the CSV/sourcing input.
  //   ON CONFLICT UPDATE — neither in the SET list (§14 ownership preserved).
  // Existing-ASIN notes get appended (with dedup) by writeResult based on the
  // `inserted` boolean returned from RETURNING (xmax = 0). promo_notes has NO
  // append path — existing ASINs keep their prior value untouched.
  const asinUpsert = await q(
    `INSERT INTO asins (asin, title, image_url, brand, category, weight_lb, buy_link, supplier, is_meltable, is_hazmat, is_dangerous_good, notes, promo_notes, supplier_sku, lead_source, last_refreshed_at)
     -- §18 (2026-09-24): NULLIF(TRIM(...)) so a blank catalog brand is stored
     -- as NULL, never "". An empty-string brand is what let the legend build a
     -- row keyed on "" and swallow every brandless ASIN into one code.
     -- $15 lead_source: INSERT-BRANCH ONLY. It is absent from the ON CONFLICT
     -- SET list below, so a re-analyze of an existing ASIN never touches it
     -- (§14 user-controlled — only the INSERT paths and the inline edit write
     -- it, and a sync must not overwrite a human's answer).
     VALUES ($1, $2, $3, NULLIF(TRIM($4::text), ''), $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW())
     ON CONFLICT (asin) DO UPDATE SET
       title = COALESCE(EXCLUDED.title, asins.title),
       image_url = COALESCE(EXCLUDED.image_url, asins.image_url),
       brand = COALESCE(EXCLUDED.brand, asins.brand),
       category = COALESCE(EXCLUDED.category, asins.category),
       weight_lb = COALESCE(EXCLUDED.weight_lb, asins.weight_lb),
       buy_link = COALESCE(EXCLUDED.buy_link, asins.buy_link),
       supplier = COALESCE(EXCLUDED.supplier, asins.supplier),
       is_meltable = EXCLUDED.is_meltable OR asins.is_meltable,
       -- Latest INBOUND hazmat result wins. NULL = inconclusive (throttle/error)
       -- → keep prior value, don't wipe. Same fail-closed contract for DG.
       is_hazmat = COALESCE(EXCLUDED.is_hazmat, asins.is_hazmat),
       is_dangerous_good = COALESCE(EXCLUDED.is_dangerous_good, asins.is_dangerous_good),
       last_refreshed_at = CASE WHEN $16::boolean THEN asins.last_refreshed_at ELSE NOW() END
     RETURNING (xmax = 0) AS inserted`,
    [
      result.asin,
      result.catalogData.title,
      result.catalogData.imageUrl,
      result.catalogData.brand,
      result.catalogData.bsrCategory,
      result.catalogData.weightLbs,
      result.buyLink,
      supplier,
      (result.catalogData as any).isMeltable ?? false,
      // tri-state: true | false | null(inconclusive → COALESCE keeps prior)
      (result.catalogData as any).isHazmat ?? null,
      (result.catalogData as any).isDangerousGood ?? null,
      notesForNewInsert, // $12 — used in INSERT; ignored by UPDATE
      promoNotesForNewInsert, // $13 — used in INSERT; ignored by UPDATE
      result.supplierSku ?? null, // $14 — user-controlled (§14): INSERT branch only, never in the ON CONFLICT SET list
      leadSourceForNewInsert, // $15 — §6, same INSERT-branch-only contract
      insertOnly,             // $16 — keep last_refreshed_at on an existing row
    ]
  );
  const inserted = asinUpsert.rows[0]?.inserted === true;

  // DA-2: catalog-deleted signal + auto-archive on FALSE→TRUE transition.
  // Single source of truth lives in server/catalog-deleted-write.ts so the
  // bulk backfill script can't drift from the live analyze write.
  // Tri-state input: null = inconclusive (no write), true/false = definitive.
  if (!insertOnly) {
    await applyCatalogDeletedSignal(
      result.asin,
      (result.catalogData as any).isCatalogDeleted ?? null,
      q,
    ).catch((err: any) =>
      log(`catalog-deleted write error for ${result.asin}: ${err.message}`, "db"),
    );
  }

  // Asymmetric UPSERT: INSERT populates estimated_cogs from the CSV upload
  // input (result.cogs). ON CONFLICT UPDATE only refreshes Amazon-side pricing/
  // fees — never touches estimated_cogs, actual_cogs, or other user-controlled
  // cost fields. This is an architectural smell: CSV upload piggybacks on the
  // analyze UPSERT to persist COGS. TODO: separate CSV write path from analyze.
  // Fee triple + fee_source write gate (migration 026): 'spapi' always wins;
  // 'fallback' only fills missing fees or refreshes a prior 'fallback' — it
  // never overwrites a real fee ('spapi' or legacy-NULL rows, which predate
  // the marker and are presumed real after the fingerprint backfill). The
  // three fee fields + source move as ONE coherent block, keyed on the
  // incoming fba_fee (all-null error shapes write nothing, as before).
  await q(
    `INSERT INTO asin_estimates (
       asin, estimated_cogs, estimated_cogs_source,
       lowest_fba_price, buy_box_price, buy_box_fulfillment, lowest_price,
       sellers_fba, sellers_fbm, fba_fee, referral_fee, fees_estimate_price, fee_source,
       bsr, bsr_category, eligibility_status, error, fetched_at, fba_fee_promotion, fee_fetched_at
     ) VALUES ($1,$2,'csv',$3,$4,$5,$6,$7,$8,$9,$10,$11,$16::text,$12,$13,$14,$15,${insertOnly ? "NULL" : "NOW()"},$17,CASE WHEN $16::text = 'spapi' AND $9::numeric IS NOT NULL THEN NOW() END)
     ${insertOnly ? "ON CONFLICT (asin) DO NOTHING" : `ON CONFLICT (asin) DO UPDATE SET
       lowest_fba_price = COALESCE(EXCLUDED.lowest_fba_price, asin_estimates.lowest_fba_price),
       buy_box_price = COALESCE(EXCLUDED.buy_box_price, asin_estimates.buy_box_price),
       buy_box_fulfillment = COALESCE(EXCLUDED.buy_box_fulfillment, asin_estimates.buy_box_fulfillment),
       lowest_price = COALESCE(EXCLUDED.lowest_price, asin_estimates.lowest_price),
       sellers_fba = COALESCE(EXCLUDED.sellers_fba, asin_estimates.sellers_fba),
       sellers_fbm = COALESCE(EXCLUDED.sellers_fbm, asin_estimates.sellers_fbm),
       fba_fee = CASE WHEN EXCLUDED.fba_fee IS NOT NULL AND (EXCLUDED.fee_source = 'spapi' OR asin_estimates.fee_source = 'fallback' OR asin_estimates.fba_fee IS NULL)
                      THEN EXCLUDED.fba_fee ELSE asin_estimates.fba_fee END,
       referral_fee = CASE WHEN EXCLUDED.fba_fee IS NOT NULL AND (EXCLUDED.fee_source = 'spapi' OR asin_estimates.fee_source = 'fallback' OR asin_estimates.fba_fee IS NULL)
                      THEN EXCLUDED.referral_fee ELSE asin_estimates.referral_fee END,
       fees_estimate_price = CASE WHEN EXCLUDED.fba_fee IS NOT NULL AND (EXCLUDED.fee_source = 'spapi' OR asin_estimates.fee_source = 'fallback' OR asin_estimates.fba_fee IS NULL)
                      THEN EXCLUDED.fees_estimate_price ELSE asin_estimates.fees_estimate_price END,
       fee_source = CASE WHEN EXCLUDED.fba_fee IS NOT NULL AND (EXCLUDED.fee_source = 'spapi' OR asin_estimates.fee_source = 'fallback' OR asin_estimates.fba_fee IS NULL)
                      THEN EXCLUDED.fee_source ELSE asin_estimates.fee_source END,
       -- The fee's promotion / date / last error follow a real SP-API fee only (2026-11-06, migration 095).
       fba_fee_promotion = CASE WHEN EXCLUDED.fba_fee IS NOT NULL AND EXCLUDED.fee_source = 'spapi' THEN EXCLUDED.fba_fee_promotion ELSE asin_estimates.fba_fee_promotion END,
       fee_fetched_at = CASE WHEN EXCLUDED.fba_fee IS NOT NULL AND EXCLUDED.fee_source = 'spapi' THEN NOW() ELSE asin_estimates.fee_fetched_at END,
       fee_error = CASE WHEN EXCLUDED.fba_fee IS NOT NULL AND EXCLUDED.fee_source = 'spapi' THEN NULL ELSE asin_estimates.fee_error END,
       fee_error_at = CASE WHEN EXCLUDED.fba_fee IS NOT NULL AND EXCLUDED.fee_source = 'spapi' THEN NULL ELSE asin_estimates.fee_error_at END,
       bsr = COALESCE(EXCLUDED.bsr, asin_estimates.bsr),
       bsr_category = COALESCE(EXCLUDED.bsr_category, asin_estimates.bsr_category),
       eligibility_status = EXCLUDED.eligibility_status,
       error = EXCLUDED.error,
       fetched_at = NOW()`}`,
    [
      result.asin,
      result.cogs, // $2 — only used in INSERT (new ASIN), ignored by UPDATE
      result.pricingData.lowestFbaPrice, result.pricingData.buyBoxPrice,
      result.pricingData.buyBoxFulfillment, result.pricingData.lowestPrice,
      result.pricingData.sellersFba, result.pricingData.sellersFbm,
      result.feesData.fbaFulfillmentFee, result.feesData.referralFee, result.feesData.feesEstimatePrice,
      result.catalogData.bsrRank, result.catalogData.bsrCategory,
      result.eligibilityData?.status, result.error,
      result.feesData.feeSource ?? null, // $16 — fee provenance, gated with the fee block
      result.feesData.fbaFeePromotion ?? null, // $17 — the FBA fee promotion (migration 095)
    ]
  );

  // Record history snapshot for seller/price/BSR trends
  if (insertOnly) return { inserted };
  const salePrice = result.pricingData.lowestFbaPrice ?? result.pricingData.buyBoxPrice ?? result.pricingData.lowestPrice;
  const idRow = await q(`SELECT id FROM asins WHERE asin = $1`, [result.asin]);
  if (idRow.rows.length > 0) {
    await q(
      `INSERT INTO asin_estimates_history (asin_id, sellers_fba, sellers_fbm, sale_price, bsr) VALUES ($1, $2, $3, $4, $5)`,
      [idRow.rows[0].id, result.pricingData.sellersFba, result.pricingData.sellersFbm, salePrice, result.catalogData.bsrRank]
    ).catch(() => {});
  }

  return { inserted };
}

export async function appendNotesForAsin(q: QueryLike, asin: string, newNotes: string): Promise<void> {
  await q(
    `UPDATE asins SET notes = CASE
       WHEN notes IS NULL OR notes = '' THEN $2
       WHEN notes = $2 THEN notes
       ELSE notes || E'\n' || $2
     END WHERE asin = $1`,
    [asin, newNotes]
  );
}
