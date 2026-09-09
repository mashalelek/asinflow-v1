// §21 bulk run pipeline (2026-09-09). Replaces runAnalyzeCore on the bulk
// page — that core reads prices from the MAIN tables (Prices & Stock owns
// them), so a bulk-only ASIN could never be priced ("⚠ Error on every
// row"). This pipeline runs the SAME fetch passes the ASINs page runs —
// runPricePass / runFeesPass / fetchCatalogBatch — with the bulk table as
// the pluggable writer. §21 isolation: every write here targets
// bulk_list_asins; the shared passes perform no DB access of their own
// (pinned by bulk-refresh.test.ts).
//
// Stages: prices → fees (on just-fetched prices; no price ⇒ skipped, never
// a fallback estimate) → catalog → gating+hazmat (30-day rule on THIS
// table's gating_checked_at / hazmat_checked_at — same rule as the main
// page's stamps). Account-scoped stages (inventory/sales/listings) are
// excluded: meaningless for arbitrary ASINs.
//
// Run lifecycle (SPEC §21 decision, 2026-09-09): a run CONTINUES TO
// COMPLETION after client disconnect — subscribers just stop receiving
// events; GET /api/bulk-lists/:id/refresh/status re-attaches. One run per
// list at a time: startBulkRun refuses with `busy` while one is live.
import { runPricePass, type PriceOutcome } from "./price-sync";
import { runFeesPass } from "./refresh-job";
import { fetchCatalogBatch } from "./product-info-batch";
import { getEligibility } from "./spapi";
import { getInboundHazmat } from "./inbound-hazmat";
import { getFeePriceForAsin } from "@shared/schema";
import { query } from "./db";
import { log } from "./index";
import { rateLimitStats, rateLimitStatsSince } from "./spapi-rate-limit";

export type BulkStage = "prices" | "fees" | "catalog" | "gating" | "hazmat";

export interface BulkRunState {
  listId: string;
  startedAt: string;
  stage: BulkStage | "done" | "failed";
  current: number;
  total: number;
  requested: number;
  /** Per-stage counts, filled as stages finish. */
  stages: Partial<Record<BulkStage, { counts: Record<string, number>; outcomes: Record<string, string> }>>;
  rateLimits?: Record<string, { rate: number; sent: number; throttled: number; adjusted: boolean }>;
  error?: string;
}

type Subscriber = (event: object) => void;
interface ActiveRun { state: BulkRunState; subscribers: Set<Subscriber>; }
const activeRuns = new Map<string, ActiveRun>();

export function getBulkRunStatus(listId: string): BulkRunState | null {
  return activeRuns.get(listId)?.state ?? null;
}

export function subscribeBulkRun(listId: string, fn: Subscriber): (() => void) | null {
  const run = activeRuns.get(listId);
  if (!run) return null;
  run.subscribers.add(fn);
  return () => run.subscribers.delete(fn);
}

const THIRTY_D = 30 * 86400000;
const staleOrNever = (ts: any) => ts == null || Date.now() - new Date(ts).getTime() > THIRTY_D;

// Conclusive price outcomes stamp fetched_at; everything else records the
// outcome only (same honesty rule as the main page).
const CONCLUSIVE: ReadonlySet<string> = new Set(["updated", "no_offers"]);

export function startBulkRun(
  listId: string,
  opts: { scope: "failed" | "all"; asins?: string[] },
): { busy: true; since: string } | { busy: false; state: BulkRunState } {
  const existing = activeRuns.get(listId);
  // Only a LIVE run blocks; a terminal state lingering for re-attach
  // (60 s window) must never refuse the next run.
  if (existing && existing.state.stage !== "done" && existing.state.stage !== "failed") {
    return { busy: true, since: existing.state.startedAt };
  }

  const state: BulkRunState = {
    listId, startedAt: new Date().toISOString(),
    stage: "prices", current: 0, total: 0, requested: 0, stages: {},
  };
  const run: ActiveRun = { state, subscribers: new Set() };
  activeRuns.set(listId, run);
  const emit = (event: object) => { for (const fn of Array.from(run.subscribers)) { try { fn(event); } catch {} } };

  void executeBulkRun(listId, opts, state, emit)
    .catch((err: any) => {
      state.stage = "failed";
      state.error = err?.message ?? String(err);
      log(`Bulk run failed (list ${listId}): ${state.error}`, "bulk");
      emit({ type: "error", message: state.error });
    })
    .finally(() => {
      emit({ type: "complete", data: donePayload(state) });
      // Keep the terminal state readable for a short re-attach window.
      setTimeout(() => { if (activeRuns.get(listId)?.state === state) activeRuns.delete(listId); }, 60_000);
    });
  return { busy: false, state };
}

