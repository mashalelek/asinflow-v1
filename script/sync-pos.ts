// Sync POs from the shell — the PO half of POST /api/sheets/sync (intake of
// new POs, and the Col P refresh of po_sheet_fba_shipments). Never writes an
// existing PO.
//
//   tsx script/sync-pos.ts           # dry run
//   tsx script/sync-pos.ts --live
//
// Needs GOOGLE_SHEET_ID / GOOGLE_CREDENTIALS_PATH and DATABASE_URL. Then run
// script/sync-shipments.ts so the Col P signal is used.
import "dotenv/config";
import pool from "../server/db";
import { syncPoSheet } from "../server/po-sheet-sync";

async function main() {
  const dryRun = !process.argv.includes("--live");
  const sheetId = process.env.GOOGLE_SHEET_ID;
  if (!sheetId) throw new Error("GOOGLE_SHEET_ID not set");
  const r = await syncPoSheet({ sheetId, dryRun });
  console.log(`Sync POs ${dryRun ? "DRY RUN" : "live"}: wrote=${r.wrote} stop=${r.stop ?? "-"}`);
  console.log(JSON.stringify(r.counts));
  for (const d of r.diffs.filter((x) => x.kind === "insert")) console.log(`  insert ${d.po}`);
  if (r.unmapped.length) console.log(`  unmapped: ${r.unmapped.map((u) => `${u.po} [${u.tokens.join(", ")}]`).join("; ")}`);
}

main()
  .catch((e) => { console.error("FATAL", e?.message ?? e); process.exitCode = 1; })
  .finally(() => pool.end());
