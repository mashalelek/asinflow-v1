// One-time backfill for §6 asins.lead_source (2026-10-13).
//
// Lead source used to live in three tags — Spark Lead, OA Hunt, OAL 24/7 —
// a structure that cannot express "exactly one of these": an ASIN could
// carry two, or none, and nothing noticed. This migrates that meaning into
// the CHECKed column and then those tags are deleted.
//
// PRECEDENCE, first match wins:
//   1. tag Spark Lead -> Spark · OA Hunt -> OA Hunt · OAL 24/7 -> OAL 24/7
//   2. ASIN in data/er-lead-asins.txt -> ER
//   3. Master sheet ASINs tab col G, normalised -> that enum value
//   4. else -> MP
//
// CONFLICTS: an ASIN matching more than one of rules 1-3 with DIFFERENT
// answers is listed. Precedence still decides the value — the list exists so
// a systematic disagreement (a whole tag contradicting the sheet) is visible
// before the live run, not discovered later.
//
//   dry run:  PORT=3999 npx tsx script/backfill-lead-source.ts
//   live:     PORT=3999 npx tsx script/backfill-lead-source.ts --live
//
// --live is REQUIRED to write; there is no default-to-live. PORT is needed
// because the sheet readers import ./index, which boots Express.
//
// Delete this script once it has run.

import "dotenv/config";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { query } from "../server/db";
import { normalizeLeadSource, type LeadSource } from "@shared/schema";

const LIVE = process.argv.includes("--live");
// ESM: no __dirname. The other script/ files that read files are CJS-style;
// this one imports @shared/schema, which makes it ESM under tsx.
const ER_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "er-lead-asins.txt");

const TAG_TO_SOURCE: Record<string, LeadSource> = {
  "Spark Lead": "Spark",
  "OA Hunt": "OA Hunt",
  "OAL 24/7": "OAL 24/7",
};

interface Row {
  asin: string;
  fromTag: LeadSource | null;
  fromEr: boolean;
  fromSheetRaw: string | null;
  fromSheet: LeadSource | null;
  resolved: LeadSource;
  rule: 1 | 2 | 3 | 4;
}

