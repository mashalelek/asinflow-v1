/**
 * DIAGNOSTIC ONLY — read-only. No DB writes, no schema change, no fix.
 *
 * Calls getItemEligibilityPreview program=INBOUND for 7 ASINs spanning
 * TRUE-HAZMAT / DG-ONLY / NEITHER. Dumps the full raw payload and tests
 * whether ineligibility codes in the FBA_INB_0007..0016 range isolate the
 * 2 CO2 cylinders (true hazmat) from everything else.
 */
import "dotenv/config";
import axios from "axios";

const MARKETPLACE = "ATVPDKIKX0DER";

// The candidate is_hazmat range from Amazon discussion #3554.
const HAZMAT_RANGE = new Set(
  Array.from({ length: 10 }, (_, i) => `FBA_INB_${String(7 + i).padStart(4, "0")}`), // 0007..0016
);

const ASINS: { asin: string; state: string; label: string }[] = [
  { asin: "B082DM585M", state: "TRUE-HAZMAT", label: "SodaStream CO2" },
  { asin: "B077CH5Z57", state: "TRUE-HAZMAT", label: "Drinkmate CO2" },
  { asin: "B0DP94LJHL", state: "DG-ONLY",     label: "Lighter fluid" },
  { asin: "B07KH9SQKB", state: "DG-ONLY",     label: "Craftsman lithium battery" },
  { asin: "B079P76WWM", state: "DG-ONLY",     label: "Zara perfume" },
  { asin: "B07YX5971R", state: "NEITHER",     label: "Morton Salt Substitute" },
  { asin: "B0756KB8N1", state: "NEITHER",     label: "Keystone Canned Chicken" },
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

type Row = { asin: string; state: string; label: string; eligible: any; codes: string[]; inRange: string[]; err?: string };
const rows: Row[] = [];

async function probe(a: { asin: string; state: string; label: string }) {
  console.log(`\n================= ${a.asin} [${a.state}] ${a.label} =================`);
  const row: Row = { asin: a.asin, state: a.state, label: a.label, eligible: "?", codes: [], inRange: [] };
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

  console.log("\n\n######## SUMMARY ########");
  console.log("state       | asin       | eligible | codes                          | in 0007-0016");
  for (const r of rows) {
    const c = (s: any, w: number) => String(s).padEnd(w).slice(0, w);
    console.log(`${c(r.state,11)} | ${r.asin} | ${c(r.eligible,8)} | ${c(r.err ?? (r.codes.join(",") || "-"),30)} | ${r.inRange.join(",") || "none"}`);
  }
  const co2 = rows.filter((r) => r.state === "TRUE-HAZMAT");
  const other = rows.filter((r) => r.state !== "TRUE-HAZMAT");
  const co2AllInRange = co2.every((r) => r.inRange.length > 0);
  const otherNoneInRange = other.every((r) => r.inRange.length === 0);
  console.log(`\nKEY TEST — 0007..0016 isolates the 2 CO2? ${co2AllInRange && otherNoneInRange ? "YES ✓" : "NO ✗"}`);
  console.log(`  both CO2 have an in-range code: ${co2AllInRange}`);
  console.log(`  all non-hazmat have NO in-range code: ${otherNoneInRange}`);
}
main().catch((e) => { console.error("FATAL", e?.message ?? e); process.exit(1); });
