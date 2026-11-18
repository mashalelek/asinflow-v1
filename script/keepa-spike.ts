// Keepa spike (docs/claude_spec-patch-keepa-trends.md, commit 1) — READ-ONLY.
//
// Calls Keepa's /product for the test ASIN B08G6J2PY5 (base, +buybox, +buybox+rating), then one batch of 20
// (B08G6J2PY5 + 19 catalog ASINs) with buybox=1&rating=1, and answers S1–S6: where each series sits in the
// response, where (if anywhere) the New, FBA offer count history is, tokens per request, how monthlySoldHistory
// ends, response size / parse time, and whether the data is current without `update`.
//
// Writes nothing to any database. Reads KEEPA_API_KEY from .env (script/env.ts); the key is never printed.
// Output: a markdown report on stdout (committed as docs/keepa-spike-<date>.md) and, with --fixture <path>, the
// test ASIN's product object trimmed to the series this patch reads (public Keepa data) for the unit tests.
//
//   tsx script/keepa-spike.ts [--fixture server/__fixtures__/keepa/B08G6J2PY5.json] [--fixture-only] [--prod]
//   --fixture-only: one call for the test ASIN (4 tokens), the fixture rewritten, no report.
import "./env";
import fs from "node:fs";
import pg from "pg";

const KEY = process.env.KEEPA_API_KEY;
if (!KEY) { console.error("KEEPA_API_KEY is not set"); process.exit(1); }
const TEST_ASIN = "B08G6J2PY5";
const KEEPA_EPOCH_MIN = 21_564_000;
const toDate = (keepaMin: number) => new Date((keepaMin + KEEPA_EPOCH_MIN) * 60_000);
const ymd = (d: Date) => d.toISOString().slice(0, 10);

// Keepa's documented csv indices (Product object → csv). What the patch expects is marked.
const CSV_NAMES = [
  "AMAZON", "NEW", "USED", "SALES", "LISTPRICE", "COLLECTIBLE", "REFURBISHED", "NEW_FBM_SHIPPING", "LIGHTNING_DEAL", "WAREHOUSE",
  "NEW_FBA", "COUNT_NEW", "COUNT_USED", "COUNT_REFURBISHED", "COUNT_COLLECTIBLE", "EXTRA_INFO_UPDATES", "RATING", "COUNT_REVIEWS",
  "BUY_BOX_SHIPPING", "USED_NEW_SHIPPING", "USED_VERY_GOOD_SHIPPING", "USED_GOOD_SHIPPING", "USED_ACCEPTABLE_SHIPPING",
  "COLLECTIBLE_NEW_SHIPPING", "COLLECTIBLE_VERY_GOOD_SHIPPING", "COLLECTIBLE_GOOD_SHIPPING", "COLLECTIBLE_ACCEPTABLE_SHIPPING",
  "REFURBISHED_SHIPPING", "EBAY_NEW_SHIPPING", "EBAY_USED_SHIPPING", "TRADE_IN", "RENT", "BUY_BOX_USED_SHIPPING", "PRIME_EXCL",
];
const EXPECTED: Array<{ series: string; idx: number }> = [
  { series: "buy_box", idx: 18 }, { series: "new_price", idx: 1 }, { series: "sales_rank", idx: 3 },
  { series: "offers_new", idx: 11 }, { series: "rating_count", idx: 17 },
];

interface KeepaReply {
  tokensLeft: number; refillIn: number; refillRate: number; tokensConsumed: number; processingTimeInMs: number;
  timestamp: number; products?: any[]; error?: any;
}

async function call(params: Record<string, string>): Promise<{ reply: KeepaReply; bytes: number; httpMs: number; parseMs: number; status: number }> {
  const qs = new URLSearchParams({ key: KEY!, domain: "1", ...params });
  const t0 = performance.now();
  const res = await fetch(`https://api.keepa.com/product?${qs}`);
  const text = await res.text();
  const t1 = performance.now();
  const reply = JSON.parse(text) as KeepaReply;
  const t2 = performance.now();
  return { reply, bytes: Buffer.byteLength(text), httpMs: Math.round(t1 - t0), parseMs: Math.round((t2 - t1) * 10) / 10, status: res.status };
}

