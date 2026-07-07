// LIVE PUSH — POSTs { cost } to Aura for PUSH-verdict rows. Required --limit
// flag (a number, or `all`). Writes only to Aura (no AF DB writes).
//
//   npx tsx script/aura-push.ts --limit=25      (first run)
//   npx tsx script/aura-push.ts --limit=all
import "dotenv/config";
import { pushAuraCosts, fmtCost } from "../server/aura-cost-sync";

function parseLimit(): number | "all" {
  const arg = process.argv.find((a) => a.startsWith("--limit="));
  if (!arg) {
    console.error("ERROR: --limit is required (e.g. --limit=25, or --limit=all). First run should be --limit=25.");
    process.exit(1);
  }
  const val = arg.split("=")[1];
  if (val === "all") return "all";
  const n = parseInt(val, 10);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`ERROR: invalid --limit=${val}. Use a positive integer or 'all'.`);
    process.exit(1);
  }
  return n;
}

(async () => {
  const limit = parseLimit();
  console.log(`=== AURA COST PUSH — LIVE (--limit=${limit}) ===\n`);

  const r = await pushAuraCosts({ limit });

  console.log("=== REPORT ===");
  console.log(`  attempted (PUSH rows this run): ${r.attempted}`);
  console.log(`  pushed:                         ${r.pushed}`);
  console.log(`  failed:                         ${r.failed}`);
  console.log(`  skipped (SKIP:* + UNCHANGED):   ${r.skipped}`);
  console.log(`  PUSH remaining (beyond limit):  ${r.remaining}`);
  console.log(`  write variant used:             ${JSON.stringify(r.variantsUsed)}`);

  if (r.failures.length) {
    console.log(`\n=== FAILED ROWS (${r.failures.length}) ===`);
    for (const f of r.failures) {
      const body = typeof f.body === "string" ? f.body : JSON.stringify(f.body);
      console.log(`  ${f.id} | sku=${f.sku} | asin=${f.asin ?? "—"} | sent=${fmtCost(f.sentCost)} | HTTP ${f.status} | variant=${f.variant} | resp.cost=${f.respCost} | ${body?.slice(0, 400)}`);
    }
  } else {
    console.log(`\n=== FAILED ROWS: none ===`);
  }

  console.log(`\n=== READ-BACK (${r.readback.length} of pushed) — stored vs sent ===`);
  for (const rb of r.readback) {
    const stored = typeof rb.stored === "number" ? fmtCost(rb.stored) : String(rb.stored);
    console.log(`  ${rb.id} | sku=${rb.sku} | sent=${fmtCost(rb.sent)} | stored=${stored} | ${rb.match ? "MATCH ✓" : "MISMATCH ✗"}`);
  }
  process.exit(0);
})().catch((e) => { console.error("PUSH FAILED:", e?.message ?? e); process.exit(1); });
