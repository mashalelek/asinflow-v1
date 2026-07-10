// DIAGNOSTIC ONLY — read-only. Re-probe the 4 non-clean SKUs from the first
// audit to test whether their bad states were transient (mid-processing).
import "dotenv/config";
import { spApiGet } from "../server/spapi-auth";

const MKT = "ATVPDKIKX0DER";
const sellerId = process.env.SP_API_SELLER_ID!;
const SKUS: { asin: string; sku: string; firstAudit: string }[] = [
  { asin: "B09ZQ692W5", sku: "SPR-HEA-2W5-VSM-001", firstAudit: "DISCOVERABLE + WARN 18448" },
  { asin: "B00QLAAV5M", sku: "SPR-HEA-V5M-AGV-002", firstAudit: "DISCOVERABLE clean" },
  { asin: "B0FQKGTC6Y", sku: "MOR-GRO-C6Y-SSS-001", firstAudit: "DISCOVERABLE + ERROR 18555" },
  { asin: "B00434MRG4", sku: "BET-GRO-RG4-THT-001", firstAudit: "HTTP 404" },
];

async function main() {
  for (const { asin, sku, firstAudit } of SKUS) {
    console.log(`\n===== ${asin}  ${sku} =====`);
    console.log(`  first audit: ${firstAudit}`);
    try {
      const d = await spApiGet(`/listings/2021-08-01/items/${sellerId}/${encodeURIComponent(sku)}`, {
        marketplaceIds: MKT, includedData: "summaries,issues,offers,fulfillmentAvailability",
      });
      const status = d?.summaries?.[0]?.status ?? [];
      const issues = (d?.issues ?? []).map((i: any) => `${i.code}/${i.severity}: ${(i.message ?? "").slice(0, 60)}`);
      const has8541 = (d?.issues ?? []).some((i: any) => String(i.code) === "8541");
      console.log(`  NOW status:  ${JSON.stringify(status)}`);
      console.log(`  offers:      ${(d?.offers ?? []).length} | fulfillmentAvailability: ${(d?.fulfillmentAvailability ?? []).length}`);
      console.log(`  issues NOW:  ${issues.length ? JSON.stringify(issues, null, 1) : "none"}`);
      console.log(`  8541 present now? ${has8541 ? "YES" : "no"}`);
      const errs = (d?.issues ?? []).filter((i: any) => i.severity === "ERROR");
      console.log(`  → verdict: ${errs.length ? "ERROR present" : (status.length ? "LIVE (no ERROR)" : "NO-STATUS")}`);
    } catch (e: any) {
      console.log(`  NOW: HTTP ${e?.response?.status}`);
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
}
main().catch((e) => { console.error("FATAL", e?.message ?? e); process.exit(1); });
