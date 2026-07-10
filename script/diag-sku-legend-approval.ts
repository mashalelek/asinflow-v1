// Integration smoke for the bulk legend approval flow.
//
// Wraps the entire run in BEGIN/ROLLBACK so the real DB is unchanged after.
// Exercises every action variant against real sku_legend / sku_legend_alias.

import "dotenv/config";
import pool from "../server/db";
import {
  processBulkApproval,
  makeProductionHandlers,
  type ApprovalItem,
} from "../server/sku-legend-approval";

(async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Snapshot pre-state for AMG and AminoGenesis Cosmetics (from migration 011 seed)
    console.log("─── PRE-STATE ──────────────────────────────────────────");
    const preLegend = await client.query(
      `SELECT type, raw_value, code, status FROM sku_legend WHERE type='brand' ORDER BY raw_value`,
    );
    console.log("Approved brands (pre):");
    for (const r of preLegend.rows) console.log(`  ${r.raw_value} → ${r.code} (${r.status})`);

    // ─── Bulk batch: every action variant + the critical merge-dep case ───
    const items: ApprovalItem[] = [
      // 1. approve_new — fresh brand (Patagonia → PAT)
      { type: "brand", rawValue: "TestPatagonia", action: "approve_new", code: "TPA" },

      // 2. merge — into pre-existing AminoGenesis (works regardless of phase order)
      { type: "brand", rawValue: "AminoGenesis Skincare Inc", action: "merge", intoRawValue: "AminoGenesis" },

      // 3. approve_new — then merge into it (same-batch dependency, should succeed)
      { type: "brand", rawValue: "TestCerMedia", action: "approve_new", code: "TCE" },
      { type: "brand", rawValue: "TestMarinePure", action: "merge", intoRawValue: "TestCerMedia" },

      // 4. approve_new that WILL FAIL (code already used) → dependent merge → merge_target_failed
      { type: "brand", rawValue: "BrandWithBadCode", action: "approve_new", code: "AMG" }, // AMG is taken
      { type: "brand", rawValue: "MergeIntoFailed", action: "merge", intoRawValue: "BrandWithBadCode" },

      // 5. dept approve_new (new dept code)
      { type: "dept", rawValue: "Test Dept Category", action: "approve_new", code: "TDC" },

      // 6. merge target_not_found (rawValue not in any approval/legend)
      { type: "brand", rawValue: "OrphanMerge", action: "merge", intoRawValue: "NeverHeardOfBrand" },

      // 7. Idempotent re-approve: try to approve_new AminoGenesis again with same code
      { type: "brand", rawValue: "AminoGenesis", action: "approve_new", code: "AMG" },
    ];

    console.log("\n─── BULK BATCH ─────────────────────────────────────────");
    console.log(`Sending ${items.length} items through processBulkApproval...`);

    const handlers = makeProductionHandlers(client);
    const results = await processBulkApproval(items, handlers);

    console.log("\n─── RESULTS (position-correlated with input) ──────────");
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const r = results[i];
      const label = it.action.padEnd(18);
      const status = r.outcome.padEnd(16);
      let extra = "";
      if (r.outcome === "created" || r.outcome === "updated" || r.outcome === "already_approved") {
        extra = ` code=${r.code}`;
      } else if (r.outcome === "merged" || r.outcome === "already_merged") {
        extra = ` intoCode=${r.intoCode}`;
      } else if (r.outcome === "error") {
        extra = ` reason=${r.reason}  ${r.message}`;
      }
      console.log(`  [${i}] ${label} ${it.rawValue.padEnd(32)} → ${status}${extra}`);
    }

    console.log("\n─── EXPECTATIONS ──────────────────────────────────────");
    const expect = (cond: boolean, label: string) =>
      console.log(`  ${cond ? "✓" : "✗"} ${label}`);

    expect(results[0].outcome === "created", "TestPatagonia → created");
    expect(results[1].outcome === "merged", "AminoGenesis Skincare Inc → merged");
    expect(results[2].outcome === "created", "TestCerMedia → created");
    expect(results[3].outcome === "merged", "TestMarinePure → merged (same-batch target)");
    expect(results[4].outcome === "error" && (results[4] as any).reason === "code_collision", "BrandWithBadCode → code_collision (AMG taken)");
    expect(results[5].outcome === "error" && (results[5] as any).reason === "merge_target_failed", "MergeIntoFailed → merge_target_failed (CRITICAL: dependent failure surfaced)");
    expect(results[6].outcome === "created", "Test Dept Category → created (dept)");
    expect(results[7].outcome === "error" && (results[7] as any).reason === "target_not_found", "OrphanMerge → target_not_found");
    expect(results[8].outcome === "already_approved", "AminoGenesis (re-approve) → already_approved (idempotent)");

    console.log("\n─── POST-STATE (inside transaction, will be ROLLED BACK) ───");
    const postLegend = await client.query(
      `SELECT type, raw_value, code, status FROM sku_legend WHERE type IN ('brand','dept') ORDER BY type, raw_value`,
    );
    const newBrands = postLegend.rows.filter((r: any) => r.raw_value.startsWith("Test") || r.raw_value === "Test Dept Category");
    console.log(`New rows created this batch: ${newBrands.length}`);
    for (const r of newBrands) console.log(`  ${r.type} ${r.raw_value} → ${r.code} (${r.status})`);

    const newAliases = await client.query(
      `SELECT raw_value, note FROM sku_legend_alias WHERE raw_value ILIKE 'Test%' OR raw_value ILIKE 'AminoGenesis Skincare%' OR raw_value = 'AminoGenesis' ORDER BY raw_value`,
    );
    console.log(`\nNew alias rows: ${newAliases.rows.length}`);
    for (const r of newAliases.rows) console.log(`  ${r.raw_value}  note: ${r.note}`);

    await client.query("ROLLBACK");
    console.log("\n✓ ROLLBACK — nothing persisted.");
  } finally {
    client.release();
    await pool.end();
  }
})().catch(async (err) => {
  console.error("Smoke failed:", err.message);
  try { await pool.end(); } catch {}
  process.exit(1);
});
