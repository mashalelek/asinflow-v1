// ONE-OFF DIAGNOSTIC (Maria, 2026-10-16), not a feature — not wired to any
// route or button. Question: what does putListingsItem do with a BRAND-GATED
// ASIN? Rejected synchronously (no SKU), or accepted with the restriction
// surfacing later (a SKU shell)?
//
// RESULT (run 2026-10-16, B0DK7YJCFF, stored eligibility_status 'no' since
// 2026-10-12, SKU ZZTEST-GATED-B0DK7YJCFF-001): putListingsItem returned
// 2xx, status ACCEPTED, submissionId 3004518a632045139a5a29acd841eef3,
// issues []. getListingsItem at T+10 s / T+60 s / T+5 min: the SKU EXISTS
// (200, summaries [] — a §18 A1 shell), the only issue an 18448 WARNING
// (missing animal_theme). No approval / restriction code ever surfaced.
// Deleted afterwards via deleteListingsItem (ACCEPTED). CONCLUSION: the API
// does NOT say no to a gated ASIN at submit time; the Listings Restrictions
// check is the only thing that does. The live gating probe STAYS in Add to
// SC (scheduler decision 9 confirmed; it runs inline since this date).
//
//   npx tsx script/probe-gated-submit.ts            # phase 1: build + print the payload, STOP
//   npx tsx script/probe-gated-submit.ts --send     # phase 2 (after go-ahead): PUT once, poll T+10s/60s/5min
//
// Phase 2 sends EXACTLY the payload phase 1 printed (saved to the job tmp dir),
// so nothing is re-resolved between the go-ahead and the send. Writes nothing
// to listing_submissions, asins or asin_skus — log only. Never deletes.
import "dotenv/config";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import pool from "../server/db";
import { settingsSchema } from "../shared/schema";
import { resolveOfferPrice } from "../shared/price-resolver";
import { fetchCompetingOffers } from "../server/listings-offers-fetch";
import { fetchDgHzLive } from "../server/sku-catalog-fetch";
import { fetchDgHzRegulationEnum } from "../server/listings-definitions";
import { resolveDgHzRegulation } from "../server/hazmat-classify";
import { buildOfferOnlyPayload, type OfferAddInput } from "../server/offer-add";
import { putListingsItem } from "../server/listings-write";
import { checkSkuListingStatus } from "../server/sku-listing-fetch";
import { spApiGet } from "../server/spapi-auth";

const ASIN = "B0DK7YJCFF";
const SKU = "ZZTEST-GATED-B0DK7YJCFF-001"; // outside BRD-DEP-AS3-TTL-NNN on purpose
const MARKETPLACE = "ATVPDKIKX0DER";
const PRODUCT_TYPE = "PRODUCT";
const TMP = process.env.CLAUDE_JOB_DIR ? join(process.env.CLAUDE_JOB_DIR, "tmp") : "/tmp";
const PAYLOAD_FILE = join(TMP, "probe-gated-payload.json");

const out: string[] = [];
function say(line = "") { out.push(line); console.log(line); }
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function loadRow() {
  const r = await pool.query(
    `SELECT a.asin, a.status, a.title, a.brand, a.category, a.weight_lb, COALESCE(a.is_hazmat, false) AS is_hazmat,
            e.eligibility_status, a.gating_checked_at, a.has_live_offer,
            COALESCE(e.estimated_cogs, e.cogs) AS cogs, e.fba_fee, e.referral_fee, e.fees_estimate_price,
            e.prep_override, e.storage_override, e.buy_box_price, e.lowest_fba_price,
            (SELECT COUNT(*)::int FROM asin_skus k WHERE k.asin_id = a.id) AS sku_rows,
            (SELECT COUNT(*)::int FROM listing_submissions s WHERE s.asin = a.asin) AS submissions
       FROM asins a LEFT JOIN asin_estimates e ON e.asin = a.asin WHERE a.asin = $1`, [ASIN]);
  if (!r.rows[0]) throw new Error(`${ASIN} not in asins`);
  return r.rows[0];
}

