// Bulk Calc refresh on the job queue (SPEC §11 "Refresh job"; patch
// "Scope rules — Bulk Calc Refresh", decision 5, 2026-10-15).
//
// A bulk-target job is scoped to a list's ASINs. The runner resolves each
// ASIN: in `asins` → the normal components run against the MAIN tables and
// the result row is then copied into bulk_list_asins; not in `asins` → the
// PUBLIC components (catalog 2–6, hazmat 7, gating 8, prices 10–12, fees 13;
// 14 persists nothing) run here against the bulk tables only. Store
// components (15–21) never run for ASINs outside the catalog.
//
// §21 isolation holds: this module writes bulk_list_asins ONLY. The one
// direction is main → bulk (copyMainToBulk); nothing here writes asins or
// asin_estimates. The 30-day gating/hazmat cache is gone (decision 3).
import { query as defaultQuery } from "../db";
import { fetchCatalogBatch as realFetchCatalogBatch } from "../product-info-batch";
import { getInboundHazmat as realGetInboundHazmat } from "../inbound-hazmat";
import { getEligibility as realGetEligibility } from "../spapi";
import { runPricePass as realRunPricePass } from "../price-sync";
import { runFeesPass as realRunFeesPass } from "../refresh-job";
import { getFeePriceForAsin } from "@shared/schema";
import { enqueueJob, listActive, recordComponentRun, laneAhead } from "./jobs-repo";
import type { JobRow, QueryLike, ComponentResult } from "./types";

export interface BulkScope {
  listId: string;
  /** The list's ASINs in scope for this job, ordered. */
  listAsins: string[];
  /** Subset present in `asins`, ordered by asins.id (main components run on these). */
  inCatalog: string[];
  /** Subset absent from `asins` (public components, bulk tables only). */
  publicOnly: string[];
}

export async function resolveBulkScope(job: JobRow, query: QueryLike): Promise<BulkScope> {
  if (!job.bulk_list_id) throw new Error(`job ${job.id}: bulk target without bulk_list_id`);
  const listId = job.bulk_list_id;
  const rows = (await query(`SELECT asin FROM bulk_list_asins WHERE list_id = $1 ORDER BY asin`, [listId])).rows.map((r: any) => String(r.asin));
  const want = job.scope_asins && job.scope_asins.length > 0 ? new Set(job.scope_asins.map((a) => a.toUpperCase())) : null;
  const listAsins = want ? rows.filter((a) => want.has(a)) : rows;
  const inCatalog = listAsins.length === 0 ? [] : (await query(`SELECT asin FROM asins WHERE asin = ANY($1::text[]) ORDER BY id`, [listAsins])).rows.map((r: any) => String(r.asin));
  const inSet = new Set(inCatalog);
  return { listId, listAsins, inCatalog, publicOnly: listAsins.filter((a) => !inSet.has(a)) };
}

/** The fetch/parse passes, injectable for tests; the defaults are the real SP-API callers. */
export interface BulkPasses {
  fetchCatalogBatch: typeof realFetchCatalogBatch;
  getInboundHazmat: typeof realGetInboundHazmat;
  getEligibility: typeof realGetEligibility;
  runPricePass: typeof realRunPricePass;
  runFeesPass: typeof realRunFeesPass;
}
export const REAL_PASSES: BulkPasses = {
  fetchCatalogBatch: realFetchCatalogBatch, getInboundHazmat: realGetInboundHazmat, getEligibility: realGetEligibility,
  runPricePass: realRunPricePass, runFeesPass: realRunFeesPass,
};

const CONCLUSIVE: ReadonlySet<string> = new Set(["updated", "no_offers"]);

/**
 * The public pass for ASINs not in the catalog: catalog → hazmat → gating →
 * prices → fees, every write to bulk_list_asins, one ledger row per stage
 * (stage `bulk:<name>`, scope `bulk:<listId>`, linked to the job).
 */
