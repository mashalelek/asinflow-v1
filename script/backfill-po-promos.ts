// Col AK → po_promos backfill (patch po-ai-prefill §8.4 as amended 2026-10-31).
// ONE Haiku batch call over the DISTINCT non-empty promo texts (paired with
// the supplier, so the michaels.com rule can apply); high-confidence results
// are applied as po_promos rows on every PO carrying that text; low-confidence
// ones are stored with type NULL and listed in
// docs/promo-classification-review-<date>.csv for Maria. The call is logged
// in po_prefill_log (kind 'backfill'). Idempotent: a PO that already has
// po_promos rows is skipped.
//
//   npm run backfill:po-promos            # dry run: the one call runs (cents), the plan and CSVs are written, nothing inserted
//   npm run backfill:po-promos -- --live  # insert
//   npm run backfill:po-promos -- --prod [--live]   # production (script/env.ts, which also loads ANTHROPIC_API_KEY from .env.production.local)
// Needs DATABASE_URL and ANTHROPIC_API_KEY. A dry run works on a pre-075
// database (the one call runs and the CSVs are written; the call is logged
// in po_prefill_log only where the table exists).
import "./env";
import { DB_TARGET } from "./env";
import fs from "fs";
import path from "path";
import pg from "pg";
import { classifyPromos, type PromoClassifyInput } from "../server/promo-classify";
import { aiAvailable, AI_OFF_MESSAGE } from "../server/config/ai";
import { logPrefill } from "../server/po-prefill";
import { csv } from "../server/po-model-backfill";
import { promoCountsByDefault } from "../shared/po-form";

const LIVE = process.argv.includes("--live");
const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();

