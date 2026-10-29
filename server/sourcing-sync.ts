import { query } from "./db";
import { normalizeLeadSource } from "@shared/schema";
import { log } from "./log";
import { fetchSourcingSheet, type RawSourcingRow } from "./sourcing-sheet";
import { fetchErLeadsSheet, type RawErRow } from "./er-leads-sheet";
import type { AsinInput } from "@shared/schema";

/** Per-sheet counts in the run report (patch er-leads-sheet-sync, 2026-10-22). */
export interface SheetLegReport {
  sheet: "master" | "er";
  /** False when the sheet id is not configured — the leg was skipped. */
  configured: boolean;
  /** Raw rows read with an ASIN. */
  read: number;
  /** Rows dropped by the leg's filter (ER: not Approved = Yes, or dated before the floor). */
  filteredOut: number;
  /** Distinct ASINs already in AF — skipped, untouched. */
  alreadyInAf: number;
  /** Distinct new ASINs this leg inserts (dry run: would insert). */
  inserted: number;
  /** New ASINs with no asins row after the insert. */
  failed: number;
  /** The leg's read or config failure — the leg was aborted, the other leg still ran. */
  error?: string;
  warning?: string;
  /** ER: Approved = Yes rows whose Date is blank or unparseable — skipped, never guessed. */
  unparseableDates?: Array<{ row: number; asin: string; value: string }>;
  /** ER: new in both sheets this run — inserted once, by the Master leg (it reads first). */
  inMasterLeg?: string[];
  /** ER: what the leg inserts (dry run: would insert). */
  rows?: Array<{ asin: string; date: string; buyLink: string | null; cogs: number | null; leadSource: "ER" }>;
}

export interface SourcingSyncResult {
  inserted: number;
  archivedNew: number;
  skippedExisting: number;
  errors: string[];
  sampleNewAsins: string[];
  sampleArchiveAsins: string[];
  dryRun: boolean;
  // §6 (2026-10-13): col G values that did not normalise to the enum. They
  // fall back to MP — the common case for a blank or ad-hoc cell — but the
  // DISTINCT strings are reported so a systematic typo is visible rather
  // than quietly becoming MP forever.
  unrecognizedLeadSources: string[];
  /** Per sheet: Master first, then ER. */
  sheets: SheetLegReport[];
}

// One collapsed record per NEW ASIN (asin not yet in the `asins` table).
// Existing ASINs are skipped before this struct is ever built.
interface CollapsedNew {
  asin: string;
  cogs: number | null;     // first non-null parsed cogs across this ASIN's rows
  buyLink: string | null;  // first non-empty buy link
  leadSourceRaw: string | null; // §6 col G, first non-empty; normalised below
  promoNotes: string | null; // first non-empty Col O cell → promo_notes
  vaNotes: string | null;  // first non-empty AP cell
  myNotes: string | null;  // first non-empty AS cell
  statuses: string[];      // ALL status strings (lowercased+trimmed) for this ASIN
}

function buildNotes(myNotes: string | null, vaNotes: string | null): string | null {
  const lines: string[] = [];
  if (myNotes) lines.push(myNotes);           // AS (My notes) renders bare, no label
  if (vaNotes) lines.push(`VA: ${vaNotes}`);  // AP gets the short "VA: " prefix
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
        leadSourceRaw: null,
        promoNotes: null,
        vaNotes: null,
        myNotes: null,
        statuses: [],
      };
      byNew.set(row.asin, entry);
    }
    entry.statuses.push(row.status.toLowerCase().trim());
    if (entry.cogs == null && row.cogs != null) entry.cogs = row.cogs;
    if (!entry.buyLink && row.buyLink) entry.buyLink = row.buyLink;
    if (!entry.leadSourceRaw && row.leadSourceRaw) entry.leadSourceRaw = row.leadSourceRaw;
    if (!entry.promoNotes && row.promoNotes) entry.promoNotes = row.promoNotes;
    if (!entry.vaNotes && row.vaNotes) entry.vaNotes = row.vaNotes;
    if (!entry.myNotes && row.myNotes) entry.myNotes = row.myNotes;
  }

  return { byNew, skippedExistingSet };
}

export interface SourcingSyncPlan {
  newCount: number;
  skippedExisting: number;
  toArchiveCount: number;
  sheets?: Array<Pick<SheetLegReport, "sheet" | "configured" | "read" | "inserted" | "alreadyInAf" | "error">>;
}

// ── ER leg (patch er-leads-sheet-sync) ─────────────────────────────────
export const DEFAULT_ER_LEADS_MIN_DATE = "2026-10-20";

