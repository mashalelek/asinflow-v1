/**
 * DIAGNOSTIC ONLY — read-only. No DB writes, no schema change, no fix.
 *
 * For 5 ASINs, pull getCatalogItem with ALL includedData and recursively
 * surface EVERY field whose key matches hazmat/dangerous/dg/regulation/liquid.
 * We do not assume where the DG data lives — we walk the whole response tree.
 */
import "dotenv/config";
import axios from "axios";

const MARKETPLACE = "ATVPDKIKX0DER";
const INCLUDED = "attributes,dimensions,identifiers,productTypes,relationships,salesRanks,summaries,classifications";

const ASINS: { asin: string; group: string; label: string }[] = [
  { asin: "B07YX5971R", group: "NON-HAZMAT", label: "Morton Salt Substitute" },
  { asin: "B0756KB8N1", group: "NON-HAZMAT", label: "Keystone Canned Chicken" },
  { asin: "B0FTKHZ8H8", group: "NON-HAZMAT", label: "Kinder's BBQ Sauce" },
  { asin: "B0FHP65413", group: "DG (SellerAmp: Hazmat=No, DG=Yes)", label: "Sand + Fog perfume oil" },
  { asin: "B07QZZB4C1", group: "DG (SellerAmp: Hazmat=No, DG=Yes)", label: "Spectracide aerosol" },
];

const KEY_RE = /(hazmat|dangerous|(^|_)dg($|_)|regulation|liquid_volume|liquidvolume|un_?regulat|shipping_name)/i;

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

// Recursively collect { path -> value } for any object key matching KEY_RE.
function walk(node: any, path: string, hits: Record<string, any>) {
  if (node == null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    node.forEach((v, i) => walk(v, `${path}[${i}]`, hits));
    return;
  }
  for (const [k, v] of Object.entries(node)) {
    const child = path ? `${path}.${k}` : k;
    if (KEY_RE.test(k)) hits[child] = v;
    walk(v, child, hits);
  }
}

type Row = {
  asin: string; group: string;
  hazmatArray: any; supplierDeclared: any; isHazmat: any;
  dangerousGoods: any; liquidVolume: any; otherHits: string[];
};
const rows: Row[] = [];

async function probe(a: { asin: string; group: string; label: string }) {
  console.log(`\n================= ${a.asin}  [${a.group}] =================`);
  console.log(a.label);
  const row: Row = {
    asin: a.asin, group: a.group,
    hazmatArray: "—", supplierDeclared: "—", isHazmat: "—",
    dangerousGoods: "—", liquidVolume: "—", otherHits: [],
  };
  try {
    const t = await token();
    const res = await axios.get(
      `https://sellingpartnerapi-na.amazon.com/catalog/2022-04-01/items/${a.asin}`,
      {
        headers: { Authorization: `Bearer ${t}`, "x-amz-access-token": t },
        params: { marketplaceIds: MARKETPLACE, includedData: INCLUDED },
      },
    );
    const hits: Record<string, any> = {};
    walk(res.data, "", hits);

    console.log("DG/hazmat-matching field paths (raw):");
    if (Object.keys(hits).length === 0) console.log("   (none)");
    for (const [p, v] of Object.entries(hits)) {
      console.log(`   ${p} = ${JSON.stringify(v)}`);
    }

    // Bucket the well-known fields for the summary table.
    const attrs = res.data?.attributes ?? {};
    row.hazmatArray = attrs.hazmat ? JSON.stringify(attrs.hazmat) : "absent";
    row.supplierDeclared = attrs.supplier_declared_dg_hz_regulation
      ? attrs.supplier_declared_dg_hz_regulation.map((x: any) => x.value).join("|") : "absent";
    // IsHazmat / DangerousGoodsDetails / LiquidVolume can appear anywhere — scan hits + summaries.
    for (const [p, v] of Object.entries(hits)) {
      if (/ishazmat|is_hazmat/i.test(p)) row.isHazmat = JSON.stringify(v);
      if (/dangerous/i.test(p)) row.dangerousGoods = JSON.stringify(v);
      if (/liquid_volume|liquidvolume/i.test(p)) row.liquidVolume = JSON.stringify(v);
      if (!/hazmat|supplier_declared_dg|dangerous|liquid_volume/i.test(p)) row.otherHits.push(p);
    }
    const summaries = res.data?.summaries?.[0] ?? {};
    for (const [k, v] of Object.entries(summaries)) {
      if (/hazmat|dangerous|dg/i.test(k)) row.otherHits.push(`summaries[0].${k}=${JSON.stringify(v)}`);
    }
  } catch (err: any) {
    console.log("HTTP status:", err.response?.status, "ERROR:", JSON.stringify(err.response?.data) ?? err.message);
    row.hazmatArray = `ERROR ${err.response?.status}`;
  }
  rows.push(row);
  await new Promise((r) => setTimeout(r, 1500));
}

async function main() {
  for (const a of ASINS) await probe(a);

  console.log("\n\n######## SUMMARY TABLE ########");
  for (const r of rows) {
    console.log(`\n${r.asin}  [${r.group}]`);
    console.log(`  attributes.hazmat:                        ${r.hazmatArray === "absent" ? "absent" : "PRESENT"}`);
    console.log(`  attributes.supplier_declared_dg_hz_reg:   ${r.supplierDeclared}`);
    console.log(`  IsHazmat attribute:                       ${r.isHazmat}`);
    console.log(`  DangerousGoodsDetails:                    ${r.dangerousGoods}`);
    console.log(`  LiquidVolume:                             ${r.liquidVolume}`);
    if (r.otherHits.length) console.log(`  other matching paths:                     ${r.otherHits.join(", ")}`);
  }
}
main().catch((e) => { console.error("FATAL", e?.message ?? e); process.exit(1); });
