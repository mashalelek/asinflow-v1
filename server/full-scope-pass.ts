// §18 manual full-scope listing scan (item 8 + 8c).
//
// Phase a: every active ASIN with ≥1 asin_skus row, ALL flag states — probes
// EVERY SKU via getListingsItem (no first-live short-circuit: the 8c primary
// rule needs per-SKU liveness). Phase b: active no-SKU ASINs via
// searchListingsItems (§19 fallback endpoint) to discover SC-created SKUs.
//
// Writes (live mode only; dryRun=true probes identically but writes NOTHING):
//   - has_live_offer / offer_checked_at (any-SKU-live verdict)
//   - current_issues / issues_checked_at (§6 snapshot; newest-live SKU's
//     issues, [] when none live)
//   - 8c primary re-point: latest-live-wins — primary = most recently
//     observed (asin_skus.created_at) LIVE SKU, amzn.gr.* EXCLUDED from the
//     candidate set (never-amzn.gr-primary invariant); atomic single-statement
//     re-point; NO live non-amzn.gr SKU → primary untouched (never point at a
//     dead SKU, never null it out)
//   - phase b: discovered asin_skus rows; bootstrap primary only if none
//     exists (§18); not-found stays NULL ("no listing" — sourcing leads)
// Fail-closed: any transient SKU probe skips that ASIN entirely.
// NEVER touches listing_submissions.
import { query as defaultQuery } from "./db";
import { checkSkuListingStatus, type ListingIssueLite } from "./sku-listing-fetch";
import { spApiGet as realSpApiGet } from "./spapi-auth";
import type { HttpGetFn } from "./sku-catalog-fetch";
import { log } from "./index";

type QueryLike = (sql: string, params?: any[]) => Promise<{ rows: any[]; rowCount: number | null }>;

const MARKETPLACE = "ATVPDKIKX0DER";
const PACING_MS = 260; // 5 rps Listings bucket, shared by both phases

export interface RepointEntry { asin: string; from: string | null; to: string }
export interface DiscoveredEntry { asin: string; skus: string[]; live: boolean }
export interface FlipEntry { asin: string; from: boolean | null; to: boolean }

export interface FullScopeReport {
  dryRun: boolean;
  phaseA: {
    asins: number; skusProbed: number; live: number; noOffer: number;
    transientSkipped: number; flips: FlipEntry[]; repoints: RepointEntry[];
    durationMs: number;
  };
  phaseB: {
    asins: number; discovered: DiscoveredEntry[]; noListing: number;
    transientSkipped: number; durationMs: number;
  };
}

export type ProgressEmit = (event: Record<string, any>) => void;

