// Read-only. Walks NULL-category ASINs calling getCatalogItem, prints the
// first 5 that return found (the "stale: alive but un-enriched" sub-bucket).

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

(async () => {
  const nullRes = await query(`SELECT asin FROM asins WHERE category IS NULL ORDER BY asin`);
  const asins: string[] = nullRes.rows.map((r) => r.asin);

  const found: { asin: string; brand?: string; itemName?: string; topClassification?: string }[] = [];

  for (const asin of asins) {
    if (found.length >= 5) break;
    try {
      const data = await spApiGet(`/catalog/2022-04-01/items/${asin}`, {
        marketplaceIds: "ATVPDKIKX0DER",
        includedData: "summaries,classifications",
      });
      const s = data.summaries?.[0] ?? {};
      const topCls = data.classifications?.[0]?.classifications?.[0]?.displayName;
      found.push({ asin, brand: s.brand, itemName: s.itemName, topClassification: topCls });
    } catch (err: any) {
      if (err.response?.status !== 404) {
        console.error(`${asin} unexpected error: ${err.response?.status}`);
      }
    }
    await delay(500);
  }

  console.log(`\n=== 5 stale (alive but un-enriched) ASINs ===\n`);
  for (const f of found) {
    console.log(`ASIN:           ${f.asin}`);
    console.log(`  brand:         ${f.brand ?? "(missing)"}`);
    console.log(`  itemName:      ${(f.itemName ?? "(missing)").slice(0, 100)}`);
    console.log(`  classification: ${f.topClassification ?? "(none)"}`);
    console.log();
  }
  process.exit(0);
})().catch((err) => {
  console.error("Failed:", err.message);
  process.exit(1);
});
