// Settings rows → the typed Settings calculateProfit takes. Pure (no pool), so
// the offer-add loaders and the Capture PO history's "This PO" profit
// (server/extension-history.ts) read the same keys the same way.
import { settingsSchema, type Settings } from "@shared/schema";

/** Pure: settings rows → the typed Settings calculateProfit takes (also the Capture PO history's "This PO" profit). */
export function settingsFromRows(rows: ReadonlyArray<{ key: string; value: unknown }>): Settings {
  const raw: Record<string, any> = {};
  for (const r of rows) {
    const n = parseFloat(r.value as any);
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