/** The last (time, value) of a change-point array; shipping triples (BUY_BOX_SHIPPING) carry price + shipping. */
function last(arr: number[] | null | undefined, stride: 2 | 3 = 2): { at: Date; value: number; extra?: number } | null {
  if (!arr || arr.length < stride) return null;
  const n = arr.length - stride;
  return { at: toDate(arr[n]), value: arr[n + 1], extra: stride === 3 ? arr[n + 2] : undefined };
}
const money = (cents: number | null | undefined) => cents == null || cents < 0 ? "—" : `$${(cents / 100).toFixed(2)}`;

function describeSeries(name: string, arr: number[] | null | undefined, stride: 2 | 3): string {
  if (!arr) return `| ${name} | absent (null) | | | |`;
  const n = arr.length / stride;
  const first = arr.length ? toDate(arr[0]) : null;
  const l = last(arr, stride);
  const negs = [] as number[]; for (let i = 1; i < arr.length; i += stride) if (arr[i] === -1) negs.push(i);
  return `| ${name} | ${n} points | ${first ? ymd(first) : "—"} → ${l ? ymd(l.at) : "—"} | last value ${l?.value}${l?.extra != null ? ` (+ shipping ${l.extra})` : ""} | ${negs.length} × -1 |`;
}

async function main() {
  const fixtureArg = process.argv.indexOf("--fixture");
  const fixturePath = fixtureArg >= 0 ? process.argv[fixtureArg + 1] : null;
  const out: string[] = [];
  const p = (s = "") => out.push(s);

  if (process.argv.includes("--fixture-only")) {
    if (!fixturePath) { console.error("--fixture-only needs --fixture <path>"); process.exit(1); }
    const r = await call({ asin: TEST_ASIN, buybox: "1", rating: "1" });
    if (!r.reply.products?.[0]) { console.error(`no product (HTTP ${r.status})`); process.exit(1); }
    writeFixture(fixturePath, r.reply.products[0], r.reply);
    console.log(`fixture written: ${fixturePath} (${fs.statSync(fixturePath).size.toLocaleString()} bytes; tokensConsumed ${r.reply.tokensConsumed}, tokensLeft ${r.reply.tokensLeft})`);
    return;
  }

  // 19 more ASINs from the catalog (active, oldest first — a stable pick).
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const others = (await pool.query(`SELECT asin FROM asins WHERE status = 'active' AND asin <> $1 ORDER BY added_at, asin LIMIT 19`, [TEST_ASIN])).rows.map((r) => String(r.asin));
  await pool.end();
  const batch = [TEST_ASIN, ...others];

  p(`# Keepa spike — ${ymd(new Date())}`);
  p();
  p(`Read-only run of \`tsx script/keepa-spike.ts\` against the Keepa API (Starter plan). Test ASIN ${TEST_ASIN} plus ${others.length} catalog ASINs. Nothing was written to any database; the key is not in this file.`);
  p();

  // S3 / S6: single-ASIN cost ladder.
  p(`## Requests and tokens (S3)`);
  p();
  p(`| Request | HTTP | tokensConsumed | tokensLeft after | refillIn (ms) | refillRate | bytes | http ms | parse ms |`);
  p(`|---|---|---|---|---|---|---|---|---|`);
  const ladder: Array<[string, Record<string, string>]> = [
    ["1 ASIN, base", { asin: TEST_ASIN }],
    ["1 ASIN, +buybox", { asin: TEST_ASIN, buybox: "1" }],
    ["1 ASIN, +buybox +rating", { asin: TEST_ASIN, buybox: "1", rating: "1" }],
  ];
  let single: any = null;
  for (const [label, params] of ladder) {
    const r = await call(params);
    p(`| ${label} | ${r.status} | ${r.reply.tokensConsumed} | ${r.reply.tokensLeft} | ${r.reply.refillIn} | ${r.reply.refillRate} | ${r.bytes.toLocaleString()} | ${r.httpMs} | ${r.parseMs} |`);
    if (r.reply.error) p(`| | error: ${JSON.stringify(r.reply.error)} | | | | | | | |`);
    if (params.rating) single = r.reply.products?.[0] ?? null;
    await new Promise((res) => setTimeout(res, 1500));
  }
  const b = await call({ asin: batch.join(","), buybox: "1", rating: "1" });
  p(`| ${batch.length} ASINs, +buybox +rating | ${b.status} | ${b.reply.tokensConsumed} | ${b.reply.tokensLeft} | ${b.reply.refillIn} | ${b.reply.refillRate} | ${b.bytes.toLocaleString()} | ${b.httpMs} | ${b.parseMs} |`);
  if (b.reply.error) p(`| | error: ${JSON.stringify(b.reply.error)} | | | | | | | |`);
  p();
  const perAsin = b.reply.tokensConsumed / batch.length;
  p(`Per ASIN in the batch: **${perAsin.toFixed(2)} tokens**. Products returned: ${b.reply.products?.length ?? 0} of ${batch.length}.`);
  p();

  if (!single) { p(`No product object for ${TEST_ASIN} — stop.`); console.log(out.join("\n")); return; }

  // S1: where each series sits.
  p(`## Series positions for ${TEST_ASIN} (S1)`);
  p();
  p(`Top-level keys: ${Object.keys(single).sort().join(", ")}`);
  p();
  p(`\`lastUpdate\` = ${single.lastUpdate} → ${toDate(single.lastUpdate).toISOString()}; \`lastPriceChange\` → ${single.lastPriceChange ? toDate(single.lastPriceChange).toISOString() : "—"}; \`lastRatingUpdate\` → ${single.lastRatingUpdate ? toDate(single.lastRatingUpdate).toISOString() : "—"}; \`trackingSince\` → ${single.trackingSince ? toDate(single.trackingSince).toISOString() : "—"}`);
  p();
  p(`| csv index | Keepa name | points | span | last | -1 count |`);
  p(`|---|---|---|---|---|---|`);
  const csv: Array<number[] | null> = single.csv ?? [];
  for (let i = 0; i < Math.max(csv.length, CSV_NAMES.length); i++) {
    const stride: 2 | 3 = CSV_NAMES[i]?.endsWith("SHIPPING") ? 3 : 2;
    p(describeSeries(`${i} ${CSV_NAMES[i] ?? "?"}`, csv[i], stride));
  }
  p();
  p(`### Current values vs Keepa's chart (reference 2026-11-18: Buy Box $25.31 · New $25.28 · Sales Rank #175,887 · Rating Count 222 · New offers 7 · New, FBA 3)`);
  p();
  const bb = last(csv[18], 3), nw = last(csv[1]), sr = last(csv[3]), cn = last(csv[11]), rc = last(csv[17]);
  p(`- buy_box csv[18]: price ${money(bb?.value)} + shipping ${money(bb?.extra)} (at ${bb ? bb.at.toISOString() : "—"})`);
  p(`- new_price csv[1]: ${money(nw?.value)} (at ${nw ? nw.at.toISOString() : "—"})`);
  p(`- sales_rank csv[3]: ${sr?.value == null ? "—" : `#${sr.value.toLocaleString()}`} (at ${sr ? sr.at.toISOString() : "—"})`);
  p(`- offers_new csv[11]: ${cn?.value ?? "—"} (at ${cn ? cn.at.toISOString() : "—"})`);
  p(`- rating_count csv[17]: ${rc?.value ?? "—"} (at ${rc ? rc.at.toISOString() : "—"})`);
  p(`- monthlySold (current field): ${single.monthlySold ?? "—"}`);
  p(`- stats present: ${single.stats ? "yes" : "no (no \`stats\` parameter sent)"}`);
  p();

  // S2: New, FBA offer count.
  p(`## New, FBA offer count (S2)`);
  p();
  const fbaKeys = Object.keys(single).filter((k) => /fba/i.test(k));
  p(`Keys mentioning FBA: ${fbaKeys.length ? fbaKeys.map((k) => `\`${k}\` (${Array.isArray(single[k]) ? `array[${single[k].length}]` : typeof single[k]})`).join(", ") : "none"}.`);
  p(`\`offers\` in the response: ${single.offers == null ? "absent (not requested)" : `array[${single.offers.length}]`}. csv[10] NEW_FBA is a PRICE series (lowest new FBA offer), not a count.`);
  p();

  // S4: monthlySoldHistory.
  p(`## monthlySoldHistory (S4)`);
  p();
  const msh: number[] | null = single.monthlySoldHistory ?? null;
  if (!msh) p(`absent.`);
  else {
    p(`${msh.length / 2} change points. Every point:`);
    p();
    p(`| at | value |`); p(`|---|---|`);
    for (let i = 0; i < msh.length; i += 2) p(`| ${toDate(msh[i]).toISOString()} | ${msh[i + 1]} |`);
  }
  p();

  // S5: batch payload.
  p(`## Batch payload (S5)`);
  p();
  p(`${batch.length} ASINs: ${(b.bytes / 1024 / 1024).toFixed(2)} MB, HTTP ${b.httpMs} ms (Keepa processingTimeInMs ${b.reply.processingTimeInMs}), JSON.parse ${b.parseMs} ms. Rule: halve the batch above 30 MB or 10 s — ${b.bytes > 30 * 1024 * 1024 || b.httpMs > 10_000 ? "EXCEEDED" : "within bounds"}.`);
  p();
  p(`| ASIN | present | lastUpdate | csv indices present | monthlySoldHistory |`);
  p(`|---|---|---|---|---|`);
  const byAsin = new Map<string, any>((b.reply.products ?? []).map((x: any) => [x.asin, x]));
  for (const a of batch) {
    const x = byAsin.get(a);
    if (!x) { p(`| ${a} | no | | | |`); continue; }
    const present = (x.csv ?? []).map((s: any, i: number) => (s ? i : null)).filter((i: any) => i != null);
    p(`| ${a} | yes | ${x.lastUpdate ? ymd(toDate(x.lastUpdate)) : "—"} | ${present.join(" ")} | ${x.monthlySoldHistory ? `${x.monthlySoldHistory.length / 2} points` : "—"} |`);
  }
  p();

  // S6: freshness.
  p(`## Freshness without \`update\` (S6)`);
  p();
  const ages = (b.reply.products ?? []).map((x: any) => (Date.now() - toDate(x.lastUpdate).getTime()) / 3_600_000);
  const stale = ages.filter((h: number) => h > 24).length;
  p(`lastUpdate age across the batch: min ${Math.min(...ages).toFixed(1)} h, median ${ages.sort((a: number, c: number) => a - c)[Math.floor(ages.length / 2)]?.toFixed(1)} h, max ${Math.max(...ages).toFixed(1)} h; ${stale} of ${ages.length} older than a day.`);
  p();

  if (fixturePath) {
    writeFixture(fixturePath, single, b.reply);
    p(`Fixture written: ${fixturePath} (${fs.statSync(fixturePath).size.toLocaleString()} bytes).`);
  }
  console.log(out.join("\n"));
}

