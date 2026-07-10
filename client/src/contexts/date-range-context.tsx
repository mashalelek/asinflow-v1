/**
 * Shared global date range state. Lifted out of individual pages so the
 * picker can live in the top nav and a single value is reused across ASINs,
 * Analytics, and PO pages (consistent "what time window am I looking at?").
 *
 * Stores the preset key + advanced config alongside the resolved {start, end}
 * so the picker can pre-select the right mode when re-opened. Relative
 * presets (e.g. "today", "last_7_days") are re-resolved against the current
 * date on every page load — so "Today" stored yesterday means today's
 * date, not yesterday's.
 *
 * Persisted to localStorage.
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import {
  computePresetRange, computeAdvancedRange,
  DEFAULT_ADVANCED,
  type PresetKey, type AdvancedConfig,
} from "@/lib/date-presets";

export interface DateRange {
  /** YYYY-MM-DD */
  start: string;
  /** YYYY-MM-DD */
  end: string;
  /** Which preset produced this range (or "fixed"/"advanced" for manual). */
  preset: PresetKey;
  /** Only populated when preset === "advanced". */
  advancedConfig?: AdvancedConfig;
}

interface Ctx {
  range: DateRange;
  setRange: (r: DateRange) => void;
}

const STORAGE_KEY = "asinflow-date-range-v2";

function defaultRange(): DateRange {
  const r = computePresetRange("last_30_days");
  return { ...r, preset: "last_30_days" };
}

/**
 * Resolve a stored DateRange against the current date. Relative presets get
 * their dates recomputed; "fixed" preserves the stored dates; "advanced"
 * recomputes from the stored advancedConfig.
 */
function resolveRange(stored: DateRange): DateRange {
  if (stored.preset === "fixed") return stored;
  if (stored.preset === "advanced" && stored.advancedConfig) {
    const r = computeAdvancedRange(stored.advancedConfig);
    return { ...stored, start: r.start, end: r.end };
  }
  const r = computePresetRange(stored.preset);
  return { ...stored, start: r.start, end: r.end };
}

function loadFromStorage(): DateRange | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DateRange;
    if (typeof parsed.start !== "string" || typeof parsed.end !== "string" || !parsed.preset) return null;
    return resolveRange(parsed);
  } catch { return null; }
}

const DateRangeCtx = createContext<Ctx | null>(null);

export function DateRangeProvider({ children }: { children: ReactNode }) {
  const [range, setRangeRaw] = useState<DateRange>(() => loadFromStorage() ?? defaultRange());

  const setRange = (r: DateRange) => setRangeRaw(r);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(range)); } catch { /* swallow */ }
  }, [range]);

  return <DateRangeCtx.Provider value={{ range, setRange }}>{children}</DateRangeCtx.Provider>;
}

export function useDateRange(): Ctx {
  const ctx = useContext(DateRangeCtx);
  if (!ctx) throw new Error("useDateRange must be used inside <DateRangeProvider>");
  return ctx;
}

// Re-export so callers can build new DateRange values without importing from two places.
export { DEFAULT_ADVANCED } from "@/lib/date-presets";
