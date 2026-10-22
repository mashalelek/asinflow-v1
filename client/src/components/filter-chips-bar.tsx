import { X, Filter } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { FilterChip, FilterChipKey } from "@/lib/filter-chips";

/** Active filters above the ASINs table: one chip per filter (× clears it), Clear filters. */
export function FilterChipsBar({ chips, onClear, onClearAll }: { chips: FilterChip[]; onClear: (key: FilterChipKey) => void; onClearAll: () => void }) {
  if (chips.length === 0) return null;
  return (
    <div className="mx-4 mb-2 flex flex-wrap items-center gap-1.5 text-xs" data-testid="filter-chips-bar">
      <Filter className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
      {chips.map((c) => (
        <span key={c.key} className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 pl-2.5 pr-1 py-0.5 text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-300" data-testid={`filter-chip-${c.key}`}>
          {c.label}
          <button onClick={() => onClear(c.key)} className="rounded-full p-0.5 hover:bg-amber-200 dark:hover:bg-amber-900" aria-label={`Clear ${c.label}`} data-testid={`button-clear-chip-${c.key}`}>
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={onClearAll} data-testid="button-clear-all-filters">Clear filters</Button>
    </div>
  );
}
