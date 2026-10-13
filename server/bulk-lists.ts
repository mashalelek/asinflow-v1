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
import { cleanBuyLink, extractDomain, normalizeLeadSource } from "@shared/schema";
import type { AsinInput } from "@shared/schema";
// Pure lead-date helpers live in bulk-lead-dates.ts (no Express-boot import
// chain) — re-exported here so existing callers keep their import path.
import { parseAddedAt, resolveAddedAt, extractPromoFromNotes } from "./bulk-lead-dates";
export { parseAddedAt, resolveAddedAt, extractPromoFromNotes };

const ASIN_RE = /^[A-Z0-9]{10}$/;

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
    tags: string[] | null; promoNotes: string | null; notes: string | null; addedAt: Date | null;
    leadSource: string | null;   // §6: per-row CSV value, else the dialog's list-wide pick
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
      // §21 bulk-local Notes (2026-09-08): stored verbatim — the SAME value
      // the lead-date fallback below reads.
      notes: input.notes ? String(input.notes).trim() || null : null,
      addedAt: (() => {
        const r = resolveAddedAt(input.addedAtRaw, input.notes);
        if (r.source === "fallback") {
          log(`bulk list "${name}": ${asin} added_at falls back to NOW() (raw=${JSON.stringify(r.raw)}, reason=${r.raw ? "unparseable" : "absent, no Notes lead date"})`, "bulk");
        }
        return r.date;
      })(),
      // §6: normalised here so an unrecognised CSV cell becomes NULL rather
      // than failing the CHECK at INSERT time. The caller has already applied
      // the dialog's list-wide pick as the default on AsinInput.
      leadSource: normalizeLeadSource(input.leadSource) ?? null,
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
                                    buy_link, supplier, tags, promo_notes, notes, added_at, lead_source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, COALESCE($11, NOW()), $12)`,
      [listId, row.asin, row.cogs, row.cogs != null ? "csv" : null, row.supplierSku,
       row.buyLink, row.supplier, row.tags, row.promoNotes, row.notes, row.addedAt,
       // §6: the per-row CSV value if the file had a lead_source column,
       // else the dialog's list-wide selection. Per-row OVERRIDES the
       // list-wide value — the file is more specific than the dropdown.
       row.leadSource ?? null],
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

// The old per-result sink (resolveSalePrice / writeBulkRow /
// makeBulkListSink) was REMOVED 2026-09-09: the bulk refresh runs the
// staged pipeline in bulk-refresh.ts — shared fetch passes with
// column-scoped bulk writers — instead of runAnalyzeCore.
