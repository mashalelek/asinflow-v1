/**
 * DIAGNOSTIC ONLY — read-only. No DB writes, no schema change, no fix.
 *
 * 9 ASINs spanning NEITHER / DG-ONLY / BOTH. Pull getCatalogItem with all
 * includedData, recursively surface every hazmat/DG field, and break down the
 * `hazmat` array by aspect so we can see whether any single field/value isolates
 * true-Hazmat (CO2 cylinders) from DG-only.
 */
import "dotenv/config";
import axios from "axios";

const MARKETPLACE = "ATVPDKIKX0DER";
const INCLUDED = "attributes,dimensions,identifiers,productTypes,relationships,salesRanks,summaries,classifications";

const ASINS: { asin: string; state: string; label: string }[] = [
  { asin: "B07YX5971R", state: "NEITHER",  label: "Morton Salt Substitute" },
  { asin: "B0756KB8N1", state: "NEITHER",  label: "Keystone Canned Chicken" },
  { asin: "B079P76WWM", state: "NEITHER",  label: "Zara perfume" },
  { asin: "B0DP94LJHL", state: "DG-ONLY",  label: "Charcoal lighter fluid" },
  { asin: "B08MWQ7ZNT", state: "DG-ONLY",  label: "Butane fuel canister" },
  { asin: "B0741FC121", state: "DG-ONLY",  label: "Rust-Oleum spray" },
  { asin: "B07KH9SQKB", state: "DG-ONLY",  label: "Craftsman lithium battery" },
  { asin: "B082DM585M", state: "BOTH",     label: "SodaStream CO2 cylinders" },
  { asin: "B077CH5Z57", state: "BOTH",     label: "Drinkmate CO2 cylinders" },
];

const KEY_RE = /(hazmat|dangerous|(^|_)dg($|_)|regulation|liquid_volume|liquidvolume|shipping_name)/i;

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

function walk(node: any, path: string, hits: Record<string, any>) {
  if (node == null || typeof node !== "object") return;
  if (Array.isArray(node)) { node.forEach((v, i) => walk(v, `${path}[${i}]`, hits)); return; }
  for (const [k, v] of Object.entries(node)) {
    const child = path ? `${path}.${k}` : k;
    if (KEY_RE.test(k)) hits[child] = v;
    walk(v, child, hits);
  }
}

// pull the distinct non-exception aspects + the set of exception values
function summarizeHazmat(arr: any[]): {
  psn?: string; un?: string; pg?: string; cls?: string;
  exceptions: string[]; otherAspects: string[];
} {
  const out: any = { exceptions: [] as string[], otherAspects: [] as string[] };
  for (const e of arr) {
    const a = e?.aspect, v = e?.value;
    if (a === "proper_shipping_name") out.psn = v;
    else if (a === "united_nations_regulatory_id") out.un = v;
    else if (a === "regulatory_packing_group") out.pg = v;
    else if (a === "transportation_regulatory_class") out.cls = v;
    else if (a === "exception") out.exceptions.push(v);
    else out.otherAspects.push(`${a}=${v}`);
  }
  return out;
}

type Row = {
  asin: string; state: string; label: string;
  hazmatPresent: boolean; hz: any;
  supplierDeclared: string; isHazmat: string; dangerousGoods: string; liquidVolume: string;
  extraPaths: string[];
};
const rows: Row[] = [];

