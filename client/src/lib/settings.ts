import { type Settings } from "@shared/schema";

// Profit settings live in the database since the Finances API patch
// (commit 1, SPEC §5): GET / PUT /api/settings/profit. The browser copy under
// "fba-analyzer-settings" is removed on first load — a value Maria saves
// shows in every browser. `loadSettings()` stays synchronous (the pages'
// useState initialiser): the module cache after the first fetch, the
// defaults before it; `useProfitSettings` (client/src/hooks/use-settings.ts)
// does the fetch.
const LEGACY_SETTINGS_KEY = "fba-analyzer-settings";
let cached: Settings | null = null;
const listeners = new Set<(s: Settings) => void>();

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

/** The settings as last fetched (defaults before the first fetch). Synchronous on purpose. */
export function loadSettings(): Settings {
  try { localStorage.removeItem(LEGACY_SETTINGS_KEY); } catch {}
  return cached ? { ...cached } : { ...defaultSettings };
}

/** Test seam / cache reset. */
export function primeSettingsCache(s: Settings | null): void { cached = s; }

export function subscribeSettings(fn: (s: Settings) => void): () => void { listeners.add(fn); return () => { listeners.delete(fn); }; }
function publish(s: Settings) { cached = { ...s }; listeners.forEach((fn) => fn({ ...s })); }

/** GET /api/settings/profit → the cache; the defaults when the request fails (the page still renders). */
export async function fetchSettings(): Promise<Settings> {
  try {
    const res = await fetch("/api/settings/profit");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const s = { ...defaultSettings, ...(await res.json()) } as Settings;
    publish(s);
    return { ...s };
  } catch {
    return loadSettings();
  }
}

/** PUT /api/settings/profit — the server's answer (the stored values) becomes the cache; throws on failure so the dialog can say so. */
export async function saveSettings(settings: Settings): Promise<Settings> {
  const res = await fetch("/api/settings/profit", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(settings) });
  if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.message || `HTTP ${res.status}`); }
  const s = { ...defaultSettings, ...(await res.json()) } as Settings;
  publish(s);
  return { ...s };
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
