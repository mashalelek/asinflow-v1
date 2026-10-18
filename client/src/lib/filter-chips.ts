// Active filters, always visible (2026-10-18). Every client-side filter that
// can hide a loaded ASIN becomes a chip above the table — including the
// visibility toggles (hide gated / hide meltable), which used to hide rows
// with no sign of it (Maria's saved "hide gated" hid new leads). Pure.

export type FilterChipKey = "tile" | "uncalculated" | "search" | "selection" | "gated" | "meltable" | "reveal" | `col:${string}`;
export interface FilterChip { key: FilterChipKey; label: string }

export interface FilterChipState {
  activeFilter: string;                      // scorecard tile: "all" | "profitable" | …
  filterUncalculated: boolean;
  searchQuery: string;
  selectedCount: number;                     // multi-select search ASINs
  showGated: boolean;
  showMeltable: boolean;
  colFilters: Record<string, { colId: string }>;
  revealedCount?: number;                    // ASINs shown past the filters (item: upload "Show")
}

const TILE_LABEL: Record<string, string> = { profitable: "Profitable", unprofitable: "Unprofitable", replens: "Replens", buyList: "Buy List", onHold: "On hold" };

export function buildFilterChips(s: FilterChipState, colLabel: (colId: string) => string, colValue: (colId: string) => string): FilterChip[] {
  const out: FilterChip[] = [];
  if (s.activeFilter && s.activeFilter !== "all") out.push({ key: "tile", label: `Tile: ${TILE_LABEL[s.activeFilter] ?? s.activeFilter}` });
  if (s.filterUncalculated) out.push({ key: "uncalculated", label: "Uncalculated only" });
  if (s.selectedCount > 0) out.push({ key: "selection", label: `Selected ASINs: ${s.selectedCount}` });
  else if (s.searchQuery.trim()) out.push({ key: "search", label: `Search: "${s.searchQuery.trim()}"` });
  if (!s.showGated) out.push({ key: "gated", label: "Gated: hidden" });
  if (!s.showMeltable) out.push({ key: "meltable", label: "Meltable: hidden" });
  for (const colId of Object.keys(s.colFilters)) out.push({ key: `col:${colId}`, label: `${colLabel(colId)}: ${colValue(colId)}` });
  if ((s.revealedCount ?? 0) > 0) out.push({ key: "reveal", label: `${s.revealedCount} added ASIN${s.revealedCount === 1 ? "" : "s"} shown past filters` });
  return out;
}

/** Of the ASINs an upload / sourcing sync added: which are loaded, and which of those the filters hide. */
export function addedHiddenReport(added: readonly string[], loaded: ReadonlyArray<{ asin: string }>, shown: ReadonlyArray<{ asin: string }>): { present: string[]; hidden: string[] } {
  const inList = new Set(loaded.map((r) => r.asin.toUpperCase()));
  const visible = new Set(shown.map((r) => r.asin.toUpperCase()));
  const present = Array.from(new Set(added.map((a) => a.toUpperCase()))).filter((a) => inList.has(a));
  return { present, hidden: present.filter((a) => !visible.has(a)) };
}