async function loadSettings() {
  const result = await pool.query("SELECT key, value FROM settings");
  const raw: Record<string, any> = {};
  for (const r of result.rows) { const n = parseFloat(r.value); raw[r.key] = isNaN(n) ? r.value : n; }
  const mapped = {
    inboundShippingCost: raw.inbound_shipping_per_lb, prepCost: raw.prep_cost, storageFee: raw.storage_fee,
    lowInventorySurcharge: raw.low_inventory_surcharge, hazmatShipSurcharge: raw.hazmat_ship_surcharge,
    hazmatPrepSurcharge: raw.hazmat_prep_surcharge, minRoiThreshold: raw.min_roi, minMarginThreshold: raw.min_margin,
  };
  const cleaned = Object.fromEntries(Object.entries(mapped).filter(([, v]) => v !== undefined && v !== null && !isNaN(v as number)));
  const includeInbound = raw.include_inbound_shipping === "true" || raw.include_inbound_shipping === true;
  return { settings: settingsSchema.parse(cleaned), includeInbound };
}

async function phase1Build() {
  const sellerId = process.env.SP_API_SELLER_ID!;
  if (!sellerId) throw new Error("SP_API_SELLER_ID not set");
  const row = await loadRow();
  say(`=== ${ASIN} as stored`);
  say(`title: ${row.title}`);
  say(`brand: ${row.brand} · status: ${row.status} · has_live_offer: ${row.has_live_offer} · asin_skus rows: ${row.sku_rows} · submissions: ${row.submissions}`);
  say(`eligibility_status: ${row.eligibility_status} (gating_checked_at ${row.gating_checked_at ? new Date(row.gating_checked_at).toISOString() : "null"})`);
  if (row.eligibility_status !== "no") throw new Error(`expected stored eligibility_status 'no', found '${row.eligibility_status}' — not a gated ASIN as stored; stopping`);

  // Price: the same resolver Add to SC phase 3 uses, on the same inputs.
  const { settings, includeInbound } = await loadSettings();
  const offers = await fetchCompetingOffers(ASIN, sellerId);
  const resolverInput = {
    cogs: row.cogs != null ? parseFloat(row.cogs) : null,
    fbaFee: row.fba_fee != null ? parseFloat(row.fba_fee) : null,
    referralFee: row.referral_fee != null ? parseFloat(row.referral_fee) : null,
    feesEstimatePrice: row.fees_estimate_price != null ? parseFloat(row.fees_estimate_price) : null,
    weightLbs: row.weight_lb != null ? parseFloat(row.weight_lb) : null,
    isHazmat: row.is_hazmat === true,
    category: row.category ?? null,
    prepCost: row.prep_override != null ? parseFloat(row.prep_override) : settings.prepCost,
    storageCost: row.storage_override != null ? parseFloat(row.storage_override) : settings.storageFee,
    offers: offers.ok
      ? { kind: "definitive" as const, offers: offers.allOffers.filter((o) => o.sellerId !== sellerId), competitivePriceThreshold: offers.competitivePriceThreshold, buyBoxPrice: offers.buyBoxPrice }
      : { kind: "fetch_failed" as const, reason: `${offers.reason}: ${offers.message}` },
  };
  const resolved = resolveOfferPrice(resolverInput, settings, includeInbound);
  say(`\n=== price resolver (Add to SC phase 3)`);
  say(`offers fetch: ${offers.ok ? `${offers.allOffers.length} offers, buy box ${offers.buyBoxPrice}, CPT ${offers.competitivePriceThreshold}` : `FAILED ${offers.reason}`}`);
  say(`resolved: price=${resolved.resolvedPrice} source=${resolved.source} blocked=${resolved.blocked} · ${resolved.detail}`);
  let price = resolved.resolvedPrice;
  if (price == null) {
    const fallback = row.buy_box_price != null ? parseFloat(row.buy_box_price) : row.lowest_fba_price != null ? parseFloat(row.lowest_fba_price) : null;
    if (fallback == null) throw new Error("no price: resolver blocked and no stored price — stopping");
    price = fallback;
    say(`NOTE: resolver blocked (${resolved.blocked}); Add to SC would SKIP this row. Using stored buy-box/lowest-FBA price ${price} so the gating question can still be asked.`);
  }

  // DG value + product-type definition, exactly as the orchestrator does (steps 3–4b).
  const live = await fetchDgHzLive(ASIN);
  const isDg = live?.isDangerousGood ?? false;
  const catalogDgHz = live?.dgHzRegulation ?? null;
  const dgEnum = await fetchDgHzRegulationEnum(PRODUCT_TYPE, sellerId);
  const dg = resolveDgHzRegulation(catalogDgHz, isDg, dgEnum);
  say(`\n=== DG (live catalog): is_dangerous_good=${isDg} catalog supplier_declared_dg_hz_regulation=${catalogDgHz ?? "absent"} → ${dg.kind === "value" ? dg.value : "UNRESOLVED"}`);
  if (dg.kind !== "value") throw new Error("DG value unresolved — Add to SC would exclude this row; stopping");

  const input: OfferAddInput = { asin: ASIN, productNumber: 0, price, cogs: resolverInput.cogs };
  const payload = buildOfferOnlyPayload(input, dg.value);
  const envelope = { sellerId, sku: SKU, productType: payload.productType, requirements: payload.requirements, attributes: payload.attributes, marketplaceIds: MARKETPLACE };
  writeFileSync(PAYLOAD_FILE, JSON.stringify(envelope, null, 2), { mode: 0o600 });
  say(`\n=== PUT /listings/2021-08-01/items/${sellerId}/${SKU}?marketplaceIds=${MARKETPLACE}`);
  say(JSON.stringify({ productType: payload.productType, requirements: payload.requirements, attributes: payload.attributes }, null, 2));
  say(`\nPayload saved to ${PAYLOAD_FILE}. STOP — nothing sent. Re-run with --send after go-ahead.`);
}

