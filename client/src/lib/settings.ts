import { type Settings } from "@shared/schema";

const SETTINGS_KEY = "fba-analyzer-settings";

export const defaultSettings: Settings = {
  inboundShippingCost: 0.5,
  prepCost: 0,
  storageFee: 0,
  lowInventorySurcharge: 0.26,
  hazmatShipSurcharge: 0,
  hazmatPrepSurcharge: 0,
  minRoiThreshold: 15,
  minMarginThreshold: 10,
  minProfitUnitThreshold: 3,
  maxCogsMinMarginPct: 12,
  maxCogsMinRoiPct: 20,
  maxCogsMinProfitUnit: 3,
};

export function loadSettings(): Settings {
  try {
    const stored = localStorage.getItem(SETTINGS_KEY);
    if (stored) {
      return { ...defaultSettings, ...JSON.parse(stored) };
    }
  } catch {}
  return { ...defaultSettings };
}

export function saveSettings(settings: Settings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

// Include Inbound Shipping in profit (2026-09-09): ONE key for every page.
// Was home.tsx-local ("fba-include-inbound" — key preserved, so existing
// values carry over); Bulk Calc silently hard-defaulted to true, which was
// the §21 settings drift. Analytics still has its own deliberate key
// (fba-analytics-include-inbound) — flagged in SPEC, not part of this fix.
const INBOUND_KEY = "fba-include-inbound";

export function loadIncludeInbound(): boolean {
  try {
    const v = localStorage.getItem(INBOUND_KEY);
    if (v !== null) return v === "true";
  } catch {}
  return true;
}

export function saveIncludeInbound(v: boolean): void {
  localStorage.setItem(INBOUND_KEY, String(v));
}
