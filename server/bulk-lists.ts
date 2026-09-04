// Bulk Profit Calculator (SPEC §21) — list storage + the bulk analyze sink.
//
// Isolation guarantee (§21): this module writes to bulk_lists /
// bulk_list_asins ONLY. It never writes to asins, asin_estimates,
// sales_daily, asin_tags, or asin_skus. The single sanctioned read from the
// main catalog is the EXISTS check backing `in_database` (see the
// /api/asins/in-database endpoint in routes.ts — set-based, computed at
// render time, never stored).
//
// Deliberately ABSENT vs the main-catalog sink (every §21-suppressed site):
//   - asins UPSERT (title/brand/category/image_url self-heal + insert)
//   - applyCatalogDeletedSignal (is_catalog_deleted write + auto-archive) —
//     the dead-ASIN 404 signal stays in the streamed result object only
//   - asin_estimates UPSERT and upsertCsvCogs
//   - asin_estimates_history insert
//   - appendNotesForAsin / notes writes
//   - upsertTagsForAsin (persistTags is a no-op — no tag source on this page)
//   - runPostAnalyzeBackgroundSyncs (sheets/PO + suppression) — the refresh
//     endpoint never calls it
//   - getListingsItem live-status machinery — has_live_offer is neither
//     computed nor stored here

import { query } from "./db";
import { log } from "./index";
import { cleanBuyLink, extractDomain } from "@shared/schema";
import type { AsinInput, AsinResult } from "@shared/schema";
import type { AnalyzeSink } from "./analyze-sink";

const ASIN_RE = /^[A-Z0-9]{10}$/;

// §21 Date Added backdate (2026-09-04): M/D/YYYY parses as LOCAL midnight
// (the server runs in America/New_York — never UTC midnight, so 09/02/2026
// renders 09/02/2026); ISO strings (what Export CSV emits for Date Added)
// parse natively, so export → re-upload round-trips. Unparseable/absent →
// null, caller falls back to NOW() — a bad date never fails the row.
export function parseAddedAt(raw: string | null | undefined): Date | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  const mdy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (mdy) {
    const m = Number(mdy[1]), day = Number(mdy[2]), y = Number(mdy[3]);
    const d = new Date(y, m - 1, day);
    // JS Date rolls invalid components over (13/45 → Feb of next year) —
    // reject unless the constructed date round-trips exactly.
    if (d.getFullYear() !== y || d.getMonth() !== m - 1 || d.getDate() !== day) return null;
    return d;
  }
  const iso = new Date(s);
  return isNaN(iso.getTime()) ? null : iso;
}

// ── List CRUD ────────────────────────────────────────────────────────────────

export async function createBulkList(
  name: string,
  sourceFilename: string | null,
  inputs: AsinInput[],
): Promise<{ id: string; name: string; asinCount: number; skippedInvalid: number }> {
  const seen = new Set<string>();
  const rows: Array<{
    asin: string; cogs: number | null; supplierSku: string | null;
    buyLink: string | null; supplier: string | null;
    tags: string[] | null; promoNotes: string | null; addedAt: Date | null;
  }> = [];
  let skippedInvalid = 0;
  for (const input of inputs) {
    const asin = String(input.asin ?? "").trim().toUpperCase();
    if (!ASIN_RE.test(asin)) { skippedInvalid++; continue; }
    if (seen.has(asin)) continue; // first occurrence wins, same as UNIQUE would enforce
    seen.add(asin);
    // §21 user-controlled fields (2026-09-04): supplier is DERIVED from the
    // buy link via the same cleanBuyLink + extractDomain as the main path.
    const buyLink = input.buyLink ? cleanBuyLink(String(input.buyLink)) : null;
    rows.push({
      asin,
      cogs: input.cogs > 0 ? input.cogs : null,
      supplierSku: input.supplierSku ? String(input.supplierSku).trim().slice(0, 100) || null : null,
      buyLink,
      supplier: buyLink ? extractDomain(buyLink) : null,
      tags: input.tags && input.tags.length > 0 ? input.tags : null,
      promoNotes: input.promoNotes ? String(input.promoNotes).trim() || null : null,
      addedAt: parseAddedAt(input.addedAtRaw),
    });
  }
  if (rows.length === 0) {
    throw new Error("No valid ASINs in the uploaded file.");
  }

  const listRes = await query(
    `INSERT INTO bulk_lists (name, source_filename, asin_count)
     VALUES ($1, $2, $3) RETURNING id, name, asin_count`,
    [name, sourceFilename, rows.length],
  );
  const listId = listRes.rows[0].id as string;

  // Rows carry the CSV COGS + supplier SKU immediately; everything else
  // fills in on analyze (which never touches either — both user-controlled).
  for (const row of rows) {
    await query(
      `INSERT INTO bulk_list_asins (list_id, asin, estimated_cogs, estimated_cogs_source, supplier_sku,
                                    buy_link, supplier, tags, promo_notes, added_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10, NOW()))`,
      [listId, row.asin, row.cogs, row.cogs != null ? "csv" : null, row.supplierSku,
       row.buyLink, row.supplier, row.tags, row.promoNotes, row.addedAt],
    );
  }

  return { id: listId, name: listRes.rows[0].name, asinCount: rows.length, skippedInvalid };
}

export async function listBulkLists(): Promise<any[]> {
  const res = await query(
    `SELECT l.id, l.name, l.source_filename, l.asin_count, l.created_at,
            MAX(a.fetched_at) AS last_fetched_at
     FROM bulk_lists l
     LEFT JOIN bulk_list_asins a ON a.list_id = l.id
     GROUP BY l.id
     ORDER BY l.created_at DESC`,
  );
  return res.rows;
}

