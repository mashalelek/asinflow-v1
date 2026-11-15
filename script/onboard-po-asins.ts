// PO'd ASINs AF never onboarded (Maria 2026-11-14): the sheet-era POs name ASINs that have no `asins` row, so every
// per-ASIN write (component 9's Actual COGS first) matched no row — 17 of them failed every hourly pass as
// "no asin_estimates row". This script lists them, looks each up in Amazon's catalog (--check), and with --live gives
// the real ones their rows through the normal onboarding path: the insert-only write of server/asin-upsert.ts (both
// rows in one transaction, as the fixed insert path and backfill:asin-estimates do), then ONE onboarding Refresh job
// for exactly them (the same job "Not in AF — Add to AF" enqueues), then the scoped cost sync so Actual COGS follows
// their POs at once. Rows whose `asin` is not an ASIN at all ("no ASIN yet", shared/asin.ts) are listed and never
// onboarded. Dead or mistyped ASINs (catalog 404) are listed and skipped unless named in --asins.
//
//   npm run onboard:po-asins                                  # dry run, local DB: the list
//   npm run onboard:po-asins -- --prod --check                # production, read-only, with the catalog verdicts
//   npm run onboard:po-asins -- --prod --live [--asins A,B]   # onboard the real ones (or exactly the ASINs named)
import "./env";
import pool from "../server/db";
import { upsertAsinResult } from "../server/asin-upsert";
import { blankOnboardingResult } from "../server/asin-estimates-backfill";
import { enqueueOnboardingJob } from "../server/scheduler/jobs-repo";
import { syncAsinCostsFromPos } from "../server/asin-po-costs";
import { IS_ASIN_SQL, NO_ASIN_SQL, isValidAsin } from "../shared/asin";

const live = process.argv.includes("--live");
const check = process.argv.includes("--check") || live;
const argOf = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const only = (argOf("asins") ?? "").split(/[,\s]+/).map((a) => a.trim().toUpperCase()).filter(Boolean);
const q = (sql: string, params?: any[]) => pool.query(sql, params) as any;

interface Row { asin: string; po_rows: number; pos: string; names: string | null }
const LIST_SQL = (where: string) => `
  SELECT pa.asin, count(*)::int AS po_rows,
         string_agg(p.order_id || ' ' || p.supplier || ' ' || p.order_date::date || ' ' || p.source, ' | ' ORDER BY p.order_date) AS pos,
         string_agg(DISTINCT coalesce(pa.asin_name, (SELECT l.product_name FROM po_line_items l WHERE l.po_asin_id = pa.id LIMIT 1)), ' / ') AS names
    FROM po_asins pa JOIN purchase_orders p ON p.id = pa.po_id
   WHERE ${where}
   GROUP BY pa.asin ORDER BY pa.asin`;

async function catalogVerdict(asin: string): Promise<{ ok: boolean; title: string | null; why: string }> {
  const { spApiGet } = await import("../server/spapi-auth");
  try {
    const r: any = await spApiGet(`/catalog/2022-04-01/items/${asin}`, { marketplaceIds: "ATVPDKIKX0DER", includedData: "summaries" });
    return { ok: true, title: r?.summaries?.[0]?.itemName ?? null, why: "in the catalog" };
  } catch (e: any) {
    const st = e?.response?.status;
    return { ok: false, title: null, why: st === 404 ? "not in Amazon's catalog (dead or mistyped)" : `catalog lookup failed (HTTP ${st ?? "?"})` };
  }
}

