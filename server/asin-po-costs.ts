// Actual COGS from AF's PO tables (Orders-sheet retirement commit 1, 2026-11-13; was routes.ts's runSheetsSync,
// "PO sync", since 2026-10-18 reading loadAfAsinCostMap — the Orders sheet is not read here and never was after that
// date). The rule: an ASIN's Actual COGS, Est. COGS (unless manual) and prep override follow the cost per unit / prep
// on its newest NON-CANCELED PO ASIN row — newest by ORDER DATE, then entry sequence, then created_at (NEWEST_PO_ORDER;
// a backdated PO entered later does not win; a canceled latest PO falls back to the one before it) — with
// cogs_source = 'af_po' (migration 109; was 'af_po'). An ASIN whose every PO is canceled keeps its last value.
//
// Runs: after every PO write, scoped to the PO's ASINs (syncAsinCostsAfterPoWrite — the request's own sync, logged and
// never failing the save); component 9 on every hourly pass over the whole map (the backstop); onboarding phase c for
// the uploaded ASINs; Push to Aura's cost half for the selection; the Sync POs button. SPEC §2 / §11 / §22.
import { loadAfAsinCostMap } from "./po-af-source";
import { log as defaultLog } from "./log";

export type QueryFn = (sql: string, params?: any[]) => Promise<{ rows: any[]; rowCount: number | null }>;
type Log = (msg: string, tag?: string) => void;

/** The stored source label for a cost that came from AF's POs (migration 109; was 'af_po'). */
export const AF_PO_COGS_SOURCE = "af_po";

export interface AsinCostSyncResult { updated: number; skipped: number; errors: string[]; cleared: number; clearedAsins: string[] }

