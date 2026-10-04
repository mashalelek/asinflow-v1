// ONE-TIME BACKFILL (2026-10-03) — set max_order_quantity on offers that
// predate the 2026-09-13 always-present attribute (SPEC §18 "Always-present
// offer attributes").
//
// NOT a migration and NOT a feature. It writes nothing to AF data: no asins,
// asin_skus, asin_estimates, or brand_product_registry. The only writes it
// can ever make are PATCHes to Amazon listings, and only with --live.
//
// The cap tiers are NOT re-implemented here. resolveMaxOrderQuantity is
// imported from server/offer-add.ts, so this backfill and the live offer-add
// path can never disagree: <= $20 -> 6, > $20 -> 4, unknown -> 4.
//
// SKU universe comes from AMAZON, not asin_skus: asin_skus retains deleted
// SKUs, and Seller Central can hold SKUs AF never created. The source is the
// GET_MERCHANT_LISTINGS_ALL_DATA report, which lists every SKU in the account
// including inactive/closed ones — a closed listing gets the cap now so it is
// already correct if it is ever reopened.
//
//   Phase 1 (default):  npx tsx script/backfill-max-order-quantity.ts
//   Phase 2 (writes):   npx tsx script/backfill-max-order-quantity.ts --live
//
// --live is REQUIRED to write; there is no default that writes (§14, no
// fail-open defaults).
//
// SCOPE IS PERMANENTLY bucket (a): SKUs with NO cap at all. Maria's decision
// 2026-10-04 — "I only want empty caps filled. Existing caps of any value
// (1-6, 10, 12) stay as they are." The Phase 1 dry run found 276 SKUs whose
// cap differs from the rule, 271 of which the rule would LOOSEN, including
// 173 currently capped at 1-3 that look like deliberate scarcity limits.
// There is deliberately no flag to patch them; adding one back needs a new
// decision, not a command-line argument.
import "dotenv/config";
import axios from "axios";
import { writeFileSync } from "fs";
import { spApiGet, spApiPost, getAccessToken } from "../server/spapi-auth";
import { withRateLimit } from "../server/spapi-rate-limit";
import { resolveMaxOrderQuantity, findForbiddenQuantityPaths } from "../server/offer-add";
import { query } from "../server/db";

const SP_API_BASE = "https://sellingpartnerapi-na.amazon.com";

const LIVE = process.argv.includes("--live");
const LIMIT_FLAG = process.argv.indexOf("--limit");
const LIMIT = LIMIT_FLAG >= 0 ? Number(process.argv[LIMIT_FLAG + 1]) : null;

const MARKETPLACE = process.env.SP_API_MARKETPLACE_ID ?? "ATVPDKIKX0DER";
const SELLER = process.env.SP_API_SELLER_ID;
if (!SELLER) { console.error("SP_API_SELLER_ID not configured"); process.exit(1); }

const STAMP = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
const OUT_JSON = `/tmp/max-order-qty-backfill-${STAMP}.json`;
const OUT_CSV = `/tmp/max-order-qty-backfill-${STAMP}.csv`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Bucket = "a_will_patch" | "b_already_correct" | "c_mismatch" | "d_unresolvable" | "e_gone_404";
interface Row {
  sku: string;
  asin: string | null;
  bucket: Bucket;
  currentCap: number | null;
  ruleCap: number | null;
  cogsUsed: number | null;
  productType: string | null;
  status: string;
  reason?: string;
  // phase 2
  submitted?: boolean;
  outcome?: string;
  issues?: string;
  verifiedCap?: number | null;
}

