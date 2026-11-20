// Profit settings ↔ `settings` table keys (Finances API patch commit 1, SPEC §5
// "Settings live in the database"). ONE map for the server reader
// (`settingsFromRows`), the writer (`PUT /api/settings`) and migration 122;
// the browser's localStorage copy is gone. `storageFee` is the dialog's
// "Additional Fees ($/unit)" field and has always been the DB's
// `additional_fees` row.
import { settingsSchema, type Settings } from "./schema";

export const SETTINGS_KEY_MAP: Readonly<Record<keyof Settings, string>> = {
  inboundShippingCost: "inbound_shipping_per_lb",
  prepCost: "prep_cost",
  storageFee: "additional_fees",
  lowInventorySurcharge: "low_inventory_surcharge",
  hazmatShipSurcharge: "hazmat_ship_surcharge",
  hazmatPrepSurcharge: "hazmat_prep_surcharge",
  minRoiThreshold: "min_roi",
  minMarginThreshold: "min_margin",
  minProfitUnitThreshold: "min_profit_unit",
  maxCogsMinMarginPct: "max_cogs_min_margin_pct",
  maxCogsMinRoiPct: "max_cogs_min_roi_pct",
  maxCogsMinProfitUnit: "max_cogs_min_profit_unit",
};

export const SETTINGS_FIELDS = Object.keys(SETTINGS_KEY_MAP) as (keyof Settings)[];
export const SETTINGS_DB_KEYS = Object.values(SETTINGS_KEY_MAP);

/** Pure: `settings` rows (key, value — jsonb number or its text) → the typed Settings; a missing / non-numeric key keeps the schema default. */
export function settingsFromRows(rows: ReadonlyArray<{ key: string; value: unknown }>): Settings {
  const byKey = new Map(rows.map((r) => [r.key, r.value] as const));
  const partial: Partial<Settings> = {};
  for (const field of SETTINGS_FIELDS) {
    const v = byKey.get(SETTINGS_KEY_MAP[field]);
    const n = typeof v === "number" ? v : v == null ? NaN : parseFloat(String(v));
    if (Number.isFinite(n) && n >= 0) partial[field] = n;
  }
  return settingsSchema.parse(partial);
}

/** Pure: the fields of a Settings patch → (key, value) rows to upsert; unknown fields and non-finite / negative values are dropped. */
export function settingsToRows(patch: Partial<Record<keyof Settings, unknown>>): { key: string; value: number }[] {
  const out: { key: string; value: number }[] = [];
  for (const field of SETTINGS_FIELDS) {
    if (!(field in patch)) continue;
    const n = Number(patch[field]);
    if (Number.isFinite(n) && n >= 0) out.push({ key: SETTINGS_KEY_MAP[field], value: n });
  }
  return out;
}