async function describeSku(sellerId: string, label: string) {
  const r = await checkSkuListingStatus(sellerId, SKU);
  if (r.ok && r.present) {
    say(`${label}: SKU EXISTS — statuses ${JSON.stringify(r.statuses)} issues ${JSON.stringify(r.issues)}`);
    return true;
  }
  if (r.ok && !r.present && (r as any).shell) {
    // 200 with no summaries: a SKU shell (§18 A1). Show the raw body.
    let raw: any = null;
    try { raw = await spApiGet(`/listings/2021-08-01/items/${sellerId}/${encodeURIComponent(SKU)}`, { marketplaceIds: MARKETPLACE, includedData: "summaries,issues,attributes" }); } catch {}
    say(`${label}: SKU SHELL EXISTS (200, summaries: []) — raw: ${JSON.stringify(raw)?.slice(0, 1500)}`);
    return true;
  }
  if (r.ok) { say(`${label}: no SKU (404)`); return false; }
  say(`${label}: transient ${r.status ?? ""} ${r.message}`);
  return false;
}

async function phase2Send() {
  const sellerId = process.env.SP_API_SELLER_ID!;
  if (!existsSync(PAYLOAD_FILE)) throw new Error("no saved payload — run phase 1 first");
  const env = JSON.parse(readFileSync(PAYLOAD_FILE, "utf8"));
  if (env.sku !== SKU || env.attributes?.merchant_suggested_asin?.[0]?.value !== ASIN) throw new Error("saved payload does not match this test — refusing");
  say(`=== pre-check: does ${SKU} already exist?`);
  if (await describeSku(sellerId, "pre")) throw new Error("SKU already exists before the test — stopping");

  say(`\n=== putListingsItem (ONE call) at ${new Date().toISOString()}`);
  const result = await putListingsItem({ sellerId, sku: SKU, productType: env.productType, attributes: env.attributes, requirements: env.requirements });
  if (result.kind === "ok") {
    say(`HTTP 2xx — body.status=${result.body?.status} submissionId=${result.body?.submissionId} sku=${result.body?.sku}`);
    say(`issues: ${JSON.stringify(result.body?.issues ?? [], null, 2)}`);
    say(`full body: ${JSON.stringify(result.body)}`);
  } else if (result.kind === "http_error") {
    say(`HTTP ${result.status} — body: ${JSON.stringify(result.body, null, 2)}`);
  } else {
    say(`NETWORK ERROR: ${result.message}`);
  }

  let exists = false;
  for (const [label, ms] of [["T+10s", 10_000], ["T+60s", 50_000], ["T+5min", 240_000]] as const) {
    await sleep(ms);
    say(`\n--- ${label} (${new Date().toISOString()})`);
    exists = (await describeSku(sellerId, label)) || exists;
  }
  say(exists ? `\nRESULT: a SKU exists in SC for ${SKU}. STOP — not deleting; awaiting Maria's word.` : `\nRESULT: no SKU exists in SC for ${SKU} after 5 minutes.`);
}

(async () => {
  try {
    if (process.argv.includes("--send")) await phase2Send(); else await phase1Build();
  } catch (err: any) {
    say(`ERROR: ${err?.message ?? err}`);
    process.exitCode = 1;
  } finally {
    writeFileSync(join(TMP, `probe-gated-${process.argv.includes("--send") ? "send" : "build"}.log`), out.join("\n") + "\n");
    await pool.end();
  }
})();
