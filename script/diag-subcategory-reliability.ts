// Read-only diagnostic. No DB writes. No code changes.
//
// Question for 2C: does getCatalogItem return a sub-category reliably across
// the categories AsinFlow actually sells in? Specifically:
//   - Is classifications[0].classifications[0].displayName always present?
//   - When present, is it distinct from the top-level category we already store?
//   - What does the response look like when an ASIN has top-level only with
//     no deeper classification leaf?
//
// Samples 2 ASINs from each of the top-10 populated categories (20 total),
// calls getCatalogItem, dumps the relevant slice of the classifications block,
// and bucketizes the result.

import "dotenv/config";
import axios from "axios";
import { query } from "../server/db";

let cachedToken: { value: string; expiresAt: number } | null = null;
async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60000) return cachedToken.value;
  const res = await axios.post("https://api.amazon.com/auth/o2/token", {
    grant_type: "refresh_token",
    refresh_token: process.env.SP_API_REFRESH_TOKEN!,
    client_id: process.env.SP_API_CLIENT_ID!,
    client_secret: process.env.SP_API_CLIENT_SECRET!,
  });
  cachedToken = { value: res.data.access_token, expiresAt: Date.now() + res.data.expires_in * 1000 };
  return cachedToken.value;
}

async function spApiGet(endpoint: string, params?: Record<string, any>) {
  const token = await getAccessToken();
  const res = await axios.get(`https://sellingpartnerapi-na.amazon.com${endpoint}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "x-amz-access-token": token,
      "Content-Type": "application/json",
    },
    params,
  });
  return res.data;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ProbeResult {
  asin: string;
  storedCategory: string;
  bucket:
    | "has_leaf_distinct"        // leaf classification distinct from top-level
    | "has_leaf_same_as_top"     // leaf == stored category (no deeper info)
    | "no_classification"        // empty/missing classifications block
    | "error_404"
    | "error_other";
  leafDisplayName?: string;
  parentTrail?: string[];        // walked up from leaf via .parent.displayName
  raw?: any;                     // first row in each bucket captures raw
}

(async () => {
  // 2 ASINs from each of the top-10 categories. Random within category.
  const sample = await query(`
    WITH top_cats AS (
      SELECT category, COUNT(*) AS n
      FROM asins
      WHERE category IS NOT NULL AND category <> ''
      GROUP BY category
      ORDER BY n DESC
      LIMIT 10
    ),
    picked AS (
      SELECT a.asin, a.category,
             ROW_NUMBER() OVER (PARTITION BY a.category ORDER BY random()) AS rn
      FROM asins a
      JOIN top_cats t ON t.category = a.category
      WHERE a.title IS NOT NULL
    )
    SELECT asin, category FROM picked WHERE rn <= 2 ORDER BY category, asin
  `);

  console.error(`Probing ${sample.rowCount} ASINs (2 per top-10 category)...\n`);

  const results: ProbeResult[] = [];
  const rawCapturedByBucket = new Set<ProbeResult["bucket"]>();

  for (const row of sample.rows) {
    const asin = row.asin;
    const storedCategory: string = row.category;

    let pr: ProbeResult;
    try {
      const data = await spApiGet(`/catalog/2022-04-01/items/${asin}`, {
        marketplaceIds: "ATVPDKIKX0DER",
        includedData: "classifications,summaries",
      });
      const block = data.classifications?.[0];
      const leaf = block?.classifications?.[0];
      const leafName: string | undefined = leaf?.displayName;

      // Walk parents up to a depth cap
      const parents: string[] = [];
      let cur = leaf?.parent;
      while (cur && parents.length < 6) {
        if (cur.displayName) parents.push(cur.displayName);
        cur = cur.parent;
      }

      let bucket: ProbeResult["bucket"];
      if (!leafName) {
        bucket = "no_classification";
      } else if (leafName.trim().toLowerCase() === storedCategory.trim().toLowerCase()) {
        bucket = "has_leaf_same_as_top";
      } else {
        bucket = "has_leaf_distinct";
      }

      const captureRaw = !rawCapturedByBucket.has(bucket);
      if (captureRaw) rawCapturedByBucket.add(bucket);

      pr = {
        asin,
        storedCategory,
        bucket,
        leafDisplayName: leafName,
        parentTrail: parents,
        raw: captureRaw ? block : undefined,
      };
    } catch (err: any) {
      const status = err.response?.status;
      pr = {
        asin,
        storedCategory,
        bucket: status === 404 ? "error_404" : "error_other",
      };
    }
    results.push(pr);
    console.error(`  ${asin}  ${pr.bucket.padEnd(22)} leaf=${pr.leafDisplayName ?? "-"}`);
    await delay(500);
  }

  // Bucket counts
  const counts: Record<string, number> = {};
  for (const r of results) counts[r.bucket] = (counts[r.bucket] ?? 0) + 1;
  console.log(`\n=== Bucket counts (n=${results.length}) ===`);
  for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(22)} ${v}`);

  // Sample rows per bucket
  console.log(`\n=== Sample per bucket ===`);
  const buckets: ProbeResult["bucket"][] = ["has_leaf_distinct", "has_leaf_same_as_top", "no_classification", "error_404", "error_other"];
  for (const b of buckets) {
    const ex = results.filter((r) => r.bucket === b).slice(0, 3);
    if (ex.length === 0) continue;
    console.log(`\n[${b}]`);
    for (const r of ex) {
      const trail = r.parentTrail && r.parentTrail.length > 0 ? ` ← ${r.parentTrail.join(" ← ")}` : "";
      console.log(`  ${r.asin} stored=${JSON.stringify(r.storedCategory)} leaf=${JSON.stringify(r.leafDisplayName ?? null)}${trail}`);
    }
  }

  // Raw block shape per bucket (first occurrence captured)
  console.log(`\n=== Raw classifications block (first per bucket) ===`);
  for (const r of results) {
    if (r.raw) {
      console.log(`\n[${r.bucket}] ${r.asin}`);
      console.log(JSON.stringify(r.raw, null, 2).slice(0, 800));
    }
  }

  process.exit(0);
})().catch((err) => {
  console.error("Diag failed:", err.message);
  if (err.response?.data) console.error("API body:", JSON.stringify(err.response.data).slice(0, 500));
  process.exit(1);
});