/** Pure: the ER sheet's Date cell → YYYY-MM-DD, or null. ISO as observed; M/D/YYYY too. Rolled-over dates rejected. */
export function parseErDate(raw: string): string | null {
  const s = raw.trim();
  let y: number, m: number, d: number;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  const mdy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (iso) { y = +iso[1]; m = +iso[2]; d = +iso[3]; }
  else if (mdy) { y = +mdy[3]; m = +mdy[1]; d = +mdy[2]; }
  else return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export interface ErLegPlan {
  inputs: AsinInput[];
  /** ASIN → lead date (YYYY-MM-DD) of its top passing row. */
  dates: Map<string, string>;
  report: SheetLegReport;
}

/**
 * Pure: filter + collapse the ER rows. Keep a row iff Approved is "yes"
 * (trim + lowercase) AND its Date parses AND Date ≥ floor. ASINs already in
 * AF are skipped; an ASIN the Master leg inserts this run is left to it.
 * One record per new ASIN, first non-empty wins, top of sheet canonical.
 */
export function planErLeg(rows: readonly RawErRow[], existingAsins: ReadonlySet<string>, masterNew: ReadonlySet<string>, minDate: string): ErLegPlan {
  const report: SheetLegReport = { sheet: "er", configured: true, read: rows.length, filteredOut: 0, alreadyInAf: 0, inserted: 0, failed: 0, unparseableDates: [], inMasterLeg: [], rows: [] };
  const already = new Set<string>(), inMaster = new Set<string>();
  const by = new Map<string, { date: string; buyLink: string | null; promoNotes: string | null; cogs: number | null; vaNotes: string | null; myNotes: string | null }>();
  for (const r of rows) {
    if (r.approvedRaw.trim().toLowerCase() !== "yes") { report.filteredOut++; continue; }
    const date = parseErDate(r.dateRaw);
    if (!date) { report.unparseableDates!.push({ row: r.row, asin: r.asin, value: r.dateRaw }); continue; }
    if (date < minDate) { report.filteredOut++; continue; }
    if (existingAsins.has(r.asin)) { already.add(r.asin); continue; }
    if (masterNew.has(r.asin)) { inMaster.add(r.asin); continue; }
    const e = by.get(r.asin);
    if (!e) { by.set(r.asin, { date, buyLink: r.buyLink, promoNotes: r.promoNotes, cogs: r.cogs, vaNotes: r.vaNotes, myNotes: r.myNotes }); continue; }
    if (!e.buyLink && r.buyLink) e.buyLink = r.buyLink;
    if (!e.promoNotes && r.promoNotes) e.promoNotes = r.promoNotes;
    if (e.cogs == null && r.cogs != null) e.cogs = r.cogs;
    if (!e.vaNotes && r.vaNotes) e.vaNotes = r.vaNotes;
    if (!e.myNotes && r.myNotes) e.myNotes = r.myNotes;
  }
  report.alreadyInAf = already.size;
  report.inMasterLeg = Array.from(inMaster);
  const inputs: AsinInput[] = [];
  const dates = new Map<string, string>();
  for (const [asin, e] of Array.from(by.entries())) {
    dates.set(asin, e.date);
    inputs.push({
      asin, cogs: e.cogs ?? 0, buyLink: e.buyLink, leadSource: "ER",
      prepOverride: null, storageOverride: null, tags: null,
      notes: buildNotes(e.myNotes, e.vaNotes), promoNotes: e.promoNotes,
    });
    report.rows!.push({ asin, date: e.date, buyLink: e.buyLink, cogs: e.cogs, leadSource: "ER" });
  }
  report.inserted = inputs.length;
  return { inputs, dates, report };
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
  const errors: string[] = [];

  // ── Master leg — a failed read aborts this leg only (patch §7) ──
  const master: SheetLegReport = { sheet: "master", configured: true, read: 0, filteredOut: 0, alreadyInAf: 0, inserted: 0, failed: 0 };
  let byNew = new Map<string, CollapsedNew>();
  try {
    const rawRows = await fetchSourcingSheet(sheetId);
    master.read = rawRows.length;
    const c = collapseNewAsinRows(rawRows, existingAsins);
    byNew = c.byNew;
    master.alreadyInAf = c.skippedExistingSet.size;
  } catch (err: any) {
    master.error = `Master sheet read failed: ${err?.message ?? err}`;
    errors.push(master.error);
  }

  const toArchive = Array.from(byNew.values())
    .filter((r) => shouldArchiveNew(r.statuses))
    .map((r) => r.asin);

  const unrecognized = new Set<string>();
  for (const r of Array.from(byNew.values())) {
    if (r.leadSourceRaw && normalizeLeadSource(r.leadSourceRaw) == null) unrecognized.add(r.leadSourceRaw);
  }

  const masterInputs: AsinInput[] = Array.from(byNew.values()).map((r) => ({
    asin: r.asin,
    cogs: r.cogs ?? 0,
    buyLink: r.buyLink,
    // §6: unrecognised or blank col G -> MP. The sourcing sheet is the
    // marketplace lead pipeline, so MP is the honest default for a row that
    // came from it without saying otherwise.
    leadSource: normalizeLeadSource(r.leadSourceRaw) ?? "MP",
    prepOverride: null,
    storageOverride: null,
    tags: null,
    notes: buildNotes(r.myNotes, r.vaNotes),
    promoNotes: r.promoNotes,
  }));
  master.inserted = masterInputs.length;

  // ── ER leg (patch er-leads-sheet-sync): after the Master leg, same insert path ──
  let er: ErLegPlan | null = null;
  let erReport: SheetLegReport;
  const erSheetId = process.env.ER_LEADS_SHEET_ID;
  if (!erSheetId) {
    erReport = { sheet: "er", configured: false, read: 0, filteredOut: 0, alreadyInAf: 0, inserted: 0, failed: 0, warning: "ER_LEADS_SHEET_ID not set — ER leg skipped" };
    log(`Sourcing sync: ${erReport.warning}`, "sheets");
  } else {
    try {
      const minDate = process.env.ER_LEADS_MIN_DATE?.trim() || DEFAULT_ER_LEADS_MIN_DATE;
      if (parseErDate(minDate) !== minDate) throw new Error(`ER_LEADS_MIN_DATE must be YYYY-MM-DD, got ${JSON.stringify(minDate)}`);
      const sheet = await fetchErLeadsSheet(erSheetId);
      er = planErLeg(sheet.rows, existingAsins, new Set(byNew.keys()), minDate);
      erReport = er.report;
      if (sheet.rawRows === 0) erReport.warning = "ER sheet read returned 0 rows — check the share / credentials (not treated as nothing new)";
    } catch (err: any) {
      erReport = { sheet: "er", configured: true, read: 0, filteredOut: 0, alreadyInAf: 0, inserted: 0, failed: 0, error: `ER sheet leg aborted: ${err?.message ?? err}` };
      errors.push(erReport.error!);
      er = null;
    }
  }
  const erInputs = er?.inputs ?? [];
  const newInputs = [...masterInputs, ...erInputs];

  log(
    `Sourcing sync${dryRun ? " [DRY-RUN]" : ""}: ${newInputs.length} new ASIN(s) to insert (Master ${masterInputs.length}, ER ${erInputs.length}), ${master.alreadyInAf + erReport.alreadyInAf} existing skipped, ${toArchive.length} flagged discontinued` +
      (erReport.unparseableDates?.length ? `, ER unparseable dates ${erReport.unparseableDates.length}` : "") + (errors.length ? ` — ${errors.join(" | ")}` : ""),
    "sheets",
  );

  const legSummary = (l: SheetLegReport) => ({ sheet: l.sheet, configured: l.configured, read: l.read, inserted: l.inserted, alreadyInAf: l.alreadyInAf, ...(l.error ? { error: l.error } : {}) });
  onPlan?.({
    newCount: newInputs.length,
    skippedExisting: master.alreadyInAf + erReport.alreadyInAf,
    toArchiveCount: toArchive.length,
    sheets: [legSummary(master), legSummary(erReport)],
  });

  if (!dryRun && newInputs.length > 0) {
    // One onboarding call for both legs: one stream, one Refresh job.
    await runAnalyze(newInputs);
    const wanted = newInputs.map((i) => i.asin);
    const present = new Set((await query(`SELECT asin FROM asins WHERE asin = ANY($1::text[])`, [wanted])).rows.map((r: any) => String(r.asin)));
    master.failed = masterInputs.filter((i) => !present.has(i.asin)).length;
    master.inserted -= master.failed;
    erReport.failed = erInputs.filter((i) => !present.has(i.asin)).length;
    erReport.inserted -= erReport.failed;
    // added_at = the ER lead date (col B), on the rows this leg just created.
    const erPresent = erInputs.filter((i) => present.has(i.asin));
    if (er && erPresent.length > 0) {
      await query(
        `UPDATE asins a SET added_at = (v.d::date)::timestamp AT TIME ZONE 'America/New_York'
           FROM unnest($1::text[], $2::text[]) AS v(asin, d)
          WHERE a.asin = v.asin AND a.lead_source = 'ER'`,
        [erPresent.map((i) => i.asin), erPresent.map((i) => er!.dates.get(i.asin)!)],
      );
    }
  }

  let archivedNew = 0;
  if (!dryRun && toArchive.length > 0) {
    const r = await query(
      `UPDATE asins SET status = 'parked', status_reason = 'discontinued', status_changed_at = NOW() WHERE asin = ANY($1::text[]) AND status = 'active'`,
      [toArchive],
    );
    archivedNew = r.rowCount ?? 0;
  }

  return {
    inserted: master.inserted + erReport.inserted,
    archivedNew: dryRun ? toArchive.length : archivedNew,
    skippedExisting: master.alreadyInAf + erReport.alreadyInAf,
    errors,
    sampleNewAsins: newInputs.slice(0, 10).map((i) => i.asin),
    sampleArchiveAsins: toArchive.slice(0, 10),
    dryRun,
    unrecognizedLeadSources: Array.from(unrecognized).sort(),
    sheets: [master, erReport],
  };
}
