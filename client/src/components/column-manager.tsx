import { useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { Columns3, RotateCcw } from "lucide-react";
import { ALL_COLUMNS, COLUMN_GROUPS, type ColumnId } from "@shared/schema";
import { type ColumnConfig, getDefaultConfig, saveColumnConfig } from "@/lib/columns";

interface ColumnManagerProps {
  config: ColumnConfig;
  onChange: (config: ColumnConfig) => void;
}

export function ColumnManager({ config, onChange }: ColumnManagerProps) {
  const toggleColumn = useCallback(
    (id: ColumnId) => {
      if (id === "product") return;
      const next = { ...config, visible: new Set(config.visible) };
      if (next.visible.has(id)) next.visible.delete(id);
      else next.visible.add(id);
      saveColumnConfig(next);
      onChange(next);
    },
    [config, onChange],
  );

  const resetToDefault = useCallback(() => {
    const def = getDefaultConfig();
    saveColumnConfig(def);
    onChange(def);
  }, [onChange]);

  // Group columns by their schema-defined group
  const colsByGroup = new Map<string, typeof ALL_COLUMNS>();
  for (const col of ALL_COLUMNS) {
    const arr = colsByGroup.get(col.group) ?? [];
    arr.push(col);
    colsByGroup.set(col.group, arr);
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="secondary" size="sm" data-testid="button-column-manager">
          <Columns3 className="h-4 w-4 mr-1.5" />
          Columns
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="end" side="bottom">
        <div className="p-3 pb-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium">Manage Columns</span>
            <Button variant="ghost" size="sm" onClick={resetToDefault} className="h-7 text-xs" data-testid="button-reset-columns">
              <RotateCcw className="h-3 w-3 mr-1" />
              Reset
            </Button>
          </div>
        </div>
        <Separator />
        <div className="max-h-[400px] overflow-y-auto p-1">
          {COLUMN_GROUPS.map((group) => {
            const cols = colsByGroup.get(group.key) ?? [];
            if (cols.length === 0) return null;
            return (
              <div key={group.key}>
                <div className="px-2 pt-2 pb-1">
                  <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">{group.label}</span>
                </div>
                {cols.map((col) => (
                  <div key={col.id} className="flex items-center gap-2 px-2 py-1.5 rounded-md" data-testid={`column-item-${col.id}`}>
                    <Checkbox
                      checked={config.visible.has(col.id)}
                      onCheckedChange={() => toggleColumn(col.id)}
                      id={`col-${col.id}`}
                      disabled={col.id === "product"}
                      data-testid={`checkbox-column-${col.id}`}
                    />
                    <label htmlFor={`col-${col.id}`} className="text-sm cursor-pointer flex-1 select-none">
                      {col.qualifier ? `${col.qualifier} ${col.label}` : col.label}
                    </label>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