export async function runBulkPublic(args: {
  job: JobRow; query: QueryLike; listId: string; asins: string[];
  log: (m: string) => void; passes?: BulkPasses;
}): Promise<Record<string, ComponentResult>> {
  const { job, query, listId, asins, log } = args;
  const p = args.passes ?? REAL_PASSES;
  const out: Record<string, ComponentResult> = {};
  if (asins.length === 0) return out;
  const ledger = async (stage: string, startedAt: Date, result: ComponentResult) => {
    out[`bulk:${stage}`] = result;
    await recordComponentRun({ jobId: job.id, trigger: job.trigger, stage: `bulk:${stage}`, scope: `bulk:${listId}`, requested: asins.length, startedAt, result, error: null }, query);
    log(`bulk:${stage} (${asins.length} public ASINs): ${Object.entries(result.counts).map(([k, v]) => `${k}=${v}`).join(" ")}`);
  };

  // ── catalog (2–6 ride one batch) ──
  {
    const t = new Date();
    const counts = { parsed: 0, absent: 0, inconclusive: 0 };
    const outcomes: Record<string, string> = {};
    for (let i = 0; i < asins.length; i += 100) {
      const part = asins.slice(i, i + 100);
      const m = await p.fetchCatalogBatch(part);
      for (const asin of part) {
        const e = m.get(asin);
        if (e?.kind === "parsed") {
          counts.parsed++;
          const c = e.data;
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
        } else if (e?.kind === "absent") {
          counts.absent++; outcomes[asin] = "absent";
          await query(`UPDATE bulk_list_asins SET catalog_outcome = 'absent' WHERE list_id = $1 AND asin = $2`, [listId, asin]);
        } else {
          counts.inconclusive++; outcomes[asin] = `inconclusive${e?.kind === "inconclusive" ? `: ${e.message}` : ""}`;
        }
      }
    }
    await ledger("catalog", t, { counts, outcomes });
  }

  // ── hazmat (7): every ASIN, every run — no cache (decision 3) ──
  {
    const t = new Date();
    const counts = { probed: 0, hazmat: 0, error: 0 };
    const outcomes: Record<string, string> = {};
    for (const asin of asins) {
      const hz = await p.getInboundHazmat(asin);
      if (hz.kind !== "ok") { counts.error++; outcomes[asin] = `error: ${hz.message}`; continue; }
      await query(`UPDATE bulk_list_asins SET is_hazmat = $3 WHERE list_id = $1 AND asin = $2`, [listId, asin, hz.isHazmat]);
      counts.probed++; if (hz.isHazmat) counts.hazmat++;
    }
    await ledger("hazmat", t, { counts, outcomes });
  }

  // ── gating (8) ──
  {
    const t = new Date();
    const counts = { probed: 0, yes: 0, no: 0, error: 0 };
    const outcomes: Record<string, string> = {};
    for (const asin of asins) {
      const el = await p.getEligibility(asin);
      if (el.kind !== "ok") { counts.error++; outcomes[asin] = `error: ${el.message}`; continue; }
      await query(`UPDATE bulk_list_asins SET eligibility_status = $3 WHERE list_id = $1 AND asin = $2`, [listId, asin, el.status]);
      counts.probed++; if (el.status === "yes") counts.yes++; else counts.no++;
    }
    await ledger("gating", t, { counts, outcomes });
  }

  // ── prices (10–12) ──
  const t5 = new Date();
  const priceRes = await p.runPricePass(
    asins,
    async (asin, po) => {
      await query(
        `UPDATE bulk_list_asins SET sale_price = $3, sale_price_buy_box = $4, sale_price_lowest = $5,
                sellers_fba = $6, sellers_fbm = $7, price_outcome = $8, fetched_at = NOW()
          WHERE list_id = $1 AND asin = $2`,
        [listId, asin, po.lowestFbaPrice, po.buyBoxPrice, po.lowestPrice, po.sellersFba, po.sellersFbm, po.noOffers ? "no_offers" : "updated"],
      );
    },
  );
  for (const [asin, outcome] of Object.entries(priceRes.outcomes)) {
    const word = outcome.split(":")[0];
    if (CONCLUSIVE.has(word)) continue;
    await query(`UPDATE bulk_list_asins SET price_outcome = $3 WHERE list_id = $1 AND asin = $2`, [listId, asin, word]);
  }
  await ledger("prices", t5, { counts: priceRes.counts as any, outcomes: priceRes.outcomes });

  // ── fees (13): on the just-fetched price only; no price ⇒ skipped ──
  {
    const t = new Date();
    const cats = new Map<string, string | null>(
      (await query(`SELECT asin, category FROM bulk_list_asins WHERE list_id = $1 AND asin = ANY($2::text[])`, [listId, asins]))
        .rows.map((r: any) => [String(r.asin), r.category ?? null]),
    );
    const items: Array<{ asin: string; price: number; category?: string | null }> = [];
    const feeOutcomes: Record<string, string> = {};
    let skipped = 0;
    for (const asin of asins) {
      const po = priceRes.parsed.get(asin);
      const { price, isFallback } = getFeePriceForAsin({ lowestFbaPrice: po?.lowestFbaPrice ?? null, buyBoxPrice: po?.buyBoxPrice ?? null, lowestPrice: po?.lowestPrice ?? null });
      if (!po || isFallback) { skipped++; feeOutcomes[asin] = "skipped_no_price"; continue; }
      items.push({ asin, price, category: cats.get(asin) ?? null });
    }
    const feesRes = await p.runFeesPass(items, async (asin, fees) => {
      await query(
        `UPDATE bulk_list_asins SET fba_fee = $3, referral_fee = $4, fees_estimate_price = $5 WHERE list_id = $1 AND asin = $2`,
        [listId, asin, fees.fbaFulfillmentFee, fees.referralFee, fees.feesEstimatePrice],
      );
    });
    await ledger("fees", t, { counts: { ...feesRes.counts, skipped_no_price: skipped }, outcomes: { ...feeOutcomes, ...feesRes.outcomes } });
  }

  return out;
}

