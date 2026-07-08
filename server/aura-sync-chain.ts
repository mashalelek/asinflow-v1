// Chained job: PO sheet sync → Aura cost push (SPEC §11 "Aura cost sync").
// One shared function so the cron and the manual route can never diverge.
//
// HARD DEPENDENCY: the Aura push runs ONLY after a successful PO sync. If the
// PO sync throws, we log and stop — pushing stale AF costs that we believe are
// fresh would be worse than not pushing at all.

import { getRunSheetsSync } from "./routes";
import { pushAuraCosts } from "./aura-cost-sync";
import { log } from "./index";

export interface AuraSyncChainSummary {
  poSync: { updated: number; skipped: number; errors: number };
  aura: {
    pushed: number;
    unchanged: number;
    failed: number;
    skipped: { unmapped_sku: number; ambiguous_sku: number; null_cogs: number; zero_cost: number };
  };
}

export async function runAuraSyncChain(): Promise<AuraSyncChainSummary> {
  // (a) Full PO sheet sync (no ASIN filter). (b) Hard dependency on success.
  let po: { updated: number; skipped: number; errors: string[] };
  try {
    po = await getRunSheetsSync()(); // undefined filter = full catalog
  } catch (err: any) {
    log(`Aura sync chain: PO sheet sync FAILED — aborting, no Aura push (would push stale costs): ${err.message}`, "aura-sync");
    throw err; // STOP — never push after a failed PO sync
  }

  // (c) PO sync succeeded → Aura live push, full scope.
  const push = await pushAuraCosts({ limit: "all" });
  const pv = push.dryRunSummary.perVerdict;

  const summary: AuraSyncChainSummary = {
    poSync: { updated: po.updated, skipped: po.skipped, errors: po.errors.length },
    aura: {
      pushed: push.pushed,
      unchanged: pv.UNCHANGED,
      failed: push.failed,
      skipped: {
        unmapped_sku: pv["SKIP:unmapped_sku"],
        ambiguous_sku: pv["SKIP:ambiguous_sku"],
        null_cogs: pv["SKIP:null_cogs"],
        zero_cost: pv["SKIP:zero_cost"],
      },
    },
  };

  // (d) One-line summary, same style as the other sync jobs.
  log(
    `Aura sync chain complete: PO rows updated ${po.updated}/skipped ${po.skipped}/errors ${po.errors.length} | ` +
    `Aura pushed ${push.pushed}, unchanged ${pv.UNCHANGED}, failed ${push.failed}, ` +
    `skip[unmapped ${summary.aura.skipped.unmapped_sku}, ambiguous ${summary.aura.skipped.ambiguous_sku}, ` +
    `null_cogs ${summary.aura.skipped.null_cogs}, zero_cost ${summary.aura.skipped.zero_cost}]`,
    "aura-sync",
  );

  return summary;
}