/** The test ASIN's product trimmed to what the trend columns read: csv 1 / 3 / 11 / 17 / 18 / 34 / 35 (+10), monthlySoldHistory, the stamps. */
function writeFixture(path: string, single: any, reply: KeepaReply): void {
  const csv: Array<number[] | null> = single.csv ?? [];
  const keep: any = {
    asin: single.asin, domainId: single.domainId, lastUpdate: single.lastUpdate, lastPriceChange: single.lastPriceChange,
    lastRatingUpdate: single.lastRatingUpdate, trackingSince: single.trackingSince, monthlySold: single.monthlySold ?? null,
    monthlySoldHistory: single.monthlySoldHistory ?? null,
    csv: csv.map((s, i) => ([1, 3, 10, 11, 17, 18, 34, 35].includes(i) ? s : null)),
  };
  fs.mkdirSync(path.replace(/\/[^/]+$/, ""), { recursive: true });
  fs.writeFileSync(path, JSON.stringify({ _note: `Keepa /product for ${TEST_ASIN}, domain 1, buybox=1&rating=1, fetched ${new Date().toISOString()}; trimmed to the series the trend columns read (csv 1, 3, 10, 11, 17, 18, 34 COUNT_NEW_FBA, 35 COUNT_NEW_FBM; monthlySoldHistory). Public catalog data.`, tokensLeft: reply.tokensLeft, refillIn: reply.refillIn, refillRate: reply.refillRate, products: [keep] }, null, 0));
}

main().catch((err) => { console.error(err?.message ?? err); process.exit(1); });
