import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { X } from "lucide-react";
import { type ColumnId, ALL_COLUMNS, COLUMN_GROUPS } from "@shared/schema";
import { type ColFilter, type FilterMap } from "./column-filter";

const colLabelMap = new Map(ALL_COLUMNS.map((c) => [c.id, c.label]));
const colGroupMap = new Map(ALL_COLUMNS.map((c) => [c.id, c.group]));
const groupLabelMap = new Map(COLUMN_GROUPS.map((g) => [g.key, g.label]));

function formatFilterValue(f: ColFilter): string {
  const op = f.operator;
  const v = f.value;
  if (op === "gt") return `> ${v}`;
  if (op === "gte") return `\u2265 ${v}`;
  if (op === "lt") return `< ${v}`;
  if (op === "lte") return `\u2264 ${v}`;
  if (op === "eq") return `= ${v}`;
  if (op === "between") return `between ${v} and ${f.value2 ?? "?"}`;
  if (op === "contains") return `contains "${v}"`;
  if (op === "startsWith") return `starts with "${v}"`;
  if (op === "notContains") return `excludes "${v}"`;
  if (op === "never") return `never`;
  if (op === "olderThan") return `not in last ${v} days`;
  if (op === "newerThan") return `in last ${v} days`;
  // Multi-select (tags, supplier, category, sourcing)
  if (op === "anyOf" || op === "allOf") {
    try {
      const items = JSON.parse(v) as string[];
      const display = items.filter((s) => s !== "__none__").slice(0, 5).join(", ");
      const hasNone = items.includes("__none__");
      const parts: string[] = [];
      if (display) parts.push(display);
      if (hasNone) parts.push("(none)");
      return `${op === "allOf" ? "all of" : "any of"}: ${parts.join(", ")}${items.length > 5 ? ` +${items.length - 5}` : ""}`;
    } catch { return v; }
  }
  return `${op} ${v}`;
}

function getGroup(colId: ColumnId): string {
  const group = colGroupMap.get(colId);
  return group ? (groupLabelMap.get(group) ?? "Other") : "Other";
}

interface ActiveFiltersModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  colFilters: FilterMap;
  searchQuery: string;
  selectedAsins?: Set<string>;
  onRemoveFilter: (colId: ColumnId) => void;
  onClearSearch: () => void;
  onClearSelectedAsins?: () => void;
  onClearAll: () => void;
}

export function ActiveFiltersModal({
  open, onOpenChange, colFilters, searchQuery, selectedAsins, onRemoveFilter, onClearSearch, onClearSelectedAsins, onClearAll,
}: ActiveFiltersModalProps) {
  const filters = Object.values(colFilters);
  const hasSearch = searchQuery.trim().length > 0;
  const hasSelectedAsins = selectedAsins && selectedAsins.size > 0;

  // Group filters
  const grouped = new Map<string, { colId: ColumnId; label: string; display: string }[]>();
  for (const f of filters) {
    const group = getGroup(f.colId as ColumnId);
    const arr = grouped.get(group) ?? [];
    arr.push({
      colId: f.colId as ColumnId,
      label: colLabelMap.get(f.colId as ColumnId) ?? f.colId,
      display: formatFilterValue(f),
    });
    grouped.set(group, arr);
  }
  if (hasSearch) {
    const arr = grouped.get("Search") ?? [];
    arr.push({ colId: "product" as ColumnId, label: "Search", display: `"${searchQuery.trim()}"` });
    grouped.set("Search", arr);
  }
  if (hasSelectedAsins) {
    const arr = grouped.get("Search") ?? [];
    const asinList = Array.from(selectedAsins!);
    arr.push({ colId: "product" as ColumnId, label: "Selected ASINs", display: `${asinList.length} ASIN${asinList.length !== 1 ? "s" : ""}: ${asinList.slice(0, 3).join(", ")}${asinList.length > 3 ? "..." : ""}` });
    grouped.set("Search", arr);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md max-h-[70vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Active Filters</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          {Array.from(grouped.entries()).map(([group, items]) => (
            <div key={group}>
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">{group}</h3>
              <div className="space-y-1.5">
                {items.map((item) => (
                  <div key={item.colId} className="flex items-center justify-between gap-2 px-2 py-1.5 rounded bg-muted/50">
                    <span className="text-sm">
                      <span className="font-medium">{item.label}:</span>{" "}
                      <span className="text-muted-foreground">{item.display}</span>
                    </span>
                    <button
                      className="text-muted-foreground/60 hover:text-red-500 transition-colors flex-shrink-0"
                      onClick={() => {
                        if (item.label === "Selected ASINs") { onClearSelectedAsins?.(); onClearSearch(); }
                        else if (item.colId === "product" && group === "Search") onClearSearch();
                        else onRemoveFilter(item.colId);
                      }}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        <DialogFooter className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>Close</Button>
          <Button variant="destructive" size="sm" onClick={() => { onClearAll(); onOpenChange(false); }}>Clear All</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Count of active column filters + search + selected ASINs (excludes visibility toggles) */
export function getActiveFilterCount(colFilters: FilterMap, searchQuery: string, selectedAsinsCount = 0): number {
  return Object.keys(colFilters).length + (searchQuery.trim() ? 1 : 0) + (selectedAsinsCount > 0 ? 1 : 0);
}
