// One-off backfill for the split hazard flags (migration 016). Re-derives BOTH
// flags for every ASIN and overwrites the FBA_INB_0096-poisoned is_hazmat:
//
//   is_dangerous_good ← getCatalogItem attributes.hazmat present/non-empty
//   is_hazmat         ← getItemEligibilityPreview INBOUND, code FBA_INB_0015
//
// SINGLE SOURCE OF TRUTH — no drift from the live analyze path:
//   • hazmat uses the SAME getInboundHazmat() the live path calls (retry +
//     fail-closed null baked in).
//   • DG uses the SAME isDangerousGoodFromAttributes() classifier the live
//     getCatalogData() uses.
// Both modules are Express-free (import spApiGet from spapi-auth, never
// ./index), so this script can reuse them without booting a second server.
//
// FAIL-CLOSED: a throttled/failed derivation returns null → that flag stays
// NULL (never written false) and the ASIN is reported as unchecked.
//
// RESUMABLE: default selection is "rows where either flag is still NULL", and
// per ASIN we only call the API for the flag(s) still NULL. So a partial run +
// re-run converges, and re-runs are cheap (only the leftover NULLs). Pass --all
// to force-reprocess every row.
//
// Paced ~1.1s/ASIN for the eligibility endpoint's ~1 rps limit (same cadence as
// the original hazmat backfill). ~1936 ASINs ≈ 40–70 min depending on throttle.
//
// Run:  npx tsx script/backfill-hazmat-dg.ts          (resumable: NULLs only)
//       npx tsx script/backfill-hazmat-dg.ts --all     (force re-derive all)

import "dotenv/config";
import { query } from "../server/db";
import { spApiGet } from "../server/spapi-auth";
import { getInboundHazmat } from "../server/inbound-hazmat";
import { isDangerousGoodFromAttributes } from "../server/hazmat-classify";

const MARKETPLACE = "ATVPDKIKX0DER";
const BASE_DELAY_MS = 1100;
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// DG probe: getCatalogItem attributes → presence classifier. Fail-closed to
// null on 404 (catalog gone → DG unknown) or any transient/throttle error, with
// a couple of short QuotaExceeded retries to reduce inconclusive noise.
async function probeDangerousGood(asin: string): Promise<boolean | null> {
  let backoff = 1200;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const data = await spApiGet(`/catalog/2022-04-01/items/${asin}`, {
        marketplaceIds: MARKETPLACE,
        includedData: "attributes",
      });
      return isDangerousGoodFromAttributes(data?.attributes);
    } catch (err: any) {
      const code = err?.response?.data?.errors?.[0]?.code;
      if (code === "QuotaExceeded" && attempt < 2) {
        await delay(backoff);
        backoff *= 2;
        continue;
      }
      return null; // 404 or transient → unknown, never false (fail-closed)
    }
  }
  return null;
}

// Anchors we validated by hand — post-run spot check. Expected (hz, dg):
const ANCHORS: { asin: string; label: string; hz: boolean; dg: boolean }[] = [
  { asin: "B082DM585M", label: "SodaStream CO2",          hz: true,  dg: true },
  { asin: "B077CH5Z57", label: "Drinkmate CO2",           hz: true,  dg: true },
  { asin: "B0DP94LJHL", label: "Lighter fluid",           hz: false, dg: true },
  { asin: "B08MWQ7ZNT", label: "Butane canister",         hz: false, dg: true },
  { asin: "B0741FC121", label: "Rust-Oleum spray",        hz: false, dg: true },
  { asin: "B07KH9SQKB", label: "Craftsman Li battery",    hz: false, dg: true },
  { asin: "B079P76WWM", label: "Zara perfume",            hz: false, dg: true },
  { asin: "B0FHP65413", label: "Sand+Fog perfume",        hz: false, dg: true },
  { asin: "B07QZZB4C1", label: "Spectracide aerosol",     hz: false, dg: true },
  { asin: "B07YX5971R", label: "Morton Salt Substitute",  hz: false, dg: false },
  { asin: "B0756KB8N1", label: "Keystone Canned Chicken", hz: false, dg: false },
  { asin: "B0FTKHZ8H8", label: "Kinder's BBQ Sauce",      hz: false, dg: false },
];

function fmt(v: boolean | null): string {
  return v === null ? "null" : v ? "true" : "false";
}

