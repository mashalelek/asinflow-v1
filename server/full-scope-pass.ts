// §18 manual full-scope listing scan (item 8 + 8c).
//
// SCOPE = EVERY ASIN AF KNOWS (§18 A3, 2026-10-09). All statuses — active,
// parked AND dead — with or without asin_skus rows. The two filters this
// replaced (`status IN ('active','parked')` here, `in_catalog = TRUE` in the
// now-deleted live-offer-sync.ts) are why B07J2WWWD4's wrong TRUE was frozen:
// dead + in_catalog=f put it outside both reconciles, so nothing could ever
// correct it. A flag AF cannot re-probe is a flag AF should not be showing.
//
// Phase a: every ASIN with ≥1 asin_skus row, ANY status, ALL flag states —
// probes EVERY SKU via getListingsItem (no first-live short-circuit: the 8c
// primary rule needs per-SKU liveness). Phase b: no-SKU ASINs, ANY status
// (the active-only gate was removed 2026-10-09), via searchListingsItems
// (§19 fallback endpoint) to discover SC-created SKUs.
//
// Every ASIN gets a per-ASIN outcome in `report.outcomes` — not only the ones
// that changed (§18 A2). The flag itself is written by the ONE primitive in
// live-offer-write.ts, which records the outcome in the same call.
//
// Writes (live mode only; dryRun=true probes identically but writes NOTHING):
//   - has_live_offer / has_buyable_offer + both stamps, and current_issues /
//     issues_checked_at — ALL via writeLiveOfferVerdict, one statement, so
//     the flags can never disagree about one probe (§18 A2, §23)
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
import { discoverAsinListings, recordDiscoveredSkus, pick8cPrimary, anyBuyable } from "./live-offer-check";
import { writeLiveOfferVerdict, recordTransient, recordError, type OutcomeSink } from "./live-offer-write";
import { fetchAllAccountListings, type OnboardResolution } from "./sc-discovery";
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
  // §18 A2: ASIN -> outcome, for EVERY ASIN probed across both phases. The
  // caller persists this into refresh_runs.outcomes. ~2.5k entries at
  // full-catalog scope (~100 KB jsonb), accepted deliberately — "which ASINs
  // did this run look at" has to be answerable from the ledger alone.
  outcomes: Record<string, string>;
  phaseA: {
    asins: number; skusProbed: number; live: number; noOffer: number;
    transientSkipped: number; flips: FlipEntry[]; repoints: RepointEntry[];
    // §18 all-404 → discovery (2026-08-28): ASINs whose known SKUs all 404'd
    // but searchListingsItems found SC-created listing(s).
    discoveries: DiscoveredEntry[];
    durationMs: number;
  };
  phaseB: {
    asins: number; discovered: DiscoveredEntry[]; noListing: number;
    transientSkipped: number; durationMs: number;
  };
  // §18 Part B phase c (2026-10-11): ASINs SC has that AF does not. Absent
  // when the caller did not ask for phase c (a selection-scoped run).
  phaseC?: {
    ran: boolean;
    /** Set when the account pull was partial — NOTHING was onboarded. */
    incomplete: string | null;
    scListings: number;      // rows in the account list, A1-qualified
    scAsins: number;         // distinct ASINs among them
    alreadyInAf: number;
    onboarded: OnboardResolution[];
    durationMs: number;
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
  // §18 phase c: pull the account-wide SKU list and onboard SC-only ASINs.
  // OFF by default — a selection-scoped run reconciles the selection and has
  // no business pulling 41 pages of account listings. Prices & Stock turns it
  // on for every run; Product Info only when its working set is the full
  // catalog.
  phaseC?: boolean;
  // Run ONLY phase c, skipping the per-ASIN phases a and b. The phase-c dry
  // run and the "re-run, expect 0 onboarded" check both want the
  // account-list diff on its own — 41 calls, ~19s — not a full-catalog
  // reconcile of every known SKU, which is a different (much longer) job.
  onlyPhaseC?: boolean;
  // Injected so this module never imports routes.ts. Called ONCE with every
  // ASIN to onboard; the implementation is onboardNewAsins (§14 — the ONE
  // insert path). Not called on a dry run.
  onboard?: (rows: OnboardResolution[]) => Promise<void>;
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

  // §18 A3 (2026-10-09): NO status filter, filtered or not. The unfiltered
  // walk used to be `a.status IN ('active','parked')` (cron scope, decision 5,
  // 2026-09-07); dead ASINs were therefore unreachable by any reconcile and
  // their flags froze at whatever a past run left behind. Dead rows still get
  // skipped by the OTHER stages — there is no point re-pricing one — but
  // "does SC still list it" is exactly the question a dead row needs asked.
  const hasFilter = opts.asinFilter != null && opts.asinFilter.size > 0;
  const filterCond = hasFilter ? `AND a.asin = ANY($1::text[])` : "";
  const filterParams = opts.asinFilter && opts.asinFilter.size > 0 ? [Array.from(opts.asinFilter)] : undefined;

  // ─── Phase a: ASINs with ≥1 SKU, all flag states ──────────────────────────
  const t0 = now();
  const skipAB = opts.onlyPhaseC === true;
  const aRows = skipAB ? [] : (await query(
    `SELECT a.asin, a.id, a.primary_sku, a.has_live_offer,
            json_agg(json_build_object('sku', s.sku, 'created_at', s.created_at)
                     ORDER BY s.created_at DESC) AS skus
       FROM asins a JOIN asin_skus s ON s.asin_id = a.id
      WHERE TRUE ${filterCond}
      GROUP BY a.asin, a.id, a.primary_sku, a.has_live_offer
      ORDER BY a.asin`,
    filterParams,
  )).rows;

  // §18 A2: one outcome per ASIN, both phases, written by the primitive.
  const outcomes: Record<string, string> = {};
  const sink: OutcomeSink = (asin, outcome) => { outcomes[asin] = outcome; };

  const phaseA: FullScopeReport["phaseA"] = {
    asins: aRows.length, skusProbed: 0, live: 0, noOffer: 0,
    transientSkipped: 0, flips: [], repoints: [], discoveries: [], durationMs: 0,
  };
  emit({ type: "phase", phase: "a", asins: aRows.length, dryRun });

  // Bounded-concurrency probes (SPEC §11 Part C, 2026-09-07): the old
  // sequential await ran ~2 probes/s (latency-bound) against a 5 rps bucket
  // — 18 min for the full catalog. 5 ASINs in flight; the limiter still
  // paces at the wire, and each ASIN's SKUs still resolve fully before its
  // flag is written (per-ASIN fail-closed semantics unchanged).
  let aDone = 0;
  const processARow = async (row: (typeof aRows)[number], i: number): Promise<void> => {
    const skus: { sku: string; created_at: string }[] = row.skus ?? [];
    // Probe EVERY SKU (8c needs full liveness, not first-live short-circuit).
    let transient = false;
    // statuses retained (2026-09-15, §23): has_buyable_offer is derived from
    // summaries[].status here — already parsed, no extra call.
    const liveByCreated: { sku: string; created_at: string; issues: ListingIssueLite[]; statuses: string[] }[] = [];
    for (const s of skus) {
      const out = await checkSkuListingStatus(sellerId, s.sku, httpGet);
      phaseA.skusProbed++;
      if (!out.ok) { transient = true; }
      else if (out.present) liveByCreated.push({ sku: s.sku, created_at: s.created_at, issues: out.issues, statuses: out.statuses ?? [] });
    }
    if (transient) {
      phaseA.transientSkipped++;
      recordTransient(row.asin, sink);
      emit({ type: "progress", phase: "a", done: i + 1, total: aRows.length, asin: row.asin, skipped: "transient" });
      return;
    }

    // §18 all-known-SKUs-404 → discovery before FALSE (2026-08-28): every
    // known SKU just definitively 404'd, which proves nothing about SC-created
    // SKUs AF doesn't know. Probe by ASIN before writing FALSE; fail-closed on
    // a transient discovery. (Phase b can't cover this ASIN — it HAS rows.)
    if (liveByCreated.length === 0) {
      const disc = await discoverAsinListings(row.asin, sellerId, httpGet);
      if (!disc.ok) {
        phaseA.transientSkipped++;
        recordTransient(row.asin, sink);
        emit({ type: "progress", phase: "a", done: i + 1, total: aRows.length, asin: row.asin, skipped: "transient" });
        return;
      }
      if (disc.found.length > 0) {
        phaseA.discoveries.push({ asin: row.asin, skus: disc.found.map((f) => f.sku), live: true });
        phaseA.live++;
        const prevFlag: boolean | null = row.has_live_offer;
        if (prevFlag !== true) phaseA.flips.push({ asin: row.asin, from: prevFlag, to: true });
        const newPrimary = pick8cPrimary(disc.found);
        if (newPrimary != null && newPrimary !== row.primary_sku) {
          phaseA.repoints.push({ asin: row.asin, from: row.primary_sku ?? null, to: newPrimary });
        }
        const lead = disc.found.find((f) => f.sku === newPrimary) ?? disc.found[0];
        if (!dryRun) await recordDiscoveredSkus(row.asin, disc.found, query);
        // One primitive, dry-run aware: the outcome is recorded either way,
        // which is what makes the dry run a faithful preview.
        await writeLiveOfferVerdict(
          {
            asin: row.asin, prevFlag: row.has_live_offer, listed: true,
            buyable: anyBuyable(disc.found.map((f) => f.statuses)),
            issues: lead.issues, event: "discovery",
          },
          { query, outcomes: sink, dryRun },
        );
        if (!dryRun) {
          log(`Full-scope phase a discovery: ${row.asin} — known SKUs all 404/shell, found ${disc.found.map((f) => f.sku).join(", ")}${newPrimary ? `; primary → newest live: ${row.primary_sku ?? "∅"} → ${newPrimary}` : ""}`, "full-scope");
        }
        if ((i + 1) % 25 === 0 || i === aRows.length - 1) {
          emit({ type: "progress", phase: "a", done: i + 1, total: aRows.length });
        }
        return;
      }
      // discovery empty (200, zero items) → the FALSE verdict below stands.
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

    await writeLiveOfferVerdict(
      {
        asin: row.asin, prevFlag: prev, listed: anyLive,
        buyable: anyBuyable(liveByCreated.map((l) => l.statuses)),
        issues: (newestLiveReal ?? newestLiveAny)?.issues ?? [],
      },
      { query, outcomes: sink, dryRun },
    );
    if (!dryRun) {
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
  };
  const A_CONCURRENCY = 5;
  {
    let next = 0;
    const workers = Array.from({ length: Math.min(A_CONCURRENCY, aRows.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= aRows.length) return;
        try { await processARow(aRows[i], i); } catch (err: any) {
          phaseA.transientSkipped++;
          // A2: a throw is this ASIN's outcome, not an absence of one.
          recordError(aRows[i].asin, String(err?.message ?? err), sink);
          log(`Full-scope phase a: row ${aRows[i].asin} threw (${err?.message ?? err}) — skipped fail-closed`, "full-scope");
        }
        aDone++;
        if (aDone % 25 === 0 || aDone === aRows.length) {
          emit({ type: "progress", phase: "a", done: aDone, total: aRows.length });
        }
      }
    });
    await Promise.all(workers);
  }
  phaseA.durationMs = now() - t0;
  emit({ type: "phase_done", phase: "a", ...summarizeA(phaseA) });

  // ─── Phase b: no-SKU ASINs → searchListingsItems discovery ────────────────
  const t1 = now();
  const bRows = skipAB ? [] : (await query(
    // has_live_offer is selected for flip detection (§18 A2) — without it
    // every phase-b discovery would report `flip: null -> true` even when the
    // flag was already TRUE.
    `SELECT a.asin, a.id, a.primary_sku, a.has_live_offer,
            EXISTS (SELECT 1 FROM asin_skus s WHERE s.asin_id = a.id AND s.is_primary) AS has_primary_row
       FROM asins a
      WHERE NOT EXISTS (SELECT 1 FROM asin_skus s WHERE s.asin_id = a.id)
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
      recordTransient(row.asin, sink);
      await sleep(pacingMs);
      continue;
    }
    // §18 A1: shells are not listings — filtered before the found/not-found
    // decision, so a shell can never be discovered into asin_skus.
    const items: any[] = (data?.items ?? []).filter(
      (it: any) => Array.isArray(it?.summaries) && it.summaries.length > 0,
    );
    if (items.length === 0) {
      phaseB.noListing++; // sourcing lead — expected; stays NULL
      // A2: "nothing there" is an outcome too. The flag is NOT written —
      // a no-SKU ASIN with no SC listing stays NULL, never coerced to FALSE
      // (§18 tri-state) — so this records directly rather than through the
      // primitive, which exists to write a verdict.
      sink(row.asin, "not_listed");
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

      // Bootstrap primary ONLY if none exists (§18): no-SKU ASIN has no
      // is_primary row by definition, but primary_sku may hold a stale value.
      const bootstrap = row.primary_sku == null && row.has_primary_row !== true;
      if (!opts.dryRun) {
        for (let f = 0; f < found.length; f++) {
          await query(
            `INSERT INTO asin_skus (asin_id, sku, is_primary) VALUES ($1, $2, $3)
             ON CONFLICT (asin_id, sku) DO NOTHING`,
            [row.id, found[f].sku, bootstrap && f === 0],
          );
        }
        if (bootstrap) {
          // primary_sku is NOT part of the flag primitive's statement — it is
          // §14 analyze-owned and has its own promotion rules (§18 8c).
          await query(`UPDATE asins SET primary_sku = $2 WHERE asin = $1`, [row.asin, found[0].sku]);
        }
      }
      await writeLiveOfferVerdict(
        {
          asin: row.asin, prevFlag: row.has_live_offer ?? null, listed: anyLive,
          buyable: anyBuyable(found.map((f) => f.statuses)),
          issues: found[0].issues, event: "discovery",
        },
        { query, outcomes: sink, dryRun: opts.dryRun },
      );
      if (!opts.dryRun) {
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

  // ─── Phase c: ASINs SC has that AF does not (§18 Part B, 2026-10-11) ─────
  let phaseC: FullScopeReport["phaseC"];
  if (opts.phaseC) {
    const t2 = now();
    emit({ type: "phase", phase: "c", dryRun });
    const pull = await fetchAllAccountListings(sellerId, httpGet, pacingMs);

    if (!pull.ok) {
      // A partial pull onboards NOTHING. Onboarding from a truncated list
      // creates rows for some ASINs and silently omits others, and the
      // omission is invisible — there is no "missing" to notice.
      phaseC = {
        ran: true, incomplete: pull.detail, scListings: 0, scAsins: 0,
        alreadyInAf: 0, onboarded: [], durationMs: now() - t2,
      };
      outcomes["_phase_c"] = `error: sc_list_incomplete — ${pull.detail}`;
      log(`Full-scope phase c: sc_list_incomplete after ${pull.pagesFetched} page(s) — onboarded nothing. ${pull.detail}`, "full-scope");
    } else {
      const skusByAsin = new Map<string, string[]>();
      for (const l of pull.listings) {
        const arr = skusByAsin.get(l.asin) ?? [];
        arr.push(l.sku);
        skusByAsin.set(l.asin, arr);
      }
      const scAsins = Array.from(skusByAsin.keys());
      const known = new Set(
        (await query(`SELECT asin FROM asins WHERE asin = ANY($1::text[])`, [scAsins]))
          .rows.map((r: any) => String(r.asin)),
      );
      const missing = scAsins.filter((a) => !known.has(a));

      const resolved = missing.length > 0 ? await resolveForOnboard(missing, skusByAsin, query) : [];
      if (!dryRun && resolved.length > 0 && opts.onboard) {
        await opts.onboard(resolved);
      }
      // The flag + its outcome are written by the onboarding path through the
      // A2 primitive (outcome `onboarded`); recorded here too so a dry run
      // previews the same outcomes a live run would record.
      if (dryRun) {
        for (const r of resolved) {
          outcomes[r.asin] = `onboarded · SKUs ${r.skus.join(", ")} · COGS ${r.cogsSource} · link ${r.buyLinkSource}`;
        }
      }

      phaseC = {
        ran: true, incomplete: null,
        scListings: pull.listings.length, scAsins: scAsins.length,
        alreadyInAf: known.size, onboarded: resolved, durationMs: now() - t2,
      };
      log(`Full-scope phase c${dryRun ? " DRY-RUN" : ""}: ${pull.pages} pages, ${pull.listings.length} listings, ${scAsins.length} ASINs, ${known.size} already in AF, ${resolved.length} to onboard`, "full-scope");
    }
    emit({ type: "phase_done", phase: "c", ...phaseC });
  }

  const report: FullScopeReport = { dryRun: opts.dryRun, outcomes, phaseA, phaseB, phaseC };
  log(
    `Full-scope pass ${opts.dryRun ? "DRY-RUN " : ""}complete: phase a ${phaseA.asins} ASINs/${phaseA.skusProbed} SKUs ` +
    `(${phaseA.live} live, ${phaseA.noOffer} no_offer, ${phaseA.transientSkipped} transient, ${phaseA.flips.length} flips, ` +
    `${phaseA.repoints.length} re-points, ${phaseA.discoveries.length} discoveries, ${Math.round(phaseA.durationMs / 1000)}s); ` +
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
    discoveries: a.discoveries.length, durationMs: a.durationMs,
  };
}

/**
 * Resolve the per-ASIN onboarding data phase c needs (§18 phase c step 3).
 *
 * Two sheet reads for the whole batch, not per ASIN:
 *   - the Master sheet's ASINs tab (SOURCING_SHEET_ID, col N = Buy Link) —
 *     a TARGETED read, deliberately NOT the insert-only sourcing sync, which
 *     would try to create rows of its own;
 *   - the Orders sheet (the PO mirror), for "does this ASIN have PO rows"
 *     and its col-E supplier domain.
 *
 * Either read failing is non-fatal: the ASIN onboards with whatever resolved,
 * down to buy_link/supplier NULL and COGS none. Phase c's job is to get the
 * ASIN into AF; the enrichment is best-effort and self-corrects on the next
 * PO sync.
 */
async function resolveForOnboard(
  missing: string[],
  skusByAsin: Map<string, string[]>,
  query: QueryLike,
): Promise<OnboardResolution[]> {
  const masterBuyLinks = new Map<string, string>();
  const ordersSuppliers = new Map<string, string | null>();

  try {
    const sheetId = process.env.SOURCING_SHEET_ID;
    if (sheetId) {
      const { fetchSourcingSheet } = await import("./sourcing-sheet");
      const want = new Set(missing);
      for (const row of await fetchSourcingSheet(sheetId)) {
        if (!want.has(row.asin)) continue;
        // First non-empty wins, matching the sourcing sync's collapse rule.
        if (row.buyLink && !masterBuyLinks.has(row.asin)) masterBuyLinks.set(row.asin, row.buyLink);
      }
    }
  } catch (err: any) {
    log(`Phase c: master-sheet buy-link lookup failed (${err?.message ?? err}) — falling through to Orders`, "full-scope");
  }

  try {
    const sheetId = process.env.GOOGLE_SHEET_ID;
    if (sheetId) {
      const { fetchSheetData } = await import("./google-sheets");
      const po = await fetchSheetData(sheetId);
      for (const asin of missing) {
        const row = po.get(asin);
        if (row) ordersSuppliers.set(asin, row.supplier ?? null);
      }
    }
  } catch (err: any) {
    log(`Phase c: Orders-sheet lookup failed (${err?.message ?? err}) — COGS/supplier left unresolved`, "full-scope");
  }

  const { resolveOnboardData } = await import("./sc-discovery");
  return resolveOnboardData(missing, skusByAsin, masterBuyLinks, ordersSuppliers);
}
