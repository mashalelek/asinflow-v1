// §21 scoped backfill (2026-09-08): restore added_at (lead date),
// promo_notes, and notes on ONE bulk list whose upload predates the
// mapping-modal fix / the bulk-local Notes column (migration 034)
// (the 42f0f42 handleContinue literal dropped promos/dateAdded, so every
// row got NOW() and NULL promos). Values come from the original CSV —
// explicit Date Added / Promos columns first, Notes "Lead date"/"Promo:"
// fragments as fallback — through the SAME parsers the live path uses
// (resolveAddedAt / extractPromoFromNotes / parseAddedAt).
//
// Usage (mode is REQUIRED — no fail-open default):
//   npx tsx script/backfill-bulk-lead-dates.ts --list <name> --csv <path> --mode dry
//   npx tsx script/backfill-bulk-lead-dates.ts --list <name> --csv <path> --mode apply
//
// Writes bulk_list_asins.added_at / promo_notes / notes ONLY (never
// overwrites an existing promo or note; §21 isolation — no main tables).
import { readFileSync } from "fs";
import { query } from "../server/db";
// bulk-lead-dates, NOT bulk-lists: bulk-lists pulls server/index which
// boots Express on import (EADDRINUSE killed the first apply mid-loop).
import { resolveAddedAt, extractPromoFromNotes } from "../server/bulk-lead-dates";

function parseCsv(text: string): Record<string, string>[] {
  // Minimal RFC-4180 parser (quoted fields, embedded commas/newlines).
  const rows: string[][] = [];
  let field = "", row: string[] = [], inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); if (row.some((f) => f !== "")) rows.push(row); }
  const [header, ...data] = rows;
  return data.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), r[i] ?? ""])));
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
  const listName = opt("list"), csvPath = opt("csv"), mode = opt("mode");
  if (!listName || !csvPath || (mode !== "dry" && mode !== "apply")) {
    console.error("Required: --list <name> --csv <path> --mode dry|apply"); process.exit(2);
  }

  const listRes = await query(`SELECT id FROM bulk_lists WHERE name = $1`, [listName]);
  if (listRes.rows.length !== 1) { console.error(`List "${listName}": found ${listRes.rows.length}, need exactly 1`); process.exit(2); }
  const listId = listRes.rows[0].id as string;

  const byAsin = new Map<string, { addedAtRaw: string | null; promos: string | null; notes: string | null }>();
  for (const row of parseCsv(readFileSync(csvPath!, "utf8"))) {
    const asin = (row["ASIN"] ?? "").trim().toUpperCase();
    if (!/^[A-Z0-9]{10}$/.test(asin) || byAsin.has(asin)) continue; // first occurrence wins, same as createBulkList
    byAsin.set(asin, {
      addedAtRaw: (row["Date Added"] ?? "").trim() || null,
      promos: (row["Promos"] ?? "").trim() || null,
      notes: (row["Notes"] ?? "").trim() || null,
    });
  }

  const dbRows = await query(`SELECT asin, added_at, promo_notes, notes FROM bulk_list_asins WHERE list_id = $1 ORDER BY asin`, [listId]);
  let dateSet = 0, promoSet = 0, promoKept = 0, notesSet = 0, notesKept = 0, noSource = 0, notInCsv = 0;
  const plan: Array<{ asin: string; beforeDate: string; afterDate: string | null; source: string; beforePromo: string | null; afterPromo: string | null; beforeNotes: string | null; afterNotes: string | null }> = [];
  for (const db of dbRows.rows) {
    const src = byAsin.get(db.asin);
    if (!src) { notInCsv++; continue; }
    const r = resolveAddedAt(src.addedAtRaw, src.notes);
    const promo = src.promos ?? extractPromoFromNotes(src.notes);
    const afterPromo = db.promo_notes ?? promo; // never overwrite an existing promo
    const afterNotes = db.notes ?? src.notes;   // never overwrite an existing note
    if (r.date) dateSet++; else noSource++;
    if (afterPromo && !db.promo_notes) promoSet++; else if (db.promo_notes) promoKept++;
    if (afterNotes && !db.notes) notesSet++; else if (db.notes) notesKept++;
    plan.push({
      asin: db.asin,
      beforeDate: new Date(db.added_at).toISOString(),
      afterDate: r.date ? r.date.toISOString() : null,
      source: r.source,
      beforePromo: db.promo_notes,
      afterPromo,
      beforeNotes: db.notes,
      afterNotes,
    });
  }

  console.log(`list "${listName}" (${listId}): ${dbRows.rows.length} rows | date from csv: ${dateSet}, no source (kept as-is): ${noSource}, not in csv: ${notInCsv} | promos to set: ${promoSet}, existing kept: ${promoKept} | notes to set: ${notesSet}, existing kept: ${notesKept}`);
  for (const p of plan.slice(0, 8)) {
    console.log(`  ${p.asin}: added_at ${p.beforeDate.slice(0, 10)} -> ${p.afterDate ? p.afterDate.slice(0, 10) : "(unchanged)"} [${p.source}] | promo ${JSON.stringify(p.beforePromo)} -> ${JSON.stringify(p.afterPromo)} | notes ${JSON.stringify(p.beforeNotes)} -> ${JSON.stringify((p.afterNotes ?? "").slice(0, 40) || null)}`);
  }
  if (plan.length > 8) console.log(`  … ${plan.length - 8} more`);

  if (mode === "dry") { console.log("[DRY] nothing written"); process.exit(0); }

  let updated = 0;
  for (const p of plan) {
    if (!p.afterDate && p.afterPromo === p.beforePromo && p.afterNotes === p.beforeNotes) continue;
    await query(
      `UPDATE bulk_list_asins SET added_at = COALESCE($3, added_at), promo_notes = COALESCE(promo_notes, $4), notes = COALESCE(notes, $5) WHERE list_id = $1 AND asin = $2`,
      [listId, p.asin, p.afterDate, p.afterPromo, p.afterNotes],
    );
    updated++;
  }
  console.log(`[APPLY] updated ${updated} rows`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
