// Chained action: PO sheet read → Aura cost push (SPEC §11 "Aura cost sync").
// One shared function for the full chain and the selection-scoped Push to
// Aura button, so they can never diverge.
//
// HARD DEPENDENCY: the Aura push runs ONLY after a successful PO sheet read
// for the same selection. The read is runSheetsSync (component 9's logic,
// scoped) run INLINE here — a Google Sheet read + COGS upsert, no SP-API, so
// it is not refresh work and does not go on the queue (Maria, 2026-10-16:
// manual actions never wait on the scheduled pass). If the read fails, we
// log and stop — pushing stale AF costs that we believe are fresh would be
// worse than not pushing.

import { pushAuraCosts } from "./aura-cost-sync";
import { getRunSheetsSync } from "./routes";
import { log } from "./log";

export interface PoSheetReadResult {
  updated: number;
  skipped: number;
  errors: number;
  cleared: number;
}

export interface AuraSyncChainSummary {
  poSync: PoSheetReadResult;
  aura: {
    pushed: number;
    unchanged: number;
    failed: number;
    skipped: { unmapped_sku: number; ambiguous_sku: number; null_cogs: number; zero_cost: number };
    notInAura: string[];
  };
}

export interface AuraSyncChainOptions {
  /** The selection; undefined = the full sheet and every Aura-mapped SKU. */
  asinFilter?: Set<string>;
  /** Injected for tests; the default is runSheetsSync (the /api/sheets/sync implementation) scoped to the selection. */
  readPoSheet?: (filter: Set<string> | undefined) => Promise<PoSheetReadResult>;
  push?: typeof pushAuraCosts;
}

/** Default PO sheet read: runSheetsSync inline, scoped to the selection (undefined = full sheet). */
export async function readPoSheetInline(filter: Set<string> | undefined): Promise<PoSheetReadResult> {
  const r = await getRunSheetsSync()(filter);
  return { updated: r.updated, skipped: r.skipped, errors: r.errors.length, cleared: r.cleared };
}

export async function runAuraSyncChain(opts: AuraSyncChainOptions = {}): Promise<AuraSyncChainSummary> {
  const readPoSheet = opts.readPoSheet ?? readPoSheetInline;
  const push = opts.push ?? pushAuraCosts;
  const scopeLabel = opts.asinFilter ? `${opts.asinFilter.size} selected` : "full";

  // (a) PO sheet read for the selection, through the queue. (b) Hard dependency on success.
  let po: PoSheetReadResult;
  try {
    po = await readPoSheet(opts.asinFilter);
  } catch (err: any) {
    log(`Aura sync chain (${scopeLabel}): PO sheet read FAILED — aborting, no Aura push (would push stale costs): ${err.message}`, "aura-sync");
    throw err; // STOP — never push after a failed PO read
  }

  // (c) PO read succeeded → Aura live push, same selection.
  const r = await push({ limit: "all", asinFilter: opts.asinFilter });
  const pv = r.dryRunSummary.perVerdict;

  const summary: AuraSyncChainSummary = {
    poSync: po,
    aura: {
      pushed: r.pushed,
      unchanged: pv.UNCHANGED,
      failed: r.failed,
      skipped: {
        unmapped_sku: pv["SKIP:unmapped_sku"],
        ambiguous_sku: pv["SKIP:ambiguous_sku"],
        null_cogs: pv["SKIP:null_cogs"],
        zero_cost: pv["SKIP:zero_cost"],
      },
      notInAura: r.notInAura ?? [],
    },
  };

  // (d) One-line summary, same style as the other sync jobs.
  log(
    `Aura sync chain complete (${scopeLabel}): PO rows updated ${po.updated}/skipped ${po.skipped}/errors ${po.errors} | ` +
    `Aura pushed ${r.pushed}, unchanged ${pv.UNCHANGED}, failed ${r.failed}, ` +
    `skip[unmapped ${summary.aura.skipped.unmapped_sku}, ambiguous ${summary.aura.skipped.ambiguous_sku}, ` +
    `null_cogs ${summary.aura.skipped.null_cogs}, zero_cost ${summary.aura.skipped.zero_cost}]` +
    `${summary.aura.notInAura.length ? `, notInAura ${summary.aura.notInAura.length}` : ""}`,
    "aura-sync",
  );

  return summary;
}
