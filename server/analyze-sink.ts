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
   */
  persistResult(
    result: AsinResult,
    opts: {
      fromCsvUpload: boolean;
      inputNotes: string | null;
      inputPromoNotes: string | null;
    },
  ): void;

  /**
   * Called once per input ASIN carrying CSV tags (the old direct
   * upsertTagsForAsin call site in runAnalyzeCore). The bulk sink no-ops:
   * §21 — tags have no data source on that page.
   */
  persistTags(asin: string, tagNames: string[]): void;
}
