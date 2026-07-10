/**
 * Date preset definitions + computations, matching Looker Studio (formerly
 * Google Data Studio) semantics.
 *
 *   - "Today"  / "Yesterday" are exact single days.
 *   - "This X" are the current period start-to-end (full window).
 *   - "This X to date" are the current period start through today.
 *   - "Last N days" are the N days BEFORE today (excludes today).
 *   - "Last week / month / quarter / year" are the previous COMPLETE period.
 *
 * Used by both DateRangeContext (to recompute relative ranges on load) and the
 * DataStudioDatePicker (to fill the trigger label + apply preset clicks).
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type PresetKey =
  | "fixed"
  | "today" | "yesterday"
  | "this_week_sun" | "this_week_to_date_sun"
  | "this_week_mon" | "this_week_to_date_mon"
  | "this_month" | "this_month_to_date"
  | "this_quarter" | "this_quarter_to_date"
  | "this_year" | "this_year_to_date"
  | "last_7_days" | "last_14_days" | "last_28_days" | "last_30_days"
  | "last_week_sun" | "last_week_mon"
  | "last_month" | "last_quarter" | "last_year"
  | "advanced";

export type AdvancedAnchor = "today" | "fixed";
export type AdvancedOp = "minus" | "plus";
export type AdvancedUnit = "days" | "weeks_sun" | "weeks_mon" | "months" | "quarters" | "years";

export interface AdvancedRef {
  type: AdvancedAnchor;
  /** YYYY-MM-DD anchor; only used when type === "fixed". */
  fixedDate?: string;
  op: AdvancedOp;
  value: number;
  unit: AdvancedUnit;
}

export interface AdvancedConfig {
  start: AdvancedRef;
  end: AdvancedRef;
}

// ─── Labels ───────────────────────────────────────────────────────────────────

export const PRESET_LABEL: Record<PresetKey, string> = {
  fixed: "Fixed",
  today: "Today",
  yesterday: "Yesterday",
  this_week_sun: "This week (starts Sunday)",
  this_week_to_date_sun: "This week to date (starts Sunday)",
  this_week_mon: "This week (starts Monday)",
  this_week_to_date_mon: "This week to date (starts Monday)",
  this_month: "This month",
  this_month_to_date: "This month to date",
  this_quarter: "This quarter",
  this_quarter_to_date: "This quarter to date",
  this_year: "This year",
  this_year_to_date: "This year to date",
  last_7_days: "Last 7 days",
  last_14_days: "Last 14 days",
  last_28_days: "Last 28 days",
  last_30_days: "Last 30 days",
  last_week_sun: "Last week (starts Sunday)",
  last_week_mon: "Last week (starts Monday)",
  last_month: "Last month",
  last_quarter: "Last quarter",
  last_year: "Last year",
  advanced: "Advanced",
};

export const UNIT_LABEL: Record<AdvancedUnit, string> = {
  days: "Days",
  weeks_sun: "Weeks (starts Sunday)",
  weeks_mon: "Weeks (starts Monday)",
  months: "Months",
  quarters: "Quarters",
  years: "Years",
};

// ─── Date helpers (local time) ────────────────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, "0");
export const fmtISO = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const parseISO = (s: string): Date => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
};