async function main() {
  if (!aiAvailable()) throw new Error(AI_OFF_MESSAGE);
  const url = process.env.DATABASE_URL; if (!url) throw new Error("DATABASE_URL not set");
  const c = (client = new pg.Client({ connectionString: url, ssl: /localhost|127\.0\.0\.1/.test(url) ? undefined : { rejectUnauthorized: false } }));
  await c.connect();
  const q = (sql: string, params?: any[]) => c.query(sql, params);
  const has075 = ((await q(`SELECT 1 FROM information_schema.tables WHERE table_name = 'po_promos'`)).rowCount ?? 0) > 0;
  if (!has075 && LIVE) throw new Error("migration 075 is not applied on this database — apply it first (npm run migrate), then rerun");
  if (!has075) console.log("  migration 075 is not applied here — the dry run plans against the empty post-075 state (no po_promos rows yet; the call is not logged)");
  const pos = (await q(`SELECT p.id, p.supplier, p.order_id, trim(p.promo) AS promo FROM purchase_orders p
    WHERE COALESCE(trim(p.promo), '') <> '' ${has075 ? "AND NOT EXISTS (SELECT 1 FROM po_promos x WHERE x.po_id = p.id)" : ""} ORDER BY p.order_date DESC`)).rows;
  // Distinct (text, michaels?) pairs — the michaels.com rule is the one supplier-specific rule.
  const key = (text: string, supplier: string) => `${text}\u0000${supplier.toLowerCase() === "michaels.com" ? "michaels.com" : ""}`;
  const items = new Map<string, PromoClassifyInput>();
  for (const p of pos) { const k = key(p.promo, p.supplier); if (!items.has(k)) items.set(k, { id: items.size + 1, text: p.promo, supplier: p.supplier.toLowerCase() === "michaels.com" ? "michaels.com" : null }); }
  const list = Array.from(items.values());
  console.log(`${LIVE ? "LIVE" : "DRY RUN"} · ${pos.length} PO(s) with a promo and no po_promos rows · ${list.length} distinct text(s) → one ${LIVE ? "" : "(dry-run) "}classification call`);
  const { results, usage } = await classifyPromos(list);
  const logId = has075 ? await logPrefill(q, { user_id: null, kind: "backfill", retailer: null, ...usage, error: usage.schema_ok ? null : `schema failure (stop_reason ${usage.stop_reason ?? "?"})` }) : null;
  if (!usage.schema_ok) throw new Error(`classification failed (stop_reason ${usage.stop_reason ?? "?"}, ${usage.output_tokens} output tokens) — nothing planned`);
  console.log(`  model ${usage.model} · ${usage.input_tokens} in / ${usage.output_tokens} out · ${usage.cost_estimate} · ${usage.duration_ms} ms · stop ${usage.stop_reason ?? "?"} · schema ${usage.schema_ok ? "ok" : "FAILED"} · po_prefill_log ${logId == null ? "not written (075 not applied)" : `#${logId}`}`);
  const byType: Record<string, number> = {}; let high = 0, low = 0, missing = 0;
  const review: unknown[][] = [["order_id", "supplier", "raw_text", "proposed_type", "proposed_description", "amount", "percent", "type (fill in: sale | coupon | rewards)"]];
  const plan: Array<{ po_id: string; type: string | null; description: string | null; amount: number | null; percent: number | null; confidence: string; raw: string }> = [];
  for (const p of pos) {
    const it = items.get(key(p.promo, p.supplier))!;
    const r = results.get(it.id);
    if (!r) { missing++; plan.push({ po_id: p.id, type: null, description: null, amount: null, percent: null, confidence: "low", raw: p.promo }); review.push([p.order_id, p.supplier, p.promo, "", "", "", "", ""]); continue; }
    if (r.confidence === "high") { high++; byType[r.type] = (byType[r.type] ?? 0) + 1; plan.push({ po_id: p.id, type: r.type, description: r.description, amount: r.amount, percent: r.percent, confidence: "high", raw: p.promo }); }
    else { low++; plan.push({ po_id: p.id, type: null, description: r.description, amount: r.amount, percent: r.percent, confidence: "low", raw: p.promo }); review.push([p.order_id, p.supplier, p.promo, r.type, r.description, r.amount ?? "", r.percent ?? "", ""]); }
  }
  console.log(`  applied (high confidence): ${high} PO(s) — by type ${JSON.stringify(byType)}; review (low confidence): ${low}; not returned by the model: ${missing}`);
  const outDir = arg("--out") ?? "docs";
  const f = path.join(outDir, `promo-classification-review-${today}.csv`);
  fs.writeFileSync(f, csv(review)); console.log(`  review list → ${f} (${review.length - 1} row(s))`);
  const f2 = path.join(outDir, `promo-classification-plan-${today}.csv`);
  fs.writeFileSync(f2, csv([["po_id", "raw_text", "type", "description", "amount", "percent", "confidence"], ...plan.map((x) => [x.po_id, x.raw, x.type ?? "", x.description ?? "", x.amount ?? "", x.percent ?? "", x.confidence])]));
  console.log(`  full plan → ${f2}`);
  if (!LIVE) { console.log("\nDry run — nothing inserted."); await c.end(); return; }
  await q("BEGIN");
  try {
    for (const x of plan) {
      await q(`INSERT INTO po_promos (po_id, position, type, description, amount, percent, counts_toward_cogs, raw_text, confidence, source) VALUES ($1, 0, $2, $3, $4, $5, $6, $7, $8, 'backfill')`,
        [x.po_id, x.type, x.description, x.amount, x.percent, x.type ? promoCountsByDefault(x.type) : true, x.raw, x.confidence]);
    }
    await q("COMMIT"); console.log(`\nCOMMIT — ${plan.length} po_promos row(s) inserted`);
  } catch (e) { await q("ROLLBACK").catch(() => {}); throw e; } finally { await c.end(); }
}
// An error after connect must still close the client, or the open socket
// keeps the process alive forever (the first --prod dry run, 2026-11-01).
let client: pg.Client | undefined;
main().catch((e) => { console.error("FATAL", e?.message ?? e); process.exitCode = 1; }).finally(() => client?.end().catch(() => {}));
