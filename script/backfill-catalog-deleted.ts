// One-off DA-2 backfill: call getCatalogData against every ASIN, write
// is_catalog_deleted + catalog_checked_at, auto-archive on FALSE→TRUE.
//
// Idempotent: re-runs are safe because COALESCE/CASE handle every state
// transition correctly. ~16 min at 2/sec throttle.
//
// Uses the same applyCatalogDeletedSignal helper as the live analyze write,
// so the backfill cannot drift from the live path. Cannot inline the CASE
// logic here — that's the whole point of the helper.
//
// getCatalogData inlined here (mirrors server/spapi.ts:getCatalogData minimally
// — only the 404/200 detection, not the field extraction). Inlining avoids
// importing spapi.ts which would bootstrap server/index.ts (Express).

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

async function probeCatalog(asin: string): Promise<boolean | null> {
  // Returns: true (404 NOT_FOUND), false (2xx), null (transient — preserve prior)
  try {
    const token = await getAccessToken();
    await axios.get(`https://sellingpartnerapi-na.amazon.com/catalog/2022-04-01/items/${asin}`, {
      headers: { Authorization: `Bearer ${token}`, "x-amz-access-token": token },
      params: { marketplaceIds: "ATVPDKIKX0DER", includedData: "summaries" },
    });
    return false;
  } catch (err: any) {
    const status = err?.response?.status;
    if (status === 404) return true;
    return null;
  }
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const all = await query(`SELECT asin FROM asins ORDER BY asin`);
  const total = all.rowCount ?? 0;
  console.error(`Probing ${total} ASINs (~${Math.round((total * 0.5) / 60)} min at 500ms/call)\n`);

  let alive = 0, deleted = 0, inconclusive = 0;
  const start = Date.now();

  for (let i = 0; i < all.rows.length; i++) {
    const asin = all.rows[i].asin;
    const signal = await probeCatalog(asin);
    if (signal === true) deleted++;
    else if (signal === false) alive++;
    else inconclusive++;

    // Single source of truth for the write (same call live analyze uses).
    await applyCatalogDeletedSignal(asin, signal);

    if ((i + 1) % 50 === 0) {
      const pct = Math.round(((i + 1) / total) * 100);
      const elapsed = Math.round((Date.now() - start) / 1000);
      console.error(`  ${i + 1}/${total} (${pct}%)  alive=${alive} deleted=${deleted} inconclusive=${inconclusive}  ${elapsed}s elapsed`);
    }
    await delay(500);
  }

  console.log(`\n=== Backfill complete ===`);
  console.log(`  total probed:    ${total}`);
  console.log(`  alive (2xx):     ${alive}`);
  console.log(`  deleted (404):   ${deleted}`);
  console.log(`  inconclusive:    ${inconclusive}  (preserved prior value, catalog_checked_at unchanged)`);
  process.exit(0);
})().catch((err) => {
  console.error("Backfill failed:", err.message);
  process.exit(1);
});
