// §21 "Promote to database" (2026-09-09) — the ONE user-initiated write
// from Bulk Calc into the main tables, through this dedicated path (not
// the bulk sink, not the analyze UPSERT; shaped so the CSV upload path
// can adopt it later — the §14 "dedicated write path for user-controlled
// fields"). Per promoted ASIN: one transaction inserting the asins row +
// its asin_estimates row, carrying the bulk row's user-controlled fields
// and its snapshot with ORIGINAL timestamps (bulk fetched_at, cache
// *_checked_at — passed explicitly so no column default fires; Price Age
// and the 30-day rule stay honest). added_at = the bulk row's lead date.
// Tag creation runs AFTER the insert commits, inside the same per-ASIN
// unit of work: a tag failure makes that ASIN's outcome 'error', never a
// silent success without tags. Existing ASINs (ANY status) are skipped
// untouched — 'already_in_database'.
import pool, { query } from "./db";
import { upsertTagsForAsin } from "./tags-repo";
import { log } from "./index";

export interface PromoteResult {
  asin: string;
  outcome: "added" | "already_in_database" | "error";
  message?: string;
}

// Pure field mapping, exported for the promote tests: bulk row → the two
// INSERT column/value maps. Every doc-table field lands here. The gating/
// hazmat cache is gone (scheduler v1, decision 3): the row carries its own
// eligibility_status / is_hazmat, and the stamps start NULL — the onboarding
// job queued by the promote route probes both.
export function buildPromoteRows(bulk: any): {
  asins: Record<string, any>;
  estimates: Record<string, any>;
} {
  return {
    asins: {
      asin: bulk.asin,
      title: bulk.title ?? null,
      brand: bulk.brand ?? null,
      image_url: bulk.image_url ?? null,
      category: bulk.category ?? null,
      weight_lb: bulk.weight_lb ?? null,
      length_in: bulk.length_in ?? null,
      width_in: bulk.width_in ?? null,
      height_in: bulk.height_in ?? null,
      is_meltable: bulk.is_meltable ?? false,
      is_hazmat: bulk.is_hazmat ?? null,
      is_dangerous_good: bulk.is_dangerous_good ?? null,
      buy_link: bulk.buy_link ?? null,
      supplier: bulk.supplier ?? null,
      supplier_sku: bulk.supplier_sku ?? null,
      lead_source: bulk.lead_source ?? null,   // §6 — carried through promote

      notes: bulk.notes ?? null,
      promo_notes: bulk.promo_notes ?? null,
      added_at: bulk.added_at,               // lead date, NOT promotion date
      last_reviewed_at: bulk.last_reviewed_at ?? null, // review stamp carries (2026-09-10)
      status: "active",
      gating_checked_at: null,
      hazmat_checked_at: null,
    },
    estimates: {
      asin: bulk.asin,
      lowest_fba_price: bulk.sale_price ?? null,
      buy_box_price: bulk.sale_price_buy_box ?? null,
      lowest_price: bulk.sale_price_lowest ?? null,
      fba_fee: bulk.fba_fee ?? null,
      referral_fee: bulk.referral_fee ?? null,
      // No variable_closing_fee: asin_estimates has no such column (the
      // §14 "Analyze MAY write" list naming it is stale — flagged 2026-09-09).
      fees_estimate_price: bulk.fees_estimate_price ?? null,
      bsr: bulk.bsr ?? null,
      bsr_category: bulk.category ?? null,
      sellers_fba: bulk.sellers_fba ?? null,
      sellers_fbm: bulk.sellers_fbm ?? null,
      eligibility_status: bulk.eligibility_status ?? null,
      estimated_cogs: bulk.estimated_cogs ?? null,
      estimated_cogs_source: bulk.estimated_cogs_source ?? null,
      fetched_at: bulk.fetched_at ?? null,   // bulk snapshot age — never NOW()
    },
  };
}

function insertSql(table: string, cols: Record<string, any>): { text: string; values: any[] } {
  const names = Object.keys(cols);
  return {
    text: `INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map((_, i) => `$${i + 1}`).join(", ")})`,
    values: names.map((n) => cols[n]),
  };
}

export async function promoteBulkAsins(listId: string, asins: string[]): Promise<PromoteResult[]> {
  const want = asins.map((a) => String(a).trim().toUpperCase()).filter(Boolean);
  const bulkRows = (await query(
    `SELECT * FROM bulk_list_asins WHERE list_id = $1 AND asin = ANY($2::text[])`,
    [listId, want],
  )).rows;
  const bulkByAsin = new Map<string, any>(bulkRows.map((r: any) => [r.asin, r]));

  const results: PromoteResult[] = [];
  for (const asin of want) {
    const bulk = bulkByAsin.get(asin);
    if (!bulk) { results.push({ asin, outcome: "error", message: "not in this list" }); continue; }

    const client = await pool.connect();
    let inserted = false;
    try {
      await client.query("BEGIN");
      // Skip existing — ANY status, parked/dead included (decision).
      const exists = await client.query(`SELECT 1 FROM asins WHERE asin = $1`, [asin]);
      if (exists.rows.length > 0) {
        await client.query("ROLLBACK");
        results.push({ asin, outcome: "already_in_database" });
        continue;
      }
      const { asins: aCols, estimates: eCols } = buildPromoteRows(bulk);
      const aIns = insertSql("asins", aCols);
      await client.query(aIns.text, aIns.values);
      const eIns = insertSql("asin_estimates", eCols);
      await client.query(eIns.text, eIns.values);
      await client.query("COMMIT");
      inserted = true;
    } catch (err: any) {
      try { await client.query("ROLLBACK"); } catch {}
      results.push({ asin, outcome: "error", message: err?.message ?? "unknown" });
      client.release();
      continue;
    }
    client.release();

    // Tags AFTER the commit (upsertTagsForAsin no-ops pre-insert), same
    // per-ASIN unit of work: a tag failure is an 'error' outcome.
    try {
      const tagNames: string[] = Array.isArray(bulk.tags) ? bulk.tags.filter(Boolean) : [];
      if (tagNames.length > 0) await upsertTagsForAsin(asin, tagNames);
    } catch (err: any) {
      results.push({ asin, outcome: "error", message: `row inserted; tag creation failed: ${err?.message ?? "unknown"}` });
      continue;
    }

    if (inserted) {
      log(`Promoted ${asin} from bulk list ${listId} (lead date ${bulk.added_at?.toISOString?.().slice(0, 10) ?? bulk.added_at}, cogs ${bulk.estimated_cogs ?? "—"}, tags ${Array.isArray(bulk.tags) ? bulk.tags.length : 0}, snapshot fetched_at ${bulk.fetched_at ? new Date(bulk.fetched_at).toISOString() : "null"})`, "bulk");
      results.push({ asin, outcome: "added" });
    }
  }
  return results;
}
