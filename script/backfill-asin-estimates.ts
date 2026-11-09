// asin_estimates rows for ASINs that have none (Maria 2026-11-09 — the $16 regression, 2026-11-06 → 11-09).
//   npm run backfill:asin-estimates                     # dry run on the local DB: the blast-radius report + the plan
//   npm run backfill:asin-estimates -- --prod           # the same against production (read-only)
//   npm run backfill:asin-estimates -- --prod --live    # create the rows the way the fixed insert path does, then ONE manual Refresh job for exactly them
//   --since <ISO>  the deploy instant the report measures from (default 2026-11-06T11:19:00Z, migration 095 applied)
// Each row is written through server/asin-upsert.ts (insert-only, one transaction per ASIN, both rows checked), with
// estimated_cogs from the sourcing sheet row that brought the ASIN in (ER col M for an ER lead, else the Master sheet's
// cost; NULL when none — never a synthetic 0, so the 'csv' source is cleared with it). Reusable: a run with nothing
// missing prints the report and exits.
import "./env";
import pool from "../server/db";
import { fetchErLeadsSheet } from "../server/er-leads-sheet";
import { fetchSourcingSheet } from "../server/sourcing-sheet";
import { upsertAsinResult } from "../server/asin-upsert";
import { enqueueJob } from "../server/scheduler/jobs-repo";
import { howItGotIn, sheetCostFor, blankOnboardingResult, MISSING_ROWS_SQL, type MissingRow } from "../server/asin-estimates-backfill";

const live = process.argv.includes("--live");
const argOf = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const since = argOf("since") ?? "2026-11-06T11:19:00Z";
const q = (sql: string, params?: any[]) => pool.query(sql, params) as any;
const et = (d: any) => (d ? new Date(d).toLocaleString("en-US", { timeZone: "America/New_York", hour12: false }) : "—");