function donePayload(state: BulkRunState) {
  return { stages: state.stages, rateLimits: state.rateLimits, requested: state.requested, error: state.error ?? null };
}

async function executeBulkRun(
  listId: string,
  opts: { scope: "failed" | "all"; asins?: string[] },
  state: BulkRunState,
  emit: (e: object) => void,
): Promise<void> {
  const rateBaseline = rateLimitStats();
  const runStartedAt = new Date();

  const rows = (await query(
    `SELECT asin, eligibility_status, is_hazmat, fetched_at, price_outcome, category
       FROM bulk_list_asins WHERE list_id = $1 ORDER BY asin`,
    [listId],
  )).rows;
  if (rows.length === 0) throw new Error("List not found or empty");

  let scoped = rows;
  if (opts.asins && opts.asins.length > 0) {
    const want = new Set(opts.asins.map((a) => a.toUpperCase()));
    scoped = rows.filter((r: any) => want.has(r.asin));
  } else if (opts.scope === "failed") {
    // Default scope: failed + never-fetched (SPEC §21). Falls back to ALL
    // when nothing matches — a fully-green list re-runs everything.
    scoped = rows.filter((r: any) => r.fetched_at == null || r.price_outcome == null || !CONCLUSIVE.has(r.price_outcome));
    if (scoped.length === 0) scoped = rows;
  }
  const asins: string[] = scoped.map((r: any) => r.asin);
  state.requested = asins.length;
  log(`Bulk run (list ${listId}): ${asins.length}/${rows.length} rows in scope (${opts.asins?.length ? "retry" : opts.scope})`, "bulk");

  const setStage = (stage: BulkStage, total: number) => {
    state.stage = stage; state.current = 0; state.total = total;
    emit({ type: "stage", stage, status: "running", current: 0, total });
  };
  const tick = (stage: BulkStage, current: number, total: number, asin?: string) => {
    state.current = current; state.total = total;
    emit({ type: "stage", stage, status: "running", current, total, asin });
  };

  // ── prices ──
  setStage("prices", asins.length);
  const priceRes = await runPricePass(
    asins,
    async (asin, p) => {
      // All three parsed prices stored verbatim (migration 039) — the
      // client's price-source toggle + getSelectedPrice fallback then
      // behave exactly as on the main page.
      await query(
        `UPDATE bulk_list_asins SET sale_price = $3, sale_price_buy_box = $4, sale_price_lowest = $5,
                sellers_fba = $6, sellers_fbm = $7, price_outcome = $8, fetched_at = NOW()
          WHERE list_id = $1 AND asin = $2`,
        [listId, asin, p.lowestFbaPrice, p.buyBoxPrice, p.lowestPrice, p.sellersFba, p.sellersFbm, p.noOffers ? "no_offers" : "updated"],
      );
    },
    (prog) => tick("prices", prog.current, prog.total, prog.asin),
  );
  // Non-conclusive outcomes: record the outcome, do NOT stamp fetched_at.
  for (const [asin, outcome] of Object.entries(priceRes.outcomes)) {
    const word = outcome.split(":")[0];
    if (CONCLUSIVE.has(word)) continue;
    await query(
      `UPDATE bulk_list_asins SET price_outcome = $3 WHERE list_id = $1 AND asin = $2`,
      [listId, asin, word],
    );
  }
  state.stages.prices = { counts: priceRes.counts as any, outcomes: priceRes.outcomes };

  // ── fees (just-fetched prices only; no price ⇒ skipped_no_price) ──
  const feeItems: Array<{ asin: string; price: number; category?: string | null }> = [];
  const feeOutcomes: Record<string, string> = {};
  let skippedNoPrice = 0;
  const catByAsin = new Map<string, string | null>(scoped.map((r: any) => [r.asin, r.category ?? null]));
  for (const asin of asins) {
    const p = priceRes.parsed.get(asin);
    const { price, isFallback } = getFeePriceForAsin({
      lowestFbaPrice: p?.lowestFbaPrice ?? null, buyBoxPrice: p?.buyBoxPrice ?? null, lowestPrice: p?.lowestPrice ?? null,
    });
    if (!p || isFallback) { skippedNoPrice++; feeOutcomes[asin] = "skipped_no_price"; continue; }
    feeItems.push({ asin, price, category: catByAsin.get(asin) });
  }
  setStage("fees", feeItems.length);
  const feesRes = await runFeesPass(
    feeItems,
    async (asin, fees) => {
      await query(
        `UPDATE bulk_list_asins SET fba_fee = $3, referral_fee = $4, fees_estimate_price = $5
          WHERE list_id = $1 AND asin = $2`,
        [listId, asin, fees.fbaFulfillmentFee, fees.referralFee, fees.feesEstimatePrice],
      );
    },
    (current, total) => tick("fees", current, total),
  );
  state.stages.fees = {
    counts: { ...feesRes.counts, skipped_no_price: skippedNoPrice },
    outcomes: { ...feeOutcomes, ...feesRes.outcomes },
  };

  // ── catalog ──
  setStage("catalog", asins.length);
  const catalogMap = await fetchCatalogBatch(asins);
  const catCounts = { parsed: 0, absent: 0, inconclusive: 0 };
  const catOutcomes: Record<string, string> = {};
  let catDone = 0;
  for (const asin of asins) {
    const entry = catalogMap.get(asin);
    if (entry?.kind === "parsed") {
      catCounts.parsed++;
      const c = entry.data;
      await query(
        `UPDATE bulk_list_asins SET
           title = COALESCE($3, title), image_url = COALESCE($4, image_url),
           brand = COALESCE($5, brand), category = COALESCE($6, category),
           weight_lb = COALESCE($7, weight_lb), length_in = COALESCE($8, length_in),
           width_in = COALESCE($9, width_in), height_in = COALESCE($10, height_in),
           bsr = COALESCE($11, bsr),
           is_meltable = (is_meltable OR $12),
           is_dangerous_good = COALESCE($13, is_dangerous_good),
           catalog_outcome = 'parsed'
         WHERE list_id = $1 AND asin = $2`,
        [listId, asin, c.title, c.imageUrl, c.brand, c.bsrCategory, c.weightLbs,
         c.lengthIn ?? null, c.widthIn ?? null, c.heightIn ?? null, c.bsrRank,
         c.isMeltable ?? false, c.isDangerousGood ?? null],
      );
    } else if (entry?.kind === "absent") {
      // DA-2 batch analogue of a 404 — renders "Not found". Keep the last
      // known catalog snapshot (never blank a leg from another leg's result).
      catCounts.absent++;
      catOutcomes[asin] = "absent";
      await query(`UPDATE bulk_list_asins SET catalog_outcome = 'absent' WHERE list_id = $1 AND asin = $2`, [listId, asin]);
    } else {
      catCounts.inconclusive++;
      catOutcomes[asin] = `inconclusive: ${entry?.kind === "inconclusive" ? entry.message : "no response"}`;
      await query(`UPDATE bulk_list_asins SET catalog_outcome = 'inconclusive' WHERE list_id = $1 AND asin = $2`, [listId, asin]);
    }
    catDone++;
    if (catDone % 20 === 0 || catDone === asins.length) tick("catalog", catDone, asins.length);
  }
  state.stages.catalog = { counts: catCounts, outcomes: catOutcomes };

  // ── gating + hazmat via the SHARED per-ASIN cache (migration 038) ──
  // Stamps live ONLY in bulk_gating_hazmat_cache — one place decides
  // "needs probe"; every list shares it, so re-uploads of already-probed
  // ASINs cost nothing. Read-through by default; scope "all" (Refresh all)
  // BUSTS the cache for this list's ASINs — fresh probes, matching what
  // Refresh all means everywhere else. Cache rows survive list deletion by
  // design. Per-row eligibility_status / is_hazmat are the display copy,
  // written from the cache on reuse and from the probe on probe.
  const cacheRows = (await query(
    `SELECT asin, eligibility_status, is_hazmat, gating_checked_at, hazmat_checked_at
       FROM bulk_gating_hazmat_cache WHERE asin = ANY($1::text[])`,
    [asins],
  )).rows;
  const cache = new Map<string, any>(cacheRows.map((r: any) => [r.asin, r]));
  const bustCache = opts.scope === "all" && !(opts.asins && opts.asins.length > 0);

  const gCounts = { probed: 0, reused_cache: 0, error: 0 };
  const gOutcomes: Record<string, string> = {};
  const gatingScope = scoped.filter((r: any) => bustCache || staleOrNever(cache.get(r.asin)?.gating_checked_at));
  const gatingScopeSet = new Set(gatingScope.map((r: any) => r.asin));
  setStage("gating", gatingScope.length);
  // Cache hits: copy the cached value into the row's display column.
  for (const r of scoped as any[]) {
    if (gatingScopeSet.has(r.asin)) continue;
    gCounts.reused_cache++;
    const c = cache.get(r.asin);
    if (c?.eligibility_status != null && c.eligibility_status !== r.eligibility_status) {
      await query(`UPDATE bulk_list_asins SET eligibility_status = $3 WHERE list_id = $1 AND asin = $2`, [listId, r.asin, c.eligibility_status]);
    }
  }
  for (const r of gatingScope as any[]) {
    try {
      const elig = await getEligibility(r.asin);
      await query(
        `INSERT INTO bulk_gating_hazmat_cache (asin, eligibility_status, gating_checked_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (asin) DO UPDATE SET eligibility_status = $2, gating_checked_at = NOW()`,
        [r.asin, elig.status],
      );
      await query(`UPDATE bulk_list_asins SET eligibility_status = $3 WHERE list_id = $1 AND asin = $2`, [listId, r.asin, elig.status]);
    } catch (err: any) {
      gCounts.error++;
      gOutcomes[r.asin] = `error: ${err?.message ?? "unknown"}`;
      continue;
    }
    gCounts.probed++;
    tick("gating", gCounts.probed + gCounts.error, gatingScope.length, r.asin);
  }
  state.stages.gating = { counts: gCounts, outcomes: gOutcomes };

  const hCounts = { probed: 0, reused_cache: 0, error: 0 };
  const hOutcomes: Record<string, string> = {};
  const hazmatScope = scoped.filter((r: any) => bustCache || staleOrNever(cache.get(r.asin)?.hazmat_checked_at));
  const hazmatScopeSet = new Set(hazmatScope.map((r: any) => r.asin));
  setStage("hazmat", hazmatScope.length);
  for (const r of scoped as any[]) {
    if (hazmatScopeSet.has(r.asin)) continue;
    hCounts.reused_cache++;
    const c = cache.get(r.asin);
    if (c?.is_hazmat != null && c.is_hazmat !== r.is_hazmat) {
      await query(`UPDATE bulk_list_asins SET is_hazmat = $3 WHERE list_id = $1 AND asin = $2`, [listId, r.asin, c.is_hazmat]);
    }
  }
  for (const r of hazmatScope as any[]) {
    try {
      const hz = await getInboundHazmat(r.asin);
      await query(
        `INSERT INTO bulk_gating_hazmat_cache (asin, is_hazmat, hazmat_checked_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (asin) DO UPDATE SET is_hazmat = COALESCE($2, bulk_gating_hazmat_cache.is_hazmat), hazmat_checked_at = NOW()`,
        [r.asin, hz],
      );
      // Tri-state preserved on the display copy too.
      await query(`UPDATE bulk_list_asins SET is_hazmat = COALESCE($3, is_hazmat) WHERE list_id = $1 AND asin = $2`, [listId, r.asin, hz]);
    } catch (err: any) {
      hCounts.error++;
      hOutcomes[r.asin] = `error: ${err?.message ?? "unknown"}`;
      continue;
    }
    hCounts.probed++;
    tick("hazmat", hCounts.probed + hCounts.error, hazmatScope.length, r.asin);
  }
  state.stages.hazmat = { counts: hCounts, outcomes: hOutcomes };

  state.rateLimits = rateLimitStatsSince(rateBaseline);
  state.stage = "done";

  // Ledger: one refresh_runs row per stage, scope `bulk:<list_id>` — the
  // dialog and the ledger use the same words (SPEC §21).
  for (const [stage, s] of Object.entries(state.stages)) {
    try {
      await query(
        `INSERT INTO refresh_runs (started_at, finished_at, trigger, stage, scope, requested, counts, outcomes)
         VALUES ($1, NOW(), 'manual', $2, $3, $4, $5::jsonb, $6::jsonb)`,
        [runStartedAt, stage, `bulk:${listId}`, asins.length, JSON.stringify(s!.counts), JSON.stringify(s!.outcomes)],
      );
    } catch (err: any) {
      log(`refresh_runs write failed for bulk stage ${stage}: ${err?.message ?? err}`, "bulk");
    }
  }
  const line = Object.entries(state.stages).map(([k, s]) => `${k} ${Object.entries(s!.counts).map(([a, b]) => `${a}=${b}`).join(",")}`).join(" · ");
  log(`Bulk run complete (list ${listId}): ${line}`, "bulk");
}
