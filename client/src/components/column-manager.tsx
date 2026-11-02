import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogTrigger, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { Columns3, RotateCcw } from "lucide-react";
import { ALL_COLUMNS, COLUMN_GROUPS, type ColumnDef, type ColumnId } from "@shared/schema";
import { type ColumnConfig, getDefaultConfig, saveColumnConfig } from "@/lib/columns";

interface ColumnManagerProps {
  config: ColumnConfig;
  onChange: (config: ColumnConfig) => void;
  // §21 bulk page: pass its column subset + its own storage key. Defaults
  // preserve the main table exactly (ALL_COLUMNS, "fba-column-config").
  columns?: ColumnDef[];
  storageKey?: string;
}

export function ColumnManager({ config, onChange, columns = ALL_COLUMNS, storageKey }: ColumnManagerProps) {
  const toggleColumn = useCallback(
    (id: ColumnId) => {
      if (id === "product") return;
      const next = { ...config, visible: new Set(config.visible) };
      if (next.visible.has(id)) next.visible.delete(id);
      else next.visible.add(id);
      saveColumnConfig(next, storageKey);
      onChange(next);
    },
    [config, onChange, storageKey],
  );

  const resetToDefault = useCallback(() => {
    const def = getDefaultConfig(columns);
    saveColumnConfig(def, storageKey);
    onChange(def);
  }, [onChange, columns, storageKey]);

  // Group columns by their schema-defined group
  const colsByGroup = new Map<string, ColumnDef[]>();
  for (const col of columns) {
    const arr = colsByGroup.get(col.group) ?? [];
    arr.push(col);
    colsByGroup.set(col.group, arr);
  }

  const [open, setOpen] = useState(false);
  return (
    // The column manager on the shared dialog frame (AF-wide dialog rule, 2026-11-01) — no longer a popover.
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="secondary" size="sm" data-testid="button-column-manager">
          <Columns3 className="h-4 w-4 mr-1.5" />
          Columns
        </Button>
      </DialogTrigger>
      <DialogContent dialogId="column-manager" className="max-w-md" data-testid="dialog-column-manager">
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between gap-2 pr-6">
            <span>Manage Columns</span>
            <Button variant="ghost" size="sm" onClick={resetToDefault} className="h-7 text-xs" data-testid="button-reset-columns">
              <RotateCcw className="h-3 w-3 mr-1" />
              Reset
            </Button>
          </DialogTitle>
          <DialogDescription>Show, hide and order the table's columns.</DialogDescription>
        </DialogHeader>
        <Separator />
        <div className="p-1">
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
      </DialogContent>
    </Dialog>
  );
}
