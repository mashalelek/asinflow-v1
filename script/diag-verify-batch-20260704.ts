// DIAGNOSTIC ONLY — read-only. Probes each SKU from yesterday's batch via
// getListingsItem (summaries,issues) to classify live vs ghost and dump issues.
import "dotenv/config";
import { spApiGet } from "../server/spapi-auth";

const MKT = "ATVPDKIKX0DER";
const sellerId = process.env.SP_API_SELLER_ID!;
const BATCH: { asin: string; sku: string }[] = [
  { asin: "B08XMZQHFF", sku: "KIS-BPC-HFF-LCT-001" },
  { asin: "B003M1EE10", sku: "KRA-GRO-E10-CGT-001" },
  { asin: "B0FQKGTC6Y", sku: "MOR-GRO-C6Y-SSS-001" },
  { asin: "B00434MRG4", sku: "BET-GRO-RG4-THT-001" },
  { asin: "B09ZQ692W5", sku: "SPR-HEA-2W5-VSM-001" },
  { asin: "B00QLAAV5M", sku: "SPR-HEA-V5M-AGV-002" },
  { asin: "B09R7VZLV7", sku: "SPR-HEA-LV7-FFB-003" },
  { asin: "B07GWGB7QT", sku: "FUJ-ELE-7QT-QFO-001" },
];

async function main() {
  const summary: any[] = [];
  for (const { asin, sku } of BATCH) {
    try {
      const d = await spApiGet(`/listings/2021-08-01/items/${sellerId}/${encodeURIComponent(sku)}`, {
        marketplaceIds: MKT, includedData: "summaries,issues",
      });
      const status = d?.summaries?.[0]?.status ?? [];
      const issues = (d?.issues ?? []).map((i: any) => ({ code: i.code, sev: i.severity, msg: (i.message ?? "").slice(0, 90) }));
      const errors = issues.filter((i: any) => i.sev === "ERROR");
      const verdict = errors.length ? "GHOST/FAILED" : (status.length ? "LIVE" : "NO-STATUS");
      summary.push({ asin, sku, verdict, status, errors });
      console.log(`\n${asin}  ${sku}  → ${verdict}`);
      console.log(`  summaries[0].status: ${JSON.stringify(status)}`);
      if (issues.length) console.log(`  issues: ${JSON.stringify(issues, null, 1)}`);
    } catch (e: any) {
      const st = e?.response?.status;
      summary.push({ asin, sku, verdict: st === 404 ? "404-GONE" : `ERR-${st}`, status: [], errors: [] });
      console.log(`\n${asin}  ${sku}  → HTTP ${st}`);
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
  console.log("\n\n===== VERDICT TABLE =====");
  for (const s of summary) {
    const errCodes = s.errors.map((e: any) => e.code).join(",");
    console.log(`  ${s.asin}  ${s.sku.padEnd(20)} ${s.verdict.padEnd(12)} status=${JSON.stringify(s.status)} ${errCodes ? "errs=[" + errCodes + "]" : ""}`);
  }
  const ghosts = summary.filter((s) => s.verdict === "GHOST/FAILED" || s.verdict === "NO-STATUS");
  console.log(`\n  GHOSTS: ${ghosts.length}/${summary.length}  → ${ghosts.map((g) => g.asin).join(", ")}`);
}
main().catch((e) => { console.error("FATAL", e?.message ?? e); process.exit(1); });
