// DA-4 substep 1 verification: run price resolver against ~10 representative
// real ASINs. Read-only — no wiring to preview, no live writes.
//
// Picks a mix:
//   - Multiple competing offers (Rule 1, verify "highest excluding ours")
//   - Zero competing offers (Rule 2, verify 100% ROI solve)
//   - ASINs we currently list (verify ourSellerId filter works)
//   - Missing/zero COGS (Rule 2 edge: skip_no_cogs)
//   - Varying fee categories (Beauty / Grocery / etc.)
//
// Prints a table: ASIN | #competing | highest-comp | rule | COGS | resolved $ | resulting ROI
//
// SP-API auth + DB query inlined to avoid bootstrapping server/index.ts (Express).

import "dotenv/config";
import axios from "axios";
import pool, { query } from "../server/db";
import {
  resolveOfferPrice,
  type PriceResolverInput,
  type OffersInput,
} from "../shared/price-resolver";
import { fetchCompetingOffers } from "../server/listings-offers-fetch";
import { settingsSchema, type Settings, calculateProfit } from "../shared/schema";

const MARKETPLACE = "ATVPDKIKX0DER";
const SELLER_ID = process.env.SP_API_SELLER_ID;
if (!SELLER_ID) {
  console.error("SP_API_SELLER_ID not set"); process.exit(1);
}

// --- inlined SP-API GET (avoids server/index.ts boot) ---------------------
let cachedToken: { value: string; expiresAt: number } | null = null;
async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60000) return cachedToken.value;
  const res = await axios.post("https://api.amazon.com/auth/o2/token", {
    grant_type: "refresh_token",
    refresh_token: process.env.SP_API_REFRESH_TOKEN!,
    client_id: process.env.SP_API_CLIENT_ID!,
    client_secret: process.env.SP_API_CLIENT_SECRET!,
  });
  cachedToken = { value: res.data.access_token, expiresAt: Date.now() + res.data.expires_in * 1000 };
  return cachedToken.value;
}
async function spGet(endpoint: string, params?: Record<string, any>) {
  const token = await getAccessToken();
  const res = await axios.get(`https://sellingpartnerapi-na.amazon.com${endpoint}`, {
    headers: { Authorization: `Bearer ${token}`, "x-amz-access-token": token },
    params,
  });
  return res.data;
}
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- load Settings from DB so the diag reflects production behavior --------
async function loadSettings(): Promise<Settings> {
  const rows = await query(`SELECT key, value FROM settings`);
  const raw: Record<string, any> = {};
  for (const r of rows.rows) {
    const n = parseFloat(r.value);
    raw[r.key] = isNaN(n) ? r.value : n;
  }
  // Map DB keys to settingsSchema fields (best-effort; missing → defaults)
  const mapped = {
    inboundShippingCost: raw.inbound_shipping_cost,
    prepCost: raw.prep_cost,
    storageFee: raw.storage_fee,
    lowInventorySurcharge: raw.low_inventory_surcharge,
    hazmatShipSurcharge: raw.hazmat_ship_surcharge,
    hazmatPrepSurcharge: raw.hazmat_prep_surcharge,
    minRoiThreshold: raw.min_roi_threshold,
    minMarginThreshold: raw.min_margin_threshold,
    minProfitUnitThreshold: raw.min_profit_unit_threshold,
    maxCogsMinMarginPct: raw.max_cogs_min_margin_pct,
    maxCogsMinRoiPct: raw.max_cogs_min_roi_pct,
    maxCogsMinProfitUnit: raw.max_cogs_min_profit_unit,
  };
  const cleaned = Object.fromEntries(
    Object.entries(mapped).filter(([_, v]) => v !== undefined && v !== null && !isNaN(v as number)),
  );
  return settingsSchema.parse(cleaned);
}

// --- pick representative ASINs ---------------------------------------------
interface SampleRow {
  asin: string;
  title: string | null;
  brand: string | null;
  category: string | null;
  estimated_cogs: number | null;
  fba_fee: number | null;
  referral_fee: number | null;
  fees_estimate_price: number | null;
  weight_lb: number | null;
  is_hazmat: boolean | null;
  prep_override: number | null;
  storage_override: number | null;
  sellers_fba: number | null;
  sellers_fbm: number | null;
  primary_sku: string | null;
  scenario: string;
}

