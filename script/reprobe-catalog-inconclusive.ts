// One-off: re-probe ASINs where catalog_checked_at IS NULL (the 16 that hit
// transient errors during the initial backfill). Uses the same helper.

import "dotenv/config";
import axios from "axios";
import { query } from "../server/db";
import { applyCatalogDeletedSignal } from "../server/catalog-deleted-write";

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

async function probe(asin: string): Promise<boolean | null> {
  try {
    const token = await getAccessToken();
    await axios.get(`https://sellingpartnerapi-na.amazon.com/catalog/2022-04-01/items/${asin}`, {
      headers: { Authorization: `Bearer ${token}`, "x-amz-access-token": token },
      params: { marketplaceIds: "ATVPDKIKX0DER", includedData: "summaries" },
    });
    return false;
  } catch (err: any) {
    if (err?.response?.status === 404) return true;
    return null;
  }
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const rows = await query(`SELECT asin FROM asins WHERE catalog_checked_at IS NULL ORDER BY asin`);
  const asins: string[] = rows.rows.map((r) => r.asin);
  console.log(`Re-probing ${asins.length} inconclusive ASINs...`);

  let alive = 0, deleted = 0, stillInconclusive = 0;
  for (const asin of asins) {
    const signal = await probe(asin);
    if (signal === true) deleted++;
    else if (signal === false) alive++;
    else stillInconclusive++;
    await applyCatalogDeletedSignal(asin, signal);
    await delay(500);
  }
  console.log(`Done: alive=${alive} deleted=${deleted} stillInconclusive=${stillInconclusive}`);
  process.exit(0);
})().catch((err) => { console.error("Failed:", err.message); process.exit(1); });
