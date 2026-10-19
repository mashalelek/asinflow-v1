// 23. Inventory Ledger (daily, account). CALL-13 GET_LEDGER_SUMMARY_VIEW_DATA
// (DAILY, COUNTRY) — listing hygiene, SPEC §11. Runs in the 00:00 pass only
// (scheduled, include_daily) and in the backfill job; never in a manual
// Refresh, onboarding or bulk job (componentsForJob).
//
// Window: `job.params.ledger_window = {from, to}` (YYYY-MM-DD) for the
// one-time backfill — 92-day chunks, LEDGER_CHUNK_SPACING_MS apart, progress
// in chunks — else the nightly last 7 days (overlap on purpose).
//
// Nightly failure modes do NOT fail the pass: an empty report while 15 saw
// stock is `inconclusive`, a report error is `error`; either way nothing is
// written, the ledger row says `conclusive: 0`, and component 24 tonight
// skips every SKU as ledger_unavailable. A backfill chunk that is inconclusive
// or fails stops the job (ComponentError) — never skipped, so coverage has no
// silent gap.
import {
  fetchLedgerReport, parseLedgerReport, applyLedgerChunk, ledgerChunks, nightlyWindow, todayEt,
  realLedgerDeps, LEDGER_CHUNK_SPACING_MS, type LedgerDeps,
} from "../../ledger-sync";
import { ComponentError, type ComponentDef, type ComponentContext, type ComponentResult } from "../types";

/** Test seam. */
export const ledgerComponentDeps: { ledger: LedgerDeps; spacingMs: number; now: () => Date } = {
  ledger: realLedgerDeps, spacingMs: LEDGER_CHUNK_SPACING_MS, now: () => new Date(),
};

const YMD = /^\d{4}-\d{2}-\d{2}$/;
export function ledgerWindowFor(params: Record<string, any> | null | undefined, now: Date): { from: string; to: string; source: "params" | "nightly" } {
  const w = params?.ledger_window;
  if (w && YMD.test(String(w.from)) && YMD.test(String(w.to)) && String(w.from) <= String(w.to)) {
    return { from: String(w.from), to: String(w.to), source: "params" };
  }
  return { ...nightlyWindow(now), source: "nightly" };
}

export const ledger: ComponentDef = {
  n: 23, key: "23_ledger", name: "Inventory Ledger", tier: "daily", kind: "account",
  call: "CALL-13 GET_LEDGER_SUMMARY_VIEW_DATA (DAILY, COUNTRY)",
  async run(ctx: ComponentContext): Promise<ComponentResult> {
    const d = ledgerComponentDeps;
    const window = ledgerWindowFor(ctx.job.params, d.now());
    const backfill = window.source === "params";
    const chunks = backfill ? ledgerChunks(window.from, window.to) : [{ from: window.from, to: window.to }];
    ctx.log(`window ${window.from}..${window.to} (${window.source}), ${chunks.length} chunk(s)`);
    const counts: Record<string, number> = { chunks: chunks.length, rows: 0, skus: 0, stocked_skus: 0, conclusive: 0, inconclusive: 0, failed: 0 };
    const outcomes: Record<string, string> = { _window: `${window.from}..${window.to} (${window.source})`, _today_et: todayEt(d.now()) };
    if (backfill) await ctx.setProgress(0, chunks.length, "chunk");

    for (let i = 0; i < chunks.length; i++) {
      const w = chunks[i];
      const key = `_chunk_${String(i + 1).padStart(2, "0")} ${w.from}..${w.to}`;
      if (backfill && i > 0) await d.ledger.sleep(d.spacingMs);
      try {
        const text = await fetchLedgerReport(w, d.ledger, ctx.log);
        const rows = parseLedgerReport(text);
        const out = await applyLedgerChunk(w, rows, ctx.query);
        if (out.status === "inconclusive") {
          counts.inconclusive++;
          outcomes[key] = `inconclusive: ${out.reason}`;
          ctx.log(`${key}: ${outcomes[key]} — nothing written`);
          if (backfill) throw new ComponentError(`ledger chunk ${w.from}..${w.to} inconclusive (empty report while stocked) — re-run the backfill`, { counts, outcomes });
        } else {
          counts.rows += out.rows; counts.skus += out.skus; counts.stocked_skus += out.stocked;
          outcomes[key] = `written · rows ${out.rows} · skus ${out.skus} · stocked ${out.stocked}`;
          ctx.log(`${key}: ${outcomes[key]}`);
        }
      } catch (err: any) {
        if (err instanceof ComponentError) throw err;
        counts.failed++;
        outcomes[key] = `error: ${err?.message ?? err}`;
        ctx.log(`${key}: ${outcomes[key]}`);
        if (backfill) throw new ComponentError(`ledger chunk ${w.from}..${w.to} failed: ${err?.message ?? err}`, { counts, outcomes });
      }
      if (backfill) await ctx.setProgress(i + 1, chunks.length, "chunk");
    }
    // Component 24 reads this flag: only a run whose every chunk was written is conclusive.
    if (counts.inconclusive === 0 && counts.failed === 0) counts.conclusive = 1;
    return { counts, outcomes };
  },
};
