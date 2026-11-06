// The ASIN pack review backfill (Maria 2026-11-06, migration 098): every ASIN's pack decided from its evidence —
// confirmed by (a) PO lines that agree or (b) Velocity, when they don't contradict; otherwise needs review with the
// reason and a suggestion (catalog item_package_quantity, the title, the AI's image count, an earlier unreviewed value),
// each only when it reproduces the ASIN's past PO quantities. A pack Maria set herself is never re-decided. A
// confirmed pack fills the ASIN's PO rows with no pack (open rows always, closed only where it reproduces).
//   tsx script/asin-pack-review.ts [--prod] [--live] [--catalog] [--ai] [--asins A,B] [--csv <path>]
// Dry run by default: everything runs inside one transaction and is rolled back. --catalog reads Amazon's catalog
// (SP-API GET, read only) for the ASINs with nothing from (a)/(b); --ai reads the main image + title for those same
// ASINs — the dry run prints the estimated cost and calls nothing, --live makes the calls (each logged, kind pack_review).
import "./env";
import { Pool } from "pg";
import { writeFileSync } from "fs";
import { applyPackDecision, decideFromEvidence, loadPackEvidence, packFitsHistory, packFromUnits, packLabel, suggestPack, type AiPack, type CatalogPack, type PackDecision } from "../server/asin-pack-review";
import { aiPackSuggestion, allowedPackUnits } from "../server/asin-pack-ai";
import { catalogItem } from "../server/asin-amazon-search";
import { aiAvailable, estimateCost } from "../server/config/ai";

const arg = (k: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : undefined; };
const live = process.argv.includes("--live"), useCatalog = process.argv.includes("--catalog"), useAi = process.argv.includes("--ai");
const only = arg("--asins")?.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
const csvPath = arg("--csv");
// One image (~1,600 tokens) + the prompt and system (~700) in, ~150 out — the estimate before any call.
const AI_EST = { input: 2300, output: 150 };

async function pool<T, R>(items: T[], n: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } }));
  return out;
}

