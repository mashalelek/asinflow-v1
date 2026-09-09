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

// Include Inbound Shipping in profit (2026-09-09): ONE key for every page —
// home, Bulk Calc, AND Analytics (its fba-analytics-include-inbound key was
// folded in 2026-09-09: value migrated only when the shared key was unset,
// shared key wins otherwise; the old key is removed on first load).
const INBOUND_KEY = "fba-include-inbound";
const LEGACY_ANALYTICS_INBOUND_KEY = "fba-analytics-include-inbound";

export function loadIncludeInbound(): boolean {
  try {
    const legacy = localStorage.getItem(LEGACY_ANALYTICS_INBOUND_KEY);
    if (legacy !== null) {
      if (localStorage.getItem(INBOUND_KEY) === null) localStorage.setItem(INBOUND_KEY, legacy);
      localStorage.removeItem(LEGACY_ANALYTICS_INBOUND_KEY);
    }
    const v = localStorage.getItem(INBOUND_KEY);
    if (v !== null) return v === "true";
  } catch {}
  return true;
}

export function saveIncludeInbound(v: boolean): void {
  localStorage.setItem(INBOUND_KEY, String(v));
}

// Price source (2026-09-09): shared + persisted for every page — was
// session-only on the ASINs page and hard-coded lowestFba on Bulk Calc.
const PRICE_SOURCE_KEY = "fba-price-source";

export function loadPriceSource(): "lowestFba" | "buyBox" {
  try {
    const v = localStorage.getItem(PRICE_SOURCE_KEY);
    if (v === "buyBox" || v === "lowestFba") return v;
  } catch {}
  return "lowestFba";
}

export function savePriceSource(v: "lowestFba" | "buyBox"): void {
  localStorage.setItem(PRICE_SOURCE_KEY, String(v));
}