async function main() {
  console.log(`backfill:asin-estimates ${live ? "LIVE" : "dry run"} · report since ${since}`);

  // ── 1. The blast radius: asins rows with no estimates row, any status, any added_at ──
  const missing = (await q(MISSING_ROWS_SQL)).rows as MissingRow[];
  console.log(`\nASINs with an asins row and NO asin_estimates row: ${missing.length}`);
  const byHow = new Map<string, number>();
  for (const r of missing) byHow.set(howItGotIn(r), (byHow.get(howItGotIn(r)) ?? 0) + 1);
  for (const [how, n] of byHow) console.log(`  ${String(n).padStart(4)}  ${how}`);
  for (const r of missing) console.log(`  ${r.asin}  ${r.status.padEnd(6)}  ${(r.lead_source ?? "—").padEnd(4)}  added ${et(r.added_at)}  ${(r.title ?? "").slice(0, 48)}`);

  // ── 2. Other writes the failing statement could have lost since the deploy ──
  // Who ran the insert / Analyze upsert since then: onboarding jobs (every insert path enqueues one), and the two
  // components that onboard on their own (sales, SC discovery). runAnalyzeCore — the non-insert-only upsert — has no
  // writing caller since scheduler v1 (its only call is the Product Info dry run with a no-op sink).
  const jobs = (await q(
    `SELECT j.id, j.trigger, ${"j.queued_at"}, cardinality(j.scope_asins) AS n,
            -- an ASIN that existed BEFORE the job (an upload naming a known ASIN): its notes append / uploaded pack were lost
            -- with the failing statement. ER leads are excluded — the ER leg sets added_at to the sheet's lead date, not the insert time.
            (SELECT count(*) FROM unnest(j.scope_asins) s JOIN asins a ON a.asin = s WHERE a.lead_source IS DISTINCT FROM 'ER' AND a.added_at < j.queued_at - interval '2 minutes')::int AS already_existed,
            (SELECT count(*) FROM unnest(j.scope_asins) s JOIN asins a ON a.asin = s WHERE a.lead_source = 'ER')::int AS er_leads
       FROM jobs j WHERE j.trigger = 'onboarding' AND j.queued_at >= $1::timestamptz ORDER BY j.id`, [since])).rows;
  console.log(`\nOnboarding jobs since ${since}: ${jobs.length}`);
  for (const j of jobs) console.log(`  #${j.id}  ${et(j.queued_at)}  ${j.n} ASIN(s) · ${j.er_leads} ER lead(s) · ${j.already_existed} existed before the job (non-ER; such an ASIN's notes append / uploaded pack were lost with the failing statement)`);
  const sales = (await q(
    `SELECT r.job_id, r.started_at, r.counts->>'onboarded_from_sales' AS onboarded FROM refresh_runs r
      WHERE r.stage = '19_sales' AND r.started_at >= $1::timestamptz AND COALESCE((r.counts->>'onboarded_from_sales')::int, 0) > 0 ORDER BY r.started_at`, [since])).rows;
  console.log(`Sales passes that onboarded ASINs since then: ${sales.length}${sales.length ? " — " + sales.map((s: any) => `#${s.job_id}: ${s.onboarded}`).join(", ") : ""}`);
  const sc = (await q(
    `SELECT r.job_id, r.started_at, (SELECT count(*) FROM jsonb_each_text(r.outcomes) o WHERE o.value = 'onboarded')::int AS onboarded FROM refresh_runs r
      WHERE r.stage = '01_sc_discovery' AND r.started_at >= $1::timestamptz AND r.outcomes IS NOT NULL ORDER BY r.started_at`, [since])).rows.filter((r: any) => r.onboarded > 0);
  console.log(`SC-discovery passes that onboarded ASINs since then: ${sc.length}${sc.length ? " — " + sc.map((s: any) => `#${s.job_id}: ${s.onboarded}`).join(", ") : ""}`);
  const legacy = (await q(`SELECT trigger, count(*)::int AS n FROM refresh_runs WHERE job_id IS NULL AND started_at >= $1::timestamptz GROUP BY 1`, [since])).rows;
  console.log(`Ledger rows outside a job since then (a direct Analyze would leave one): ${legacy.length ? legacy.map((l: any) => `${l.trigger} ${l.n}`).join(", ") : "none"}`);

  if (missing.length === 0) { console.log("\nnothing to backfill"); await pool.end(); return; }

  // ── 3. The plan: the sheet's COGS for each missing ASIN ──
  const erId = process.env.ER_LEADS_SHEET_ID, masterId = process.env.SOURCING_SHEET_ID;
  const er = erId ? (await fetchErLeadsSheet(erId)).rows.map((r) => ({ asin: r.asin, cogs: r.cogs })) : [];
  const master = masterId ? (await fetchSourcingSheet(masterId)).map((r) => ({ asin: r.asin.toUpperCase(), cogs: r.cogs })) : [];
  if (!erId) console.log("ER_LEADS_SHEET_ID not set — ER costs unavailable");
  if (!masterId) console.log("SOURCING_SHEET_ID not set — Master costs unavailable");
  const plan = missing.map((r) => ({ ...r, cost: sheetCostFor(r.asin, r.lead_source, { er, master }) }));
  console.log(`\nPlan — insert ${plan.length} asin_estimates row(s) the way the fixed insert path does, then ONE manual Refresh job for exactly them:`);
  for (const p of plan) console.log(`  ${p.asin}  est. COGS ${p.cost.cogs == null ? "NULL (no sheet cost)" : `$${p.cost.cogs.toFixed(2)} (${p.cost.from} sheet)`}`);
  console.log(`  with a sheet cost: ${plan.filter((p) => p.cost.cogs != null).length} · without: ${plan.filter((p) => p.cost.cogs == null).length}`);

  if (!live) { console.log("\ndry run — nothing written, no job enqueued"); await pool.end(); return; }

  // ── 4. Live: one transaction per ASIN, both rows checked, then the job ──
  const done: string[] = [], failed: string[] = [];
  for (const p of plan) {
    const client = await pool.connect();
    const cq = (sql: string, params?: any[]) => client.query(sql, params) as any;
    try {
      await client.query("BEGIN");
      await upsertAsinResult(cq, blankOnboardingResult(p.asin, p.cost.cogs), null, null, null, true);
      if (p.cost.cogs == null) await cq(`UPDATE asin_estimates SET estimated_cogs_source = NULL WHERE asin = $1 AND estimated_cogs IS NULL AND estimated_cogs_source = 'csv'`, [p.asin]);
      const both = await cq(`SELECT (SELECT count(*) FROM asins WHERE asin = $1)::int AS a, (SELECT count(*) FROM asin_estimates WHERE asin = $1)::int AS e`, [p.asin]);
      if (Number(both.rows[0]?.a) !== 1 || Number(both.rows[0]?.e) !== 1) throw new Error(`rows after insert: asins ${both.rows[0]?.a}, asin_estimates ${both.rows[0]?.e}`);
      await client.query("COMMIT");
      done.push(p.asin);
    } catch (err: any) {
      await client.query("ROLLBACK").catch(() => {});
      failed.push(p.asin);
      console.log(`  ${p.asin}  FAILED: ${err?.message ?? err}`);
    } finally { client.release(); }
  }
  console.log(`\nLIVE — estimates rows created: ${done.length}${failed.length ? `, failed: ${failed.length} (${failed.join(", ")})` : ""}`);
  if (done.length) {
    const job = await enqueueJob({ trigger: "manual", includeDaily: true, scopeAsins: done }, q);
    console.log(`Refresh job #${job.id} queued (manual, daily block included) for ${done.length} ASIN(s) — watch it in the jobs dialog`);
  }
  const left = (await q(`SELECT count(*)::int AS n FROM asins a WHERE NOT EXISTS (SELECT 1 FROM asin_estimates e WHERE e.asin = a.asin)`)).rows[0].n;
  console.log(`asins rows still without an estimates row: ${left}`);
  await pool.end();
}
main().catch(async (e) => { console.error(e?.message ?? e); await pool.end().catch(() => {}); process.exit(1); });
