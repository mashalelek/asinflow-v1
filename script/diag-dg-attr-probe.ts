/**
 * DIAGNOSTIC ONLY — read-only. No DB writes, no fixes.
 *
 * Dumps the RAW catalog attributes for a set of ASINs so we can locate the
 * authoritative dangerous-goods / hazmat classification field and SEE whether
 * it discriminates non-hazmat (grocery) vs genuinely-hazmat (aerosol/fragrance)
 * ASINs. We do NOT assume the field path — we dump every attribute key and
 * surface anything matching a DG/hazmat/flammable/battery/safety regex.
 */
import "dotenv/config";
import axios from "axios";

const MARKETPLACE = "ATVPDKIKX0DER";

// disputed non-hazmat (grocery)      | genuine-hazmat candidates (aerosol/fragrance)
const ASINS: { asin: string; expect: string; label: string }[] = [
  { asin: "B07YX5971R", expect: "NOT hazmat", label: "Morton Salt Substitute (grocery)" },
  { asin: "B0756KB8N1", expect: "NOT hazmat", label: "Keystone Canned Chicken (grocery)" },
  { asin: "B0FTKHZ8H8", expect: "NOT hazmat", label: "Kinder's BBQ Sauce (grocery)" },
  { asin: "B07QZZB4C1", expect: "HAZMAT?",    label: "Spectracide Pruning Seal AEROSOL" },
  { asin: "B00367HAV6", expect: "HAZMAT?",    label: "SpectraFix Fixative SPRAY (aerosol)" },
  { asin: "B0FHN5SWFV", expect: "HAZMAT?",    label: "Sand+Fog Perfume Eau de Parfum" },
];

// Keys anywhere in the attributes object that could carry DG/hazmat meaning.
const DG_KEY_RE = /(dg|hazmat|hazard|dangerous|flammab|hz_regulation|ghs|battery|batteries|lithium|aerosol|pesticide|safety_data|compliance|regulat)/i;

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

async function probe(a: { asin: string; expect: string; label: string }) {
  console.log(`\n================= ${a.asin}  [expect: ${a.expect}] =================`);
  console.log(a.label);
  try {
    const t = await token();
    const res = await axios.get(
      `https://sellingpartnerapi-na.amazon.com/catalog/2022-04-01/items/${a.asin}`,
      {
        headers: { Authorization: `Bearer ${t}`, "x-amz-access-token": t },
        params: { marketplaceIds: MARKETPLACE, includedData: "attributes,productTypes,summaries" },
      },
    );
    const attrs = res.data?.attributes ?? {};
    const productType = res.data?.summaries?.[0]?.itemClassification
      ?? res.data?.productTypes?.[0]?.productType;
    console.log("productType:", JSON.stringify(res.data?.productTypes));
    console.log("total attribute keys:", Object.keys(attrs).length);

    // 1. surface any DG/hazmat-ish key with its RAW value + exact path
    const hits = Object.keys(attrs).filter((k) => DG_KEY_RE.test(k)).sort();
    if (hits.length === 0) {
      console.log("!! NO attribute key matched the DG/hazmat regex");
    } else {
      console.log("DG/hazmat-ish attribute keys found:");
      for (const k of hits) {
        console.log(`   attributes.${k} = ${JSON.stringify(attrs[k])}`);
      }
    }
    // 2. the specific field the offer-add validator uses
    const declared = attrs["supplier_declared_dg_hz_regulation"];
    console.log("EXACT: attributes.supplier_declared_dg_hz_regulation =", JSON.stringify(declared));

    // 3. full key list (so we can eyeball anything the regex missed)
    console.log("ALL attribute keys:", Object.keys(attrs).sort().join(", "));
  } catch (err: any) {
    console.log("HTTP status:", err.response?.status);
    console.log("ERROR:", JSON.stringify(err.response?.data) ?? err.message);
  }
  await new Promise((r) => setTimeout(r, 1500));
}

async function main() {
  for (const a of ASINS) await probe(a);
}
main().catch((e) => { console.error("FATAL", e?.message ?? e); process.exit(1); });
