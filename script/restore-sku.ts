// Re-create a deleted Seller Central SKU on its ASIN — the SAME SKU, not a
// generated one (Maria 2026-10-22: KZ-K3SV-T350 on B078MYRN9V; Velocity's
// inbound order is keyed on it). The Add to SC path cannot do this: its
// skuOverride takes only the canonical BRD-DEP-AS3-TTL-NNN form on the
// generate path, and an ASIN with any SKU already in SC stops at
// already_in_catalog. So this runs that path's own pieces, unchanged:
//   price    — fetchCompetingOffers + resolveOfferPrice on the submit rows /
//              settings the route loads (same SQL)
//   DG       — fetchDgHzLive + fetchDgHzRegulationEnum + resolveDgHzRegulation
//   payload  — buildOfferOnlyPayload (condition new, FBA, no quantity,
//              BORN CLOSED end_at), the forbidden-quantity pre-flight
//   PUT      — putListingsItem → mapPutListingsResponse
//   DB       — the same primary promotion statement and recordSubmission
//   after    — poll getListingsItem until the SKU resolves, then verifyPending
//              scoped to the new ledger row.
// Never a different SKU: if Amazon refuses this one, it reports and stops.
//   npx tsx script/restore-sku.ts --asin B078MYRN9V --sku KZ-K3SV-T350          # plan only
//   npx tsx script/restore-sku.ts --asin B078MYRN9V --sku KZ-K3SV-T350 --live   # PUT + writes + verify
import "dotenv/config";
import pool from "../server/db";
import { settingsSchema } from "@shared/schema";
import { resolveOfferPrice } from "@shared/price-resolver";
import { fetchCompetingOffers } from "../server/listings-offers-fetch";
import { checkSkuListingStatus } from "../server/sku-listing-fetch";
import { fetchDgHzLive } from "../server/sku-catalog-fetch";
import { fetchDgHzRegulationEnum } from "../server/listings-definitions";
import { resolveDgHzRegulation } from "../server/hazmat-classify";
import { buildOfferOnlyPayload, findForbiddenQuantityPaths } from "../server/offer-add";
import { putListingsItem } from "../server/listings-write";
import { mapPutListingsResponse } from "../server/listings-error-map";
import { recordSubmission, verifyPending } from "../server/listing-submissions-repo";

const PRODUCT_TYPE = "PRODUCT"; // offer-add.ts: offer-only matching uses the generic PRODUCT type
const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1]?.trim() : undefined; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// routes.ts loadSettingsForSubmit, verbatim.
async function loadSettings() {
  const result = await pool.query("SELECT key, value FROM settings");
  const raw: Record<string, any> = {};
  for (const r of result.rows) { const n = parseFloat(r.value); raw[r.key] = isNaN(n) ? r.value : n; }
  const mapped = {
    inboundShippingCost: raw.inbound_shipping_per_lb, prepCost: raw.prep_cost, storageFee: raw.storage_fee,
    lowInventorySurcharge: raw.low_inventory_surcharge, hazmatShipSurcharge: raw.hazmat_ship_surcharge,
    hazmatPrepSurcharge: raw.hazmat_prep_surcharge, minRoiThreshold: raw.min_roi, minMarginThreshold: raw.min_margin,
  };
  return settingsSchema.parse(Object.fromEntries(Object.entries(mapped).filter(([_, v]) => v !== undefined && v !== null && !isNaN(v as number))));
}

