/**
 * DIAGNOSTIC ONLY — read-only. No DB writes, no schema change, no fix.
 *
 * Final validation before proposing the fix: getItemEligibilityPreview
 * program=INBOUND for the 3 DG-only ASINs not yet tested through INBOUND.
 * All are Hazmat=No per SellerAmp → NONE may return a code in FBA_INB_0007..0016.
 * If any fires in-range, the range over-flags and we must narrow it.
 */
import "dotenv/config";
import axios from "axios";

const MARKETPLACE = "ATVPDKIKX0DER";
const HAZMAT_RANGE = new Set(
  Array.from({ length: 10 }, (_, i) => `FBA_INB_${String(7 + i).padStart(4, "0")}`), // 0007..0016
);

const ASINS: { asin: string; label: string }[] = [
  { asin: "B08MWQ7ZNT", label: "Butane fuel canister (DG-only)" },
  { asin: "B0741FC121", label: "Rust-Oleum spray (DG-only)" },
  { asin: "B0FHP65413", label: "Sand+Fog perfume oil (DG-only)" },
];

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

type Row = { asin: string; label: string; eligible: any; codes: string[]; inRange: string[]; err?: string };
const rows: Row[] = [];

async function probe(a: { asin: string; label: string }) {
  console.log(`\n================= ${a.asin} ${a.label} =================`);
  const row: Row = { asin: a.asin, label: a.label, eligible: "?", codes: [], inRange: [] };
  let delay = 1500;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const t = await token();
      const res = await axios.get(
        "https://sellingpartnerapi-na.amazon.com/fba/inbound/v1/eligibility/itemPreview",
        { headers: { Authorization: `Bearer ${t}`, "x-amz-access-token": t },
          params: { asin: a.asin, program: "INBOUND", marketplaceIds: MARKETPLACE } },
      );
      console.log("RAW payload:", JSON.stringify(res.data?.payload, null, 2));
      const p = res.data?.payload ?? {};
      row.eligible = p.isEligibleForProgram;
      const reasons: any[] = p.ineligibilityReasonList ?? [];
      row.codes = reasons.map((x) => (typeof x === "string" ? x : x?.code)).filter(Boolean);
      row.inRange = row.codes.filter((c) => HAZMAT_RANGE.has(c));
      console.log(`isEligibleForProgram: ${row.eligible}`);
      console.log(`ineligibility codes: [${row.codes.join(", ") || "-"}]`);
      console.log(`codes in FBA_INB_0007..0016: [${row.inRange.join(", ") || "none"}]`);
      break;
    } catch (err: any) {
      const code = err.response?.data?.errors?.[0]?.code;
      if (code === "QuotaExceeded" && attempt < 3) { await new Promise((r) => setTimeout(r, delay)); delay *= 2; continue; }
      row.err = `HTTP ${err.response?.status}: ${JSON.stringify(err.response?.data?.errors ?? err.message)}`;
      console.log("ERROR:", row.err);
      break;
    }
  }
  rows.push(row);
  await new Promise((r) => setTimeout(r, 1500));
}

async function main() {
  for (const a of ASINS) await probe(a);
  console.log("\n\n######## VALIDATION SUMMARY ########");
  let anyInRange = false;
  for (const r of rows) {
    if (r.inRange.length) anyInRange = true;
    console.log(`${r.asin} | eligible=${r.eligible} | codes=[${r.err ?? (r.codes.join(",") || "-")}] | inRange=[${r.inRange.join(",") || "none"}]`);
  }
  console.log(`\nAny DG-only ASIN fired in FBA_INB_0007..0016? ${anyInRange ? "YES ✗ — RANGE OVER-FLAGS, STOP" : "NO ✓ — range holds"}`);
}
main().catch((e) => { console.error("FATAL", e?.message ?? e); process.exit(1); });