export async function syncAsinCostsFromPos(
  query: QueryFn,
  asinFilter?: ReadonlySet<string>,
  log: Log = defaultLog,
): Promise<AsinCostSyncResult> {
  // Source = the AF PO tables (patch po-af-owned §2.4, 2026-10-18): the
  // newest non-canceled ASIN row per ASIN (order_date, then entry_seq). The
  // Orders sheet is intake-only and is no longer read here.
  const { data: sheetData, rowsRead: rawRowsRead } = await loadAfAsinCostMap(query, asinFilter && asinFilter.size > 0 ? Array.from(asinFilter) : undefined);
  let updated = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const [asin, data] of Array.from(sheetData.entries())) {
    if (asinFilter && asinFilter.size > 0 && !asinFilter.has(asin)) {
      skipped++;
      continue;
    }
    try {
      const setClauses: string[] = [];
      const values: any[] = [];
      let idx = 1;
      // Per-ASIN branch trace (2026-08-11): the csv-freeze diagnosis had to
      // reconstruct these decisions from DB side-effects — log them instead.
      let actBranch = "no-cogs";
      let estBranch = "no-cogs";
      if (data.cogs != null) {
        // ALWAYS overwrite actual_cogs from PO — §2, enforced 2026-08-30.
        // actual_cogs is PO-sync-only; the old cogs_source='manual' guard let
        // a phantom marker (manual + NULL value) block this write forever
        // (B0G4XGFX1Z). Manual-override semantics live on estimated_cogs ONLY.
        setClauses.push(`cogs = $${idx++}`, `cogs_source = $${idx++}`, `actual_cogs = $${idx++}`);
        values.push(data.cogs, AF_PO_COGS_SOURCE, data.cogs);
        actBranch = "written";
      }
      // Est. COGS auto-sync (§2, corrected 2026-08-11): overwrite with the PO
      // value (source → 'af_po') UNLESS the source is 'manual'. csv/imported
      // yield to PO — CSV seeds pre-purchase estimates, a PO row is ground
      // truth. The old af_po/NULL-only check silently froze csv rows.
      if (data.cogs != null) {
        const estCheck = await query(`SELECT estimated_cogs_source FROM asin_estimates WHERE asin = $1`, [asin]);
        const estSource = estCheck?.rows?.[0]?.estimated_cogs_source;
        if (estSource !== "manual") {
          setClauses.push(`estimated_cogs = $${idx++}`, `estimated_cogs_source = $${idx++}`);
          values.push(data.cogs, AF_PO_COGS_SOURCE);
          estBranch = `written(was:${estSource ?? "null"})`;
        } else {
          estBranch = "skipped:manual";
        }
      }
      // Prep cost from PO sheet (Col AS)
      if (data.prepCost != null) {
        setClauses.push(`prep_override = $${idx++}`);
        values.push(data.prepCost);
      }
      // ordered_qty is NOT written any more (patch asins-on-order-from-pos
      // §3.4, 2026-10-17): the ASINs page derives On Order / Pipeline from
      // the PO tables. The column stays in place, unread, until a cleanup
      // migration drops it. A row the sheet gives no cost or prep for has
      // nothing left to write.
      if (setClauses.length === 0) { skipped++; continue; }
      values.push(asin);

      const result = await query(
        `UPDATE asin_estimates SET ${setClauses.join(", ")} WHERE asin = $${idx}`,
        values
      );
      if ((result.rowCount ?? 0) > 0) {
        updated++;
        log(`PO costs ${asin}: cogs=${data.cogs ?? "-"} actual=${actBranch} est=${estBranch} prep=${data.prepCost ?? "-"}`, "sheets");
      } else {
        // A PO'd ASIN with no asin_estimates row (2026-11-09): named, not counted as skipped.
        errors.push(`${asin}: no asin_estimates row`);
      }

      // Update supplier on asins table if available
      if (data.supplier) {
        await query(`UPDATE asins SET supplier = COALESCE(supplier, $2) WHERE asin = $1`, [asin, data.supplier]);
      }
    } catch (err: any) {
      errors.push(`${asin}: ${err.message}`);
    }
  }

  // The ordered_qty clearing pass (SPEC §11, 2026-08-23) is gone with the
  // column's last writer (2026-10-17): nothing reads asin_estimates.
  // ordered_qty any more. `cleared` / `clearedAsins` stay in the result
  // shape for the callers (toast, component 9 ledger) and are always 0.
  // rawRowsRead keeps its fail-closed meaning for the read itself.
  if (rawRowsRead === 0) log(`PO costs: rawRowsRead=0 — no PO rows in AF (nothing written)`, "sheets");
  const clearedAsins: string[] = [];
  return { updated, skipped, errors, cleared: clearedAsins.length, clearedAsins };
}


/** The ASINs on a PO (empty for null or a deleted PO). */
export async function poAsinList(query: QueryFn, poId: string | null | undefined): Promise<string[]> {
  if (!poId) return [];
  return (await query(`SELECT asin FROM po_asins WHERE po_id = $1`, [poId])).rows.map((r: any) => String(r.asin));
}

/**
 * After a PO write has committed: the affected ASINs' Actual COGS / prep follow the newest PO at once. A failure is
 * logged and swallowed — the save already happened, and component 9 writes the same thing on the next hourly pass.
 */
export async function syncAsinCostsAfterPoWrite(query: QueryFn, asins: Iterable<string>, what: string, log: Log = defaultLog): Promise<AsinCostSyncResult | null> {
  const set = new Set(Array.from(asins).map((a) => a.trim().toUpperCase()).filter(Boolean));
  if (set.size === 0) return null;
  try {
    const r = await syncAsinCostsFromPos(query, set, log);
    log(`PO costs after ${what}: ${set.size} ASIN(s) — ${r.updated} updated${r.errors.length ? `, ${r.errors.length} error(s): ${r.errors.join("; ")}` : ""}`, "po");
    return r;
  } catch (err: any) {
    log(`PO costs after ${what} failed (the hourly pass catches up): ${err?.message ?? err}`, "po");
    return null;
  }
}
