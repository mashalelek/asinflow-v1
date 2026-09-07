// Single source of truth for writing the is_catalog_deleted signal +
// auto-archive transition. Called from BOTH:
//   - upsertAsinResult (live analyze path)
//   - script/backfill-catalog-deleted.ts (one-off bulk backfill)
//
// Centralizing this prevents the "live and backfill drift apart" failure mode.
// Any future change to auto-archive semantics happens here once.
//
// Tri-state input handling:
//   null  → inconclusive (transient/throttle/network) — NO write, preserves
//           stored values. Guards against flaky calls corrupting the flag.
//   true  → mark deleted. On the FALSE→TRUE transition, also archive with
//           reason='catalog_deleted'. TRUE→TRUE is idempotent (no re-archive).
//   false → mark alive. TRUE→FALSE (catalog restored) does NOT auto-unarchive
//           — DA-3 revival dialog owns that. The user reviews and chooses.

import type pg from "pg";
import { query as defaultQuery } from "./db";

type QueryLike =
  | typeof defaultQuery
  | pg.PoolClient["query"]
  | ((sql: string, params?: any[]) => Promise<{ rows: any[]; rowCount: number | null }>);

export async function applyCatalogDeletedSignal(
  asin: string,
  isCatalogDeleted: boolean | null,
  client: QueryLike = defaultQuery,
): Promise<void> {
  // Inconclusive → no-op. Don't touch the flag, don't bump catalog_checked_at.
  if (isCatalogDeleted == null) return;

  await (client as any)(
    `UPDATE asins SET
       is_catalog_deleted = $2,
       catalog_checked_at = NOW(),
       status = CASE
         WHEN $2 = TRUE AND is_catalog_deleted = FALSE THEN 'dead'
         ELSE status
       END,
       status_reason = CASE
         WHEN $2 = TRUE AND is_catalog_deleted = FALSE THEN 'catalog_deleted'
         ELSE status_reason
       END,
       status_changed_at = CASE
         WHEN $2 = TRUE AND is_catalog_deleted = FALSE THEN NOW()
         ELSE status_changed_at
       END
     WHERE asin = $1`,
    [asin, isCatalogDeleted],
  );
}
