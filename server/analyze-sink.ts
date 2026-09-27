// Persistence sink for the analyze pipeline (SPEC §21 "Analyze path
// constraint").
//
// runAnalyzeCore is fetch-only; every DB write it triggers goes through an
// AnalyzeSink. Two implementations exist:
//   - mainCatalogSink (server/routes.ts) — the historical fire-and-forget
//     writes to asins / asin_estimates / tags. Default; behavior-identical
//     to the pre-sink code.
//   - makeBulkListSink (server/bulk-lists.ts) — awaited writes to
//     bulk_list_asins ONLY, for the Bulk Profit Calculator page.
//
// The interface lives in its own module so bulk-lists.ts doesn't have to
// import routes.ts for a type.

import type { AsinResult } from "@shared/schema";

export interface AnalyzeSink {
  /**
   * Called once per emitted result — first pass, retry `_update`, and the
   * exhausted final sweep all funnel through here (same call sites as the
   * old writeResult DB block). Implementations decide whether writes are
   * fire-and-forget (main catalog) or collected for an awaited flush (bulk).
   * Must not throw synchronously.
   *
   * Returns a promise that settles when THIS result's writes (including the
   * asins INSERT) have landed. Callers that must order a later write behind
   * the INSERT — tags, which no-op when the row doesn't exist yet — await it
   * (§11/§14, 2026-09-27). Implementations may still launch the work eagerly.
   */
  persistResult(
    result: AsinResult,
    opts: {
      fromCsvUpload: boolean;
      inputNotes: string | null;
      inputPromoNotes: string | null;
    },
  ): Promise<void>;

  /**
   * Called once per input ASIN carrying CSV tags, AFTER persistResult has
   * settled — upsertTagsForAsin silently no-ops when the asins row does not
   * exist yet, so running it concurrently with the INSERT loses every tag on
   * a brand-new ASIN (the 2026-09-27 "Tags don't land" report).
   *
   * MUST reject on failure. The caller surfaces it per-ASIN; a swallowed
   * rejection is a silent success without tags, the exact contract
   * bulk-promote.ts already refuses. The bulk sink no-ops: §21 — tags have
   * no data source on that page.
   */
  persistTags(asin: string, tagNames: string[]): Promise<void>;
}