async function pickSampleASINs(): Promise<SampleRow[]> {
  // Each pick targets a distinct scenario; combine into one list.
  const queries: Array<{ label: string; sql: string; limit: number }> = [
    {
      label: "multi-offer (≥3 sellers, alive)",
      sql: `SELECT 'multi-offer' AS scenario, a.asin, a.title, a.brand, a.category, e.estimated_cogs,
                   e.fba_fee, e.referral_fee, e.fees_estimate_price, a.weight_lb,
                   a.is_hazmat, e.prep_override, e.storage_override,
                   e.sellers_fba, e.sellers_fbm, a.primary_sku
              FROM asins a JOIN asin_estimates e ON e.asin = a.asin
             WHERE a.is_active = TRUE AND a.is_catalog_deleted = FALSE
               AND e.estimated_cogs IS NOT NULL AND e.estimated_cogs > 0
               AND (COALESCE(e.sellers_fba,0) + COALESCE(e.sellers_fbm,0)) >= 3
               AND a.primary_sku IS NULL
             ORDER BY random() LIMIT 3`,
      limit: 3,
    },
    {
      label: "we-currently-list (have primary_sku — must filter ours out)",
      sql: `SELECT 'we-list' AS scenario, a.asin, a.title, a.brand, a.category, e.estimated_cogs,
                   e.fba_fee, e.referral_fee, e.fees_estimate_price, a.weight_lb,
                   a.is_hazmat, e.prep_override, e.storage_override,
                   e.sellers_fba, e.sellers_fbm, a.primary_sku
              FROM asins a JOIN asin_estimates e ON e.asin = a.asin
             WHERE a.is_active = TRUE AND a.is_catalog_deleted = FALSE
               AND a.primary_sku IS NOT NULL
             ORDER BY random() LIMIT 2`,
      limit: 2,
    },
    {
      label: "low-competition (≤1 seller, possible Rule 2)",
      sql: `SELECT 'low-comp' AS scenario, a.asin, a.title, a.brand, a.category, e.estimated_cogs,
                   e.fba_fee, e.referral_fee, e.fees_estimate_price, a.weight_lb,
                   a.is_hazmat, e.prep_override, e.storage_override,
                   e.sellers_fba, e.sellers_fbm, a.primary_sku
              FROM asins a JOIN asin_estimates e ON e.asin = a.asin
             WHERE a.is_active = TRUE AND a.is_catalog_deleted = FALSE
               AND e.estimated_cogs IS NOT NULL AND e.estimated_cogs > 0
               AND (COALESCE(e.sellers_fba,0) + COALESCE(e.sellers_fbm,0)) <= 1
               AND a.primary_sku IS NULL
             ORDER BY random() LIMIT 3`,
      limit: 3,
    },
    {
      label: "missing-cogs (Rule 2 edge — skip_no_cogs expected)",
      sql: `SELECT 'no-cogs' AS scenario, a.asin, a.title, a.brand, a.category, e.estimated_cogs,
                   e.fba_fee, e.referral_fee, e.fees_estimate_price, a.weight_lb,
                   a.is_hazmat, e.prep_override, e.storage_override,
                   e.sellers_fba, e.sellers_fbm, a.primary_sku
              FROM asins a JOIN asin_estimates e ON e.asin = a.asin
             WHERE a.is_active = TRUE AND a.is_catalog_deleted = FALSE
               AND (e.estimated_cogs IS NULL OR e.estimated_cogs = 0)
               AND (COALESCE(e.sellers_fba,0) + COALESCE(e.sellers_fbm,0)) <= 1
             ORDER BY random() LIMIT 2`,
      limit: 2,
    },
  ];

  const out: SampleRow[] = [];
  for (const q of queries) {
    const rs = await query(q.sql);
    out.push(...rs.rows);
  }
  return out;
}