export async function runFullScopePass(opts: {
  dryRun: boolean;                       // REQUIRED — no default; callers state intent
  sellerId?: string;
  asinFilter?: ReadonlySet<string>;      // selection-aware scope
  query?: QueryLike;
  httpGet?: HttpGetFn;
  pacingMs?: number;
  emit?: ProgressEmit;                   // NDJSON progress events
  nowMs?: () => number;
}): Promise<FullScopeReport> {
  const query = opts.query ?? (defaultQuery as any as QueryLike);
  const httpGet = opts.httpGet ?? realSpApiGet;
  const sellerId = opts.sellerId ?? process.env.SP_API_SELLER_ID;
  const pacingMs = opts.pacingMs ?? PACING_MS;
  const emit = opts.emit ?? (() => {});
  const now = opts.nowMs ?? Date.now;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  if (!sellerId) throw new Error("SP_API_SELLER_ID not set");
  const { dryRun } = opts;

  // Explicit selection scans exactly those ASINs, archived included (SPEC 14
  // "Archived != excluded from sync"); active-only applies to the unfiltered
  // full-catalog walk.
  const hasFilter = opts.asinFilter != null && opts.asinFilter.size > 0;
  const activeCond = hasFilter ? "TRUE" : "a.is_active = TRUE";
  const filterCond = hasFilter ? `AND a.asin = ANY($1::text[])` : "";
  const filterParams = opts.asinFilter && opts.asinFilter.size > 0 ? [Array.from(opts.asinFilter)] : undefined;

  // ─── Phase a: ASINs with ≥1 SKU, all flag states ──────────────────────────
  const t0 = now();
  const aRows = (await query(
    `SELECT a.asin, a.id, a.primary_sku, a.has_live_offer,
            json_agg(json_build_object('sku', s.sku, 'created_at', s.created_at)
                     ORDER BY s.created_at DESC) AS skus
       FROM asins a JOIN asin_skus s ON s.asin_id = a.id
      WHERE ${activeCond} ${filterCond}
      GROUP BY a.asin, a.id, a.primary_sku, a.has_live_offer
      ORDER BY a.asin`,
    filterParams,
  )).rows;

  const phaseA: FullScopeReport["phaseA"] = {
    asins: aRows.length, skusProbed: 0, live: 0, noOffer: 0,
    transientSkipped: 0, flips: [], repoints: [], durationMs: 0,
  };
  emit({ type: "phase", phase: "a", asins: aRows.length, dryRun });

  for (let i = 0; i < aRows.length; i++) {
    const row = aRows[i];
    const skus: { sku: string; created_at: string }[] = row.skus ?? [];
    // Probe EVERY SKU (8c needs full liveness, not first-live short-circuit).
    let transient = false;
    const liveByCreated: { sku: string; created_at: string; issues: ListingIssueLite[] }[] = [];
    for (const s of skus) {
      const out = await checkSkuListingStatus(sellerId, s.sku, httpGet);
      phaseA.skusProbed++;
      if (!out.ok) { transient = true; }
      else if (out.present) liveByCreated.push({ sku: s.sku, created_at: s.created_at, issues: out.issues });
      await sleep(pacingMs);
    }
    if (transient) {
      phaseA.transientSkipped++;
      emit({ type: "progress", phase: "a", done: i + 1, total: aRows.length, asin: row.asin, skipped: "transient" });
      continue;
    }

    const anyLive = liveByCreated.length > 0;
    if (anyLive) phaseA.live++; else phaseA.noOffer++;

    // Flag flip? (NULL → definitive counts as a flip for the report.)
    const prev: boolean | null = row.has_live_offer;
    if (prev !== anyLive) phaseA.flips.push({ asin: row.asin, from: prev, to: anyLive });

    // 8c: latest-live-wins, with amzn.gr.* EXCLUDED from the primary
    // candidate set (repo-wide never-amzn.gr-primary invariant — same rule as
    // inventory-sync bootstrap and Add-Offer). If only amzn.gr.* SKUs are
    // live, primary stays unchanged.
    const isAmznGr = (sku: string) => sku.toLowerCase().startsWith("amzn.gr.");
    const newest = (arr: typeof liveByCreated) =>
      arr.length > 0 ? arr.reduce((a, b) => (a.created_at >= b.created_at ? a : b)) : null;
    const newestLiveReal = newest(liveByCreated.filter((l) => !isAmznGr(l.sku)));
    // Issue snapshot: primary-elect's issues when one exists, else the newest
    // live SKU overall (an amzn.gr listing's issues still describe the ASIN).
    const newestLiveAny = newest(liveByCreated);
    const repoint = newestLiveReal != null && newestLiveReal.sku !== row.primary_sku;
    if (repoint) phaseA.repoints.push({ asin: row.asin, from: row.primary_sku ?? null, to: newestLiveReal!.sku });

    if (!dryRun) {
      await query(
        `UPDATE asins SET has_live_offer = $2, offer_checked_at = now(),
                current_issues = $3::jsonb, issues_checked_at = now()
          WHERE asin = $1`,
        [row.asin, anyLive, JSON.stringify((newestLiveReal ?? newestLiveAny)?.issues ?? [])],
      );
      if (repoint) {
        // Atomic single-statement re-point (§18 promotion): primary_sku +
        // every is_primary flag for the ASIN in one CTE.
        await query(
          `WITH a AS (UPDATE asins SET primary_sku = $2 WHERE asin = $1 RETURNING id)
           UPDATE asin_skus s SET is_primary = (s.sku = $2)
             FROM a WHERE s.asin_id = a.id`,
          [row.asin, newestLiveReal!.sku],
        );
        log(`Full-scope 8c re-point: ${row.asin} primary → newest live: ${row.primary_sku ?? "∅"} → ${newestLiveReal!.sku}`, "full-scope");
      }
    }
    if ((i + 1) % 25 === 0 || i === aRows.length - 1) {
      emit({ type: "progress", phase: "a", done: i + 1, total: aRows.length });
    }
  }
  phaseA.durationMs = now() - t0;
  emit({ type: "phase_done", phase: "a", ...summarizeA(phaseA) });

  // ─── Phase b: no-SKU ASINs → searchListingsItems discovery ────────────────
  const t1 = now();
  const bRows = (await query(
    `SELECT a.asin, a.id, a.primary_sku,
            EXISTS (SELECT 1 FROM asin_skus s WHERE s.asin_id = a.id AND s.is_primary) AS has_primary_row
       FROM asins a
      WHERE ${activeCond}
        AND NOT EXISTS (SELECT 1 FROM asin_skus s WHERE s.asin_id = a.id)
        ${filterCond}
      ORDER BY a.asin`,
    filterParams,
  )).rows;

  const phaseB: FullScopeReport["phaseB"] = {
    asins: bRows.length, discovered: [], noListing: 0, transientSkipped: 0, durationMs: 0,
  };
  emit({ type: "phase", phase: "b", asins: bRows.length, dryRun });

  for (let i = 0; i < bRows.length; i++) {
    const row = bRows[i];
    let data: any;
    try {
      data = await httpGet(`/listings/2021-08-01/items/${sellerId}`, {
        marketplaceIds: MARKETPLACE,
        identifiers: row.asin,
        identifiersType: "ASIN",
        includedData: "summaries,issues",
      });
    } catch (err: any) {
      // Any error here is treated as transient — nothing is written; the ASIN
      // stays NULL and the next run retries. (A no-listing ASIN is a 200 with
      // empty items, not an error.)
      phaseB.transientSkipped++;
      await sleep(pacingMs);
      continue;
    }
    const items: any[] = data?.items ?? [];
    if (items.length === 0) {
      phaseB.noListing++; // sourcing lead — expected; stays NULL
    } else {
      const found = items.map((it) => ({
        sku: String(it?.sku ?? ""),
        statuses: it?.summaries?.[0]?.status ?? [],
        issues: (it?.issues ?? []).map((x: any) => ({
          code: String(x?.code ?? ""), severity: String(x?.severity ?? ""), message: String(x?.message ?? ""),
        })),
      })).filter((f) => f.sku);
      // Discovered in SC = a listing record exists → has_live_offer TRUE,
      // matching checkAsinLiveOffer's present=200 semantics (closed/empty-
      // status listings count — §18 catalog icon).
      const anyLive = found.length > 0;
      phaseB.discovered.push({ asin: row.asin, skus: found.map((f) => f.sku), live: anyLive });

      if (!opts.dryRun && found.length > 0) {
        // Bootstrap primary ONLY if none exists (§18): no-SKU ASIN has no
        // is_primary row by definition, but primary_sku may hold a stale value.
        const bootstrap = row.primary_sku == null && row.has_primary_row !== true;
        for (let f = 0; f < found.length; f++) {
          await query(
            `INSERT INTO asin_skus (asin_id, sku, is_primary) VALUES ($1, $2, $3)
             ON CONFLICT (asin_id, sku) DO NOTHING`,
            [row.id, found[f].sku, bootstrap && f === 0],
          );
        }
        await query(
          `UPDATE asins SET has_live_offer = $2, offer_checked_at = now(),
                  current_issues = $3::jsonb, issues_checked_at = now()
                  ${bootstrap ? ", primary_sku = $4" : ""}
            WHERE asin = $1`,
          bootstrap
            ? [row.asin, anyLive, JSON.stringify(found[0].issues), found[0].sku]
            : [row.asin, anyLive, JSON.stringify(found[0].issues)],
        );
        log(`Full-scope phase b: discovered ${found.length} SKU(s) for ${row.asin}: ${found.map((f) => f.sku).join(", ")}`, "full-scope");
      }
    }
    if ((i + 1) % 25 === 0 || i === bRows.length - 1) {
      emit({ type: "progress", phase: "b", done: i + 1, total: bRows.length });
    }
    await sleep(pacingMs);
  }
  phaseB.durationMs = now() - t1;
  emit({ type: "phase_done", phase: "b", asins: phaseB.asins, discovered: phaseB.discovered.length, noListing: phaseB.noListing, transient: phaseB.transientSkipped, durationMs: phaseB.durationMs });

  const report: FullScopeReport = { dryRun: opts.dryRun, phaseA, phaseB };
  log(
    `Full-scope pass ${opts.dryRun ? "DRY-RUN " : ""}complete: phase a ${phaseA.asins} ASINs/${phaseA.skusProbed} SKUs ` +
    `(${phaseA.live} live, ${phaseA.noOffer} no_offer, ${phaseA.transientSkipped} transient, ${phaseA.flips.length} flips, ` +
    `${phaseA.repoints.length} re-points, ${Math.round(phaseA.durationMs / 1000)}s); ` +
    `phase b ${phaseB.asins} ASINs (${phaseB.discovered.length} discovered, ${phaseB.noListing} no-listing, ` +
    `${phaseB.transientSkipped} transient, ${Math.round(phaseB.durationMs / 1000)}s)`,
    "full-scope",
  );
  return report;
}

function summarizeA(a: FullScopeReport["phaseA"]) {
  return {
    asins: a.asins, skusProbed: a.skusProbed, live: a.live, noOffer: a.noOffer,
    transient: a.transientSkipped, flips: a.flips.length, repoints: a.repoints.length,
    durationMs: a.durationMs,
  };
}