export async function getBulkListWithRows(
  listId: string,
): Promise<{ list: any; rows: any[] } | null> {
  const listRes = await query(
    `SELECT id, name, source_filename, asin_count, created_at
     FROM bulk_lists WHERE id = $1`,
    [listId],
  );
  if (listRes.rows.length === 0) return null;
  const rowsRes = await query(
    `SELECT * FROM bulk_list_asins WHERE list_id = $1 ORDER BY added_at, asin`,
    [listId],
  );
  return { list: listRes.rows[0], rows: rowsRes.rows };
}

export async function renameBulkList(listId: string, name: string): Promise<boolean> {
  const res = await query(`UPDATE bulk_lists SET name = $2 WHERE id = $1`, [listId, name]);
  return (res.rowCount ?? 0) > 0;
}

export async function deleteBulkList(listId: string): Promise<boolean> {
  // bulk_list_asins rows cascade (FK ON DELETE CASCADE).
  const res = await query(`DELETE FROM bulk_lists WHERE id = $1`, [listId]);
  return (res.rowCount ?? 0) > 0;
}

// AsinInput list for re-running analyze on a saved list. cogs rides along for
// completeness only — the bulk sink never persists result.cogs, and the
// refresh must not touch estimated_cogs.
export async function loadBulkListAsinInputs(listId: string): Promise<AsinInput[]> {
  const res = await query(
    `SELECT asin, estimated_cogs FROM bulk_list_asins
     WHERE list_id = $1 ORDER BY added_at, asin`,
    [listId],
  );
  return res.rows.map((r: any) => ({
    asin: r.asin,
    cogs: r.estimated_cogs != null ? parseFloat(r.estimated_cogs) : 0,
    buyLink: null,
  }));
}

// ── The bulk analyze sink ────────────────────────────────────────────────────

// Price snapshot resolution mirrors getFeePriceForAsin's order (lowest FBA →
// buy box → lowest), minus the $15 fallback — no real price means a NULL
// snapshot, never a fabricated one.
function resolveSalePrice(result: AsinResult): { price: number | null; source: string | null } {
  const p = result.pricingData;
  if (p.lowestFbaPrice != null) return { price: p.lowestFbaPrice, source: "lowest_fba" };
  if (p.buyBoxPrice != null) return { price: p.buyBoxPrice, source: "buy_box" };
  if (p.lowestPrice != null) return { price: p.lowestPrice, source: "lowest" };
  return { price: null, source: null };
}

async function writeBulkRow(listId: string, result: AsinResult): Promise<void> {
  const { price, source } = resolveSalePrice(result);
  const c = result.catalogData;
  const f = result.feesData;
  // UPDATE-only: rows exist from list creation; analyze never adds membership.
  // COALESCE on catalog fields = same never-clobber-with-null contract as the
  // main path; tri-state is_hazmat/is_dangerous_good preserved when the probe
  // is inconclusive; is_meltable latches like the main path.
  // estimated_cogs / estimated_cogs_source are NEVER in this SET list (§21 —
  // analyze must not touch user-controlled cost fields, mirrored from §14).
  await query(
    `UPDATE bulk_list_asins SET
       title = COALESCE($3, title),
       image_url = COALESCE($4, image_url),
       brand = COALESCE($5, brand),
       category = COALESCE($6, category),
       weight_lb = COALESCE($7, weight_lb),
       length_in = COALESCE($8, length_in),
       width_in = COALESCE($9, width_in),
       height_in = COALESCE($10, height_in),
       sale_price = $11,
       price_source = $12,
       fba_fee = $13,
       referral_fee = $14,
       variable_closing_fee = $15,
       fees_estimate_price = $16,
       bsr = COALESCE($17, bsr),
       sellers_fba = $18,
       sellers_fbm = $19,
       eligibility_status = $20,
       is_meltable = ($21 OR is_meltable),
       is_hazmat = COALESCE($22, is_hazmat),
       is_dangerous_good = COALESCE($23, is_dangerous_good),
       error = $24,
       fetched_at = NOW()
     WHERE list_id = $1 AND asin = $2`,
    [
      listId,
      result.asin,
      c.title,
      c.imageUrl,
      c.brand,
      c.bsrCategory,
      c.weightLbs,
      c.lengthIn ?? null,
      c.widthIn ?? null,
      c.heightIn ?? null,
      price,
      source,
      f.fbaFulfillmentFee,
      f.referralFee,
      f.variableClosingFee ?? null,
      f.feesEstimatePrice,
      c.bsrRank,
      result.pricingData.sellersFba,
      result.pricingData.sellersFbm,
      result.eligibilityData?.status ?? null,
      c.isMeltable ?? false,
      c.isHazmat ?? null,
      c.isDangerousGood ?? null,
      result.error,
    ],
  );
}

export interface BulkListSink extends AnalyzeSink {
  /** Awaits every write issued so far; call after runAnalyzeCore returns. */
  flush(): Promise<{ written: number; errors: string[] }>;
}

export function makeBulkListSink(listId: string): BulkListSink {
  const pending: Promise<void>[] = [];
  const writtenAsins = new Set<string>();
  const errors: string[] = [];
  return {
    persistResult(result, _opts) {
      pending.push(
        writeBulkRow(listId, result)
          .then(() => { writtenAsins.add(result.asin); })
          .catch((err: any) => {
            errors.push(`${result.asin}: ${err.message}`);
            log(`Bulk row write error for ${result.asin} (list ${listId}): ${err.message}`, "bulk");
          }),
      );
    },
    persistTags(_asin, _tagNames) {
      // §21: tags have no data source on the bulk page. Intentional no-op.
    },
    async flush() {
      await Promise.all(pending);
      return { written: writtenAsins.size, errors };
    },
  };
}