function startOfDay(d: Date): Date { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function addDays(d: Date, n: number): Date { const x = new Date(d); x.setDate(x.getDate() + n); return x; }

/** Sunday = 0, Monday = 1, ..., Saturday = 6. */
function startOfWeekSun(d: Date): Date { return addDays(startOfDay(d), -d.getDay()); }
function startOfWeekMon(d: Date): Date { const dow = d.getDay(); const back = dow === 0 ? 6 : dow - 1; return addDays(startOfDay(d), -back); }
function startOfMonth(d: Date): Date { return new Date(d.getFullYear(), d.getMonth(), 1); }
function endOfMonth(d: Date): Date { return new Date(d.getFullYear(), d.getMonth() + 1, 0); }
function startOfQuarter(d: Date): Date { const q = Math.floor(d.getMonth() / 3); return new Date(d.getFullYear(), q * 3, 1); }
function endOfQuarter(d: Date): Date { const q = Math.floor(d.getMonth() / 3); return new Date(d.getFullYear(), q * 3 + 3, 0); }
function startOfYear(d: Date): Date { return new Date(d.getFullYear(), 0, 1); }
function endOfYear(d: Date): Date { return new Date(d.getFullYear(), 11, 31); }

// ─── Preset → range ──────────────────────────────────────────────────────────

export function computePresetRange(key: PresetKey, now: Date = new Date()): { start: string; end: string } {
  const today = startOfDay(now);
  const yesterday = addDays(today, -1);

  switch (key) {
    case "today":     return { start: fmtISO(today), end: fmtISO(today) };
    case "yesterday": return { start: fmtISO(yesterday), end: fmtISO(yesterday) };

    // ─── This X ─────────────────────────────────────────────────────────────
    case "this_week_sun": {
      const s = startOfWeekSun(today);
      return { start: fmtISO(s), end: fmtISO(addDays(s, 6)) };
    }
    case "this_week_to_date_sun": {
      const s = startOfWeekSun(today);
      return { start: fmtISO(s), end: fmtISO(today) };
    }
    case "this_week_mon": {
      const s = startOfWeekMon(today);
      return { start: fmtISO(s), end: fmtISO(addDays(s, 6)) };
    }
    case "this_week_to_date_mon": {
      const s = startOfWeekMon(today);
      return { start: fmtISO(s), end: fmtISO(today) };
    }
    case "this_month":        return { start: fmtISO(startOfMonth(today)),   end: fmtISO(endOfMonth(today)) };
    case "this_month_to_date":return { start: fmtISO(startOfMonth(today)),   end: fmtISO(today) };
    case "this_quarter":      return { start: fmtISO(startOfQuarter(today)), end: fmtISO(endOfQuarter(today)) };
    case "this_quarter_to_date": return { start: fmtISO(startOfQuarter(today)), end: fmtISO(today) };
    case "this_year":         return { start: fmtISO(startOfYear(today)),    end: fmtISO(endOfYear(today)) };
    case "this_year_to_date": return { start: fmtISO(startOfYear(today)),    end: fmtISO(today) };

    // ─── Last N days (exclusive of today) ──────────────────────────────────
    case "last_7_days":   return { start: fmtISO(addDays(today, -7)),  end: fmtISO(yesterday) };
    case "last_14_days":  return { start: fmtISO(addDays(today, -14)), end: fmtISO(yesterday) };
    case "last_28_days":  return { start: fmtISO(addDays(today, -28)), end: fmtISO(yesterday) };
    case "last_30_days":  return { start: fmtISO(addDays(today, -30)), end: fmtISO(yesterday) };

    // ─── Last complete week/month/quarter/year ─────────────────────────────
    case "last_week_sun": {
      const ts = startOfWeekSun(today);
      return { start: fmtISO(addDays(ts, -7)), end: fmtISO(addDays(ts, -1)) };
    }
    case "last_week_mon": {
      const ts = startOfWeekMon(today);
      return { start: fmtISO(addDays(ts, -7)), end: fmtISO(addDays(ts, -1)) };
    }
    case "last_month": {
      const lastMonth = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      return { start: fmtISO(startOfMonth(lastMonth)), end: fmtISO(endOfMonth(lastMonth)) };
    }
    case "last_quarter": {
      const lastQ = new Date(today.getFullYear(), today.getMonth() - 3, 1);
      return { start: fmtISO(startOfQuarter(lastQ)), end: fmtISO(endOfQuarter(lastQ)) };
    }
    case "last_year": {
      const ly = new Date(today.getFullYear() - 1, 0, 1);
      return { start: fmtISO(startOfYear(ly)), end: fmtISO(endOfYear(ly)) };
    }

    case "fixed":
    case "advanced":
      // Caller must supply explicit dates / config — return today as a safe fallback.
      return { start: fmtISO(today), end: fmtISO(today) };
  }
}

// ─── Advanced config → range ─────────────────────────────────────────────────

function applyAdvancedRef(ref: AdvancedRef, now: Date): Date {
  const anchor = ref.type === "today" ? startOfDay(now) : startOfDay(ref.fixedDate ? parseISO(ref.fixedDate) : now);
  const sign = ref.op === "minus" ? -1 : 1;
  const v = sign * Math.max(0, Math.floor(Number(ref.value) || 0));
  const out = new Date(anchor);
  switch (ref.unit) {
    case "days":      out.setDate(out.getDate() + v); break;
    case "weeks_sun": out.setDate(out.getDate() + v * 7); break; // weekday alignment doesn't matter for offset arithmetic
    case "weeks_mon": out.setDate(out.getDate() + v * 7); break;
    case "months":    out.setMonth(out.getMonth() + v); break;
    case "quarters":  out.setMonth(out.getMonth() + v * 3); break;
    case "years":     out.setFullYear(out.getFullYear() + v); break;
  }
  return out;
}

export function computeAdvancedRange(cfg: AdvancedConfig, now: Date = new Date()): { start: string; end: string } {
  const start = applyAdvancedRef(cfg.start, now);
  const end = applyAdvancedRef(cfg.end, now);
  // Guard against inverted ranges by sorting.
  return start <= end
    ? { start: fmtISO(start), end: fmtISO(end) }
    : { start: fmtISO(end),   end: fmtISO(start) };
}

export const DEFAULT_ADVANCED: AdvancedConfig = {
  start: { type: "today", op: "minus", value: 30, unit: "days" },
  end:   { type: "today", op: "minus", value: 0,  unit: "days" },
};

// ─── Pretty-printing helpers ─────────────────────────────────────────────────

export function fmtLongDate(s: string): string {
  return parseISO(s).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}

/** Format the trigger button label as "MMM D, YYYY - MMM D, YYYY", never collapsing equal dates. */
export function fmtTriggerLabel(start: string, end: string): string {
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric" };
  const s = parseISO(start).toLocaleDateString("en-US", opts);
  const e = parseISO(end).toLocaleDateString("en-US", opts);
  return `${s} - ${e}`;
}