(async () => {
  console.log(LIVE ? "=== LIVE RUN ===" : "=== DRY RUN (zero writes) ===");

  // ── rule 1: the three lead tags ────────────────────────────────────────
  const tagRows = (await query(
    `SELECT a.asin, t.name
       FROM asin_tags at JOIN tags t ON t.id = at.tag_id JOIN asins a ON a.id = at.asin_id
      WHERE t.name = ANY($1::text[])`,
    [Object.keys(TAG_TO_SOURCE)],
  )).rows as { asin: string; name: string }[];

  const byTag = new Map<string, LeadSource[]>();
  for (const r of tagRows) {
    const arr = byTag.get(r.asin) ?? [];
    arr.push(TAG_TO_SOURCE[r.name]);
    byTag.set(r.asin, arr);
  }
  // An ASIN carrying TWO lead tags is itself a conflict — exactly the thing
  // the tag structure allowed and the column will not.
  const multiTag = Array.from(byTag.entries()).filter(([, v]) => new Set(v).size > 1);

  // ── rule 2: the ER list ────────────────────────────────────────────────
  const erSet = new Set(
    readFileSync(ER_FILE, "utf8").split("\n").map((l) => l.trim()).filter(Boolean),
  );

  // ── rule 3: Master sheet col G ─────────────────────────────────────────
  const sheetRaw = new Map<string, string>();
  try {
    const { fetchSourcingSheet } = await import("../server/sourcing-sheet");
    const id = process.env.SOURCING_SHEET_ID;
    if (!id) throw new Error("SOURCING_SHEET_ID not configured");
    for (const r of await fetchSourcingSheet(id)) {
      if (r.leadSourceRaw && !sheetRaw.has(r.asin)) sheetRaw.set(r.asin, r.leadSourceRaw);
    }
  } catch (e: any) {
    console.error(`!! Master sheet read FAILED (${e?.message ?? e}). Rule 3 cannot be applied.`);
    console.error("   Aborting: a backfill that silently skips a rule would mislabel every");
    console.error("   ASIN that rule 3 would have caught, as MP, permanently.");
    process.exit(1);
  }

  // ── resolve every ASIN ─────────────────────────────────────────────────
  const asins = (await query(`SELECT asin FROM asins ORDER BY asin`)).rows.map((r: any) => String(r.asin));
  const rows: Row[] = asins.map((asin) => {
    const tags = byTag.get(asin) ?? [];
    const fromTag = tags.length > 0 ? tags[0] : null;
    const fromEr = erSet.has(asin);
    const fromSheetRaw = sheetRaw.get(asin) ?? null;
    const fromSheet = normalizeLeadSource(fromSheetRaw);
    const [resolved, rule]: [LeadSource, 1 | 2 | 3 | 4] =
      fromTag ? [fromTag, 1]
      : fromEr ? ["ER", 2]
      : fromSheet ? [fromSheet, 3]
      : ["MP", 4];
    return { asin, fromTag, fromEr, fromSheetRaw, fromSheet, resolved, rule };
  });

  // ── conflicts: >1 of rules 1-3 matched with DIFFERENT answers ─────────
  const conflicts = rows.filter((r) => {
    const answers = new Set<string>();
    if (r.fromTag) answers.add(r.fromTag);
    if (r.fromEr) answers.add("ER");
    if (r.fromSheet) answers.add(r.fromSheet);
    return answers.size > 1;
  });

  // ── report ─────────────────────────────────────────────────────────────
  const counts = new Map<string, number>();
  const byRule = new Map<number, number>();
  for (const r of rows) {
    counts.set(r.resolved, (counts.get(r.resolved) ?? 0) + 1);
    byRule.set(r.rule, (byRule.get(r.rule) ?? 0) + 1);
  }
  console.log(`\nASINs: ${rows.length}`);
  console.log("\nper source:");
  for (const s of ["ER", "Spark", "OA Hunt", "OAL 24/7", "MP", "RA"]) {
    console.log(`  ${s.padEnd(10)} ${counts.get(s) ?? 0}`);
  }
  console.log("\nby rule:");
  console.log(`  1 tag          ${byRule.get(1) ?? 0}`);
  console.log(`  2 ER list      ${byRule.get(2) ?? 0}`);
  console.log(`  3 sheet col G  ${byRule.get(3) ?? 0}`);
  console.log(`  4 default MP   ${byRule.get(4) ?? 0}`);

  const unrecognized = Array.from(
    new Set(rows.filter((r) => r.fromSheetRaw && !r.fromSheet).map((r) => r.fromSheetRaw!)),
  ).sort();
  console.log(`\nunrecognised col-G strings (${unrecognized.length}): ${unrecognized.map((u) => JSON.stringify(u)).join(", ") || "(none)"}`);

  if (multiTag.length > 0) {
    console.log(`\nASINs carrying MORE THAN ONE lead tag (${multiTag.length}):`);
    for (const [asin, v] of multiTag.slice(0, 20)) console.log(`  ${asin}  ${Array.from(new Set(v)).join(" + ")}`);
  }

  console.log(`\nCONFLICTS — matched >1 rule with different answers (${conflicts.length}):`);
  for (const c of conflicts.slice(0, 40)) {
    const parts = [
      c.fromTag ? `tag=${c.fromTag}` : null,
      c.fromEr ? "ER-list" : null,
      c.fromSheet ? `sheet=${c.fromSheet}` : null,
    ].filter(Boolean).join(" · ");
    console.log(`  ${c.asin}  ${parts}  -> ${c.resolved} (rule ${c.rule})`);
  }
  if (conflicts.length > 40) console.log(`  ... and ${conflicts.length - 40} more`);

  if (!LIVE) {
    console.log(`\nDRY RUN — nothing written. Re-run with --live to apply.`);
    process.exit(0);
  }

  // ── live write ─────────────────────────────────────────────────────────
  let written = 0;
  for (const r of rows) {
    const res = await query(`UPDATE asins SET lead_source = $2 WHERE asin = $1`, [r.asin, r.resolved]);
    written += res.rowCount ?? 0;
  }
  console.log(`\nLIVE: ${written} rows written.`);
  const check = (await query(
    `SELECT lead_source, count(*)::int AS n FROM asins GROUP BY 1 ORDER BY 1`,
  )).rows;
  console.log("post-write distribution:", JSON.stringify(check));
  process.exit(0);
})().catch((e: any) => { console.error("FAILED:", e?.message ?? e); process.exit(1); });
