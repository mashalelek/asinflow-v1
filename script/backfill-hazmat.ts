/**
 * One-time hazmat backfill (cutover step 5).
 *
 * Re-detects hazmat for every ASIN via getItemEligibilityPreview
 * (program=COMMINGLING) and writes is_hazmat. Mirrors getCommingleHazmat in
 * server/spapi.ts exactly. Uses direct axios + pg (NOT an import of spapi.ts,
 * which would boot a second Express server and clash with the dev server).
 *
 * Tri-state: true/false → UPDATE; null (throttle/error) → SKIP (never clobber
 * via the COALESCE contract). Inconclusive ASINs get a second pass at the end.
 *
 * Run in background:  npx tsx script/backfill-hazmat.ts
 */
import "dotenv/config";
import axios from "axios";
import pg from "pg";

const MARKETPLACE = "ATVPDKIKX0DER";
const HAZMAT_CODES = new Set(["FBA_INB_0096", "FBA_INB_0097"]);
const BASE_DELAY_MS = 1100;

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Returns true | false | null(inconclusive). Mirrors server/spapi.ts.
async function detect(asin: string): Promise<boolean | null> {
  let delay = 2000;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const t = await token();
      const res = await axios.get(
        "https://sellingpartnerapi-na.amazon.com/fba/inbound/v1/eligibility/itemPreview",
        {
          headers: { Authorization: `Bearer ${t}`, "x-amz-access-token": t },
          params: { asin, program: "COMMINGLING", marketplaceIds: MARKETPLACE },
        },
      );
      const reasons: any[] = res.data?.payload?.ineligibilityReasonList ?? [];
      const codes = reasons.map((x) => (typeof x === "string" ? x : x?.code)).filter(Boolean);
      return codes.some((c: string) => HAZMAT_CODES.has(c));
    } catch (err: any) {
      const code = err.response?.data?.errors?.[0]?.code;
      if (code === "QuotaExceeded" && attempt < 5) {
        await sleep(delay);
        delay = Math.min(delay * 2, 30000);
        continue;
      }
      return null;
    }
  }
  return null;
}

async function runPass(asins: string[], label: string) {
  let trueN = 0, falseN = 0, inconc: string[] = [], i = 0;
  for (const asin of asins) {
    i++;
    const r = await detect(asin);
    if (r === null) {
      inconc.push(asin);
    } else {
      await pool.query(`UPDATE asins SET is_hazmat = $1 WHERE asin = $2`, [r, asin]);
      r ? trueN++ : falseN++;
    }
    if (i % 50 === 0 || i === asins.length) {
      console.log(`[${label}] ${i}/${asins.length} | hazmat=${trueN} clear=${falseN} inconclusive=${inconc.length}`);
    }
    await sleep(BASE_DELAY_MS);
  }
  return { trueN, falseN, inconc };
}

async function main() {
  const start = Date.now();
  const { rows } = await pool.query(`SELECT asin FROM asins ORDER BY asin`);
  const asins = rows.map((x) => x.asin as string);
  console.log(`Backfill start: ${asins.length} ASINs @ ~${BASE_DELAY_MS}ms cadence`);

  const p1 = await runPass(asins, "pass1");
  let p2 = { trueN: 0, falseN: 0, inconc: p1.inconc };
  if (p1.inconc.length > 0) {
    console.log(`Pass 2 retrying ${p1.inconc.length} inconclusive ASINs...`);
    p2 = await runPass(p1.inconc, "pass2");
  }

  const totalTrue = (await pool.query(`SELECT count(*)::int n FROM asins WHERE is_hazmat = true`)).rows[0].n;
  const totalInconc = p2.inconc.length;
  const mins = ((Date.now() - start) / 60000).toFixed(1);
  console.log("==== BACKFILL COMPLETE ====");
  console.log(`Duration: ${mins} min`);
  console.log(`Final is_hazmat=true in DB: ${totalTrue} / ${asins.length}`);
  console.log(`Still inconclusive (left at prior value = false): ${totalInconc}`);
  if (totalInconc > 0) console.log(`Inconclusive ASINs: ${p2.inconc.join(",")}`);
  await pool.end();
}

main().catch((e) => { console.error("FATAL", e?.message ?? e); process.exit(1); });
