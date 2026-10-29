// §18 Relist: re-create a deleted listing under its original SKU.
//
// The exact-SKU reuse path through the SAME submitOfferAddBatch pipeline as
// Add to SC (getDefinitionsProductType, LISTING_OFFER_ONLY, FBA, no quantity
// key, DG pass-through, price resolver) — the only differences are that the
// SKU is forced to the requested prior SKU (which must be AF history in
// asin_skus and must 404 live; format-agnostic, so legacy / Amazon-random
// SKUs relist under their original names) and that openOnCreate=true makes
// the §19 ladder skip close-after-create so the offer comes up OPEN.
// dryRun=true runs phase4Mode="preview" (everything but the PUT).
//
// Shared by POST /api/listings/relist and script/relist.ts. Takes its logger
// as a parameter: importing ./index (where routes get `log`) boots the server.
import { query } from "./db";
import { probeGatingForAsins } from "./gating-probe";
import { loadSubmitRows, loadSettingsForSubmit } from "./offer-add-load";
import { submitOfferAddBatch } from "./offer-add-submit";
import { makeProductRegistryRepo } from "./product-registry-repo";

export type RelistItem = { asin: string; sku: string };

export async function runRelist(
  items: RelistItem[],
  opts: { sellerId: string; openOnCreate?: boolean; dryRun?: boolean; log?: (msg: string) => void },
) {
  const log = opts.log ?? ((m: string) => console.log(`[offer-add] ${m}`));
  const asins = items.map((it) => it.asin);
  const relist = Object.fromEntries(items.map((it) => [it.asin, { sku: it.sku, openOnCreate: opts.openOnCreate === true }]));

  // Gating probe, inline (decision 9) — same as the offer-add preview.
  const gating = await probeGatingForAsins(asins, { query: (sql, params) => query(sql, params) });
  log(`Relist gating probe (${asins.length} ASINs): yes=${gating.counts.yes} no=${gating.counts.no} error=${gating.counts.error + gating.counts.missing_row}`);

  const submitRows = await loadSubmitRows(asins);
  const settings = await loadSettingsForSubmit();
  const inboundRow = await query(`SELECT value FROM settings WHERE key='include_inbound_shipping'`);
  const includeInboundShipping = inboundRow.rows[0]?.value === "true" || inboundRow.rows[0]?.value === true;
  const skusRes = await query(`SELECT sku FROM asin_skus`);
  const allExistingSkus = skusRes.rows.map((r: any) => String(r.sku));

  log(`Relist ${opts.dryRun ? "PREVIEW" : "SUBMIT (LIVE)"} for ${items.length} SKU(s): ${items.map((it) => `${it.asin}→${it.sku}`).join(", ")}${opts.openOnCreate ? " [openOnCreate]" : ""}`);

  const result = await submitOfferAddBatch(submitRows, {
    queryFn: (sql, params) => query(sql, params),
    sellerId: opts.sellerId,
    settings,
    includeInboundShipping,
    allExistingSkus,
    relist,
    productRegistry: makeProductRegistryRepo((sql, params) => query(sql, params)),
    phase4Mode: opts.dryRun ? "preview" : "live",
  });

  const createdPairs = result.perAsin
    .filter((p) => p.outcome.kind === "created")
    .map((p) => ({ asin: p.outcome.asin, sku: (p.outcome as any).sku as string }));
  return { result, createdPairs };
}
