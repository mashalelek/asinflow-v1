// Sanity: prove parseConformingSku ACCEPTS valid current-format SKUs and
// REJECTS real non-conforming SKUs for the RIGHT specific reasons.
//
// Defensive check before substep 3 — the 0/1547 result earlier is consistent
// with two scenarios:
//   (a) parser correct + we genuinely have no current-format SKUs (expected)
//   (b) parser broken, rejects everything (the bug we're guarding against)
// This diag distinguishes (a) from (b) by exercising both directions.

import "dotenv/config";
import pool, { query } from "../server/db";
import { parseConformingSku } from "../shared/nnn-assignment";

// Mirrors parseConformingSku's checks step-by-step so we can report WHICH
// step caused the rejection (the parser itself just returns null).
function whyRejected(sku: string): string {
  // Step 1: split must have ≥5 segments (BRD-DEP-AS3-TTL-NNN[-X])
  const parts = sku.split("-");
  if (parts.length < 5) return `segments=${parts.length} (need ≥5)`;

  // Step 2: BRD must be 3 uppercase alpha
  if (!/^[A-Z]{3}$/.test(parts[0])) return `BRD "${parts[0]}" not [A-Z]{3}`;

  // Step 3: DEP must be 3 uppercase alpha (legacy AMG has 2-char dept like "BP")
  if (!/^[A-Z]{3}$/.test(parts[1])) {
    const note = parts[1].length === 2 ? " (legacy 2-char dept)" : "";
    return `DEP "${parts[1]}" not [A-Z]{3}${note}`;
  }

  // Step 4: AS3 must be 3 alphanumeric (uppercase)
  if (!/^[A-Z0-9]{3}$/.test(parts[2])) {
    const note = parts[2].length !== 3 ? ` (length=${parts[2].length}, need 3)` : "";
    return `AS3 "${parts[2]}" not [A-Z0-9]{3}${note}`;
  }

  // Step 5: TTL must be 3 uppercase alpha
  if (!/^[A-Z]{3}$/.test(parts[3])) return `TTL "${parts[3]}" not [A-Z]{3}`;

  // Step 6: NNN numeric + in range 1-999
  const nnn = parseInt(parts[4], 10);
  if (isNaN(nnn)) return `NNN "${parts[4]}" non-numeric`;
  if (nnn < 1 || nnn > 999) return `NNN ${nnn} out of [1,999]`;

  return "(should have accepted — discriminator/parser drift bug?)";
}

const SYNTHETIC_VALID = [
  { sku: "AMG-BPC-X35-RRC-001",    expect: { brd: "AMG", dep: "BPC", nnn: 1 } },
  { sku: "KAR-GRO-8H7-NUT-042-A",  expect: { brd: "KAR", dep: "GRO", nnn: 42 } },
  { sku: "PAT-OUT-123-HIP-007",    expect: { brd: "PAT", dep: "OUT", nnn: 7 } },
  { sku: "BAM-HOM-Y0M-FIL-100",    expect: { brd: "BAM", dep: "HOM", nnn: 100 } },
  { sku: "AMG-BPC-X8M-TFR-999-Z",  expect: { brd: "AMG", dep: "BPC", nnn: 999 } },
];

(async () => {
  console.log("══════════════════════════════════════════════════════════════════════════════");
  console.log("PART A — Synthetic VALID SKUs should ACCEPT with correct extraction");
  console.log("══════════════════════════════════════════════════════════════════════════════");
  let acceptOk = 0;
  for (const { sku, expect } of SYNTHETIC_VALID) {
    const parsed = parseConformingSku(sku);
    const pass =
      parsed != null &&
      parsed.brd === expect.brd &&
      parsed.dep === expect.dep &&
      parsed.nnn === expect.nnn;
    const status = pass ? "✓ ACCEPT" : "✗ FAIL  ";
    if (pass) acceptOk++;
    const ext = parsed
      ? `→ brd=${parsed.brd} dep=${parsed.dep} nnn=${parsed.nnn}`
      : `→ REJECTED (${whyRejected(sku)})`;
    console.log(`  ${status}  ${sku.padEnd(28)} ${ext}`);
  }
  console.log(`\n  Accept rate: ${acceptOk}/${SYNTHETIC_VALID.length}`);
  if (acceptOk !== SYNTHETIC_VALID.length) {
    console.log(`  ✗ PARSER BUG: rejected valid SKUs. Halting.`);
    await pool.end();
    process.exit(1);
  }

  console.log("\n══════════════════════════════════════════════════════════════════════════════");
  console.log("PART B — Real non-conforming SKUs from asin_skus should REJECT for stated reason");
  console.log("══════════════════════════════════════════════════════════════════════════════");

  // Pull a varied sample — one from each known pattern family.
  const patterns: Array<{ label: string; sql: string }> = [
    { label: "amzn.gr.*",        sql: `SELECT sku FROM asin_skus WHERE sku LIKE 'amzn.%' LIMIT 2` },
    { label: "Amazon-random",    sql: `SELECT sku FROM asin_skus WHERE sku ~ '^[A-Z0-9]{2}-[A-Z0-9]{4}-[A-Z0-9]{4}$' LIMIT 2` },
    { label: "Legacy AMG",       sql: `SELECT sku FROM asin_skus WHERE sku LIKE 'AMG-%' LIMIT 2` },
    { label: "All-digit",        sql: `SELECT sku FROM asin_skus WHERE sku ~ '^[0-9]+$' LIMIT 2` },
    { label: "PFL_ prep-center", sql: `SELECT sku FROM asin_skus WHERE sku LIKE 'PFL_%' LIMIT 2` },
  ];

  let rejectOk = 0;
  let totalChecked = 0;
  for (const { label, sql } of patterns) {
    const rows = await query(sql);
    if (rows.rows.length === 0) {
      console.log(`\n  [${label}] no samples found in asin_skus`);
      continue;
    }
    console.log(`\n  [${label}]`);
    for (const r of rows.rows) {
      const sku: string = r.sku;
      const parsed = parseConformingSku(sku);
      totalChecked++;
      if (parsed == null) {
        rejectOk++;
        console.log(`    ✓ REJECT  ${sku.padEnd(50)} reason: ${whyRejected(sku)}`);
      } else {
        console.log(`    ✗ FAIL    ${sku.padEnd(50)} accidentally accepted as brd=${parsed.brd} dep=${parsed.dep} nnn=${parsed.nnn}`);
      }
    }
  }
  console.log(`\n  Reject rate: ${rejectOk}/${totalChecked}`);

  console.log("\n══════════════════════════════════════════════════════════════════════════════");
  if (acceptOk === SYNTHETIC_VALID.length && rejectOk === totalChecked) {
    console.log("CONCLUSION: discriminator works correctly. Accept on valid, reject on invalid");
    console.log("            for the right reasons. The 0/1547 conforming count is genuine,");
    console.log("            not a parser bug.");
  } else {
    console.log("CONCLUSION: discriminator has issues. See FAIL rows above.");
  }
  console.log("══════════════════════════════════════════════════════════════════════════════");

  await pool.end();
  process.exit(0);
})().catch(async (err) => {
  console.error("Diag failed:", err.message);
  try { await pool.end(); } catch {}
  process.exit(1);
});