async function main(): Promise<number> {
  const asin = arg("asin")?.toUpperCase(), sku = arg("sku")?.toUpperCase();
  const live = process.argv.includes("--live");
  const sellerId = process.env.SP_API_SELLER_ID;
  if (!asin || !sku || !sellerId) { console.error("--asin, --sku and SP_API_SELLER_ID are required"); return 1; }

  // 1. The SKU is this ASIN's, and Amazon no longer has it.
  const own = (await pool.query(`SELECT s.sku, s.is_primary FROM asin_skus s JOIN asins a ON a.id = s.asin_id WHERE a.asin = $1 AND s.sku = $2`, [asin, sku])).rows[0];
  if (!own) { console.error(`${sku} is not an asin_skus row of ${asin} — refusing`); return 2; }
  const before = await checkSkuListingStatus(sellerId, sku);
  console.log(`getListingsItem ${sku}: ${JSON.stringify(before)}`);
  if (!before.ok) { console.error("listing check failed — not submitting"); return 2; }
  if (before.present) { console.error(`${sku} still exists in SC — nothing to restore`); return 2; }

  // 2. Price — the route's submit row (loadSubmitRows SQL) + the resolver.
  const settings = await loadSettings();
  const r = (await pool.query(
    `SELECT a.is_catalog_deleted, e.eligibility_status, COALESCE(a.is_hazmat, false) AS is_hazmat, a.category, a.weight_lb,
            COALESCE(e.estimated_cogs, e.cogs) AS cogs, e.fba_fee, e.referral_fee, e.fees_estimate_price, e.prep_override, e.storage_override
       FROM asins a LEFT JOIN asin_estimates e ON e.asin = a.asin WHERE a.asin = $1`, [asin])).rows[0];
  if (!r) { console.error(`${asin} not in asins`); return 2; }
  if (r.is_catalog_deleted || r.eligibility_status !== "yes") { console.error(`${asin} not submittable: catalog_deleted=${r.is_catalog_deleted} eligibility=${r.eligibility_status}`); return 2; }
  const num = (v: any) => (v != null ? parseFloat(v) : null);
  const inboundRow = await pool.query(`SELECT value FROM settings WHERE key='include_inbound_shipping'`);
  const includeInboundShipping = inboundRow.rows[0]?.value === "true" || inboundRow.rows[0]?.value === true;
  const offers = await fetchCompetingOffers(asin, sellerId);
  const resolved = resolveOfferPrice({
    cogs: num(r.cogs), fbaFee: num(r.fba_fee), referralFee: num(r.referral_fee), feesEstimatePrice: num(r.fees_estimate_price),
    weightLbs: num(r.weight_lb), isHazmat: r.is_hazmat === true, category: r.category ?? null,
    prepCost: r.prep_override != null ? parseFloat(r.prep_override) : settings.prepCost,
    storageCost: r.storage_override != null ? parseFloat(r.storage_override) : settings.storageFee,
    offers: offers.ok
      ? { kind: "definitive" as const, offers: offers.allOffers.filter((o) => o.sellerId !== sellerId), competitivePriceThreshold: offers.competitivePriceThreshold, buyBoxPrice: offers.buyBoxPrice }
      : { kind: "fetch_failed" as const, reason: `${offers.reason}${offers.status ? ` (${offers.status})` : ""}: ${offers.message}` },
  }, settings, includeInboundShipping);
  console.log(`price: ${resolved.resolvedPrice ?? "BLOCKED"} (${resolved.source ?? resolved.blocked}) — ${resolved.detail}; cogs ${num(r.cogs)}`);
  if (resolved.resolvedPrice == null) return 3;

  // 3. DG — live, as the reuse path does.
  const dgLive = await fetchDgHzLive(asin);
  const dgEnum = await fetchDgHzRegulationEnum(PRODUCT_TYPE, sellerId);
  const dg = resolveDgHzRegulation(dgLive?.dgHzRegulation ?? null, dgLive?.isDangerousGood ?? false, dgEnum);
  if (dg.kind === "unresolved") { console.error(`DG unresolved (catalog value ${JSON.stringify(dgLive?.dgHzRegulation)}) — not submitting`); return 3; }

  // 4. Payload — the builder, unchanged; the pre-flight quantity abort.
  const payload = buildOfferOnlyPayload({ asin, productNumber: 1, price: resolved.resolvedPrice, cogs: num(r.cogs) }, dg.value);
  const forbidden = findForbiddenQuantityPaths(payload);
  if (forbidden.length) { console.error(`payload carries the fulfillment quantity key at ${forbidden.join(", ")} — aborted`); return 3; }
  console.log(`PUT /listings/2021-08-01/items/${sellerId}/${sku} ${JSON.stringify(payload)}`);
  if (!live) { console.log("no --live: nothing sent, nothing written"); return 0; }

  const call = await putListingsItem({ sellerId, sku, productType: PRODUCT_TYPE, attributes: payload.attributes, requirements: "LISTING_OFFER_ONLY" });
  const outcome = mapPutListingsResponse(call);
  console.log(`PUT outcome: ${JSON.stringify(outcome)}`);
  if (!outcome.ok) { console.error(`Amazon refused ${sku} — stopping, no other SKU is created`); return 4; }

  // 5. The same writes offer-add.ts makes on ok: primary promotion (one statement) + ledger row.
  await pool.query(
    `WITH tgt AS (SELECT id FROM asins WHERE asin = $1),
     promote AS (INSERT INTO asin_skus (asin_id, sku, is_primary) SELECT id, $2, true FROM tgt ON CONFLICT (asin_id, sku) DO UPDATE SET is_primary = true),
     demote AS (UPDATE asin_skus SET is_primary = false WHERE asin_id = (SELECT id FROM tgt) AND sku <> $2)
     UPDATE asins SET primary_sku = $2 WHERE asin = $1`,
    [asin, sku],
  );
  await recordSubmission({
    asin, sku, submissionId: (outcome as any).submissionId ?? null, submittedPrice: resolved.resolvedPrice,
    pricing: {
      source: resolved.source!, detail: resolved.detail, anchorOfferPrice: resolved.anchorOffer?.price ?? null,
      anchorOfferFeedback: resolved.anchorOffer?.feedbackCount ?? null, cptSeen: resolved.competitivePriceThreshold,
      resultingRoi: resolved.resultingRoi, warning: resolved.warning, qualifiedOfferCount: resolved.qualifiedCount,
      disqualifiedOffers: resolved.disqualified,
    } as any,
  }, (s: string, p?: any[]) => pool.query(s, p) as any);
  const sub = (await pool.query(`SELECT id FROM listing_submissions WHERE asin = $1 AND sku = $2 ORDER BY submitted_at DESC LIMIT 1`, [asin, sku])).rows[0];
  console.log(`written: asin_skus ${sku} primary, asins.primary_sku = ${sku}, listing_submissions ${sub?.id}`);

  // 6. Poll until the SKU resolves (≤ 30 min), then the normal verification, scoped.
  const t0 = Date.now();
  for (;;) {
    await sleep(60_000);
    const s = await checkSkuListingStatus(sellerId, sku);
    const mins = Math.round((Date.now() - t0) / 60000);
    console.log(`T+${mins}m getListingsItem: ${s.ok ? (s.present ? `present ${JSON.stringify((s as any).statuses)}` : "not yet") : "transient error"}`);
    if (s.ok && s.present) break;
    if (mins >= 30) { console.log("not resolved within 30 min — leaving the ledger row pending for the §19 sweep"); break; }
  }
  if (sub?.id) console.log(`verifyPending: ${JSON.stringify(await verifyPending(sellerId, { ids: [sub.id], query: (s: string, p?: any[]) => pool.query(s, p) as any }))}`);
  return 0;
}
main().then(async (c) => { await pool.end(); process.exit(c); }).catch(async (e) => { console.error(e?.stack ?? e); await pool.end().catch(() => {}); process.exit(1); });