async function probe(a: { asin: string; state: string; label: string }) {
  const row: Row = {
    asin: a.asin, state: a.state, label: a.label,
    hazmatPresent: false, hz: null,
    supplierDeclared: "absent", isHazmat: "absent", dangerousGoods: "absent", liquidVolume: "absent",
    extraPaths: [],
  };
  try {
    const t = await token();
    const res = await axios.get(
      `https://sellingpartnerapi-na.amazon.com/catalog/2022-04-01/items/${a.asin}`,
      { headers: { Authorization: `Bearer ${t}`, "x-amz-access-token": t },
        params: { marketplaceIds: MARKETPLACE, includedData: INCLUDED } },
    );
    const attrs = res.data?.attributes ?? {};
    if (Array.isArray(attrs.hazmat) && attrs.hazmat.length) {
      row.hazmatPresent = true;
      row.hz = summarizeHazmat(attrs.hazmat);
    }
    if (attrs.supplier_declared_dg_hz_regulation)
      row.supplierDeclared = attrs.supplier_declared_dg_hz_regulation.map((x: any) => x.value).join("|");
    if (attrs.liquid_volume) row.liquidVolume = JSON.stringify(attrs.liquid_volume);

    // scan whole tree for IsHazmat / DangerousGoodsDetails and anything else
    const hits: Record<string, any> = {};
    walk(res.data, "", hits);
    for (const [p, v] of Object.entries(hits)) {
      if (/ishazmat|is_hazmat/i.test(p)) row.isHazmat = JSON.stringify(v);
      else if (/dangerous/i.test(p)) row.dangerousGoods = JSON.stringify(v);
      else if (!/(^|\.)attributes\.hazmat|supplier_declared_dg|liquid_volume|shipping_name/i.test(p))
        row.extraPaths.push(`${p}=${JSON.stringify(v)}`);
    }
  } catch (err: any) {
    row.hazmatPresent = false;
    row.supplierDeclared = `ERROR ${err.response?.status}: ${JSON.stringify(err.response?.data?.errors ?? err.message)}`;
  }
  rows.push(row);
  await new Promise((r) => setTimeout(r, 1400));
}

async function main() {
  for (const a of ASINS) await probe(a);

  console.log("######## RAW hazmat-array breakdown per ASIN ########");
  for (const r of rows) {
    console.log(`\n${r.asin} [${r.state}] ${r.label}`);
    if (!r.hazmatPresent) { console.log("  attributes.hazmat: ABSENT"); }
    else {
      console.log(`  attributes.hazmat: PRESENT`);
      console.log(`     proper_shipping_name: ${r.hz.psn ?? "-"}`);
      console.log(`     UN id:                ${r.hz.un ?? "-"}`);
      console.log(`     transport class:      ${r.hz.cls ?? "-"}`);
      console.log(`     packing group:        ${r.hz.pg ?? "-"}`);
      console.log(`     exceptions (${r.hz.exceptions.length}): ${r.hz.exceptions.join(",") || "-"}`);
      const hasNonLQ = r.hz.exceptions.some((e: string) => !/LimitedQuantity|GroundOnly|ORMD|ORM_D/i.test(e));
      console.log(`     any NON-limited-qty exception? ${hasNonLQ}`);
      if (r.hz.otherAspects.length) console.log(`     other aspects: ${r.hz.otherAspects.join(", ")}`);
    }
    console.log(`  supplier_declared_dg_hz_regulation: ${r.supplierDeclared}`);
    console.log(`  IsHazmat: ${r.isHazmat}   DangerousGoodsDetails: ${r.dangerousGoods}   liquid_volume: ${r.liquidVolume}`);
    if (r.extraPaths.length) console.log(`  OTHER matching paths: ${r.extraPaths.join(" | ")}`);
  }

  console.log("\n\n######## COMPACT MATRIX ########");
  console.log("state    | asin       | hazmat[] | transp_class | UN      | pkg_grp | supplier_declared | IsHazmat | DGDetails");
  for (const r of rows) {
    const c = (s: any, w: number) => String(s).padEnd(w).slice(0, w);
    console.log(
      `${c(r.state,8)} | ${r.asin} | ${c(r.hazmatPresent ? "PRESENT":"absent",8)} | ${c(r.hz?.cls ?? "-",12)} | ${c(r.hz?.un ?? "-",7)} | ${c(r.hz?.pg ?? "-",7)} | ${c(r.supplierDeclared,17)} | ${c(r.isHazmat,8)} | ${c(r.dangerousGoods,9)}`,
    );
  }
}
main().catch((e) => { console.error("FATAL", e?.message ?? e); process.exit(1); });
