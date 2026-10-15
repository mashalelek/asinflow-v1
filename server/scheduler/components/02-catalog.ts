// 2. Catalog attributes (daily). CALL-2 Catalog Items batch, 20 per call.
// Fetches the batch for the scope, chunk by chunk with checkpoints, and
// writes the attribute fields it owns on `asins`: title, image_url, brand,
// weight_lb. Components 3–6 ride the same response via the job cache.
import { fetchCatalogBatch } from "../../product-info-batch";
import { forEachBatch, putCatalogResults } from "./shared";
import type { ComponentDef, ComponentContext, ComponentResult } from "../types";

export const catalog: ComponentDef = {
  n: 2, key: "02_catalog", name: "Catalog attributes", tier: "daily", kind: "batch",
  call: "CALL-2 Catalog Items batch",
  async run(ctx: ComponentContext): Promise<ComponentResult> {
    const counts = { updated: 0, absent: 0, inconclusive: 0, missing_row: 0 };
    const outcomes: Record<string, string> = {};
    await forEachBatch(ctx, async (part) => {
      const m = await fetchCatalogBatch(part);
      putCatalogResults(ctx, m);
      for (const asin of part) {
        const e = m.get(asin);
        if (e?.kind === "parsed") {
          const d = e.data;
          const r = await ctx.query(
            `UPDATE asins SET
               title = COALESCE($2, title), image_url = COALESCE($3, image_url),
               brand = COALESCE(NULLIF(TRIM($4::text), ''), brand), weight_lb = COALESCE($5, weight_lb),
               last_refreshed_at = NOW()
             WHERE asin = $1`,
            [asin, d.title, d.imageUrl, d.brand, d.weightLbs],
          );
          if ((r.rowCount ?? 0) === 0) { counts.missing_row++; outcomes[asin] = "error: no asins row"; }
          else counts.updated++;
        } else if (e?.kind === "absent") {
          counts.absent++; outcomes[asin] = "absent";
        } else {
          counts.inconclusive++; outcomes[asin] = `inconclusive${e?.kind === "inconclusive" ? `: ${e.message}` : ""}`;
        }
      }
    });
    return { counts, outcomes };
  },
};
