// Read-only diagnostic. No DB writes. No code changes.
//
// Scans ALL ~1914 ASINs via getCatalogItem to characterize:
//   1. Coverage: usable sub-category / top-only / dead / other / multi-path
//   2. Distinct sub-categories (legend curation load)
//   3. Examples of "category but no sub-category"
//
// Throttled to 500ms/call → ~16 min total runtime. Run in background.

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

type Bucket =
  | "has_sub"            // ≥1 classification path → leaf used as sub-category
  | "multi_path"         // ≥2 distinct classification paths (subset of has_sub semantically; counted separately)
  | "top_only_no_sub"    // classifications block present but no leaf
  | "dead_404"
  | "other_error";

interface ProbeResult {
  asin: string;
  storedCategory: string | null;
  bucket: Bucket;
  leaf?: string;
  topOfChain?: string;
  // For multi_path:
  pathLeaves?: string[];
  pathTops?: string[];
  pickedLeaf?: string;          // pick rule applied
  pickRule?: "single" | "matches_stored_top" | "first_when_no_match";
  // For errors:
  status?: number;
}

function walkTop(leaf: any): string | null {
  let top: string | null = null;
  let cur = leaf?.parent;
  while (cur) {
    if (cur.displayName) top = cur.displayName;
    cur = cur.parent;
  }
  return top;
}

async function probe(asin: string, storedCategory: string | null): Promise<ProbeResult> {
  let data: any;
  let attempt = 0;
  while (true) {
    try {
      data = await spApiGet(`/catalog/2022-04-01/items/${asin}`, {
        marketplaceIds: "ATVPDKIKX0DER",
        includedData: "classifications",
      });
      break;
    } catch (err: any) {
      const status = err.response?.status;
      if (status === 404) return { asin, storedCategory, bucket: "dead_404", status: 404 };
      if (status === 429 && attempt < 2) {
        attempt++;
        await delay(2000);
        continue;
      }
      return { asin, storedCategory, bucket: "other_error", status };
    }
  }

  const block = data.classifications?.[0];
  const paths: any[] = block?.classifications ?? [];

  if (paths.length === 0) {
    return { asin, storedCategory, bucket: "top_only_no_sub" };
  }

  if (paths.length === 1) {
    const leaf = paths[0]?.displayName;
    const top = walkTop(paths[0]);
    if (!leaf) return { asin, storedCategory, bucket: "top_only_no_sub" };
    return { asin, storedCategory, bucket: "has_sub", leaf, topOfChain: top ?? undefined };
  }

  // multi-path
  const leaves = paths.map((p) => p?.displayName).filter(Boolean) as string[];
  const tops = paths.map((p) => walkTop(p) ?? "").filter(Boolean);
  // Propose pick rule: path whose top matches storedCategory; else first.
  let picked: string | undefined;
  let rule: "matches_stored_top" | "first_when_no_match" = "first_when_no_match";
  if (storedCategory) {
    const idx = tops.findIndex(
      (t) => t.trim().toLowerCase() === storedCategory.trim().toLowerCase(),
    );
    if (idx >= 0) {
      picked = leaves[idx];
      rule = "matches_stored_top";
    }
  }
  if (!picked) picked = leaves[0];

  return {
    asin,
    storedCategory,
    bucket: "multi_path",
    leaf: picked,
    topOfChain: tops[0],
    pathLeaves: leaves,
    pathTops: tops,
    pickedLeaf: picked,
    pickRule: rule,
  };
}