/** main → bulk: copy the refreshed main-table row into the list for catalog ASINs. Never the reverse. */
export async function copyMainToBulk(listId: string, asins: string[], query: QueryLike): Promise<number> {
  if (asins.length === 0) return 0;
  const r = await query(
    `UPDATE bulk_list_asins b SET
       title = COALESCE(a.title, b.title), image_url = COALESCE(a.image_url, b.image_url),
       brand = COALESCE(a.brand, b.brand), category = COALESCE(a.category, b.category),
       weight_lb = COALESCE(a.weight_lb, b.weight_lb),
       length_in = COALESCE(a.length_in, b.length_in), width_in = COALESCE(a.width_in, b.width_in), height_in = COALESCE(a.height_in, b.height_in),
       is_meltable = COALESCE(a.is_meltable, b.is_meltable), is_hazmat = COALESCE(a.is_hazmat, b.is_hazmat),
       is_dangerous_good = COALESCE(a.is_dangerous_good, b.is_dangerous_good),
       bsr = COALESCE(e.bsr, b.bsr), eligibility_status = COALESCE(e.eligibility_status, b.eligibility_status),
       sale_price = e.lowest_fba_price, sale_price_buy_box = e.buy_box_price, sale_price_lowest = e.lowest_price,
       sellers_fba = e.sellers_fba, sellers_fbm = e.sellers_fbm,
       fba_fee = e.fba_fee, referral_fee = e.referral_fee, fees_estimate_price = e.fees_estimate_price,
       fetched_at = COALESCE(e.fetched_at, b.fetched_at),
       price_outcome = CASE WHEN e.lowest_fba_price IS NOT NULL OR e.buy_box_price IS NOT NULL OR e.lowest_price IS NOT NULL THEN 'updated' ELSE b.price_outcome END,
       catalog_outcome = CASE WHEN a.title IS NOT NULL THEN 'parsed' ELSE b.catalog_outcome END
     FROM asins a LEFT JOIN asin_estimates e ON e.asin = a.asin
     WHERE b.list_id = $1 AND b.asin = a.asin AND b.asin = ANY($2::text[])`,
    [listId, asins],
  );
  return r.rowCount ?? 0;
}

export type EnqueueBulkResult =
  | { kind: "queued"; job: JobRow; ahead: number }
  | { kind: "busy"; jobId: number; status: string }
  | { kind: "empty" };

/** POST /api/bulk-lists/:id/refresh — scope 'failed' | 'all' | explicit asins. */
export async function enqueueBulkRefresh(
  listId: string,
  opts: { scope: "failed" | "all"; asins?: string[]; requestedBy?: number | null },
  query: QueryLike = defaultQuery as any,
): Promise<EnqueueBulkResult> {
  const active = (await listActive(query)).find((j) => j.target === "bulk" && j.bulk_list_id === listId);
  if (active) return { kind: "busy", jobId: active.id, status: active.status };
  const rows = (await query(`SELECT asin, fetched_at, price_outcome FROM bulk_list_asins WHERE list_id = $1 ORDER BY asin`, [listId])).rows;
  if (rows.length === 0) return { kind: "empty" };
  let scoped: any[] = rows;
  if (opts.asins && opts.asins.length > 0) {
    const want = new Set(opts.asins.map((a) => String(a).toUpperCase()));
    scoped = rows.filter((r: any) => want.has(String(r.asin)));
  } else if (opts.scope === "failed") {
    scoped = rows.filter((r: any) => r.fetched_at == null || r.price_outcome == null || !CONCLUSIVE.has(String(r.price_outcome)));
    if (scoped.length === 0) scoped = rows;
  }
  const job = await enqueueJob({
    trigger: "bulk", target: "bulk", bulkListId: listId, includeDaily: true,
    scopeAsins: scoped.map((r: any) => String(r.asin)), requestedBy: opts.requestedBy ?? null,
  }, query);
  const ahead = laneAhead(job, await listActive(query)); // lane M only — the scheduled pass never delays a bulk job
  return { kind: "queued", job, ahead };
}

export interface BulkStatus {
  jobId: number; status: string; stage: string; current: number; total: number;
  startedAt: string | Date | null; finishedAt: string | Date | null; error: string | null;
}

/** GET /api/bulk-lists/:id/refresh/status — the list's active job, else its last job if it ended in the last 60 s. */
export async function bulkRefreshStatus(listId: string, query: QueryLike = defaultQuery as any): Promise<BulkStatus | null> {
  const r = await query(
    `SELECT id, status, progress, started_at, finished_at, error FROM jobs
      WHERE target = 'bulk' AND bulk_list_id = $1
        AND (status IN ('queued','running') OR finished_at > NOW() - INTERVAL '60 seconds')
      ORDER BY (status IN ('queued','running')) DESC, queued_at DESC LIMIT 1`,
    [listId],
  );
  const j = r.rows[0];
  if (!j) return null;
  const p = (j.progress ?? {}) as { component?: number; position?: number; total?: number };
  const stage = j.status === "queued" ? "queued" : (j.status === "running" ? (p.component != null ? `component ${p.component}` : "starting") : j.status);
  return {
    jobId: Number(j.id), status: String(j.status), stage, current: p.position ?? 0, total: p.total ?? 0,
    startedAt: j.started_at ?? null, finishedAt: j.finished_at ?? null, error: j.error ?? null,
  };
}
