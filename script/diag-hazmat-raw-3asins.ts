/**
 * DIAGNOSTIC ONLY — read-only. No DB writes, no fixes.
 *
 * Dumps the RAW getItemEligibilityPreview (program=COMMINGLING) response for
 * the 3 disputed grocery ASINs, then replays the exact parse logic from
 * server/spapi.ts getCommingleHazmat so we can see where "hazmat" is decided.
 */
import "dotenv/config";
import axios from "axios";

const MARKETPLACE = "ATVPDKIKX0DER";
const HAZMAT_CODES = new Set(["FBA_INB_0096", "FBA_INB_0097"]);
const ASINS = ["B07YX5971R", "B0756KB8N1", "B0FTKHZ8H8"];

let cachedToken: { tok: string; exp: number } | null = null;
async function token(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.exp - 60000) return cachedToken.tok;
  const r = await axios.post("https://api.amazon.com/auth/o2/token", {
    grant_type: "refresh_token",
    refresh_token: process.env.SP_API_REFRESH_TOKEN,
    client_id: process.env.SP_API_CLIENT_ID,
    client_secret: process.env.SP_API_CLIENT_SECRET,
  });
  cachedToken = { tok: r.data.access_token, exp: Date.now() + r.data.expires_in * 1000 };
  return cachedToken.tok;
}

async function probe(asin: string) {
  console.log(`\n================= ${asin} =================`);
  try {
    const t = await token();
    const res = await axios.get(
      "https://sellingpartnerapi-na.amazon.com/fba/inbound/v1/eligibility/itemPreview",
      {
        headers: { Authorization: `Bearer ${t}`, "x-amz-access-token": t },
        params: { asin, program: "COMMINGLING", marketplaceIds: MARKETPLACE },
      },
    );
    // 1. RAW response body
    console.log("HTTP status:", res.status);
    console.log("RAW body:", JSON.stringify(res.data, null, 2));

    // 2-4. Replay getCommingleHazmat parse EXACTLY
    const payload = res.data?.payload;
    const isEligible = payload?.isEligibleForProgram;
    const reasons: any[] = payload?.ineligibilityReasonList ?? [];
    const codes = reasons.map((x) => (typeof x === "string" ? x : x?.code)).filter(Boolean);
    const matched = codes.filter((c: string) => HAZMAT_CODES.has(c));
    const isHazmat = codes.some((c: string) => HAZMAT_CODES.has(c));

    console.log("--- PARSE TRACE (mirrors getCommingleHazmat) ---");
    console.log("payload.isEligibleForProgram:", isEligible);
    console.log("payload.ineligibilityReasonList (raw):", JSON.stringify(reasons));
    console.log("extracted codes:", JSON.stringify(codes));
    console.log("codes matching HAZMAT set {FBA_INB_0096,FBA_INB_0097}:", JSON.stringify(matched));
    console.log(">>> computed is_hazmat =", isHazmat);
  } catch (err: any) {
    console.log("HTTP status:", err.response?.status);
    console.log("ERROR body:", JSON.stringify(err.response?.data, null, 2) ?? err.message);
    console.log(">>> getCommingleHazmat would return: null (INCONCLUSIVE) — COALESCE keeps prior is_hazmat");
  }
  await new Promise((r) => setTimeout(r, 1500));
}

async function main() {
  for (const a of ASINS) await probe(a);
}
main().catch((e) => { console.error("FATAL", e?.message ?? e); process.exit(1); });
