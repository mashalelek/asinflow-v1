// Offer-add loaders, shared by the Add to SC preview / submit routes and the
// §18 Relist path (route + script/relist.ts). Moved out of routes.ts unchanged
// so a script can run the same pipeline without registering the app.
import pool from "./db";
import type { SubmitAsinRow } from "./offer-add-submit";
import { settingsSchema, type Settings } from "@shared/schema";

// Shared loader for the offer-add preview + submit endpoints. Single source of
// truth so preview and submit can't diverge on which DB fields they read.
export async function loadSubmitRows(asins: string[]): Promise<SubmitAsinRow[]> {
  const rowsRes = await pool.query(
    `SELECT a.asin,
            a.is_catalog_deleted,
            COALESCE(e.eligibility_status, NULL) AS eligibility_status,
            a.gating_checked_at,
            COALESCE(a.is_hazmat, false) AS is_hazmat,
            a.category,
            a.weight_lb,
            COALESCE(e.estimated_cogs, e.cogs) AS cogs,
            e.fba_fee,
            e.referral_fee,
            e.fees_estimate_price,
            e.prep_override,
            e.storage_override
       FROM asins a
       LEFT JOIN asin_estimates e ON e.asin = a.asin
      WHERE a.asin = ANY($1::text[])`,
    [asins],
  );
  const rowByAsin = new Map<string, any>(rowsRes.rows.map((r: any) => [r.asin, r]));
  const settings = await loadSettingsForSubmit();
  return asins.map((asin) => {
    const r = rowByAsin.get(asin);
    return {
      asin,
      is_catalog_deleted: r?.is_catalog_deleted ?? false,
      eligibility_status: r?.eligibility_status ?? null,
      gating_checked_at: r?.gating_checked_at ? new Date(r.gating_checked_at).toISOString() : null,
      is_hazmat: r?.is_hazmat === true,
      cogs: r?.cogs != null ? parseFloat(r.cogs) : null,
      fbaFee: r?.fba_fee != null ? parseFloat(r.fba_fee) : null,
      referralFee: r?.referral_fee != null ? parseFloat(r.referral_fee) : null,
      feesEstimatePrice: r?.fees_estimate_price != null ? parseFloat(r.fees_estimate_price) : null,
      weightLbs: r?.weight_lb != null ? parseFloat(r.weight_lb) : null,
      category: r?.category ?? null,
      prepCost: r?.prep_override != null ? parseFloat(r.prep_override) : settings.prepCost,
      storageCost: r?.storage_override != null ? parseFloat(r.storage_override) : settings.storageFee,
    };
  });
}

// Settings DB-key → settingsSchema field mapping. Used by the offer-add submit
// endpoint to construct the typed Settings object that the price resolver needs.
// Matches the diag script's loadSettings pattern (script/diag-price-resolver-sample.ts).
export async function loadSettingsForSubmit(): Promise<Settings> {
  const result = await pool.query("SELECT key, value FROM settings");
  const raw: Record<string, any> = {};
  for (const r of result.rows) {
    const n = parseFloat(r.value);
    raw[r.key] = isNaN(n) ? r.value : n;
  }
  const mapped = {
    inboundShippingCost: raw.inbound_shipping_per_lb,
    prepCost: raw.prep_cost,
    storageFee: raw.storage_fee,
    lowInventorySurcharge: raw.low_inventory_surcharge,
    hazmatShipSurcharge: raw.hazmat_ship_surcharge,
    hazmatPrepSurcharge: raw.hazmat_prep_surcharge,
    minRoiThreshold: raw.min_roi,
    minMarginThreshold: raw.min_margin,
  };
  const cleaned = Object.fromEntries(
    Object.entries(mapped).filter(([_, v]) => v !== undefined && v !== null && !isNaN(v as number)),
  );
  return settingsSchema.parse(cleaned);
}
