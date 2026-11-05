// Supplier verification from the shell (SPEC §11 "Supplier verification"): the panel's Verify supplier, for one supplier.
// Dry run by default — the one Claude call (web search) and its po_prefill_log row (supplier_check), the result
// printed, nothing stored on the supplier. --live stores it as the panel does. Needs ANTHROPIC_API_KEY (--prod has it).
//   npm run supplier:check -- --supplier perfectlyhealthy.com [--prod] [--live]
import "./env";
import { Pool } from "pg";
import { aiAvailable, AI_OFF_MESSAGE } from "../server/config/ai";
import { runSupplierCheck } from "../server/supplier-check";

const arg = (k: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : undefined; };
(async () => {
  const supplier = arg("--supplier");
  if (!supplier) { console.error("--supplier <domain> is required"); process.exit(2); }
  if (!aiAvailable()) { console.error(AI_OFF_MESSAGE); process.exit(2); }
  const live = process.argv.includes("--live");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: /render\.com/.test(process.env.DATABASE_URL ?? "") ? { rejectUnauthorized: false } : undefined });
  try {
    const r = await runSupplierCheck((t, p) => pool.query(t, p), supplier, null, {}, new Date(), { store: live });
    console.log(live ? "LIVE — stored on the supplier" : "DRY RUN — nothing stored (the call is logged)");
    console.log(JSON.stringify(r, null, 2));
  } finally { await pool.end(); }
})();