(async () => {
  const all = await query(`SELECT asin, category FROM asins ORDER BY asin`);
  const total = all.rowCount ?? 0;
  console.error(`Scanning ${total} ASINs (~${Math.round((total * 0.5) / 60)} min at 500ms/call)\n`);

  const results: ProbeResult[] = [];
  const start = Date.now();
  for (let i = 0; i < all.rows.length; i++) {
    const r = await probe(all.rows[i].asin, all.rows[i].category);
    results.push(r);
    if ((i + 1) % 50 === 0) {
      const pct = Math.round(((i + 1) / total) * 100);
      const elapsed = Math.round((Date.now() - start) / 1000);
      console.error(`  ${i + 1}/${total} (${pct}%) — ${elapsed}s elapsed`);
    }
    await delay(500);
  }

  // ===== Coverage counts =====
  const counts: Record<Bucket, number> = {
    has_sub: 0, multi_path: 0, top_only_no_sub: 0, dead_404: 0, other_error: 0,
  };
  for (const r of results) counts[r.bucket]++;

  console.log(`\n=== Coverage (n=${results.length}) ===`);
  for (const [k, v] of Object.entries(counts)) {
    const pct = ((v / results.length) * 100).toFixed(1);
    console.log(`  ${k.padEnd(20)} ${String(v).padStart(5)}  (${pct}%)`);
  }

  // ===== Multi-path detail =====
  const multi = results.filter((r) => r.bucket === "multi_path");
  if (multi.length > 0) {
    const byRule: Record<string, number> = {};
    for (const r of multi) byRule[r.pickRule ?? "?"] = (byRule[r.pickRule ?? "?"] ?? 0) + 1;
    console.log(`\n=== Multi-path pick-rule breakdown (n=${multi.length}) ===`);
    for (const [k, v] of Object.entries(byRule)) console.log(`  ${k.padEnd(28)} ${v}`);
    console.log(`\n--- Sample multi-path ASINs (up to 5) ---`);
    for (const r of multi.slice(0, 5)) {
      console.log(`  ${r.asin}  stored=${JSON.stringify(r.storedCategory)}  rule=${r.pickRule}`);
      console.log(`    leaves: ${JSON.stringify(r.pathLeaves)}`);
      console.log(`    tops:   ${JSON.stringify(r.pathTops)}`);
      console.log(`    picked: ${JSON.stringify(r.pickedLeaf)}`);
    }
  }

  // ===== Distinct sub-categories =====
  const subCounts = new Map<string, number>();
  for (const r of results) {
    if ((r.bucket === "has_sub" || r.bucket === "multi_path") && r.leaf) {
      subCounts.set(r.leaf, (subCounts.get(r.leaf) ?? 0) + 1);
    }
  }
  console.log(`\n=== Distinct sub-categories — ${subCounts.size} total (legend curation load) ===`);
  const sorted = Array.from(subCounts.entries()).sort((a, b) => b[1] - a[1]);
  console.log(`count  sub-category`);
  for (const [name, n] of sorted) {
    console.log(`${String(n).padStart(5)}  ${name}`);
  }

  // ===== top_only_no_sub examples =====
  const topOnly = results.filter((r) => r.bucket === "top_only_no_sub");
  if (topOnly.length > 0) {
    console.log(`\n=== 'top_only_no_sub' examples (up to 10) ===`);
    // join titles for context
    const titles = await query(
      `SELECT asin, title, brand FROM asins WHERE asin = ANY($1::text[])`,
      [topOnly.slice(0, 10).map((r) => r.asin)],
    );
    const tmap = new Map<string, { title: string; brand: string }>();
    for (const t of titles.rows) tmap.set(t.asin, { title: t.title, brand: t.brand });
    for (const r of topOnly.slice(0, 10)) {
      const t = tmap.get(r.asin);
      console.log(`  ${r.asin}  stored=${JSON.stringify(r.storedCategory)}  brand=${t?.brand ?? "-"}  title=${(t?.title ?? "").slice(0, 80)}`);
    }
  }

  // ===== other_error sample =====
  const oth = results.filter((r) => r.bucket === "other_error");
  if (oth.length > 0) {
    console.log(`\n=== 'other_error' status breakdown ===`);
    const byStatus: Record<string, number> = {};
    for (const r of oth) byStatus[String(r.status ?? "?")] = (byStatus[String(r.status ?? "?")] ?? 0) + 1;
    for (const [k, v] of Object.entries(byStatus)) console.log(`  status=${k}  ${v}`);
  }

  process.exit(0);
})().catch((err) => {
  console.error("Diag failed:", err.message);
  if (err.response?.data) console.error("API body:", JSON.stringify(err.response.data).slice(0, 500));
  process.exit(1);
});
