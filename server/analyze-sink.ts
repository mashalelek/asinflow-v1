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

import type { AsinResult, LeadSource } from "@shared/schema";

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
      /** §6 lead source — INSERT branch only (§14). */
      inputLeadSource?: LeadSource | null;
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

  /**
   * Writes the gating / hazmat probe stamps, AFTER persistResult has settled
   * (§14, 2026-10-09). Same ordering contract as persistTags and the same
   * reason: these are `UPDATE asins SET ... WHERE asin = $1`, so on a
   * brand-new ASIN they match ZERO rows until the sink's INSERT has landed.
   * They used to run from inside the per-ASIN probe loop — before the INSERT
   * — under a `.catch(() => {})`, so a first-ever Product Info run reported
   * `updated` on a probe whose stamp never landed.
   *
   * Only called for stamps whose probe returned `kind: "ok"` — a failed probe
   * writes nothing (§11). `which` names those stamps; at least one is true.
   *
   * MUST reject on failure, INCLUDING a zero-row match. Zero rows is not a
   * pg error, and it is the exact shape the old bug took: silent success
   * against a row that does not exist. A rejection here means the ledger
   * would otherwise claim an update the record cannot show, so the caller
   * turns it into that ASIN's `error` outcome.
   */
  persistProbeStamps(
    asin: string,
    which: { gating: boolean; hazmat: boolean },
  ): Promise<void>;
}