// ── 1. SKU universe, from Amazon ────────────────────────────────────────────
async function fetchAllSkusFromAmazon(): Promise<Array<{ sku: string; asin: string | null; status: string }>> {
  console.log("Requesting GET_MERCHANT_LISTINGS_ALL_DATA (every SKU, all statuses)...");
  const create: any = await spApiPost("/reports/2021-06-30/reports", {
    reportType: "GET_MERCHANT_LISTINGS_ALL_DATA",
    marketplaceIds: [MARKETPLACE],
  });
  const reportId = create?.reportId;
  console.log(`  reportId ${reportId}`);

  let docId: string | undefined;
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    await sleep(5000);
    const st: any = await spApiGet(`/reports/2021-06-30/reports/${reportId}`);
    if (st.processingStatus === "DONE") { docId = st.reportDocumentId; break; }
    if (st.processingStatus === "FATAL" || st.processingStatus === "CANCELLED") {
      throw new Error(`listings report ${reportId}: ${st.processingStatus}`);
    }
  }
  if (!docId) throw new Error(`listings report ${reportId} timed out`);

  const doc: any = await spApiGet(`/reports/2021-06-30/documents/${docId}`);
  let raw: string;
  if (doc.compressionAlgorithm === "GZIP") {
    const { gunzipSync } = await import("zlib");
    const bin = await axios.get(doc.url, { responseType: "arraybuffer", timeout: 120_000 });
    raw = gunzipSync(Buffer.from(bin.data)).toString("utf8");
  } else {
    raw = (await axios.get(doc.url, { responseType: "text", timeout: 120_000 })).data as string;
  }

  const lines = raw.split("\n").filter((l) => l.trim());
  const headers = (lines[0] ?? "").replace(/\r$/, "").split("\t");
  const col = (name: string) => headers.findIndex((h) => h.toLowerCase().trim() === name);
  const iSku = col("seller-sku");
  const iAsin = col("asin1");
  const iStatus = col("status");
  console.log(`  report rows: ${lines.length - 1}; columns: ${headers.join(", ")}`);
  if (iSku < 0) throw new Error(`report has no seller-sku column: ${headers.join(", ")}`);

  const out: Array<{ sku: string; asin: string | null; status: string }> = [];
  for (const line of lines.slice(1)) {
    const c = line.replace(/\r$/, "").split("\t");
    const sku = (c[iSku] ?? "").trim();
    if (!sku) continue;
    out.push({
      sku,
      asin: iAsin >= 0 ? ((c[iAsin] ?? "").trim() || null) : null,
      status: iStatus >= 0 ? (c[iStatus] ?? "").trim() : "",
    });
  }
  return out;
}

// ── 2. COGS, exactly the value the price resolver consumes ──────────────────
async function loadCogs(asins: string[]): Promise<Map<string, number | null>> {
  const m = new Map<string, number | null>();
  if (asins.length === 0) return m;
  // COALESCE(estimated_cogs, cogs) — §2 provenance, same expression the
  // price resolver uses (routes.ts). An ASIN absent from `asins` simply
  // never lands in the map -> treated as unknown -> cap 4.
  const res = await query(
    `SELECT a.asin, COALESCE(e.estimated_cogs, e.cogs) AS cogs
       FROM asins a LEFT JOIN asin_estimates e ON e.asin = a.asin
      WHERE a.asin = ANY($1::text[])`,
    [asins],
  );
  for (const r of res.rows as Array<{ asin: string; cogs: string | null }>) {
    m.set(r.asin, r.cogs == null ? null : Number(r.cogs));
  }
  return m;
}

function readCap(attributes: any): number | null {
  const arr = attributes?.max_order_quantity;
  if (!Array.isArray(arr) || arr.length === 0) return null;
  // Prefer the entry for our marketplace; fall back to the first.
  const entry = arr.find((e: any) => e?.marketplace_id === MARKETPLACE) ?? arr[0];
  const v = entry?.value;
  return typeof v === "number" ? v : (v == null ? null : Number(v));
}

