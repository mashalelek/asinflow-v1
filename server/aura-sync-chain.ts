// Chained job: PO sheet read → Aura cost push (SPEC §11 "Aura cost sync";
// scheduler patch decision 9). One shared function for the full chain and
// the selection-scoped Push to Aura button, so they can never diverge.
//
// HARD DEPENDENCY: the Aura push runs ONLY after a successful PO sheet read
// for the same selection. The read is component 9 of the refresh job,
// enqueued here as a one-component manual job and awaited (nothing reads
// the sheet outside the queue). If that job fails, we log and stop — pushing
// stale AF costs that we believe are fresh would be worse than not pushing.

import { pushAuraCosts } from "./aura-cost-sync";
import { runJobAndWait } from "./scheduler/await-job";
import { log } from "./index";

export interface PoSheetReadResult {
  updated: number;
  skipped: number;
  errors: number;
  cleared: number;
  /** The jobs.id of the component-9 job that read the sheet, when the queue did it. */
  jobId: number | null;
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
  /** Who enqueued the sheet-read job (jobs.requested_by). */
  requestedBy?: number | null;
  /** Injected for tests; the default enqueues component 9 for the selection and waits. */
  readPoSheet?: (filter: Set<string> | undefined) => Promise<PoSheetReadResult>;
  push?: typeof pushAuraCosts;
}

/** Default PO sheet read: a one-component (9) manual job for the selection, awaited. */
export async function readPoSheetViaQueue(filter: Set<string> | undefined, requestedBy: number | null = null): Promise<PoSheetReadResult> {
  const job = await runJobAndWait(
    { trigger: "manual", includeDaily: false, components: [9], scopeAsins: filter ? Array.from(filter) : null, requestedBy },
    { onStatus: (s) => log(`PO sheet read (job): ${s}`, "aura-sync") },
  );
  const c = job.summary?.components?.["09_po_sheet"] ?? {};
  return { updated: c.updated ?? 0, skipped: c.skipped ?? 0, errors: c.errors ?? 0, cleared: c.cleared ?? 0, jobId: job.id };
}

export async function runAuraSyncChain(opts: AuraSyncChainOptions = {}): Promise<AuraSyncChainSummary> {
  const readPoSheet = opts.readPoSheet ?? ((f) => readPoSheetViaQueue(f, opts.requestedBy ?? null));
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
    `Aura sync chain complete (${scopeLabel}): PO rows updated ${po.updated}/skipped ${po.skipped}/errors ${po.errors}${po.jobId ? ` (job ${po.jobId})` : ""} | ` +
    `Aura pushed ${r.pushed}, unchanged ${pv.UNCHANGED}, failed ${r.failed}, ` +
    `skip[unmapped ${summary.aura.skipped.unmapped_sku}, ambiguous ${summary.aura.skipped.ambiguous_sku}, ` +
    `null_cogs ${summary.aura.skipped.null_cogs}, zero_cost ${summary.aura.skipped.zero_cost}]` +
    `${summary.aura.notInAura.length ? `, notInAura ${summary.aura.notInAura.length}` : ""}`,
    "aura-sync",
  );

  return summary;
}
