// DA-4 substep 2 verification: NNN allocator against real asin_skus.
//
// 1. Scan asin_skus, count conforming vs non-conforming (validates discriminator).
// 2. For each (BRD, DEP) bucket with conforming SKUs: show max + next 3 hypothetical.
// 3. Synthetic demo of batch sequencing, gap-not-filled, retired-not-reused, 999 overflow.
//
// Read-only — no DB writes, no wiring to anything.

import "dotenv/config";
import pool, { query } from "../server/db";
import {
  assignNnns,
  parseConformingSku,
  buildExistingNnnsFromSkus,
  type ExistingNnns,
} from "../shared/nnn-assignment";

function showOutcome(o: any): string {
  if (o.kind === "assigned") return `${o.asin} → NNN=${o.nnn}`;
  return `${o.asin} → OVERFLOW (${o.bucket})`;
}

(async () => {
  // ─── 1. Scan real asin_skus ────────────────────────────────────────────
  const rows = await query(`SELECT sku FROM asin_skus`);
  const allSkus: string[] = rows.rows.map((r) => r.sku);
  console.log(`Total SKUs in asin_skus: ${allSkus.length}`);

  let conforming = 0;
  for (const sku of allSkus) {
    if (parseConformingSku(sku) != null) conforming++;
  }
  const nonConforming = allSkus.length - conforming;
  console.log(`  conforming (current format):  ${conforming}`);
  console.log(`  non-conforming (legacy/amzn/digit/PFL/etc):  ${nonConforming}`);

  // ─── 2. Per-bucket state from real data ────────────────────────────────
  const existingReal: ExistingNnns = buildExistingNnnsFromSkus(allSkus);
  if (existingReal.size === 0) {
    console.log(`\n[real data] No conforming SKUs found in asin_skus.`);
    console.log(`            All ${nonConforming} SKUs are non-current-format (expected — we've never generated any).`);
    console.log(`            Any new (BRD,DEP) bucket will start at NNN=001.`);
  } else {
    console.log(`\n[real data] Bucket state:`);
    console.log(`  BUCKET       COUNT  MAX  NEXT 3 ASSIGNMENTS WOULD BE`);
    console.log(`  ─────────────────────────────────────────────────────`);
    for (const [bucket, set] of Array.from(existingReal.entries())) {
      const arr = Array.from(set).sort((a, b) => a - b);
      const max = arr[arr.length - 1];
      const next3 = [max + 1, max + 2, max + 3]
        .filter((n) => n <= 999)
        .map((n) => String(n).padStart(3, "0"))
        .join(", ");
      console.log(`  ${bucket.padEnd(12)}  ${String(set.size).padStart(4)}  ${String(max).padStart(3)}  ${next3 || "OVERFLOW"}`);
    }
  }

  // ─── 3. Synthetic demonstration of every rule ──────────────────────────
  console.log(`\n[synthetic] Demonstrating allocator rules against fabricated state:\n`);

  // 3a. Fresh bucket
  console.log(`3a. Empty bucket, 1 ASIN:`);
  console.log(`   ${showOutcome(
    assignNnns([{ asin: "B0DEMO1", brandCode: "AMG", deptCode: "BPC" }], new Map())[0],
  )}`);

  // 3b. Batch sequencing
  console.log(`\n3b. Empty bucket, batch of 5 in SAME (AMG, BPC) → sequential 1..5:`);
  const r3b = assignNnns(
    Array.from({ length: 5 }, (_, i) => ({ asin: `B0DEMO_${i}`, brandCode: "AMG", deptCode: "BPC" })),
    new Map(),
  );
  for (const o of r3b) console.log(`   ${showOutcome(o)}`);

  // 3c. Existing max + batch
  console.log(`\n3c. Existing (AMG, BPC) = {10, 11, 12}, batch of 3 → 13, 14, 15:`);
  const r3c = assignNnns(
    [
      { asin: "B0NEW1", brandCode: "AMG", deptCode: "BPC" },
      { asin: "B0NEW2", brandCode: "AMG", deptCode: "BPC" },
      { asin: "B0NEW3", brandCode: "AMG", deptCode: "BPC" },
    ],
    new Map([["AMG-BPC", new Set([10, 11, 12])]]),
  );
  for (const o of r3c) console.log(`   ${showOutcome(o)}`);

  // 3d. Gap-not-filled
  console.log(`\n3d. Existing (AMG, BPC) = {1, 3, 5} (gaps at 2, 4 — retired), batch of 2 → 6, 7:`);
  const r3d = assignNnns(
    [
      { asin: "B0G1", brandCode: "AMG", deptCode: "BPC" },
      { asin: "B0G2", brandCode: "AMG", deptCode: "BPC" },
    ],
    new Map([["AMG-BPC", new Set([1, 3, 5])]]),
  );
  for (const o of r3d) console.log(`   ${showOutcome(o)}`);
  console.log(`   → confirms: gaps at 2, 4 NOT filled. Monotonic increase only.`);

  // 3e. Retired-not-reused
  console.log(`\n3e. Existing (AMG, BPC) = {7} (7 belongs to a deleted SKU) → next is 8, never 7:`);
  const r3e = assignNnns(
    [{ asin: "B0R1", brandCode: "AMG", deptCode: "BPC" }],
    new Map([["AMG-BPC", new Set([7])]]),
  );
  console.log(`   ${showOutcome(r3e[0])}`);
  console.log(`   → confirms: 7 is still in existing set (asin_skus retains it), so cursor never re-issues 7.`);

  // 3f. Mixed buckets
  console.log(`\n3f. Mixed batch — buckets advance independently:`);
  const r3f = assignNnns(
    [
      { asin: "B01", brandCode: "AMG", deptCode: "BPC" }, // AMG-BPC max=5 → 6
      { asin: "B02", brandCode: "KAR", deptCode: "GRO" }, // KAR-GRO empty → 1
      { asin: "B03", brandCode: "AMG", deptCode: "BPC" }, // AMG-BPC cursor=6 → 7
      { asin: "B04", brandCode: "KAR", deptCode: "GRO" }, // KAR-GRO cursor=1 → 2
    ],
    new Map([["AMG-BPC", new Set([5])]]),
  );
  for (const o of r3f) console.log(`   ${showOutcome(o)}`);

  // 3g. 999 overflow
  console.log(`\n3g. Bucket at 999, batch of 2 in that bucket → both overflow:`);
  const r3g = assignNnns(
    [
      { asin: "B0OVR1", brandCode: "AMG", deptCode: "BPC" },
      { asin: "B0OVR2", brandCode: "AMG", deptCode: "BPC" },
    ],
    new Map([["AMG-BPC", new Set([999])]]),
  );
  for (const o of r3g) console.log(`   ${showOutcome(o)}`);

  // 3h. Overflow vs not-overflow in same batch
  console.log(`\n3h. AMG-BPC at 999 (overflow), KAR-GRO empty (assigns) — same batch:`);
  const r3h = assignNnns(
    [
      { asin: "B0X1", brandCode: "AMG", deptCode: "BPC" },
      { asin: "B0X2", brandCode: "KAR", deptCode: "GRO" },
    ],
    new Map([["AMG-BPC", new Set([999])]]),
  );
  for (const o of r3h) console.log(`   ${showOutcome(o)}`);

  await pool.end();
  process.exit(0);
})().catch(async (err) => {
  console.error("Diag failed:", err.message);
  try { await pool.end(); } catch {}
  process.exit(1);
});
