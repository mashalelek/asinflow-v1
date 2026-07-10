// Read-only diagnostic. No DB writes. No code changes.
//
// Hypothesis: the 91 NULL-category ASINs are dead catalog items (product
// removed from Amazon entirely), not un-analyzed.
//
// Test plan:
//   1. For all 91 NULL-category ASINs, call getCatalogItem.
//   2. Bucket: found | not_found_404 | other_error.
//   3. Control: call getCatalogItem for 5 random known-good (populated category)
//      ASINs to confirm the endpoint returns valid data when the product is alive.
//   4. Capture the exact response shape on one dead + one alive ASIN so we know
//      what signal a future "dead ASIN" flag would key off.

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

async function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

type Outcome = "found" | "not_found_404" | "other_error";

interface ProbeResult {
  asin: string;
  outcome: Outcome;
  errorCode?: number;
  errorBody?: string;
  rawResponse?: any;
}

async function probe(asin: string, captureFull = false): Promise<ProbeResult> {
  try {
    const data = await spApiGet(`/catalog/2022-04-01/items/${asin}`, {
      marketplaceIds: "ATVPDKIKX0DER",
      includedData: "summaries,attributes,productTypes,classifications,salesRanks",
    });
    return {
      asin,
      outcome: "found",
      rawResponse: captureFull ? data : undefined,
    };
  } catch (err: any) {
    const status = err.response?.status;
    if (status === 404) {
      return {
        asin,
        outcome: "not_found_404",
        errorCode: 404,
        errorBody: captureFull ? JSON.stringify(err.response?.data) : undefined,
      };
    }
    return {
      asin,
      outcome: "other_error",
      errorCode: status,
      errorBody: JSON.stringify(err.response?.data ?? err.message)?.slice(0, 300),
    };
  }
}

(async () => {
  // 1. The 91 suspected-dead ASINs
  const nullRes = await query(`SELECT asin FROM asins WHERE category IS NULL ORDER BY asin`);
  const nullAsins: string[] = nullRes.rows.map((r) => r.asin);
  console.error(`Probing ${nullAsins.length} NULL-category ASINs via getCatalogItem...`);

  const nullOutcomes: ProbeResult[] = [];
  // Capture full response from the first dead+alive we hit
  let firstDeadCaptured = false;
  for (let i = 0; i < nullAsins.length; i++) {
    const a = nullAsins[i];
    const captureFull = !firstDeadCaptured; // grab raw on the first one regardless
    const r = await probe(a, captureFull);
    if (captureFull && r.outcome === "not_found_404") firstDeadCaptured = true;
    nullOutcomes.push(r);
    if ((i + 1) % 10 === 0) {
      console.error(`  ${i + 1}/${nullAsins.length} probed`);
    }
    await delay(500); // ~2/sec
  }

  // 2. Control: 5 random known-good
  const goodRes = await query(`
    SELECT asin FROM asins
    WHERE category IS NOT NULL AND brand IS NOT NULL AND title IS NOT NULL
    ORDER BY random() LIMIT 5
  `);
  const goodAsins: string[] = goodRes.rows.map((r) => r.asin);
  console.error(`\nControl: probing ${goodAsins.length} known-good ASINs...`);

  const goodOutcomes: ProbeResult[] = [];
  let firstAliveCaptured = false;
  for (const a of goodAsins) {
    const captureFull = !firstAliveCaptured;
    const r = await probe(a, captureFull);
    if (captureFull && r.outcome === "found") firstAliveCaptured = true;
    goodOutcomes.push(r);
    await delay(500);
  }

  // 3. Counts
  function counts(rows: ProbeResult[]) {
    const c: Record<Outcome, number> = { found: 0, not_found_404: 0, other_error: 0 };
    for (const r of rows) c[r.outcome]++;
    return c;
  }
  const nc = counts(nullOutcomes);
  const gc = counts(goodOutcomes);

  console.log(`\n=== NULL-category bucket (${nullAsins.length}) ===`);
  for (const [k, v] of Object.entries(nc)) console.log(`  ${k.padEnd(18)} ${v}`);

  console.log(`\n=== Known-good control (${goodAsins.length}) ===`);
  for (const [k, v] of Object.entries(gc)) console.log(`  ${k.padEnd(18)} ${v}`);

  // 4. Sample errors from other_error bucket
  const otherErrs = nullOutcomes.filter((r) => r.outcome === "other_error").slice(0, 5);
  if (otherErrs.length > 0) {
    console.log(`\n=== Sample "other_error" from NULL bucket (up to 5) ===`);
    for (const r of otherErrs) {
      console.log(`  ${r.asin}  status=${r.errorCode}  body=${r.errorBody}`);
    }
  }

  // 5. Raw response shape — one dead + one alive
  const firstDead = nullOutcomes.find((r) => r.outcome === "not_found_404" && r.errorBody);
  const firstAlive = goodOutcomes.find((r) => r.outcome === "found" && r.rawResponse);

  if (firstDead) {
    console.log(`\n=== Dead-ASIN response (404) — ${firstDead.asin} ===`);
    console.log(`  HTTP status: 404`);
    console.log(`  Body: ${firstDead.errorBody}`);
  }
  if (firstAlive) {
    console.log(`\n=== Alive-ASIN response shape — ${firstAlive.asin} ===`);
    const r = firstAlive.rawResponse;
    console.log(`  top-level keys: ${Object.keys(r).join(", ")}`);
    if (r.summaries?.[0]) {
      console.log(`  summaries[0] keys: ${Object.keys(r.summaries[0]).join(", ")}`);
      if (r.summaries[0].itemName) {
        console.log(`  summaries[0].itemName: ${String(r.summaries[0].itemName).slice(0, 100)}`);
      }
      if (r.summaries[0].brand) console.log(`  summaries[0].brand: ${r.summaries[0].brand}`);
    }
    if (r.classifications?.[0]) {
      console.log(`  classifications[0]: ${JSON.stringify(r.classifications[0]).slice(0, 200)}`);
    }
  }

  process.exit(0);
})().catch((err) => {
  console.error("Diagnostic failed:", err.message);
  if (err.response?.data) console.error("API body:", JSON.stringify(err.response.data).slice(0, 500));
  process.exit(1);
});