async function main() {
  console.log(`=== max_order_quantity backfill — ${LIVE ? "LIVE (PHASE 2)" : "DRY RUN (PHASE 1, read-only)"} ===\n`);

  const universe = await fetchAllSkusFromAmazon();
  const scoped = LIMIT ? universe.slice(0, LIMIT) : universe;
  console.log(`SKU universe from Amazon: ${universe.length}${LIMIT ? ` (limited to ${scoped.length})` : ""}\n`);

  const cogsMap = await loadCogs(Array.from(new Set(scoped.map((s) => s.asin).filter((a): a is string => !!a))));
  console.log(`COGS loaded for ${cogsMap.size} of the report's ASINs\n`);

  const rows: Row[] = [];
  for (let i = 0; i < scoped.length; i++) {
    const { sku, asin, status } = scoped[i];
    if (i % 25 === 0) process.stdout.write(`\r  inspecting ${i + 1}/${scoped.length}...`);
    let item: any;
    try {
      item = await spApiGet(`/listings/2021-08-01/items/${SELLER}/${encodeURIComponent(sku)}`, {
        marketplaceIds: MARKETPLACE,
        includedData: "attributes,summaries,productTypes",
      });
    } catch (err: any) {
      const code = err?.response?.status;
      if (code === 404) {
        rows.push({ sku, asin, bucket: "e_gone_404", currentCap: null, ruleCap: null, cogsUsed: null, productType: null, status, reason: "404 — SKU no longer exists in SC" });
      } else {
        rows.push({ sku, asin, bucket: "d_unresolvable", currentCap: null, ruleCap: null, cogsUsed: null, productType: null, status, reason: `HTTP ${code ?? "?"}: ${err?.response?.data?.errors?.[0]?.message ?? err?.message}` });
      }
      continue;
    }

    const liveAsin = item?.summaries?.[0]?.asin ?? asin ?? null;
    const productType = item?.productTypes?.[0]?.productType ?? item?.summaries?.[0]?.productType ?? null;
    const cogs = liveAsin ? (cogsMap.has(liveAsin) ? cogsMap.get(liveAsin)! : null) : null;
    const ruleCap = resolveMaxOrderQuantity(cogs); // THE shared function
    const currentCap = readCap(item?.attributes);

    if (!productType) {
      rows.push({ sku, asin: liveAsin, bucket: "d_unresolvable", currentCap, ruleCap, cogsUsed: cogs, productType: null, status, reason: "no productType on the listing — cannot build a schema-correct patch" });
      continue;
    }
    const bucket: Bucket =
      currentCap == null ? "a_will_patch"
      : currentCap === ruleCap ? "b_already_correct"
      : "c_mismatch";
    rows.push({ sku, asin: liveAsin, bucket, currentCap, ruleCap, cogsUsed: cogs, productType, status });
  }
  process.stdout.write("\r" + " ".repeat(50) + "\r");

  const count = (b: Bucket) => rows.filter((r) => r.bucket === b).length;
  console.log("PHASE 1 — buckets");
  console.log(`  (a) no cap set, WILL BE PATCHED      : ${count("a_will_patch")}`);
  console.log(`  (b) cap already equals the rule, skip: ${count("b_already_correct")}`);
  console.log(`  (c) cap set to a DIFFERENT value     : ${count("c_mismatch")}   <- NEVER patched (out of scope, 2026-10-04)`);
  console.log(`  (d) not resolvable                   : ${count("d_unresolvable")}`);
  console.log(`  (e) gone (404), skipped              : ${count("e_gone_404")}`);
  console.log(`      total inspected                  : ${rows.length}`);

  const capSplit = new Map<number, number>();
  for (const r of rows.filter((x) => x.bucket === "a_will_patch")) capSplit.set(r.ruleCap!, (capSplit.get(r.ruleCap!) ?? 0) + 1);
  if (capSplit.size) console.log(`\n  (a) splits by rule cap: ${Array.from(capSplit).sort().map(([c, n]) => `cap ${c} -> ${n}`).join(", ")}`);

  // ── Phase 2 ───────────────────────────────────────────────────────────────
  if (LIVE) {
    // Bucket (a) ONLY — see the scope note at the top of this file.
    const targets = rows.filter((r) => r.bucket === "a_will_patch");
    console.log(`\n=== PHASE 2 — patching ${targets.length} SKU(s) ===`);
    for (let i = 0; i < targets.length; i++) {
      const r = targets[i];
      // op "add" on max_order_quantity ONLY. No price, no
      // purchasable_offer/end_at, no fulfillment fields.
      //
      // WHY "add" and not "merge" (2026-10-04): merge is real on
      // patchListingsItem — SPEC §18 records it working live on
      // CAM-HOM-M64-RQR-003 for the purchasable_offer reopen, and the removed
      // server/listing-reopen.ts (deleted in 9360780) sent exactly that. But
      // it was `op: "merge"` on /attributes/purchasable_offer, a STRUCTURED
      // attribute where merging sub-attributes is the point. max_order_quantity
      // is a simple array-of-{value,marketplace_id}; merge against it returned
      // HTTP 400 "Invalid path provided in patch at index of 0" on all 5
      // canary SKUs (nothing written).
      //
      // WHY NOT "replace": the never-replace rule comes from purchasable_offer,
      // where replace swaps the whole array and wipes the price. It does not
      // apply to an absent simple attribute — but "add" is the correct op for
      // a value that is not there, so it is the one used. Scope is empty-caps
      // only, and the per-patch re-read below re-confirms absence immediately
      // before the write, so there is nothing for "add" to overwrite.
      const body = {
        productType: r.productType,
        patches: [{
          op: "add",
          path: "/attributes/max_order_quantity",
          value: [{ marketplace_id: MARKETPLACE, value: r.ruleCap }],
        }],
      };
      // Pre-flight abort: the exact key "quantity" at ANY depth flips the SKU
      // to merchant-fulfilled. max_order_quantity is a different key and must
      // pass; this catches a malformed body before it reaches Amazon.
      const forbidden = findForbiddenQuantityPaths(body);
      if (forbidden.length > 0) {
        console.error(`\nABORT — forbidden quantity key in the patch body for ${r.sku}: ${forbidden.join(", ")}`);
        process.exit(1);
      }
      // Re-read immediately before writing. The inspection pass above takes
      // minutes, and the Phase 1 snapshot is older again; a cap set in the
      // meantime (by Maria, by Amazon, by another tool) must not be
      // overwritten. Scope is "fill EMPTY caps", so anything non-empty now
      // is out of scope by definition, whatever its value.
      try {
        const fresh: any = await spApiGet(`/listings/2021-08-01/items/${SELLER}/${encodeURIComponent(r.sku)}`, {
          marketplaceIds: MARKETPLACE, includedData: "attributes",
        });
        const nowCap = readCap(fresh?.attributes);
        if (nowCap != null) {
          r.outcome = "skipped_changed_since_snapshot";
          r.currentCap = nowCap;
          console.log(`  [${i + 1}/${targets.length}] ${r.sku} SKIPPED — cap is now ${nowCap} (was empty at inspection)`);
          continue;
        }
      } catch (err: any) {
        r.outcome = "skipped_recheck_failed";
        r.issues = `pre-patch re-read failed: HTTP ${err?.response?.status ?? "?"} ${err?.response?.data?.errors?.[0]?.message ?? err?.message}`;
        console.log(`  [${i + 1}/${targets.length}] ${r.sku} SKIPPED — ${r.issues}`);
        continue;
      }

      try {
        const res: any = await spApiPatch(
          `/listings/2021-08-01/items/${SELLER}/${encodeURIComponent(r.sku)}`,
          body,
          { marketplaceIds: MARKETPLACE },
        );
        r.submitted = true;
        r.outcome = String(res?.status ?? "?");
        const iss = (res?.issues ?? []) as any[];
        r.issues = iss.length ? iss.map((x) => `${x.code}:${x.message}`).join(" | ") : "";
        console.log(`  [${i + 1}/${targets.length}] ${r.sku} cap ${r.ruleCap} -> ${r.outcome}${r.issues ? ` (issues: ${r.issues})` : ""}`);
      } catch (err: any) {
        r.submitted = true;
        r.outcome = "ERROR";
        r.issues = `HTTP ${err?.response?.status ?? "?"}: ${err?.response?.data?.errors?.[0]?.message ?? err?.message}`;
        console.log(`  [${i + 1}/${targets.length}] ${r.sku} -> ERROR ${r.issues}`);
      }
    }

    // Verify: re-read every patched SKU.
    const patched = targets.filter((t) => t.submitted);
    const skippedChanged = targets.filter((t) => t.outcome === "skipped_changed_since_snapshot");
    const skippedRecheck = targets.filter((t) => t.outcome === "skipped_recheck_failed");
    console.log(`\n=== PHASE 2 verification — re-reading ${patched.length} patched SKU(s) ===`);
    let ok = 0; const bad: string[] = [];
    for (const r of patched) {
      try {
        const item: any = await spApiGet(`/listings/2021-08-01/items/${SELLER}/${encodeURIComponent(r.sku)}`, {
          marketplaceIds: MARKETPLACE, includedData: "attributes",
        });
        r.verifiedCap = readCap(item?.attributes);
        if (r.verifiedCap === r.ruleCap) ok++;
        else bad.push(`${r.sku}: expected ${r.ruleCap}, read ${r.verifiedCap ?? "(absent)"}`);
      } catch (err: any) {
        bad.push(`${r.sku}: re-read failed — ${err?.response?.status ?? err?.message}`);
      }
    }
    const withIssues = patched.filter((t) => t.issues);
    console.log(`\n=== PHASE 2 SUMMARY ===`);
    console.log(`  targeted (bucket a)          : ${targets.length}`);
    console.log(`  patched                      : ${patched.length}`);
    console.log(`  confirmed correct on re-read : ${ok}`);
    console.log(`  MISMATCHED after patch       : ${bad.length}`);
    console.log(`  Amazon issues returned       : ${withIssues.length}`);
    console.log(`  skipped — changed since snapshot: ${skippedChanged.length}`);
    console.log(`  skipped — re-read failed       : ${skippedRecheck.length}`);
    if (bad.length) { console.log(`\n  MISMATCHES:`); for (const b of bad) console.log(`    ${b}`); }
    if (withIssues.length) { console.log(`\n  AMAZON ISSUES:`); for (const t of withIssues) console.log(`    ${t.sku}: ${t.issues}`); }
    if (skippedChanged.length) { console.log(`\n  CHANGED SINCE SNAPSHOT (left alone):`); for (const t of skippedChanged) console.log(`    ${t.sku}: cap is now ${t.currentCap}`); }
    if (skippedRecheck.length) { console.log(`\n  RE-READ FAILED (left alone):`); for (const t of skippedRecheck) console.log(`    ${t.sku}: ${t.issues}`); }
  }

  // ── report files ──────────────────────────────────────────────────────────
  writeFileSync(OUT_JSON, JSON.stringify({ generatedAt: new Date().toISOString(), live: LIVE, counts: {
    a_will_patch: count("a_will_patch"), b_already_correct: count("b_already_correct"),
    c_mismatch: count("c_mismatch"), d_unresolvable: count("d_unresolvable"), e_gone_404: count("e_gone_404"),
    total: rows.length,
  }, rows }, null, 2));
  const esc = (v: any) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const cols = ["sku","asin","bucket","currentCap","ruleCap","cogsUsed","productType","status","reason","submitted","outcome","issues","verifiedCap"] as const;
  writeFileSync(OUT_CSV, [cols.join(","), ...rows.map((r) => cols.map((c) => esc((r as any)[c])).join(","))].join("\n") + "\n");
  console.log(`\nFull detail:\n  ${OUT_JSON}\n  ${OUT_CSV}`);
  if (!LIVE) console.log(`\nDRY RUN — nothing was written. Re-run with --live to patch bucket (a).`);
}

// PATCH helper. Deliberately LOCAL to this one-off rather than added to
// server/spapi-auth.ts: no AF code path patches listings, and a backfill
// should not leave a general-purpose listings writer behind.
//
// It wraps the call in the EXISTING withRateLimit with the same shape as
// spApiPut, so /listings/2021-08-01/items/... resolves to the established
// `listings.items` bucket (rate 5, burst 10) and inherits its throttling and
// 429 backoff. No new limiter, no second rate table.
async function spApiPatch(endpoint: string, body: any, params?: Record<string, any>) {
  const token = await getAccessToken();
  const res = await withRateLimit(endpoint, () =>
    axios.patch(`${SP_API_BASE}${endpoint}`, body, {
      headers: {
        Authorization: `Bearer ${token}`,
        "x-amz-access-token": token,
        "Content-Type": "application/json",
      },
      params,
      timeout: 30_000,
    }),
  );
  return res.data;
}

main().then(() => process.exit(0)).catch((e) => {
  console.error("\nFATAL", e?.response?.status ?? "", e?.response?.data ?? e?.message ?? e);
  process.exit(1);
});
