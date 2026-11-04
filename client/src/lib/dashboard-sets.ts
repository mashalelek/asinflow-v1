// The Dashboard's four range sets as the segmented control labels them
// (SPEC §28 §2.2). The ranges themselves are resolved on the server
// (server/dashboard-range.ts) — the client never computes "today".
export type RangeSetKey = 1 | 2 | 3 | 4;
export const SET_COLUMN_LABELS: Readonly<Record<RangeSetKey, string>> = {
  1: "Today · This week · MTD · 30 days",
  2: "Today · Yesterday · MTD · Last month",
  3: "Today · Yesterday · 7 · 14 · 30 days",
  4: "Custom range…",
};
