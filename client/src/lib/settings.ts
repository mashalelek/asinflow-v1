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