(async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: /render\.com/.test(process.env.DATABASE_URL ?? "") ? { rejectUnauthorized: false } : undefined });
  const client = await db.connect();
  const query = (sql: string, params?: any[]) => client.query(sql, params);
  try {
    const evs = await loadPackEvidence(query, only);
    const images = new Map<string, string | null>((await query(`SELECT asin, image_url FROM asins${only ? ` WHERE asin = ANY($1::text[])` : ""}`, only ? [only] : [])).rows.map((r: any) => [r.asin, r.image_url]));
    const first = evs.map((ev) => ({ ev, d: decideFromEvidence(ev) }));
    const open = first.filter((x) => x.d == null);
    console.log(`${evs.length} ASINs: ${first.filter((x) => x.d?.kind === "mine").length} set by Maria (kept), ${first.filter((x) => x.d && x.d.kind !== "mine").length} decided by PO lines / Velocity, ${open.length} with nothing from either`);

    const catalog = new Map<string, CatalogPack | null>();
    if (useCatalog) {
      let done = 0;
      await pool(open, 2, async ({ ev }) => {
        const hit = await catalogItem(ev.asin);
        catalog.set(ev.asin, hit ? { item_package_quantity: hit.pack ?? null, number_of_items: hit.items ?? null } : null);
        if (++done % 200 === 0) console.log(`  catalog ${done}/${open.length}`);
        await new Promise((r) => setTimeout(r, 1000));
      });
      console.log(`catalog: ${Array.from(catalog.values()).filter((c) => c?.item_package_quantity != null).length} of ${open.length} have item_package_quantity`);
    }

    const ai = new Map<string, AiPack | null>();
    if (useAi) {
      const est = open.length * estimateCost(AI_EST.input, AI_EST.output);
      console.log(`AI: ${open.length} ASINs (${open.filter(({ ev }) => images.get(ev.asin)).length} with an image), estimated $${est.toFixed(2)}`);
      if (live) {
        if (!aiAvailable()) throw new Error("ANTHROPIC_API_KEY is not set — the AI stage is off");
        let cost = 0, done = 0;
        await pool(open, 4, async ({ ev }) => {
          const hist = ev.rows.some((r) => r.lines.length > 0 && r.qty > 0);
          const r = await aiPackSuggestion(query, { asin: ev.asin, title: ev.title, image_url: images.get(ev.asin) ?? null, catalog: catalog.get(ev.asin) ?? null,
            allowed: allowedPackUnits((u) => packFitsHistory(ev.rows, packFromUnits(u)), hist) });
          ai.set(ev.asin, r.result); cost += r.cost;
          if (++done % 100 === 0) console.log(`  AI ${done}/${open.length}, $${cost.toFixed(2)} so far`);
        });
        console.log(`AI: ${Array.from(ai.values()).filter((a) => a?.sold_as).length} suggestions, actual cost $${cost.toFixed(2)}`);
      }
    }

    await query("BEGIN");
    const counts: Record<string, number> = {};
    const bump = (k: string, n = 1) => { counts[k] = (counts[k] ?? 0) + n; };
    const gaps = { openRows: 0, closedRows: 0, closedSkipped: 0, lines: 0 };
    const csv: string[] = ["asin,status,reason,pack,source,on_po,was_on_record,note"];
    for (const { ev, d: d0 } of first) {
      const d: PackDecision = d0 ?? suggestPack(ev, catalog.get(ev.asin) ?? null, ai.get(ev.asin) ?? null);
      if (d.kind === "mine") { bump("mine"); continue; }
      const res = await applyPackDecision(query, ev.asin, d, null);
      gaps.openRows += res.gaps.openRows; gaps.closedRows += res.gaps.closedRows; gaps.closedSkipped += res.gaps.closedSkipped; gaps.lines += res.gaps.lines;
      if (d.kind === "confirmed") {
        bump(`confirmed ${d.source}`);
        bump(res.recordChanged ? (ev.record ? "confirmed: record changed" : "confirmed: record was empty") : "confirmed: record already so");
        if (res.recordChanged && ev.record) csv.push([ev.asin, "confirmed, record changed", d.source, packLabel(d.pack), d.source, ev.rows.length > 0 ? "yes" : "", packLabel(ev.record), `"${d.note.replace(/"/g, '""')}"`].join(","));
      } else {
        bump(`review ${d.reason}`);
        if (d.suggestionSource) bump(`  suggested by ${d.suggestionSource}`);
        if (res.demoted) bump("review: unreviewed record moved to a suggestion");
        const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
        csv.push([ev.asin, d.suggestion ? "needs review" : d.reason === "nothing" ? "missing" : "needs review", d.reason, d.suggestion ? packLabel(d.suggestion) : "", d.suggestionSource ?? "", ev.rows.length > 0 ? "yes" : "", ev.record ? packLabel(ev.record) : "", q(d.note)].join(","));
      }
    }
    const pad = (k: string) => k.padEnd(52);
    for (const k of Object.keys(counts).sort()) console.log(`${pad(k)} ${counts[k]}`);
    console.log(`${pad("PO pack-size gaps closed: open rows")} ${gaps.openRows}`);
    console.log(`${pad("PO pack-size gaps closed: closed rows")} ${gaps.closedRows}`);
    console.log(`${pad("closed rows left (the pack doesn't reproduce)")} ${gaps.closedSkipped}`);
    console.log(`${pad("lines given pack integers")} ${gaps.lines}`);
    const missingPos = (await query(`SELECT count(*) n FROM po_asins pa JOIN purchase_orders p ON p.id = pa.po_id WHERE pa.sold_as IS NULL AND p.closed_at IS NULL`)).rows[0].n;
    console.log(`${pad("open PO rows still without a pack afterwards")} ${missingPos}`);
    if (csvPath) { writeFileSync(csvPath, csv.join("\n") + "\n"); console.log(`needs review / missing list: ${csvPath} (${csv.length - 1} rows)`); }
    if (!live) { await query("ROLLBACK"); console.log("dry run — rolled back; add --live to write"); return; }
    await query("COMMIT");
    console.log("written");
  } catch (e) { await query("ROLLBACK").catch(() => {}); throw e; } finally { client.release(); await db.end(); }
})().catch((e) => { console.error(e.message); process.exit(1); });