// --- main -----------------------------------------------------------------
(async () => {
  console.error("Loading settings from DB...");
  const settings = await loadSettings();
  console.error("Settings loaded:", { inboundShippingCost: settings.inboundShippingCost, prepCost: settings.prepCost });

  console.error("Picking sample ASINs...");
  const samples = await pickSampleASINs();
  console.error(`Picked ${samples.length} ASINs across scenarios\n`);

  type Row = {
    asin: string;
    scenario: string;
    title: string;
    category: string;
    nComp: number;
    highestComp: number | null;
    ourOffer: number | null;
    rule: string;
    cogs: number | null;
    resolved: number | null;
    resultingRoi: number | null;
    cogsMissing: boolean;
    detail: string;
  };
  const results: Row[] = [];

  for (const s of samples) {
    console.error(`Fetching offers for ${s.asin} (${s.scenario})...`);
    let offersInput: OffersInput;
    let ourOffer: number | null = null;
    let competingCount = 0;

    const offers = await fetchCompetingOffers(s.asin, SELLER_ID!, spGet);
    if (offers.ok) {
      offersInput = { kind: "definitive", competing: offers.competingOffers };
      ourOffer = offers.ourOffer;
      competingCount = offers.competingOffers.length;
    } else {
      // Distinct from definitive empty — UNKNOWN, must NOT collapse to Rule 2.
      offersInput = { kind: "fetch_failed", reason: `${offers.reason} (${offers.status ?? "?"}): ${offers.message}` };
    }

    const input: PriceResolverInput = {
      cogs: s.estimated_cogs != null ? Number(s.estimated_cogs) : null,
      fbaFee: s.fba_fee != null ? Number(s.fba_fee) : null,
      referralFee: s.referral_fee != null ? Number(s.referral_fee) : null,
      feesEstimatePrice: s.fees_estimate_price != null ? Number(s.fees_estimate_price) : null,
      weightLbs: s.weight_lb != null ? Number(s.weight_lb) : null,
      isHazmat: s.is_hazmat === true,
      category: s.category,
      prepCost: s.prep_override != null ? Number(s.prep_override) : settings.prepCost,
      storageCost: s.storage_override != null ? Number(s.storage_override) : settings.storageFee,
      offers: offersInput,
    };

    const result = resolveOfferPrice(input, settings, /* includeInboundShipping */ true);

    results.push({
      asin: s.asin,
      scenario: s.scenario,
      title: (s.title ?? "").slice(0, 60),
      category: s.category ?? "—",
      nComp: competingCount,
      highestComp: result.highestCompetingOffer,
      ourOffer,
      rule: result.rule,
      cogs: input.cogs,
      resolved: result.resolvedPrice,
      resultingRoi: result.resultingRoi,
      cogsMissing: result.cogsMissing,
      detail: result.detail,
    });

    // Pace at 2200ms — getItemOffers's confirmed rate limit is 0.5 rps
    // (2000ms minimum interval). 500ms here was 4× over and was the
    // root cause of the back-half 429s in prior runs.
    await delay(2200);
  }

  // ─── Print table ─────────────────────────────────────────────────────────
  console.log(`\n${"═".repeat(140)}`);
  console.log(`SCENARIO              ASIN        #COMP HIGHEST   OURS   RULE                 COGS    RESOLVED  ROI%   FLAG`);
  console.log("─".repeat(155));
  for (const r of results) {
    const nComp = String(r.nComp).padStart(3);
    const highest = r.highestComp != null ? `$${r.highestComp.toFixed(2)}`.padStart(8) : "    —   ";
    const ours = r.ourOffer != null ? `$${r.ourOffer.toFixed(2)}`.padStart(7) : "    —  ";
    const cogs = r.cogs != null ? `$${r.cogs.toFixed(2)}`.padStart(7) : "    —  ";
    const resolved = r.resolved != null ? `$${r.resolved.toFixed(2)}`.padStart(9) : "      — ";
    const roi = r.resultingRoi != null ? `${r.resultingRoi.toFixed(1)}%`.padStart(6) : "    — ";
    const flag = r.cogsMissing && r.rule === "highest_plus_30" ? "⚠ ROI unknown" : "";
    console.log(
      `${r.scenario.padEnd(20)}  ${r.asin.padEnd(11)} ${nComp}  ${highest}  ${ours}  ${r.rule.padEnd(18)}  ${cogs} ${resolved}  ${roi}   ${flag}`,
    );
  }
  console.log("═".repeat(140));

  // ─── Per-ASIN details (line below table) ─────────────────────────────────
  console.log(`\nDetails:`);
  for (const r of results) {
    console.log(`  ${r.asin} (${r.category}): ${r.detail}`);
    if (r.ourOffer != null) {
      console.log(`    OUR offer: $${r.ourOffer.toFixed(2)}  (must NOT appear in competing offers)`);
    }
  }
  console.log("");

  await pool.end();
  process.exit(0);
})().catch(async (err) => {
  console.error("Diag failed:", err.message);
  try { await pool.end(); } catch {}
  process.exit(1);
});
