// Dashboard range resolver (SPEC §28 §2.2) — pure, unit-tested. Deliberately
// NOT computePresetRange: AF's shared presets end yesterday ("last 30 days" =
// the 30 days before today) while the Dashboard's "N days" INCLUDES today,
// its weeks start Monday (D2) and "today" is resolved on the server in two
// zones — America/New_York for Spend (order_date) and America/Los_Angeles
// for Sales (sale_date, Pacific since 2026-11-03). Every column carries both.
import type { Ymd } from "@shared/dashboard";

export type RangeSet = 1 | 2 | 3 | 4;
export type ColumnKey = "today" | "yesterday" | "this_week" | "mtd" | "d7" | "d14" | "d30" | "last_month" | "custom";

export const EASTERN = "America/New_York";
export const PACIFIC = "America/Los_Angeles";

export const SET_COLUMNS: Readonly<Record<RangeSet, readonly { key: ColumnKey; label: string }[]>> = {
  1: [{ key: "today", label: "Today" }, { key: "this_week", label: "This week" }, { key: "mtd", label: "MTD" }, { key: "d30", label: "30 days" }],
  2: [{ key: "today", label: "Today" }, { key: "yesterday", label: "Yesterday" }, { key: "mtd", label: "MTD" }, { key: "last_month", label: "Last month" }],
  3: [{ key: "today", label: "Today" }, { key: "yesterday", label: "Yesterday" }, { key: "d7", label: "7 days" }, { key: "d14", label: "14 days" }, { key: "d30", label: "30 days" }],
  4: [{ key: "custom", label: "Custom" }],
};

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

/** YYYY-MM-DD plus n days (calendar arithmetic in UTC — the strings are plain dates). */
export function addDays(ymd: string, n: number): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The calendar day of `now` in `tz`. */
export function todayIn(tz: string, now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** Monday of the week containing `ymd` (D2: weeks start Monday). */
export function mondayOf(ymd: string): string {
  const dow = (new Date(`${ymd}T12:00:00Z`).getUTCDay() + 6) % 7; // Mon = 0 … Sun = 6
  return addDays(ymd, -dow);
}

export function firstOfMonth(ymd: string): string { return `${ymd.slice(0, 7)}-01`; }

/** The previous calendar month of `ymd`'s month, inclusive. */
export function lastMonthOf(ymd: string): Ymd {
  const first = firstOfMonth(ymd);
  const to = addDays(first, -1);
  return { from: firstOfMonth(to), to };
}

/** The inclusive range of one column key for a given "today". "N days" includes today. */
export function rangeFor(key: ColumnKey, today: string, custom?: Ymd): Ymd {
  switch (key) {
    case "today": return { from: today, to: today };
    case "yesterday": { const y = addDays(today, -1); return { from: y, to: y }; }
    case "this_week": return { from: mondayOf(today), to: today };
    case "mtd": return { from: firstOfMonth(today), to: today };
    case "d7": return { from: addDays(today, -6), to: today };
    case "d14": return { from: addDays(today, -13), to: today };
    case "d30": return { from: addDays(today, -29), to: today };
    case "last_month": return lastMonthOf(today);
    case "custom": {
      if (!custom) throw new Error("custom range requires from and to");
      return { from: custom.from, to: custom.to };
    }
  }
}

export interface ResolvedColumn { key: ColumnKey; label: string; eastern: Ymd; pacific: Ymd }

/** Every column of a set, each with its Eastern (Spend) and Pacific (Sales) range. A custom range is literal in both. */
export function resolveColumns(set: RangeSet, now: Date, custom?: Ymd): ResolvedColumn[] {
  const et = todayIn(EASTERN, now);
  const pt = todayIn(PACIFIC, now);
  return SET_COLUMNS[set].map((c) => ({ key: c.key, label: c.label, eastern: rangeFor(c.key, et, custom), pacific: rangeFor(c.key, pt, custom) }));
}

export function parseSet(raw: unknown): RangeSet | null {
  const n = Number(raw);
  return n === 1 || n === 2 || n === 3 || n === 4 ? n : null;
}

export function parseYmd(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  if (!YMD_RE.test(s)) return null;
  const d = new Date(`${s}T12:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? null : s;
}

/** A custom range from query params: both valid YYYY-MM-DD, from ≤ to; else an error message. */
export function parseCustom(fromRaw: unknown, toRaw: unknown): Ymd | { error: string } {
  const from = parseYmd(fromRaw), to = parseYmd(toRaw);
  if (!from || !to) return { error: "from and to must be YYYY-MM-DD" };
  if (from > to) return { error: "from must not be after to" };
  return { from, to };
}

/** The charts' default: 12 calendar months ending with the current one (Eastern today), the current month to date. */
export function last12MonthsRange(now: Date): Ymd {
  const today = todayIn(EASTERN, now);
  const first = firstOfMonth(today);
  const d = new Date(`${first}T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - 11);
  return { from: d.toISOString().slice(0, 10), to: today };
}
