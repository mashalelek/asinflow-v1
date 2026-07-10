import { query } from "./db";
import { log } from "./index";
import { fetchSourcingSheet, type RawSourcingRow } from "./sourcing-sheet";
import type { AsinInput } from "@shared/schema";

export interface SourcingSyncResult {
  inserted: number;
  archivedNew: number;
  skippedExisting: number;
  errors: string[];
  sampleNewAsins: string[];
  sampleArchiveAsins: string[];
  dryRun: boolean;
}

// One collapsed record per NEW ASIN (asin not yet in the `asins` table).
// Existing ASINs are skipped before this struct is ever built.
interface CollapsedNew {
  asin: string;
  cogs: number | null;     // first non-null parsed cogs across this ASIN's rows
  buyLink: string | null;  // first non-empty buy link
  vaNotes: string | null;  // first non-empty AP cell
  myNotes: string | null;  // first non-empty AS cell
  statuses: string[];      // ALL status strings (lowercased+trimmed) for this ASIN
}

function buildNotes(myNotes: string | null, vaNotes: string | null): string | null {
  const lines: string[] = [];
  if (myNotes) lines.push(`My notes: ${myNotes}`);
  if (vaNotes) lines.push(`VA notes: ${vaNotes}`);
  return lines.length > 0 ? lines.join("\n") : null;
}

// Archive only if EVERY status string for this ASIN contains "discontinue".
// Matches both "discontinue" and "discontinued" — the sheet uses the singular
// form ("8. Discontinue"). Empty status exempts: we never archive when any
// row is unclear.
function shouldArchiveNew(statuses: string[]): boolean {
  if (statuses.length === 0) return false;
  return statuses.every((s) => s.includes("discontinue"));
}

/**
 * Collapse raw sheet rows into one record per NEW ASIN. Existing ASINs are
 * dropped here (counted in skippedExistingSet) and never reach the analyzer.
 *
 * Per-field collapse rule: first non-empty value across this ASIN's rows wins
 * (mirrors google-sheets.ts's "first non-canceled row per ASIN" pattern —
 * top-of-sheet is the canonical entry).
 */
function collapseNewAsinRows(
  rawRows: RawSourcingRow[],
  existingAsins: Set<string>,
): { byNew: Map<string, CollapsedNew>; skippedExistingSet: Set<string> } {
  const byNew = new Map<string, CollapsedNew>();
  const skippedExistingSet = new Set<string>();

  for (const row of rawRows) {
    if (existingAsins.has(row.asin)) {
      skippedExistingSet.add(row.asin);
      continue;
    }
    let entry = byNew.get(row.asin);
    if (!entry) {
      entry = {
        asin: row.asin,
        cogs: null,
        buyLink: null,
        vaNotes: null,
        myNotes: null,
        statuses: [],
      };
      byNew.set(row.asin, entry);
    }
    entry.statuses.push(row.status.toLowerCase().trim());
    if (entry.cogs == null && row.cogs != null) entry.cogs = row.cogs;
    if (!entry.buyLink && row.buyLink) entry.buyLink = row.buyLink;
    if (!entry.vaNotes && row.vaNotes) entry.vaNotes = row.vaNotes;
    if (!entry.myNotes && row.myNotes) entry.myNotes = row.myNotes;
  }

  return { byNew, skippedExistingSet };
}

export interface SourcingSyncPlan {
  newCount: number;
  skippedExisting: number;
  toArchiveCount: number;
}

/**
 * Sync the sourcing Google Sheet into AsinFlow as INSERT-ONLY for new ASINs.
 *
 * AF is source of truth: pre-existing ASINs are skipped completely — no update,
 * no archive, no analyze. The sheet only adds. Discontinued status on a NEW
 * ASIN still triggers full insert + analyze, then the new row is archived so it
 * lands in the Archived view.
 *
 * @param runAnalyze callback that runs SP-API enrichment + DB inserts for new
 *   ASINs. The route layer wires this to runAnalyzeCore with the appropriate
 *   emit (NDJSON for the manual route, no-op for the cron).
 * @param onPlan optional callback fired after the plan is computed but before
 *   any DB writes. Lets the manual route stream a summary line to the UI before
 *   the analyze NDJSON starts flowing.
 */
export async function syncSourcingSheet(
  runAnalyze: (newInputs: AsinInput[]) => Promise<void>,
  onPlan?: (plan: SourcingSyncPlan) => void,
  options?: { dryRun?: boolean },
): Promise<SourcingSyncResult> {
  const dryRun = options?.dryRun ?? false;
  const sheetId = process.env.SOURCING_SHEET_ID;
  if (!sheetId) throw new Error("SOURCING_SHEET_ID not configured");

  const existingAsins = new Set<string>(
    (await query(`SELECT asin FROM asins`)).rows.map((r) => r.asin),
  );

  const rawRows = await fetchSourcingSheet(sheetId);
  const { byNew, skippedExistingSet } = collapseNewAsinRows(rawRows, existingAsins);

  const toArchive = Array.from(byNew.values())
    .filter((r) => shouldArchiveNew(r.statuses))
    .map((r) => r.asin);

  const newInputs: AsinInput[] = Array.from(byNew.values()).map((r) => ({
    asin: r.asin,
    cogs: r.cogs ?? 0,
    buyLink: r.buyLink,
    prepOverride: null,
    storageOverride: null,
    tags: null,
    notes: buildNotes(r.myNotes, r.vaNotes),
  }));

  log(
    `Sourcing sync${dryRun ? " [DRY-RUN]" : ""}: ${newInputs.length} new ASIN(s) to insert, ${skippedExistingSet.size} existing skipped, ${toArchive.length} flagged discontinued`,
    "sheets",
  );

  onPlan?.({
    newCount: newInputs.length,
    skippedExisting: skippedExistingSet.size,
    toArchiveCount: toArchive.length,
  });

  if (!dryRun && newInputs.length > 0) {
    await runAnalyze(newInputs);
  }

  let archivedNew = 0;
  if (!dryRun && toArchive.length > 0) {
    const r = await query(
      `UPDATE asins SET is_active = false WHERE asin = ANY($1::text[]) AND is_active = true`,
      [toArchive],
    );
    archivedNew = r.rowCount ?? 0;
  }

  return {
    inserted: newInputs.length,
    archivedNew: dryRun ? toArchive.length : archivedNew,
    skippedExisting: skippedExistingSet.size,
    errors: [],
    sampleNewAsins: newInputs.slice(0, 10).map((i) => i.asin),
    sampleArchiveAsins: toArchive.slice(0, 10),
    dryRun,
  };
}