async function main() {
  console.log(`onboard:po-asins ${live ? "LIVE" : "dry run"}${check ? " · catalog check" : ""}${only.length ? ` · only ${only.join(", ")}` : ""}`);
  const noAsin = (await q(LIST_SQL(NO_ASIN_SQL("pa.asin")))).rows as Row[];
  console.log(`\nPO rows with no ASIN yet (never onboarded, never an error): ${noAsin.length}`);
  for (const r of noAsin) console.log(`  ${r.asin.padEnd(12)} ${r.pos}  — ${(r.names ?? "").slice(0, 60)}`);

  const missing = (await q(LIST_SQL(`${IS_ASIN_SQL("pa.asin")} AND NOT EXISTS (SELECT 1 FROM asins a WHERE a.asin = pa.asin)`))).rows as Row[];
  console.log(`\nPO'd ASINs with no asins row: ${missing.length}`);
  const verdicts = new Map<string, Awaited<ReturnType<typeof catalogVerdict>>>();
  for (const r of missing) {
    const v = check ? await catalogVerdict(r.asin) : null;
    if (v) verdicts.set(r.asin, v);
    console.log(`  ${r.asin}  ${r.po_rows} PO row(s)  ${r.pos}  — ${(r.names ?? "").slice(0, 50)}${v ? `\n              → ${v.ok ? "REAL" : "SKIP"}: ${v.why}${v.title ? ` · ${v.title.slice(0, 60)}` : ""}` : ""}`);
  }
  const wanted = only.length
    ? only.filter((a) => { if (!isValidAsin(a)) { console.log(`  ${a}: not an ASIN — ignored`); return false; } return true; })
    : missing.filter((r) => verdicts.get(r.asin)?.ok).map((r) => r.asin);
  console.log(`\nTo onboard: ${wanted.length}${wanted.length ? ` — ${wanted.join(", ")}` : ""}`);
  if (!live) { console.log("dry run — nothing written, no job enqueued"); await pool.end(); return; }

  const done: string[] = [], failed: string[] = [];
  for (const asin of wanted) {
    const client = await pool.connect();
    const cq = (sql: string, params?: any[]) => client.query(sql, params) as any;
    try {
      await client.query("BEGIN");
      await upsertAsinResult(cq, blankOnboardingResult(asin, null), null, null, null, true);
      await cq(`UPDATE asin_estimates SET estimated_cogs_source = NULL WHERE asin = $1 AND estimated_cogs IS NULL AND estimated_cogs_source = 'csv'`, [asin]);
      const both = await cq(`SELECT (SELECT count(*) FROM asins WHERE asin = $1)::int AS a, (SELECT count(*) FROM asin_estimates WHERE asin = $1)::int AS e`, [asin]);
      if (Number(both.rows[0]?.a) !== 1 || Number(both.rows[0]?.e) !== 1) throw new Error(`rows after insert: asins ${both.rows[0]?.a}, asin_estimates ${both.rows[0]?.e}`);
      await client.query("COMMIT");
      done.push(asin);
    } catch (err: any) {
      await client.query("ROLLBACK").catch(() => {});
      failed.push(asin);
      console.log(`  ${asin}  FAILED: ${err?.message ?? err}`);
    } finally { client.release(); }
  }
  console.log(`\nLIVE — onboarded: ${done.length}${failed.length ? `, failed: ${failed.length} (${failed.join(", ")})` : ""}`);
  if (done.length) {
    const r = await enqueueOnboardingJob(done, {}, q);
    console.log(r.job ? `Onboarding job #${r.job.id} queued for ${r.enqueued.length} ASIN(s)` : `No new job: ${r.duplicateOf ? `duplicate of #${r.duplicateOf}` : `${r.covered.length} already covered by an active onboarding job`}`);
    const cost = await syncAsinCostsFromPos(q, new Set(done));
    console.log(`Actual COGS from their POs: ${cost.updated} updated${cost.errors.length ? `, errors: ${cost.errors.join("; ")}` : ""}`);
  }
  const left = (await q(LIST_SQL(`${IS_ASIN_SQL("pa.asin")} AND NOT EXISTS (SELECT 1 FROM asins a WHERE a.asin = pa.asin)`))).rows.length;
  console.log(`PO'd ASINs still without an asins row: ${left}`);
  await pool.end();
}
main().catch(async (e) => { console.error(e?.message ?? e); await pool.end().catch(() => {}); process.exit(1); });