(async () => {
  const forceAll = process.argv.includes("--all");
  const sel = forceAll
    ? `SELECT asin, is_hazmat, is_dangerous_good FROM asins ORDER BY asin`
    : `SELECT asin, is_hazmat, is_dangerous_good FROM asins
        WHERE is_hazmat IS NULL OR is_dangerous_good IS NULL ORDER BY asin`;
  const rows = (await query(sel)).rows as {
    asin: string; is_hazmat: boolean | null; is_dangerous_good: boolean | null;
  }[];
  const total = rows.length;
  console.error(
    `Backfill hazmat+DG: ${total} ASIN(s) ${forceAll ? "(--all: every row)" : "(resumable: NULL flags only)"} ` +
    `@ ~${BASE_DELAY_MS}ms → ~${Math.round((total * BASE_DELAY_MS) / 60000)} min minimum\n`,
  );

  let dgTrue = 0, dgFalse = 0, hzTrue = 0, hzFalse = 0;
  const dgUnresolved: string[] = [];
  const hzUnresolved: string[] = [];
  const start = Date.now();

  for (let i = 0; i < total; i++) {
    const { asin, is_hazmat, is_dangerous_good } = rows[i];
    const needDG = forceAll || is_dangerous_good === null;
    const needHz = forceAll || is_hazmat === null;

    const dg = needDG ? await probeDangerousGood(asin) : null;
    const hz = needHz ? await getInboundHazmat(asin) : null;

    // Fail-closed write: only the flag(s) that came back non-null get written.
    const sets: string[] = [];
    const vals: any[] = [asin];
    if (needDG) {
      if (dg === null) dgUnresolved.push(asin);
      else { sets.push(`is_dangerous_good = $${vals.length + 1}`); vals.push(dg); dg ? dgTrue++ : dgFalse++; }
    }
    if (needHz) {
      if (hz === null) hzUnresolved.push(asin);
      else { sets.push(`is_hazmat = $${vals.length + 1}`); vals.push(hz); hz ? hzTrue++ : hzFalse++; }
    }
    if (sets.length) {
      await query(`UPDATE asins SET ${sets.join(", ")} WHERE asin = $1`, vals);
    }

    if ((i + 1) % 50 === 0 || i + 1 === total) {
      const pct = Math.round(((i + 1) / total) * 100);
      const elapsed = Math.round((Date.now() - start) / 1000);
      console.error(
        `  ${i + 1}/${total} (${pct}%)  dg[+${dgTrue}/-${dgFalse}/?${dgUnresolved.length}] ` +
        `hz[+${hzTrue}/-${hzFalse}/?${hzUnresolved.length}]  ${elapsed}s`,
      );
    }
    await delay(BASE_DELAY_MS);
  }

  // ── Whole-table summary (reflects converged state, incl. prior runs) ─────────
  const s = (await query(`
    SELECT count(*) AS total,
           count(*) FILTER (WHERE is_hazmat) AS hazmat_true,
           count(*) FILTER (WHERE is_dangerous_good) AS dg_true,
           count(*) FILTER (WHERE is_hazmat = false AND is_dangerous_good = false) AS neither,
           count(*) FILTER (WHERE is_hazmat IS NULL OR is_dangerous_good IS NULL) AS unchecked
      FROM asins`)).rows[0];

  console.log(`\n=== Backfill complete ===`);
  console.log(`  processed this run:  ${total}`);
  console.log(`  dg   resolved: +${dgTrue} true / -${dgFalse} false   unresolved(null): ${dgUnresolved.length}`);
  console.log(`  hz   resolved: +${hzTrue} true / -${hzFalse} false   unresolved(null): ${hzUnresolved.length}`);
  console.log(`\n--- Whole catalog (${s.total} ASINs) ---`);
  console.log(`  hazmat (is_hazmat=true):        ${s.hazmat_true}`);
  console.log(`  dangerous good (is_dg=true):    ${s.dg_true}`);
  console.log(`  neither (both false):           ${s.neither}`);
  console.log(`  unchecked (either NULL):        ${s.unchecked}  ← re-run to converge`);

  if (dgUnresolved.length || hzUnresolved.length) {
    console.log(`\n--- Fail-closed: unresolved this run (left NULL, NOT defaulted) ---`);
    if (dgUnresolved.length) console.log(`  DG null (${dgUnresolved.length}): ${dgUnresolved.join(",")}`);
    if (hzUnresolved.length) console.log(`  HZ null (${hzUnresolved.length}): ${hzUnresolved.join(",")}`);
  }

  // ── Spot-check known anchors ─────────────────────────────────────────────────
  const anchorRows = (await query(
    `SELECT asin, is_hazmat, is_dangerous_good FROM asins WHERE asin = ANY($1::text[])`,
    [ANCHORS.map((a) => a.asin)],
  )).rows as { asin: string; is_hazmat: boolean | null; is_dangerous_good: boolean | null }[];
  const byAsin = new Map(anchorRows.map((r) => [r.asin, r]));

  console.log(`\n--- Spot check (expected vs actual) ---`);
  let pass = 0, fail = 0, pending = 0;
  for (const a of ANCHORS) {
    const r = byAsin.get(a.asin);
    let verdict: string;
    if (!r) { verdict = "NOT IN CATALOG"; }
    else if (r.is_hazmat === null || r.is_dangerous_good === null) { verdict = "UNCHECKED (null)"; pending++; }
    else if (r.is_hazmat === a.hz && r.is_dangerous_good === a.dg) { verdict = "PASS"; pass++; }
    else { verdict = "*** FAIL ***"; fail++; }
    const got = r ? `hz=${fmt(r.is_hazmat)} dg=${fmt(r.is_dangerous_good)}` : "—";
    console.log(`  ${a.asin} ${a.label.padEnd(24)} exp hz=${String(a.hz).padEnd(5)} dg=${String(a.dg).padEnd(5)} | got ${got.padEnd(24)} ${verdict}`);
  }
  console.log(`\n  spot check: ${pass} pass / ${fail} fail / ${pending} pending`);
  if (fail > 0) console.log(`  ⚠ FAILURES above indicate the code set or DG rule needs review — do NOT trust the backfill.`);

  process.exit(0);
})().catch((err) => {
  console.error("Backfill failed:", err?.message ?? err);
  process.exit(1);
});
